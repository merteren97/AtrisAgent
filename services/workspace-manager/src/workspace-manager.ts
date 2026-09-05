import { and, desc, eq, inArray, lte, max } from 'drizzle-orm';
import {
  workspaces,
  missions,
  tasks,
  taskAttempts,
  worktrees,
  agentInstances,
  agentProfiles,
  agentProfileBindings,
  teamRoles,
  teamTemplates,
  executionPolicies,
  conversationTurns,
  type WorkspaceSelect,
  type WorkspaceInsert,
  type MissionSelect,
  type MissionInsert,
  type TaskSelect,
  type TaskInsert,
  type TaskAttemptSelect,
  type TaskAttemptInsert,
  type WorktreeSelect,
  type WorktreeInsert,
  type ExecutionPolicyScope,
  type AgentProfileSelect,
  type AgentProfileBindingSelect,
  type AtrisDatabase,
} from '@atris-agent-code/database';
import path from 'path';
import { WorktreeManager } from './worktree-manager';
import { CheckpointManager } from './checkpoint-manager';
import type { LocalEventBus } from '@atris-agent-code/event-bus';
import type {
  ExecutionMode,
  MissionStatus,
  TaskStatus,
  TaskPriority,
  AgentRole,
  RoleExecutionPolicy,
  EffectiveRoutingPreference,
  RoutingPreferenceSource,
  MissionAutomationPolicy,
  CanonicalReasoning,
  RouteSelectionMode,
  EffectiveAttemptRoute,
  EffectiveWorkerPoolPolicy,
  BuilderTargetDescriptor,
  AgentProfileSource,
  AgentProfile,
  AgentProfilePatch,
  AgentProfileRecord,
  AgentProfileBindingOverride,
  AgentProfileBindingRecord,
  AgentProfileCreateInput,
  AgentProfileUpdateInput,
  AgentProfileResolution,
  AgentProfileResolutionRequest,
  AgentProfileScopeType,
} from '@atris-agent-code/domain';
import {
  defaultAgentProfile,
  isAgentRole,
  mergeAgentProfiles,
  normalizeAgentProfile,
  resolveWorkerPoolPolicy,
} from '@atris-agent-code/domain';

export interface CreateWorkspaceInput {
  name: string;
  path: string;
  gitInitialized?: boolean;
  id?: string;
  lastOpenedAt?: string | null;
  lastTeamTemplateId?: string | null;
}

export interface CreateMissionInput {
  workspaceId: string;
  title: string;
  description?: string;
  teamTemplateId?: string;
  planId?: string | null;
  executionMode?: ExecutionMode;
  status?: MissionStatus;
  id?: string;
  automationPolicy?: MissionAutomationPolicy;
}

export interface CreateTaskInput {
  missionId: string;
  planId?: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedAgentId?: string | null;
  assignedRole?: AgentRole | null;
  /** Canonical named profile selected for the task. */
  agentProfileId?: string | null;
  requiredCapabilities?: string[];
  dependsOn?: string[];
  worktreeId?: string | null;
  targetDescriptor?: BuilderTargetDescriptor | null;
  id?: string;
}

export interface ClaimTaskAttemptInput {
  taskId: string;
  missionId: string;
  agentInstanceId: string;
  worktreePath?: string | null;
  leaseExpiresAt: string;
  now?: string;
  id?: string;
  /** Canonical named profile snapshot for this attempt. */
  agentProfileId?: string | null;
  route: {
    adapterId: string;
    provider?: string | null;
    accountProfileId?: string | null;
    modelCatalogId?: string | null;
    runtimeModelId?: string | null;
    reasoningLevel?: CanonicalReasoning | null;
    source: RoutingPreferenceSource;
    selectionMode: RouteSelectionMode;
    agentProfileId?: string | null;
  };
}

export interface SupervisorSessionMetadata {
  providerSessionId?: string;
  agentProfileId?: string;
  agentProfileName?: string;
  agentProfileSource?: AgentProfileSource;
  resumeCapability: 'none' | 'live' | 'restart';
  route: ClaimTaskAttemptInput['route'];
  updatedAt: string;
}

export interface ReserveAgentCapacityInput {
  id: string;
  missionId: string;
  role: AgentRole;
  modelProfileId?: string;
  /** Canonical named profile identity; DB keeps profile_id for legacy rows. */
  agentProfileId?: string | null;
  parentAgentId?: string | null;
  displayName: string;
  specialty?: string | null;
  spawnReason: string;
  workspaceMode: string;
  createdAt: string;
}

/** Public persistence DTO aliases exported by WorkspaceManager. */
export type CreateAgentProfileInput = AgentProfileCreateInput;
export type UpdateAgentProfileInput = AgentProfileUpdateInput;

export interface ListAgentProfilesOptions {
  role?: AgentRole;
  includeArchived?: boolean;
}

export interface CreateAgentProfileBindingInput {
  id?: string;
  scopeType: AgentProfileScopeType;
  scopeId: string;
  /** When omitted, the profile's immutable role is used. */
  role?: AgentRole;
  profileId?: string;
  agentProfileId?: string;
  override?: AgentProfileBindingOverride;
  /** Compatibility aliases accepted at the persistence boundary. */
  overrides?: AgentProfileBindingOverride;
  profileOverride?: AgentProfileBindingOverride;
  isDefault?: boolean;
}

export interface UpdateAgentProfileBindingInput {
  scopeType?: AgentProfileScopeType;
  scopeId?: string;
  /** The binding role is immutable; a differing value is rejected. */
  role?: AgentRole;
  profileId?: string;
  agentProfileId?: string;
  override?: AgentProfileBindingOverride | null;
  overrides?: AgentProfileBindingOverride | null;
  profileOverride?: AgentProfileBindingOverride | null;
  isDefault?: boolean;
}

export interface ListAgentProfileBindingsOptions {
  scopeType?: AgentProfileScopeType;
  scopeId?: string;
  role?: AgentRole;
  profileId?: string;
  agentProfileId?: string;
  /** Include bindings whose global profile has been soft archived. */
  includeArchivedProfiles?: boolean;
}

export interface UnbindAgentProfileInput {
  scopeType: AgentProfileScopeType;
  scopeId: string;
  role?: AgentRole;
  profileId?: string;
  agentProfileId?: string;
}

