import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Express, Request, RequestHandler, Response } from 'express';
import { PlanningError, PlanningStore, validatePlanningPath } from './planning-store';

const BASE = '/api/workspaces/:workspaceId/plans';
type Fence = (workspaceId: string) => boolean;
function errorResponse(res: Response, error: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  res.removeHeader('Content-Length');
  res.removeHeader('Content-Disposition');
  res.type('application/json');
  if (error instanceof PlanningError) res.status(error.statusCode).json({ code: error.code, error: error.message });
  else res.status(500).json({ code: 'PLANNING_IO_ERROR', error: 'Unable to access planning files.' });
}
function checkFence(fenced: Fence | undefined, workspaceId: string): void {
  if (fenced?.(workspaceId)) throw new PlanningError('Workspace deletion is in progress.', 409, 'DELETION_IN_PROGRESS');
}
function queryPath(req: Request): string {
  if (typeof req.query.path !== 'string') throw new PlanningError('path is required.');
  return validatePlanningPath(req.query.path);
}
/** Single byte range, including suffix/open-ended requests. Multiple ranges are deliberately rejected. */
export function planningByteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new PlanningError('Range not satisfiable.', 416, 'INVALID_RANGE');
  let start: number;
  let end: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new PlanningError('Range not satisfiable.', 416, 'INVALID_RANGE'); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new PlanningError('Range not satisfiable.', 416, 'INVALID_RANGE');
  return { start, end: Math.min(end, size - 1) };
}
function sendContent(store: PlanningStore, req: Request, res: Response, workspaceId: string, planId: string, relative: string): void {
  const file = store.resolveFile(workspaceId, planId, relative);
  res.set({
    'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
    'Content-Type': file.mimeType,
    'Content-Disposition': `${/^(image|video|audio)\//.test(file.mimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(relative.split('/').pop()!)}`,
  });
  let range: ReturnType<typeof planningByteRange>;
  try { range = planningByteRange(req.headers.range, file.byteSize); }
  catch (error) { res.set('Content-Range', `bytes */${file.byteSize}`); throw error; }
  if (range) res.status(206).set('Content-Range', `bytes ${range.start}-${range.end}/${file.byteSize}`);
  res.set('Content-Length', String(range ? range.end - range.start + 1 : file.byteSize));
  if (req.method === 'HEAD' || file.byteSize === 0) { res.end(); return; }
  const fd = fs.openSync(file.absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const stream = fs.createReadStream(file.absolutePath, { fd, autoClose: true, ...(range || {}) });
  stream.on('error', (error) => errorResponse(res, error));
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
interface MediaGrant { workspaceId: string; planId: string; path: string; expiresAt: number; }
export interface PlanningMediaAccess {
  middleware: RequestHandler;
  allowsRequest(req: Request): boolean;
  issue(workspaceId: string, planId: string, path: string): { url: string; expiresAt: string };
}
/**
 * Mount middleware before runtime bearer auth; it handles ONLY exact content GET/HEADs
 * carrying valid opaque grants. Alternatively the auth gate may call allowsRequest.
 * Pass this same object to installPlanningRoutes({mediaAccess}) for grant issuance.
 * No cookies or runtime credentials are encoded in URLs; grants expire across restarts.
 */
export function createPlanningMediaAccess(store: PlanningStore, options: { fenced?: Fence; ttlMs?: number; clock?: () => number } = {}): PlanningMediaAccess {
  const grants = new Map<string, MediaGrant>();
  const clock = options.clock || Date.now;
  const ttl = Math.min(Math.max(options.ttlMs ?? 120_000, 1), 300_000);
  const prune = () => { for (const [key, grant] of grants) if (grant.expiresAt <= clock()) grants.delete(key); };
  const lookup = (req: Request): MediaGrant | null => {
    if (!['GET', 'HEAD'].includes(req.method) || typeof req.query.grant !== 'string' || req.query.grant.length !== 43 || typeof req.query.path !== 'string') return null;
    const match = /^\/api\/workspaces\/([^/]+)\/plans\/([^/]+)\/content$/.exec(req.path);
    if (!match) return null;
    let workspaceId: string;
    let planId: string;
    try { workspaceId = decodeURIComponent(match[1]); planId = decodeURIComponent(match[2]); } catch { return null; }
    const grant = grants.get(req.query.grant);
    if (!grant || grant.expiresAt <= clock() || grant.workspaceId !== workspaceId || grant.planId !== planId || grant.path !== req.query.path) return null;
    if (options.fenced?.(workspaceId)) return null;
    return grant;
  };
  return {
    allowsRequest: (req) => lookup(req) !== null,
    middleware: (req, res, next) => {
      const grant = lookup(req);
      if (!grant) { next(); return; }
      try { sendContent(store, req, res, grant.workspaceId, grant.planId, grant.path); } catch (error) { errorResponse(res, error); }
    },
    issue: (workspaceId, planId, relative) => {
      checkFence(options.fenced, workspaceId);
      store.resolveFile(workspaceId, planId, relative);
      prune();
      if (grants.size >= 1000) grants.delete(grants.keys().next().value!);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = clock() + ttl;
      grants.set(token, { workspaceId, planId, path: relative, expiresAt });
      return { url: `/api/workspaces/${encodeURIComponent(workspaceId)}/plans/${encodeURIComponent(planId)}/content?path=${encodeURIComponent(relative)}&grant=${token}`, expiresAt: new Date(expiresAt).toISOString() };
    },
  };
}

/** Register after runtime auth. Uploads require an untouched binary request stream. */
export function installPlanningRoutes(app: Express, store: PlanningStore, options: { fenced?: Fence; mediaAccess?: PlanningMediaAccess } = {}): PlanningMediaAccess {
  const media = options.mediaAccess || createPlanningMediaAccess(store, { fenced: options.fenced });
  const route = (handler: (req: Request, res: Response, workspaceId: string, planId: string) => unknown): RequestHandler => (req, res) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const planId = String(req.params.planId ?? '');
      checkFence(options.fenced, workspaceId);
      Promise.resolve(handler(req, res, workspaceId, planId)).catch((error) => errorResponse(res, error));
    } catch (error) { errorResponse(res, error); }
  };
  app.get(BASE, route((_req, res, workspaceId) => res.json(store.list(workspaceId))));
  app.post(BASE, route((req, res, workspaceId) => res.status(201).json(store.create(workspaceId, { id: req.body?.id ?? randomUUID(), title: req.body?.title }))));
  app.post(`${BASE}/import`, route((req, res, workspaceId) => {
    if (typeof req.body?.content !== 'string') throw new PlanningError('Markdown content is required.');
    res.status(201).json(store.create(workspaceId, { id: req.body?.id ?? randomUUID(), title: req.body?.title, content: req.body.content }));
  }));
  app.get(`${BASE}/:planId`, route((_req, res, workspaceId, planId) => res.json(store.get(workspaceId, planId))));
  app.patch(`${BASE}/:planId`, route((req, res, workspaceId, planId) => res.json(store.update(workspaceId, planId, req.body || {}))));
  app.get(`${BASE}/:planId/board`, route((_req, res, workspaceId, planId) => res.set('Cache-Control', 'no-store').json(store.readBoard(workspaceId, planId))));
  app.put(`${BASE}/:planId/board`, route((req, res, workspaceId, planId) => res.json(store.writeBoard(workspaceId, planId, { board: req.body?.board, expectedRevision: req.body?.expectedRevision }))));
  app.get(`${BASE}/:planId/outline`, route((_req, res, workspaceId, planId) => res.set('Cache-Control', 'no-store').json(store.deriveOutline(workspaceId, planId))));
  app.post(`${BASE}/:planId/board/convert`, route((req, res, workspaceId, planId) => res.status(201).json(store.convertBoard(workspaceId, planId, req.body?.expectedRevision ?? null))));
  app.get(`${BASE}/:planId/document`, route((req, res, workspaceId, planId) => {
    res.set('Cache-Control', 'no-store').json(store.readDocument(workspaceId, planId, queryPath(req)));
  }));
  app.put(`${BASE}/:planId/document`, route((req, res, workspaceId, planId) => res.json(store.writeDocument(workspaceId, planId, { path: queryPath(req), content: req.body?.content, expectedRevision: req.body?.expectedRevision }))));
  app.get(`${BASE}/:planId/files`, route((_req, res, workspaceId, planId) => res.set('Cache-Control', 'no-store').json(store.listFiles(workspaceId, planId))));
  app.post(`${BASE}/:planId/import`, route((req, res, workspaceId, planId) => {
    const filename = req.body?.filename;
    if (typeof filename !== 'string' || filename.includes('/') || filename.includes('\\')) throw new PlanningError('Expected a Markdown filename.');
    const document = store.writeDocument(workspaceId, planId, { path: `research/${filename}`, content: req.body?.content, expectedRevision: null });
    res.status(201).json(document);
  }));
  app.post(`${BASE}/:planId/assets`, route(async (req, res, workspaceId, planId) => {
    if (!req.is('application/octet-stream') || req.readableEnded || Buffer.isBuffer(req.body)) throw new PlanningError('Upload must be an unparsed application/octet-stream request.');
    const filename = req.query.filename ?? req.headers['x-filename'];
    const mimeType = req.query.mimeType ?? req.headers['x-file-mime-type'];
    if (typeof filename !== 'string' || typeof mimeType !== 'string') throw new PlanningError('filename and mimeType are required.');
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > store.maxAssetBytes) throw new PlanningError('Asset exceeds the upload size limit.', 413);
    res.status(201).json(await store.importAsset(workspaceId, planId, { filename, mimeType, stream: req }));
  }));
  app.post(`${BASE}/:planId/media-grant`, route((req, res, workspaceId, planId) => {
    if (typeof req.body?.path !== 'string') throw new PlanningError('path is required.');
    res.set('Cache-Control', 'no-store').json(media.issue(workspaceId, planId, req.body.path));
  }));
  app.get(`${BASE}/:planId/content`, route((req, res, workspaceId, planId) => sendContent(store, req, res, workspaceId, planId, queryPath(req))));
  app.post(`${BASE}/:planId/executions`, route((req, res, workspaceId, planId) => res.status(201).json(store.createExecution(workspaceId, planId, req.body || {}))));
  app.get(`${BASE}/:planId/executions/:executionId`, route((req, res, workspaceId, planId) => res.set('Cache-Control', 'no-store').json(store.getExecution(workspaceId, planId, String(req.params.executionId)))));
  app.patch(`${BASE}/:planId/executions/:executionId`, route((req, res, workspaceId, planId) => res.json(store.recordExecutionTarget(workspaceId, planId, String(req.params.executionId), req.body?.targetId))));
  return media;
}
