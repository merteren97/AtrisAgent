import { create } from 'zustand';
import type { AttachmentRef } from '@atris-agent-code/domain';
import { apiRequest } from '@/lib/api-client';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const EXTENSION_MIMES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
  csv: 'text/csv', json: 'application/json', bin: 'application/octet-stream',
};
const SUPPORTED_MIMES = new Set(Object.values(EXTENSION_MIMES));

export interface OrchestratorAttachmentUpload {
  attachmentIds: string[];
  attachments: AttachmentRef[];
}

interface AttachmentScope {
  files: File[];
  error: string | null;
  uploading: boolean;
}

const EMPTY_SCOPE: AttachmentScope = { files: [], error: null, uploading: false };
// Immutable File objects are weak keys: successful stages survive retries without retaining removed bytes.
const staged = new WeakMap<File, Map<string, AttachmentRef>>();
const generations = new Map<string, number>();
const inFlight = new Map<string, { workspaceId: string; generation: number; promise: Promise<OrchestratorAttachmentUpload> }>();

export function attachmentMimeType(file: Pick<File, 'name' | 'type'>): string {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (extension === 'svg' || file.type === 'image/svg+xml') {
    throw new Error('SVG attachments are not supported by the native preview. Use PNG, JPEG, GIF, or WebP.');
  }
  const mime = file.type || EXTENSION_MIMES[extension] || 'application/octet-stream';
  if (!SUPPORTED_MIMES.has(mime)) throw new Error(`${file.name}: unsupported file type (${mime}).`);
  return mime;
}

export function canPreviewAttachment(file: Pick<File, 'name' | 'type'>): boolean {
  try { return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachmentMimeType(file)); }
  catch { return false; }
}