export interface ResolveAgentProfileInput extends AgentProfileResolutionRequest {
  taskId?: string;
  explicitProfileId?: string | null;
  explicitProfile?: AgentProfile | AgentProfilePatch | null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canonicalRole(value: unknown, label: string): AgentRole {
  if (!isAgentRole(value)) throw new Error(`${label} must be one of the fixed core agent roles.`);
  return String(value).toLowerCase() as AgentRole;
}

function canonicalScope(value: unknown): AgentProfileScopeType {
  if (value === 'global' || value === 'workspace' || value === 'team_template') return value;
  throw new Error("Agent profile binding scope must be 'global', 'workspace', or 'team_template'.");
}

function profileRecordFromRow(row: AgentProfileSelect): AgentProfileRecord {
  const role = canonicalRole(row.role, 'Persisted agent profile role');
  const profile = normalizeAgentProfile({
    id: row.id,
    name: row.name,
    role,
    instructions: row.instructions,
    capabilities: row.capabilities,
    specialty: row.specialty,
    description: row.description,
    ...(row.routePolicy === null || row.routePolicy === undefined ? {} : { routePolicy: row.routePolicy }),
    ...(row.allowedRoutePolicy === null || row.allowedRoutePolicy === undefined ? {} : { allowedRoutePolicy: row.allowedRoutePolicy }),
  }, role);
  return {
    ...profile,
    isDefault: Boolean(row.isDefault),
    archivedAt: row.archivedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function bindingRecordFromRow(row: AgentProfileBindingSelect): AgentProfileBindingRecord {
  return {
    id: row.id,
    scopeType: canonicalScope(row.scopeType),
    scopeId: row.scopeId,
    role: canonicalRole(row.role, 'Persisted agent profile binding role'),
    profileId: row.profileId,
    isDefault: Boolean(row.isDefault),
    override: row.override ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Normalize a binding patch and reject attempts to smuggle identity/role. */
function normalizeBindingOverride(
  value: unknown,
  base: AgentProfile,
): AgentProfileBindingOverride | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent profile binding override must be an object.');
  }
  const input = value as Record<string, unknown>;
  for (const key of ['id', 'profileId', 'agentProfileId']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const attempted = nonEmpty(input[key]);
      if (attempted !== base.id) throw new Error('Agent profile binding cannot change profile identity.');
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'role')) {
    const attemptedRole = canonicalRole(input.role, 'Agent profile binding override role');
    if (attemptedRole !== base.role) throw new Error(`Agent profile binding role '${attemptedRole}' cannot override fixed role '${base.role}'.`);
  }

  const patch: AgentProfileBindingOverride = {};
  const fields: Array<keyof AgentProfileBindingOverride> = [
    'name', 'instructions', 'capabilities', 'specialty', 'description', 'routePolicy', 'allowedRoutePolicy',
  ];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      (patch as Record<string, unknown>)[field] = input[field];
    }
  }
  // Run the same strict parser used for global records. mergeAgentProfiles
  // intersects route allowlists, making an override a narrowing constraint.
  const normalized = normalizeAgentProfile({
    ...base,
    ...patch,
    id: base.id,
    role: base.role,
  }, base.role);
  mergeAgentProfiles(base, patch);
  return {
    ...(Object.prototype.hasOwnProperty.call(input, 'name') ? { name: normalized.name } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'instructions') ? { instructions: normalized.instructions } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'capabilities') ? { capabilities: normalized.capabilities } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'specialty') ? { specialty: normalized.specialty } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'description') ? { description: normalized.description } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'routePolicy') ? { routePolicy: normalized.routePolicy } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'allowedRoutePolicy') ? { allowedRoutePolicy: normalized.allowedRoutePolicy } : {}),
  };
}

export class WorkspaceManager {
  private worktreeManager = new WorktreeManager();
  private checkpointManager: CheckpointManager;

  constructor(
    private db: AtrisDatabase,
    _eventBus?: LocalEventBus
  ) {
    this.checkpointManager = new CheckpointManager(db);
  }

  getWorktreeManager(): WorktreeManager {
    return this.worktreeManager;
  }

  getCheckpointManager(): CheckpointManager {
    return this.checkpointManager;
  }

  /** Create a new workspace record. */
  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceSelect> {
    const now = new Date().toISOString();
    const newWorkspace: WorkspaceInsert = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      path: input.path,
      gitInitialized: input.gitInitialized ?? false,
      lastOpenedAt: input.lastOpenedAt ?? now,
      lastTeamTemplateId: input.lastTeamTemplateId ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(workspaces).values(newWorkspace);
    const result = await this.getWorkspace(newWorkspace.id);
    if (!result) throw new Error(`Failed to retrieve newly created workspace "${newWorkspace.id}"`);
    return result;
  }

  /** Get workspace by ID. */
  async getWorkspace(id: string | string[]): Promise<WorkspaceSelect | null> {
    const workspaceId = Array.isArray(id) ? id[0] : id;
    if (!workspaceId) return null;
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    return rows[0] ?? null;
  }

  /** List all workspaces. */
  async listWorkspaces(): Promise<WorkspaceSelect[]> {
    return await this.db.select().from(workspaces);
  }

  // -----------------------------------------------------------------------
  // Durable Agent Profile catalog and scoped bindings
  // -----------------------------------------------------------------------

  /** Create a global Agent Profile catalog record. */
  async createAgentProfile(input: CreateAgentProfileInput): Promise<AgentProfileRecord> {
    const id = nonEmpty(input.id) ?? crypto.randomUUID();
    const normalized = normalizeAgentProfile({ ...input, id }, input.role);
    const now = new Date().toISOString();
    const archivedAt = input.archivedAt ?? null;
    const isDefault = Boolean(input.isDefault) && !archivedAt;

    if (isDefault) {
      await this.db.update(agentProfiles)
        .set({ isDefault: false })
        .where(and(eq(agentProfiles.role, normalized.role), eq(agentProfiles.isDefault, true)));
    }
    await this.db.insert(agentProfiles).values({
      id: normalized.id,
      name: normalized.name,
      role: normalized.role,
      instructions: normalized.instructions,
      capabilities: normalized.capabilities,
      specialty: normalized.specialty ?? null,
      description: normalized.description ?? null,
      routePolicy: normalized.routePolicy ?? null,
      allowedRoutePolicy: normalized.allowedRoutePolicy ?? null,
      isDefault,
      archivedAt,
      createdAt: now,
      updatedAt: now,
    });
    const created = await this.getAgentProfile(id, { includeArchived: true });
    if (!created) throw new Error(`Failed to retrieve newly created agent profile "${id}"`);
    return created;
  }

  /** Get a global profile; archived rows are hidden unless explicitly asked for. */
  async getAgentProfile(
    id: string,
    options?: { includeArchived?: boolean } | boolean,
  ): Promise<AgentProfileRecord | null> {
    const profileId = nonEmpty(id);
    if (!profileId) return null;
    const includeArchived = typeof options === 'boolean' ? options : Boolean(options?.includeArchived);
    const rows = await this.db.select().from(agentProfiles).where(eq(agentProfiles.id, profileId));
    const row = rows[0];
    if (!row || (!includeArchived && row.archivedAt !== null)) return null;
    return profileRecordFromRow(row);
  }

  /** List global profiles, excluding soft-archived records by default. */
  async listAgentProfiles(options?: ListAgentProfilesOptions | boolean): Promise<AgentProfileRecord[]> {
    const normalizedOptions: ListAgentProfilesOptions = typeof options === 'boolean'
      ? { includeArchived: options }
      : options ?? {};
    const rows = normalizedOptions.role
      ? await this.db.select().from(agentProfiles).where(eq(agentProfiles.role, canonicalRole(normalizedOptions.role, 'Agent profile role')))
      : await this.db.select().from(agentProfiles);
    return rows
      .filter((row) => normalizedOptions.includeArchived || row.archivedAt === null)
      .map(profileRecordFromRow);
  }

  /** Update mutable catalog fields while preserving the fixed ID and role. */
  async updateAgentProfile(id: string, updates: UpdateAgentProfileInput): Promise<AgentProfileRecord> {
    const existing = await this.getAgentProfile(id, { includeArchived: true });
    if (!existing) throw new Error(`Agent profile "${id}" was not found.`);
    if (updates.id !== undefined && nonEmpty(updates.id) !== existing.id) {
      throw new Error('Agent profile identity is immutable.');
    }
    if (updates.role !== undefined && canonicalRole(updates.role, 'Agent profile role') !== existing.role) {
      throw new Error(`Agent profile role '${updates.role}' cannot change from fixed role '${existing.role}'.`);
    }

    const candidate = normalizeAgentProfile({
      ...existing,
      ...updates,
      id: existing.id,
      role: existing.role,
    }, existing.role);
    const archivedAt = updates.archivedAt === undefined ? existing.archivedAt : updates.archivedAt;
    const isDefault = archivedAt ? false : updates.isDefault === undefined ? existing.isDefault : Boolean(updates.isDefault);
    if (isDefault) {
      await this.db.update(agentProfiles)
        .set({ isDefault: false })
        .where(and(eq(agentProfiles.role, existing.role), eq(agentProfiles.isDefault, true)));
    }
    const updatedAt = new Date().toISOString();
    await this.db.update(agentProfiles).set({
      name: candidate.name,
      instructions: candidate.instructions,
      capabilities: candidate.capabilities,
      specialty: candidate.specialty ?? null,
      description: candidate.description ?? null,
      routePolicy: candidate.routePolicy ?? null,
      allowedRoutePolicy: candidate.allowedRoutePolicy ?? null,
      isDefault,
      archivedAt: archivedAt ?? null,
      updatedAt,
    }).where(eq(agentProfiles.id, existing.id));
    const result = await this.getAgentProfile(existing.id, { includeArchived: true });
    if (!result) throw new Error(`Failed to retrieve updated agent profile "${existing.id}"`);
    return result;
  }

  /** Soft archive a profile and remove it from all default slots. */
  async archiveAgentProfile(id: string, archivedAt = new Date().toISOString()): Promise<AgentProfileRecord> {
    const existing = await this.getAgentProfile(id, { includeArchived: true });
    if (!existing) throw new Error(`Agent profile "${id}" was not found.`);
    await this.db.update(agentProfiles).set({ isDefault: false, archivedAt, updatedAt: archivedAt })
      .where(eq(agentProfiles.id, existing.id));
    // Keep default bindings intact so a stale/archived default is observable
    // and resolution fails closed rather than silently selecting a fallback.
    const archived = await this.getAgentProfile(existing.id, { includeArchived: true });
    if (!archived) throw new Error(`Failed to archive agent profile "${existing.id}"`);
    return archived;
  }

  /** Restore a soft-archived profile without implicitly claiming a default slot. */
  async restoreAgentProfile(id: string, options: { isDefault?: boolean } = {}): Promise<AgentProfileRecord> {
    const existing = await this.getAgentProfile(id, { includeArchived: true });
    if (!existing) throw new Error(`Agent profile "${id}" was not found.`);
    const isDefault = Boolean(options.isDefault);
    if (isDefault) {
      await this.db.update(agentProfiles)
        .set({ isDefault: false })
        .where(and(eq(agentProfiles.role, existing.role), eq(agentProfiles.isDefault, true)));
    }
    const updatedAt = new Date().toISOString();
    await this.db.update(agentProfiles).set({ archivedAt: null, isDefault, updatedAt })
      .where(eq(agentProfiles.id, existing.id));
    const restored = await this.getAgentProfile(existing.id, { includeArchived: true });
    if (!restored) throw new Error(`Failed to restore agent profile "${existing.id}"`);
    return restored;
  }

  /** Profile deletion is intentionally a soft archive. */
  async deleteAgentProfile(id: string): Promise<AgentProfileRecord> {
    return this.archiveAgentProfile(id);
  }

  /** Return one binding by durable ID. */
  async getAgentProfileBinding(id: string): Promise<AgentProfileBindingRecord | null> {
    const bindingId = nonEmpty(id);
    if (!bindingId) return null;
    const rows = await this.db.select().from(agentProfileBindings).where(eq(agentProfileBindings.id, bindingId));
    const row = rows[0];
    return row ? bindingRecordFromRow(row) : null;
  }

  /** List bindings by scope/role/profile, hiding archived profile targets by default. */
  async listAgentProfileBindings(options: ListAgentProfileBindingsOptions = {}): Promise<AgentProfileBindingRecord[]> {
    let rows = await this.db.select().from(agentProfileBindings);
    const scopeType = options.scopeType === undefined ? undefined : canonicalScope(options.scopeType);
    const role = options.role === undefined ? undefined : canonicalRole(options.role, 'Agent profile binding role');
    const profileId = nonEmpty(options.profileId ?? options.agentProfileId);
    rows = rows.filter((row) => (scopeType === undefined || row.scopeType === scopeType)
      && (options.scopeId === undefined || row.scopeId === options.scopeId)
      && (role === undefined || row.role === role)
      && (profileId === undefined || row.profileId === profileId));
    if (!options.includeArchivedProfiles) {
      const activeIds = new Set((await this.listAgentProfiles()).map((profile) => profile.id));
      rows = rows.filter((row) => activeIds.has(row.profileId));
    }
    return rows.map(bindingRecordFromRow);
  }

  /**
   * Bind a global profile to a workspace or team template. Binding identity and
   * role are validated before persistence; allowlists are narrowed on resolve.
   */
  async bindAgentProfile(input: CreateAgentProfileBindingInput): Promise<AgentProfileBindingRecord> {
    const scopeType = canonicalScope(input.scopeType);
    const scopeId = nonEmpty(input.scopeId);
    if (!scopeId) throw new Error('Agent profile binding scopeId must be non-empty.');
    const profileId = nonEmpty(input.profileId ?? input.agentProfileId);
    if (!profileId) throw new Error('Agent profile binding requires a profileId.');
    const profile = await this.getAgentProfile(profileId, { includeArchived: true });
    if (!profile) throw new Error(`Agent profile "${profileId}" was not found.`);
    if (profile.archivedAt !== null) throw new Error(`Agent profile "${profileId}" is archived and cannot be bound.`);
    const role = input.role === undefined ? profile.role : canonicalRole(input.role, 'Agent profile binding role');
    if (role !== profile.role) {
      throw new Error(`Agent profile "${profileId}" has fixed role '${profile.role}', not '${role}'.`);
    }
    const rawOverride = input.override ?? input.overrides ?? input.profileOverride;
    const override = normalizeBindingOverride(rawOverride, profile);
    const isDefault = Boolean(input.isDefault);
    const existingRows = await this.db.select().from(agentProfileBindings).where(and(
      eq(agentProfileBindings.scopeType, scopeType),
      eq(agentProfileBindings.scopeId, scopeId),
      eq(agentProfileBindings.profileId, profileId),
    ));
    const existing = existingRows[0];
    if (existing) {
      if (existing.role !== role) throw new Error('Agent profile binding role is immutable.');
      return this.updateAgentProfileBinding(existing.id, { override, isDefault });
    }
    if (isDefault) {
      await this.db.update(agentProfileBindings).set({ isDefault: false, updatedAt: new Date().toISOString() })
        .where(and(eq(agentProfileBindings.scopeType, scopeType), eq(agentProfileBindings.scopeId, scopeId), eq(agentProfileBindings.role, role)));
    }
    const now = new Date().toISOString();
    await this.db.insert(agentProfileBindings).values({
      id: nonEmpty(input.id) ?? crypto.randomUUID(),
      scopeType,
      scopeId,
      role,
      profileId,
      override: override ?? null,
      isDefault,
      createdAt: now,
      updatedAt: now,
    });
    const createdRows = await this.db.select().from(agentProfileBindings).where(and(
      eq(agentProfileBindings.scopeType, scopeType),
      eq(agentProfileBindings.scopeId, scopeId),
      eq(agentProfileBindings.profileId, profileId),
    ));
    const created = createdRows[0];
    if (!created) throw new Error(`Failed to retrieve newly created agent profile binding for "${profileId}"`);
    return bindingRecordFromRow(created);
  }