/** Same limits and duplicate identity as Manual; validate a batch atomically. */
export function addOrchestratorFiles(current: File[], incoming: File[]): File[] {
  const next = [...current];
  for (const file of incoming) {
    if (next.some((item) => item.name === file.name && item.size === file.size && item.lastModified === file.lastModified)) continue;
    if (next.length >= MAX_FILES) throw new Error('Attach up to 10 files at a time.');
    if (!file.size) throw new Error(`${file.name} is empty.`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} exceeds the 10 MB per-file limit.`);
    if (next.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_TOTAL_BYTES) throw new Error('Attachments exceed the 25 MB total limit.');
    if (!file.name.trim() || file.name.length > 255 || /[\\/:\x00-\x1f\x7f]/.test(file.name) || ['.', '..'].includes(file.name)) {
      throw new Error('Attachment name must be a filename, not a path.');
    }
    attachmentMimeType(file);
    next.push(file);
  }
  return next;
}

function sniffMime(bytes: Uint8Array, file: File): string {
  if (file.type) return attachmentMimeType(file);
  const head = Array.from(bytes.subarray(0, 12));
  const text = String.fromCharCode(...head);
  if (head.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10') return 'image/png';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(text)) return 'image/gif';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp';
  if (text.startsWith('%PDF-')) return 'application/pdf';
  return attachmentMimeType(file);
}

function toBase64(bytes: Uint8Array): string {
  // Avoid spread argument limits for multi-MB files.
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(''));
}

interface OrchestratorAttachmentsState {
  scopes: Record<string, AttachmentScope>;
  addFiles: (scopeKey: string, files: File[]) => void;
  removeFile: (scopeKey: string, index: number) => void;
  clearFiles: (scopeKey: string) => void;
  upload: (scopeKey: string, workspaceId: string | null) => Promise<OrchestratorAttachmentUpload>;
}

export const useOrchestratorAttachmentsStore = create<OrchestratorAttachmentsState>((set, get) => ({
  scopes: {},
  addFiles: (scopeKey, files) => {
    const scope = get().scopes[scopeKey] || EMPTY_SCOPE;
    try {
      const next = addOrchestratorFiles(scope.files, files);
      set((state) => ({ scopes: { ...state.scopes, [scopeKey]: { ...scope, files: next, error: null } } }));
    } catch (error) {
      set((state) => ({ scopes: { ...state.scopes, [scopeKey]: { ...scope, error: error instanceof Error ? error.message : 'Unable to attach files.' } } }));
    }
  },
  removeFile: (scopeKey, index) => set((state) => {
    const scope = state.scopes[scopeKey] || EMPTY_SCOPE;
    return { scopes: { ...state.scopes, [scopeKey]: { ...scope, files: scope.files.filter((_, position) => position !== index), error: null } } };
  }),
  clearFiles: (scopeKey) => set((state) => {
    generations.set(scopeKey, (generations.get(scopeKey) || 0) + 1);
    const scopes = { ...state.scopes };
    delete scopes[scopeKey];
    return { scopes };
  }),
  upload: (scopeKey, workspaceId) => {
    const scope = get().scopes[scopeKey] || EMPTY_SCOPE;
    const generation = generations.get(scopeKey) || 0;
    const pending = inFlight.get(scopeKey);
    if (pending?.generation === generation && pending.workspaceId === workspaceId) return pending.promise;
    if (pending?.generation === generation) return Promise.reject(new Error('Attachments are already uploading for another workspace.'));
    if (!scope.files.length) return Promise.resolve({ attachmentIds: [], attachments: [] });
    if (!workspaceId) {
      const error = 'Select a workspace before uploading attachments.';
      set((state) => ({ scopes: { ...state.scopes, [scopeKey]: { ...scope, error } } }));
      return Promise.reject(new Error(error));
    }
    set((state) => ({ scopes: { ...state.scopes, [scopeKey]: { ...scope, uploading: true, error: null } } }));
    const update = (patch: Partial<AttachmentScope>) => set((state) => {
      const current = state.scopes[scopeKey];
      // Explicit clearing during a request must not resurrect the old draft.
      return current && (generations.get(scopeKey) || 0) === generation
        ? { scopes: { ...state.scopes, [scopeKey]: { ...current, ...patch } } } : {};
    });
    const promise: Promise<OrchestratorAttachmentUpload> = Promise.resolve().then(async () => {
      const attachments: AttachmentRef[] = [];
      try {
        for (const file of scope.files) {
          let ref: AttachmentRef | undefined = staged.get(file)?.get(workspaceId);
          if (!ref) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const response: AttachmentRef = await apiRequest<AttachmentRef>('/attachments', {
              method: 'POST', body: JSON.stringify({ workspaceId, name: file.name,
                mimeType: sniffMime(bytes, file), dataBase64: toBase64(bytes) }),
            });
            // Store public metadata only, even if a service accidentally includes internal fields.
            ref = { id: response.id, workspaceId: response.workspaceId, name: response.name, mimeType: response.mimeType,
              byteSize: response.byteSize, sha256: response.sha256, createdAt: response.createdAt };
            if (!ref.id || ref.workspaceId !== workspaceId) throw new Error('The upload response did not identify an attachment in this workspace.');
            const byWorkspace = staged.get(file) || new Map<string, AttachmentRef>();
            byWorkspace.set(workspaceId, ref);
            staged.set(file, byWorkspace);
          }
          attachments.push(ref);
        }
        return { attachmentIds: attachments.map((ref) => ref.id), attachments };
      } catch (error) {
        update({ error: error instanceof Error ? error.message : 'Attachment upload failed.' });
        throw error;
      } finally {
        update({ uploading: false });
        if (inFlight.get(scopeKey)?.generation === generation) inFlight.delete(scopeKey);
      }
    });
    inFlight.set(scopeKey, { workspaceId, generation, promise });
    return promise;
  },
}));

export interface UseOrchestratorAttachmentsResult {
  files: File[];
  addFiles: (files: File[]) => void;
  removeFile: (index: number) => void;
  clearFiles: () => void;
  upload: () => Promise<OrchestratorAttachmentUpload>;
  error: string | null;
  uploading: boolean;
}

export function useOrchestratorAttachments(scopeKey: string, workspaceId: string | null): UseOrchestratorAttachmentsResult {
  const scope = useOrchestratorAttachmentsStore((state) => state.scopes[scopeKey] || EMPTY_SCOPE);
  const actions = useOrchestratorAttachmentsStore.getState();
  return { files: scope.files, error: scope.error, uploading: scope.uploading,
    addFiles: (files) => actions.addFiles(scopeKey, files), removeFile: (index) => actions.removeFile(scopeKey, index),
    clearFiles: () => actions.clearFiles(scopeKey), upload: () => actions.upload(scopeKey, workspaceId) };
}