  /** Update a binding while keeping its role and target profile role aligned. */
  async updateAgentProfileBinding(id: string, updates: UpdateAgentProfileBindingInput): Promise<AgentProfileBindingRecord> {
    const existing = await this.getAgentProfileBinding(id);
    if (!existing) throw new Error(`Agent profile binding "${id}" was not found.`);
    const scopeType = updates.scopeType === undefined ? existing.scopeType : canonicalScope(updates.scopeType);
    const scopeId = updates.scopeId === undefined ? existing.scopeId : nonEmpty(updates.scopeId);
    if (!scopeId) throw new Error('Agent profile binding scopeId must be non-empty.');
    if (updates.role !== undefined && canonicalRole(updates.role, 'Agent profile binding role') !== existing.role) {
      throw new Error(`Agent profile binding role '${updates.role}' cannot change from fixed role '${existing.role}'.`);
    }
    const profileId = nonEmpty(updates.profileId ?? updates.agentProfileId) ?? existing.profileId;
    const profile = await this.getAgentProfile(profileId, { includeArchived: true });
    if (!profile) throw new Error(`Agent profile "${profileId}" was not found.`);
    if (profile.archivedAt !== null) throw new Error(`Agent profile "${profileId}" is archived and cannot be bound.`);
    if (profile.role !== existing.role) {
      throw new Error(`Agent profile "${profileId}" has fixed role '${profile.role}', not '${existing.role}'.`);
    }
    const overrideProvided = Object.prototype.hasOwnProperty.call(updates, 'override')
      || Object.prototype.hasOwnProperty.call(updates, 'overrides')
      || Object.prototype.hasOwnProperty.call(updates, 'profileOverride');
    const rawOverride = updates.override ?? updates.overrides ?? updates.profileOverride;
    const override = overrideProvided
      ? normalizeBindingOverride(rawOverride, profile)
      : existing.override;
    const isDefault = updates.isDefault === undefined ? existing.isDefault : Boolean(updates.isDefault);
    if (isDefault) {
      await this.db.update(agentProfileBindings).set({ isDefault: false, updatedAt: new Date().toISOString() })
        .where(and(eq(agentProfileBindings.scopeType, scopeType), eq(agentProfileBindings.scopeId, scopeId), eq(agentProfileBindings.role, existing.role)));
    }
    const updatedAt = new Date().toISOString();
    await this.db.update(agentProfileBindings).set({
      scopeType,
      scopeId,
      profileId,
      override: override ?? null,
      isDefault,
      updatedAt,
    }).where(eq(agentProfileBindings.id, existing.id));
    const updated = await this.getAgentProfileBinding(existing.id);
    if (!updated) throw new Error(`Failed to retrieve updated agent profile binding "${existing.id}"`);
    return updated;
  }

  /** Remove a scope binding; global catalog records are left untouched. */
  async unbindAgentProfile(
    binding: string | UnbindAgentProfileInput,
    scopeId?: string,
    role?: AgentRole,
  ): Promise<boolean> {
    if (typeof binding === 'string') {
      if (scopeId === undefined) {
        const existing = await this.getAgentProfileBinding(binding);
        if (!existing) return false;
        await this.db.delete(agentProfileBindings).where(eq(agentProfileBindings.id, existing.id));
        return true;
      }
      const scopeType = canonicalScope(binding);
      const canonicalScopeId = nonEmpty(scopeId);
      const canonicalBindingRole = canonicalRole(role, 'Agent profile binding role');
      if (!canonicalScopeId) return false;
      const rows = await this.db.select({ id: agentProfileBindings.id }).from(agentProfileBindings).where(and(
        eq(agentProfileBindings.scopeType, scopeType),
        eq(agentProfileBindings.scopeId, canonicalScopeId),
        eq(agentProfileBindings.role, canonicalBindingRole),
      ));
      if (!rows.length) return false;
      await this.db.delete(agentProfileBindings).where(and(
        eq(agentProfileBindings.scopeType, scopeType),
        eq(agentProfileBindings.scopeId, canonicalScopeId),
        eq(agentProfileBindings.role, canonicalBindingRole),
      ));
      return true;
    }
    const scopeType = canonicalScope(binding.scopeType);
    const bindingScopeId = nonEmpty(binding.scopeId);
    const profileId = nonEmpty(binding.profileId) ?? nonEmpty(binding.agentProfileId);
    const bindingRole = binding.role === undefined ? undefined : canonicalRole(binding.role, 'Agent profile binding role');
    if (!bindingScopeId || (!profileId && !bindingRole)) return false;
    const predicates = [
      eq(agentProfileBindings.scopeType, scopeType),
      eq(agentProfileBindings.scopeId, bindingScopeId),
      ...(profileId ? [eq(agentProfileBindings.profileId, profileId)] : []),
      ...(bindingRole ? [eq(agentProfileBindings.role, bindingRole)] : []),
    ];
    const rows = await this.db.select({ id: agentProfileBindings.id }).from(agentProfileBindings).where(and(...predicates));
    if (!rows[0]) return false;
    await this.db.delete(agentProfileBindings).where(and(...predicates));
    return true;
  }

  /**
   * Resolve a durable profile for a mission or explicit workspace/team scope.
   * A requested profile never falls through to another identity; malformed,
   * missing, wrong-role, or archived requests fail closed.
   */
  async resolveAgentProfileForMission(input: ResolveAgentProfileInput): Promise<AgentProfileResolution>;
  async resolveAgentProfileForMission(missionId: string, role: AgentRole, profileId?: string): Promise<AgentProfileResolution>;
  async resolveAgentProfileForMission(missionId: string, role: AgentRole, taskId: string | undefined, profileId: string): Promise<AgentProfileResolution>;
  async resolveAgentProfileForMission(
    inputOrMissionId: ResolveAgentProfileInput | string,
    role?: AgentRole,
    taskId?: string,
    profileId?: string,
  ): Promise<AgentProfileResolution> {
    // The public/API three-argument form uses its third value as profileId;
    // the four-argument compatibility form reserves it for legacy taskId.
    const requestedProfileId = profileId === undefined ? taskId : profileId;
    return this.resolveAgentProfile(inputOrMissionId as any, role as any, undefined, requestedProfileId);
  }

  /**
   * RuntimeHost's optional resolver calls this positional form. The object form
   * is the typed API used by API/desktop integrations.
   */
  async resolveAgentProfile(input: ResolveAgentProfileInput): Promise<AgentProfileResolution>;
  async resolveAgentProfile(missionId: string, role: AgentRole, taskId?: string, profileId?: string): Promise<AgentProfileResolution>;
  async resolveAgentProfile(
    inputOrMissionId: ResolveAgentProfileInput | string,
    roleOrOptions?: AgentRole,
    _taskId?: string,
    positionalProfileId?: string,
  ): Promise<AgentProfileResolution> {
    const input: ResolveAgentProfileInput = typeof inputOrMissionId === 'string'
      ? {
          missionId: inputOrMissionId,
          role: roleOrOptions as AgentRole,
          profileId: positionalProfileId,
        }
      : inputOrMissionId;
    const role = canonicalRole(input.role, 'Agent profile resolution role');
    const mission = input.missionId ? await this.getMission(input.missionId) : null;
    const workspaceId = nonEmpty(input.workspaceId ?? mission?.workspaceId);
    const teamTemplateId = nonEmpty(input.teamTemplateId ?? mission?.teamTemplateId);
    const requestedProfileId = nonEmpty(input.explicitProfileId)
      ?? nonEmpty(input.profileId)
      ?? nonEmpty(input.agentProfileId)
      ?? nonEmpty(input.requestedProfileId);

    if (input.explicitProfile) {
      const explicit = normalizeAgentProfile(input.explicitProfile, role);
      if (explicit.role !== role) throw new Error(`Explicit agent profile role '${explicit.role}' does not match '${role}'.`);
      if (requestedProfileId && explicit.id !== requestedProfileId) {
        throw new Error(`Explicit agent profile identity does not match requested profile '${requestedProfileId}'.`);
      }
      return { profile: explicit, source: 'explicit' };
    }

    const resolveBinding = async (scopeType: AgentProfileScopeType, scopeId: string | undefined, requestedId?: string): Promise<AgentProfileResolution | undefined> => {
      if (!scopeId) return undefined;
      const bindings = await this.listAgentProfileBindings({ scopeType, scopeId, role, includeArchivedProfiles: true });
      const binding = bindings.find((candidate) => candidate.isDefault);
      if (!binding || (requestedId && binding.profileId !== requestedId)) return undefined;
      const bound = await this.getAgentProfile(binding.profileId, { includeArchived: true });
      if (!bound) throw new Error(`Agent profile binding '${binding.id}' references a missing profile.`);
      if (bound.archivedAt !== null) throw new Error(`Agent profile binding '${binding.id}' references an archived profile.`);
      if (bound.role !== role || binding.role !== role) {
        throw new Error(`Agent profile binding '${binding.id}' failed fixed-role validation.`);
      }
      const merged = mergeAgentProfiles(bound, binding.override as AgentProfilePatch | undefined);
      return {
        profile: merged,
        source: requestedId ? 'explicit' : scopeType === 'workspace' ? 'workspace' : scopeType === 'team_template' ? 'team_template' : 'default',
      };
    };

    if (requestedProfileId) {
      const requested = await this.getAgentProfile(requestedProfileId, { includeArchived: true });
      // Legacy role IDs remain safe baseline identities in pre-catalog data.
      if (!requested && requestedProfileId === role) return { profile: defaultAgentProfile(role), source: 'default' };
      if (!requested) throw new Error(`Agent profile '${requestedProfileId}' was not found for fixed role '${role}'.`);
      if (requested.archivedAt !== null) throw new Error(`Agent profile '${requestedProfileId}' is archived and cannot be resolved.`);
      if (requested.role !== role) {
        throw new Error(`Agent profile '${requestedProfileId}' is assigned to fixed role '${requested.role}', not '${role}'.`);
      }
      const refined = await resolveBinding('workspace', workspaceId, requestedProfileId)
        ?? await resolveBinding('team_template', teamTemplateId, requestedProfileId)
        ?? await resolveBinding('global', 'global', requestedProfileId);
      return refined ?? { profile: requested, source: 'explicit' };
    }

    const workspaceResolution = await resolveBinding('workspace', workspaceId);
    if (workspaceResolution) return workspaceResolution;
    const templateResolution = await resolveBinding('team_template', teamTemplateId);
    if (templateResolution) return templateResolution;
    const globalBindingResolution = await resolveBinding('global', 'global');
    if (globalBindingResolution) return globalBindingResolution;

    const globalDefaults = (await this.listAgentProfiles({ role })).filter((profile) => profile.isDefault);
    const globalDefault = globalDefaults[0];
    if (globalDefault) return { profile: globalDefault, source: 'default' };
    return { profile: defaultAgentProfile(role), source: 'default' };
  }

  // Short aliases make the catalog API discoverable without creating a second
  // persistence path. They intentionally retain the same validation rules.
  createProfile(input: CreateAgentProfileInput): Promise<AgentProfileRecord> { return this.createAgentProfile(input); }
  getProfile(id: string, options?: { includeArchived?: boolean } | boolean): Promise<AgentProfileRecord | null> { return this.getAgentProfile(id, options); }
  listProfiles(options?: ListAgentProfilesOptions): Promise<AgentProfileRecord[]> { return this.listAgentProfiles(options); }
  updateProfile(id: string, updates: UpdateAgentProfileInput): Promise<AgentProfileRecord> { return this.updateAgentProfile(id, updates); }
  archiveProfile(id: string): Promise<AgentProfileRecord> { return this.archiveAgentProfile(id); }
  bindProfile(input: CreateAgentProfileBindingInput): Promise<AgentProfileBindingRecord> { return this.bindAgentProfile(input); }
  listProfileBindings(options?: ListAgentProfileBindingsOptions): Promise<AgentProfileBindingRecord[]> { return this.listAgentProfileBindings(options); }
  unbindProfile(binding: string | Pick<CreateAgentProfileBindingInput, 'scopeType' | 'scopeId' | 'profileId' | 'agentProfileId'>): Promise<boolean> { return this.unbindAgentProfile(binding); }

  /**
   * Create a mission record only. Runtime lifecycle events are emitted by the
   * Orchestrator when execution actually transitions into Running; persistence
   * must not impersonate that transition or every mission gets two starts.
   */
  async createMission(input: CreateMissionInput): Promise<MissionSelect> {
    const now = new Date().toISOString();
    const newMission: MissionInsert = {
      id: input.id ?? crypto.randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'draft',
      teamTemplateId: input.teamTemplateId ?? '',
      planId: input.planId ?? null,
      executionMode: input.executionMode ?? 'balanced',
      automationPolicy: input.automationPolicy,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(missions).values(newMission);
    const result = await this.getMission(newMission.id);
    if (!result) throw new Error(`Failed to retrieve newly created mission "${newMission.id}"`);
    return result;
  }

  /** Get mission by ID. */
  async getMission(id: string): Promise<MissionSelect | null> {
    const rows = await this.db.select().from(missions).where(eq(missions.id, id));
    return rows[0] ?? null;
  }

  /** Update mission fields by ID. */
  async updateMission(id: string, updates: Partial<MissionInsert>): Promise<MissionSelect> {
    const now = new Date().toISOString();
    await this.db.update(missions).set({ ...updates, updatedAt: now }).where(eq(missions.id, id));
    const updated = await this.getMission(id);
    if (!updated) throw new Error(`Failed to retrieve updated mission "${id}"`);
    return updated;
  }

  /** List missions, optionally filtered by workspaceId. */
  async listMissions(workspaceId?: string): Promise<MissionSelect[]> {
    if (workspaceId) return await this.db.select().from(missions).where(eq(missions.workspaceId, workspaceId));
    return await this.db.select().from(missions);
  }

  async resolveMissionWorkerPoolPolicy(missionId: string): Promise<EffectiveWorkerPoolPolicy> {
    const mission = await this.getMission(missionId);
    if (!mission?.teamTemplateId) return resolveWorkerPoolPolicy();
    const template = (await this.db.select().from(teamTemplates).where(eq(teamTemplates.id, mission.teamTemplateId)))[0];
    return resolveWorkerPoolPolicy(template ? {
      maxParallelAgents: template.maxParallelAgents ?? undefined,
      workerPools: template.workerPools ?? undefined,
    } : undefined);
  }

  async reserveAgentCapacity(input: ReserveAgentCapacityInput): Promise<void> {
    this.db.transaction((tx) => {
      const mission = (tx.select().from(missions).where(eq(missions.id, input.missionId)) as any).get() as MissionSelect | undefined;
      if (!mission) throw new Error(`Mission ${input.missionId} was not found.`);
      const template = mission.teamTemplateId
        ? (tx.select().from(teamTemplates).where(eq(teamTemplates.id, mission.teamTemplateId)) as any).get() as typeof teamTemplates.$inferSelect | undefined
        : undefined;
      const policy = resolveWorkerPoolPolicy(template ? {
        maxParallelAgents: template.maxParallelAgents ?? undefined,
        workerPools: template.workerPools ?? undefined,
      } : undefined);
      const rolePool = policy.pools.find((pool) => pool.role === input.role);
      if (!rolePool) throw new Error(`Agent role ${input.role} is not supported by the effective worker pool.`);
      const roleLimit = Math.min(rolePool.maxInstances, rolePool.maxParallel ?? rolePool.maxInstances);

      const activeQuery = tx.select({ role: agentInstances.role }).from(agentInstances)
        .where(and(eq(agentInstances.missionId, input.missionId), inArray(agentInstances.status, ['idle', 'running', 'waiting'])));
      const active = (activeQuery as any).all() as Array<{ role: AgentRole }>;
      if (active.length >= policy.maxParallelAgents) {
        throw new Error(`Mission parallel-agent limit reached (${policy.maxParallelAgents}). Wait for an active agent to complete before spawning another.`);
      }
      if (active.filter((agent) => agent.role === input.role).length >= roleLimit) {
        throw new Error(`Mission ${input.role} parallel-agent limit reached (${roleLimit}). Wait for an active ${input.role} agent to complete before spawning another.`);
      }

      const agentRecord: typeof agentInstances.$inferInsert = {
        id: input.id,
        missionId: input.missionId,
        role: input.role,
        modelProfileId: input.modelProfileId || '',
        accountProfileId: '',
        runtimeAdapterId: '',
        status: 'idle',
        parentAgentId: input.parentAgentId || null,
        displayName: input.displayName,
        specialty: input.specialty || null,
        spawnReason: input.spawnReason,
        workspaceMode: input.workspaceMode,
        createdAt: input.createdAt,
      };
      // Keep compatibility with pre-profile standalone databases while using
      // the durable profile_id column whenever a profile was selected.
      if (input.agentProfileId !== undefined) {
        agentRecord.profileId = input.agentProfileId || null;
        agentRecord.agentProfileId = input.agentProfileId || null;
      }
      try {
        tx.insert(agentInstances).values(agentRecord).run();
      } catch (error) {
        if (input.agentProfileId === undefined) throw error;
        const { agentProfileId: _canonical, ...legacyAgentRecord } = agentRecord;
        tx.insert(agentInstances).values(legacyAgentRecord).run();
      }
    });
  }

  async upsertRoleExecutionPolicy(
    scopeType: ExecutionPolicyScope,
    scopeId: string,
    policy: RoleExecutionPolicy,
    source?: RoutingPreferenceSource,
  ): Promise<void> {
    const existing = await this.db.select().from(executionPolicies).where(and(
      eq(executionPolicies.scopeType, scopeType),
      eq(executionPolicies.scopeId, scopeId),
      eq(executionPolicies.role, policy.role),
    ));
    const values = {
      scopeType,
      scopeId,
      role: policy.role,
      modelCatalogId: policy.modelCatalogId ?? null,
      accountProfileId: policy.accountProfileId ?? null,
      reasoningLevel: policy.reasoningLevel ?? null,
      fallbackCatalogIds: policy.fallbackCatalogIds || [],
      selectionMode: policy.selectionMode,
      source: source || (scopeType === 'team_template' ? 'team_template' : scopeType),
      updatedAt: new Date().toISOString(),
    } as const;
    if (existing[0]) {
      await this.db.update(executionPolicies).set(values).where(eq(executionPolicies.id, existing[0].id));
    } else {
      await this.db.insert(executionPolicies).values({ id: crypto.randomUUID(), ...values });
    }
  }

  async deleteRoleExecutionPolicies(scopeType: ExecutionPolicyScope, scopeId: string): Promise<void> {
    await this.db.delete(executionPolicies).where(and(
      eq(executionPolicies.scopeType, scopeType),
      eq(executionPolicies.scopeId, scopeId),
    ));
  }

  async listRoleExecutionPolicies(scopeType: ExecutionPolicyScope, scopeId: string): Promise<RoleExecutionPolicy[]> {
    const rows = await this.db.select().from(executionPolicies).where(and(
      eq(executionPolicies.scopeType, scopeType),
      eq(executionPolicies.scopeId, scopeId),
    ));
    return rows.map((row) => ({
      role: row.role,
      selectionMode: row.selectionMode,
      modelCatalogId: row.modelCatalogId || undefined,
      accountProfileId: row.accountProfileId || undefined,
      reasoningLevel: row.reasoningLevel || undefined,
      fallbackCatalogIds: row.fallbackCatalogIds || [],
    }));
  }

  /** Resolve route policy with deterministic precedence: mission > workspace > team > scheduler. */
  async resolveRoleExecutionPolicy(missionId: string, role: AgentRole): Promise<EffectiveRoutingPreference | undefined> {
    const mission = await this.getMission(missionId);
    if (!mission) return undefined;

    const scopedCandidates: Array<{ scopeType: ExecutionPolicyScope; scopeId: string; source: RoutingPreferenceSource }> = [
      { scopeType: 'mission', scopeId: mission.id, source: 'mission' },
      { scopeType: 'workspace', scopeId: mission.workspaceId, source: 'workspace' },
    ];
    if (mission.teamTemplateId) scopedCandidates.push({ scopeType: 'team_template', scopeId: mission.teamTemplateId, source: 'team_template' });

    for (const candidate of scopedCandidates) {
      const rows = await this.db.select().from(executionPolicies).where(and(
        eq(executionPolicies.scopeType, candidate.scopeType),
        eq(executionPolicies.scopeId, candidate.scopeId),
        eq(executionPolicies.role, role),
      ));
      const row = rows[0];
      if (!row) continue;
      return {
        modelCatalogId: row.modelCatalogId || undefined,
        accountProfileId: row.accountProfileId || undefined,
        reasoningLevel: row.reasoningLevel || undefined,
        fallbackCatalogIds: row.fallbackCatalogIds || [],
        selectionMode: row.selectionMode,
        source: candidate.source,
      };
    }

    if (mission.teamTemplateId) {
      const legacyRows = await this.db.select().from(teamRoles).where(and(
        eq(teamRoles.templateId, mission.teamTemplateId),
        eq(teamRoles.role, role),
      ));
      const legacy = legacyRows[0];
      if (legacy && (legacy.modelProfileId || legacy.accountProfileId)) {
        return {
          modelCatalogId: legacy.modelProfileId || undefined,
          accountProfileId: legacy.accountProfileId || undefined,
          fallbackCatalogIds: [],
          selectionMode: 'prefer',
          source: 'team_template',
        };
      }
    }
    return undefined;
  }

  /** Create a new task record under a mission. */
  async createTask(input: CreateTaskInput): Promise<TaskSelect> {
    const now = new Date().toISOString();
    const newTask: TaskInsert = {
      id: input.id ?? crypto.randomUUID(),
      missionId: input.missionId,
      planId: input.planId ?? '',
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'planned',
      priority: input.priority ?? 'medium',
      assignedAgentId: input.assignedAgentId ?? null,
      assignedRole: input.assignedRole ?? null,
      requiredCapabilities: input.requiredCapabilities ?? [],
      dependsOn: input.dependsOn ?? [],
      worktreeId: input.worktreeId ?? null,
      targetDescriptor: input.targetDescriptor ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.agentProfileId !== undefined) newTask.agentProfileId = input.agentProfileId || null;

    await this.db.insert(tasks).values(newTask);
    const result = await this.getTask(newTask.id);
    if (!result) throw new Error(`Failed to retrieve newly created task "${newTask.id}"`);
    return result;
  }

  /** Get task by ID. */
  async getTask(id: string): Promise<TaskSelect | null> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return rows[0] ?? null;
  }

  /** List all tasks for a mission. */
  async listTasks(missionId: string): Promise<Array<TaskSelect & { effectiveRoute?: EffectiveAttemptRoute | null }>> {
    const missionTasks = await this.db.select().from(tasks).where(eq(tasks.missionId, missionId));
    if (!missionTasks.length) return missionTasks;
    const attempts = await this.db.select().from(taskAttempts)
      .where(inArray(taskAttempts.taskId, missionTasks.map((task) => task.id)))
      .orderBy(desc(taskAttempts.attemptNumber));
    const latestByTask = new Map<string, TaskAttemptSelect>();
    for (const attempt of attempts) if (!latestByTask.has(attempt.taskId)) latestByTask.set(attempt.taskId, attempt);
    return missionTasks.map((task) => {
      const attempt = latestByTask.get(task.id);
      if (!attempt?.routeAdapterId || !attempt.routeSource || !attempt.routeSelectionMode) return task;
      return { ...task, effectiveRoute: {
        adapterId: attempt.routeAdapterId,
        provider: attempt.routeProvider,
        accountProfileId: attempt.routeAccountProfileId,
        modelCatalogId: attempt.routeModelCatalogId,
        runtimeModelId: attempt.routeRuntimeModelId,
        reasoningLevel: attempt.routeReasoningLevel,
        source: attempt.routeSource,
        selectionMode: attempt.routeSelectionMode,
        agentProfileId: attempt.agentProfileId,
      } };
    });
  }

  async cancelMissionTasks(missionId: string): Promise<void> {
    const activeStatuses = new Set(['planned', 'ready', 'claimed', 'running', 'review', 'revision_requested', 'blocked']);
    const missionTasks = await this.listTasks(missionId);
    for (const task of missionTasks) {
      if (activeStatuses.has(String(task.status))) {
        await this.updateTask(task.id, { status: 'cancelled' });
      }
    }
  }

  /** Update task fields by ID. */
  async updateTask(id: string, updates: Partial<TaskInsert>): Promise<TaskSelect> {
    const now = new Date().toISOString();
    await this.db.update(tasks).set({ ...updates, updatedAt: now }).where(eq(tasks.id, id));
    const updated = await this.getTask(id);
    if (!updated) throw new Error(`Failed to retrieve updated task "${id}"`);
    return updated;
  }

  async saveSupervisorSessionMetadata(turnId: string, metadata: SupervisorSessionMetadata): Promise<void> {
    const rows = await this.db.select().from(conversationTurns).where(eq(conversationTurns.id, turnId));
    const turn = rows[0];
    if (!turn) return;
    await this.db.update(conversationTurns).set({
      options: { ...(turn.options || {}), supervisorSession: metadata },
    }).where(eq(conversationTurns.id, turnId));
  }

  async getLatestSupervisorSessionMetadata(missionId: string): Promise<SupervisorSessionMetadata | undefined> {
    const rows = await this.db.select().from(conversationTurns)
      .where(eq(conversationTurns.missionId, missionId)).orderBy(desc(conversationTurns.createdAt));
    for (const turn of rows) {
      const metadata = turn.options?.supervisorSession as SupervisorSessionMetadata | undefined;
      if (metadata?.route?.adapterId && metadata.resumeCapability) return metadata;
    }
    return undefined;
  }

  async claimTaskAttempt(input: ClaimTaskAttemptInput): Promise<TaskAttemptSelect> {
    const claimed = this.db.transaction((tx) => {
      const rows = tx.select({ value: max(taskAttempts.attemptNumber) })
        .from(taskAttempts).where(eq(taskAttempts.taskId, input.taskId)).all() as Array<{ value: number | null }>;
      const now = input.now ?? new Date().toISOString();
      const attempt: TaskAttemptInsert = {
        id: input.id ?? crypto.randomUUID(),
        taskId: input.taskId,
        missionId: input.missionId,
        agentInstanceId: input.agentInstanceId,
        attemptNumber: Number(rows[0]?.value || 0) + 1,
        status: 'claimed',
        worktreePath: input.worktreePath ?? null,
        runtimeSessionId: null,
        routeAdapterId: input.route.adapterId,
        routeProvider: input.route.provider ?? null,
        routeAccountProfileId: input.route.accountProfileId ?? null,
        routeModelCatalogId: input.route.modelCatalogId ?? null,
        routeRuntimeModelId: input.route.runtimeModelId ?? null,
        routeReasoningLevel: input.route.reasoningLevel ?? null,
        routeSource: input.route.source,
        routeSelectionMode: input.route.selectionMode,
        providerSessionId: null,
        heartbeatAt: now,
        leaseExpiresAt: input.leaseExpiresAt,
        retryable: false,
        claimedAt: now,
        startedAt: now,
      };
      const agentProfileId = input.agentProfileId ?? input.route.agentProfileId;
      if (agentProfileId !== undefined) attempt.agentProfileId = agentProfileId || null;
      tx.insert(taskAttempts).values(attempt).run();
      const created = tx.select().from(taskAttempts).where(eq(taskAttempts.id, attempt.id)).get();
      if (!created) throw new Error(`Failed to retrieve claimed task attempt "${attempt.id}"`);
      return created;
    }) as TaskAttemptSelect | undefined;
    if (!claimed) throw new Error(`Failed to claim task attempt for task "${input.taskId}"`);
    return claimed;
  }

  async markTaskAttemptRunning(attemptId: string, runtimeSessionId: string, heartbeatAt: string, leaseExpiresAt: string, providerSessionId?: string | null): Promise<boolean> {
    const result = await this.db.update(taskAttempts).set({
      status: 'running', runtimeSessionId, providerSessionId: providerSessionId ?? null, heartbeatAt, leaseExpiresAt,
    }).where(and(eq(taskAttempts.id, attemptId), eq(taskAttempts.status, 'claimed'))).returning({ id: taskAttempts.id });
    return result.length === 1;
  }

  async heartbeatTaskAttempt(attemptId: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean> {
    const result = await this.db.update(taskAttempts).set({ heartbeatAt, leaseExpiresAt })
      .where(and(eq(taskAttempts.id, attemptId), inArray(taskAttempts.status, ['claimed', 'running'])))
      .returning({ id: taskAttempts.id });
    return result.length === 1;
  }

  async finishTaskAttempt(
    attemptId: string,
    status: 'completed' | 'failed' | 'cancelled' | 'expired',
    options: { completedAt?: string; error?: string | null; resultSummary?: string | null; retryable?: boolean } = {},
  ): Promise<boolean> {
    const completedAt = options.completedAt ?? new Date().toISOString();
    const result = await this.db.update(taskAttempts).set({
      status,
      completedAt,
      heartbeatAt: completedAt,
      leaseExpiresAt: completedAt,
      error: options.error,
      resultSummary: options.resultSummary,
      retryable: options.retryable ?? false,
    }).where(and(eq(taskAttempts.id, attemptId), inArray(taskAttempts.status, ['claimed', 'running'])))
      .returning({ id: taskAttempts.id });
    return result.length === 1;
  }

  async expireStaleTaskAttempts(cutoff: string, completedAt = new Date().toISOString()): Promise<TaskAttemptSelect[]> {
    return this.db.update(taskAttempts).set({
      status: 'expired', completedAt, heartbeatAt: completedAt, leaseExpiresAt: completedAt,
      retryable: true, error: 'Runtime session lease expired before completion was confirmed',
    }).where(and(
      inArray(taskAttempts.status, ['claimed', 'running']),
      lte(taskAttempts.leaseExpiresAt, cutoff),
    )).returning();
  }

  async expireOrphanedTaskAttempts(completedAt = new Date().toISOString()): Promise<TaskAttemptSelect[]> {
    return this.db.update(taskAttempts).set({
      status: 'expired', completedAt, heartbeatAt: completedAt, leaseExpiresAt: completedAt,
      retryable: true, error: 'Runtime host restarted before session completion was confirmed',
    }).where(inArray(taskAttempts.status, ['claimed', 'running'])).returning();
  }

  async listTaskAttempts(taskId: string): Promise<TaskAttemptSelect[]> {
    return this.db.select().from(taskAttempts).where(eq(taskAttempts.taskId, taskId));
  }

  async getWorktreeForTask(taskId: string): Promise<WorktreeSelect | null> {
    const rows = await this.db.select().from(worktrees).where(eq(worktrees.taskId, taskId));
    return rows[0] ?? null;
  }

  async resolveAppliedTargetPath(taskId: string): Promise<string | null> {
    const task = await this.getTask(taskId);
    const mission = task ? await this.getMission(task.missionId) : null;
    const workspace = mission ? await this.getWorkspace(mission.workspaceId) : null;
    if (!task || !workspace?.path) return null;

    const worktree = await this.getWorktreeForTask(taskId);
    if (!worktree) return workspace.path;
    if (worktree.isolationKind === 'new-sibling') return worktree.targetPath || null;
    if (worktree.targetPath) return worktree.targetPath;
    if (worktree.isolationKind === 'nested-git') {
      return (await this.worktreeManager.resolveMergeBasePath(worktree.path, '')) || null;
    }
    if (worktree.targetDescriptor?.kind === 'existing_project') {
      const resolved = await this.worktreeManager.resolveBuilderTarget(workspace.path, worktree.targetDescriptor);
      return resolved.path;
    }
    if (worktree.isolationKind === 'workspace-git' || worktree.isolationKind === 'mirror') return workspace.path;

    // Legacy rows predate isolation metadata; prefer live Git ownership before the historical root fallback.
    return this.worktreeManager.resolveMergeBasePath(worktree.path, workspace.path);
  }

  async markNewSiblingApplied(taskId: string, operationKey: string, targetPath: string): Promise<void> {
    const updated = await this.db.update(worktrees).set({
      appliedOperationKey: operationKey,
      targetPath,
      status: 'merged',
    }).where(eq(worktrees.taskId, taskId)).returning({ id: worktrees.id });
    if (updated.length !== 1) throw new Error(`Could not persist new sibling ownership for task "${taskId}".`);
  }

  async preflightTaskTarget(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || task.assignedRole !== 'builder') return;
    const mission = await this.getMission(task.missionId);
    const workspace = mission ? await this.getWorkspace(mission.workspaceId) : null;
    if (!workspace?.path) throw new Error(`Workspace for Builder task "${taskId}" could not be resolved.`);
    await this.worktreeManager.resolveBuilderTarget(workspace.path, task.targetDescriptor, `${task.title}\n${task.description}`);
    if (task.targetDescriptor?.kind !== 'new_sibling_project') return;

    const targetKey = task.targetDescriptor.projectName.toLocaleLowerCase('en-US');
    const duplicates = (await this.listTasks(task.missionId))
      .filter((candidate) => candidate.assignedRole === 'builder'
        && candidate.targetDescriptor?.kind === 'new_sibling_project'
        && candidate.targetDescriptor.projectName.toLocaleLowerCase('en-US') === targetKey
        && !['cancelled', 'rejected', 'superseded'].includes(String(candidate.status)))
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || left.id.localeCompare(right.id));
    if (duplicates[0]?.id !== taskId) {
      throw new Error(`Duplicate Builder target "${task.targetDescriptor.projectName}" is already owned by task ${duplicates[0]?.id}.`);
    }
  }

  /**
   * Create a project-aware isolated worktree for a task.
   * Parent workspaces can contain several repositories; task title/description is
   * used only as a deterministic project hint, never as a shell command.
   */
  async createWorktreeForTask(taskId: string, baseBranch: string = 'HEAD', candidateSuffix?: string): Promise<string> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task with ID "${taskId}" not found`);

    const mission = await this.getMission(task.missionId);
    let workspacePath = process.cwd();
    if (mission?.workspaceId) {
      const workspace = await this.getWorkspace(mission.workspaceId);
      if (workspace?.path) workspacePath = workspace.path;
    }

    const projectHint = `${task.title}\n${task.description}`;
    const isolationBase = await this.worktreeManager.resolveBuilderTarget(workspacePath, task.targetDescriptor, projectHint);
    const projectBasePath = isolationBase.path;
    const branchName = candidateSuffix
      ? `atris/mission-${task.missionId}/task-${taskId}-${candidateSuffix}`
      : `atris/mission-${task.missionId}/task-${taskId}`;
    const worktreeSubDir = candidateSuffix ? `task-${taskId}-${candidateSuffix}` : `task-${taskId}`;
    const worktreeDir = path.join(projectBasePath, '.atris-worktrees', `mission-${task.missionId}`, worktreeSubDir);

    const createdPath = isolationBase.kind === 'new-sibling'
      ? await this.worktreeManager.createEmptyManagedStaging(worktreeDir, isolationBase.canonicalContainer!)
      : await this.worktreeManager.createWorktree(
          projectBasePath,
          branchName,
          worktreeDir,
          baseBranch,
          projectHint,
          isolationBase,
        );

    const now = new Date().toISOString();
    const worktreeRecord: WorktreeInsert = {
      id: crypto.randomUUID(),
      missionId: task.missionId,
      taskId,
      branchName,
      path: createdPath,
      status: 'active',
      isolationKind: isolationBase.kind,
      canonicalContainer: isolationBase.canonicalContainer ?? null,
      targetName: isolationBase.targetName ?? null,
      targetPath: isolationBase.targetPath ?? null,
      appliedOperationKey: null,
      targetDescriptor: task.targetDescriptor ?? null,
      createdAt: now,
    };

    try {
      await this.db.insert(worktrees).values(worktreeRecord);
    } catch {
      // A resumed/revision attempt may already have a persisted worktree row.
    }

    await this.updateTask(taskId, { worktreeId: createdPath });
    return createdPath;
  }

  /** Remove worktree for task. */
  async removeWorktreeForTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task || !task.worktreeId) return;

    await this.worktreeManager.removeWorktree(task.worktreeId);
    await this.updateTask(taskId, { worktreeId: null });
    await this.db.update(worktrees).set({ status: 'abandoned' }).where(eq(worktrees.taskId, taskId));
  }

  async removeMissionWorktrees(missionId: string): Promise<void> {
    const records = await this.db.select().from(worktrees).where(eq(worktrees.missionId, missionId));
    const missionTasks = await this.listTasks(missionId);
    const paths = new Set([
      ...records.map((record) => record.path),
      ...missionTasks.map((task) => task.worktreeId).filter((value): value is string => Boolean(value)),
    ]);
    for (const worktreePath of paths) await this.worktreeManager.removeWorktree(worktreePath);
    for (const task of missionTasks.filter((item) => item.worktreeId)) await this.updateTask(task.id, { worktreeId: null });
    await this.db.update(worktrees).set({ status: 'abandoned' }).where(eq(worktrees.missionId, missionId));
  }

  removeWorkspaceCheckpoints(workspacePath: string): void {
    this.checkpointManager.removeWorkspaceCheckpoints(workspacePath);
  }
}
