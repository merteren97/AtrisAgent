import type {
  WorkerRequest,
  AgentRole,
  TeamRole,
  AccountProfile,
  ModelDescriptor,
  CanonicalReasoning,
  RouteSelectionMode,
} from '@atris-agent-code/domain';
import { missingRuntimeCapabilities, normalizeRuntimeCapability } from '@atris-agent-code/policy-engine';

export interface SchedulerConfig {
  availableAdapters: string[];
}

export interface ResolvedRuntimeRoute {
  adapterId: string;
  profile?: AccountProfile;
  model?: ModelDescriptor;
  reasoningLevel?: CanonicalReasoning;
  score: number;
  reasons: string[];
}

export class Scheduler {
  private teamRoles: TeamRole[] = [];
  constructor(private config: SchedulerConfig) {}

  setTeamRoles(roles: TeamRole[]): void { this.teamRoles = roles; }

  resolveRoute(request: WorkerRequest, profiles: AccountProfile[], models: ModelDescriptor[]): ResolvedRuntimeRoute {
    const roleName = request.role.toLowerCase();
    const routes: ResolvedRuntimeRoute[] = [];
    const selectionMode: RouteSelectionMode = request.routeSelectionMode
      || (request.preferredCatalogId ? 'fixed' : 'auto');
    const useConfiguredPreferences = selectionMode !== 'auto';
    const fallbackOrder = new Map(
      (useConfiguredPreferences ? request.fallbackCatalogIds || [] : [])
        .map((catalogId, index) => [catalogId, index]),
    );
    const constrainedCatalogs = new Set([
      ...(useConfiguredPreferences && request.preferredCatalogId ? [request.preferredCatalogId] : []),
      ...fallbackOrder.keys(),
    ]);

    for (const profile of profiles) {
      if (!this.config.availableAdapters.includes(profile.runtimeType)) continue;
      // schedulerAuto=false removes a profile from normal automatic routing.
      // Explicit Prefer/Fixed policies may still intentionally target it.
      if (selectionMode === 'auto' && profile.schedulerAuto === false) continue;
      const allowed = (profile.allowedRoles || []).map((role) => role.toLowerCase());
      if (allowed.length && !allowed.includes(roleName)) continue;
      const runtimeRequirements = this.runtimeRequirements(request);
      const missingCapabilities = missingRuntimeCapabilities(runtimeRequirements, profile.capabilitySnapshot);
      if (missingCapabilities.length > 0) continue;

      const accountMatches = !request.preferredAccountProfileId || request.preferredAccountProfileId === profile.id;

      for (const model of models.filter((item) => item.accountProfileId === profile.id)) {
        if (!model.supportedRoles.includes(request.role)) continue;
        if (model.availability === 'unavailable' || model.availability === 'deprecated' || model.availability === 'rate_limited') continue;

        const preferredModel = Boolean(useConfiguredPreferences && request.preferredCatalogId && request.preferredCatalogId === model.catalogId);
        const fallbackIndex = fallbackOrder.get(model.catalogId);
        const isFallback = fallbackIndex !== undefined;
        if (selectionMode === 'fixed' && constrainedCatalogs.size > 0 && !preferredModel && !isFallback) continue;
        // An account-only Fixed policy stays on that account. Once explicit model
        // fallbacks exist, those exact catalog routes are allowed to cross account
        // and runtime boundaries without broadening to unlisted routes.
        if (
          selectionMode === 'fixed'
          && request.preferredAccountProfileId
          && !accountMatches
          && !isFallback
        ) continue;

        let score = 50;
        const reasons: string[] = [];
        if (request.routingSource) reasons.push(`${request.routingSource.replaceAll('_', ' ')} routing policy`);

        if (useConfiguredPreferences && request.preferredAccountProfileId) {
          if (accountMatches) {
            score += 120;
            reasons.push('preferred account profile');
          } else if (isFallback) {
            reasons.push('explicit fallback outside preferred account profile');
          } else if (selectionMode === 'prefer') {
            score -= 30;
            reasons.push('scheduler fallback outside preferred account profile');
          }
        }

        if (useConfiguredPreferences && request.preferredCatalogId) {
          if (preferredModel) {
            score += 400;
            reasons.push('preferred model route');
          } else if (isFallback) {
            score += 300 - Math.min(fallbackIndex, 20) * 10;
            reasons.push(`ordered fallback route #${fallbackIndex + 1}`);
          } else if (selectionMode === 'prefer') {
            score -= 40;
            reasons.push('scheduler fallback after configured routes');
          }
        } else if (useConfiguredPreferences && isFallback) {
          score += 200 - Math.min(fallbackIndex, 20) * 10;
          reasons.push(`ordered fallback route #${fallbackIndex + 1}`);
        }

        if (model.availability === 'available') { score += 20; reasons.push('live catalog route'); }
        else { score -= 10; reasons.push('availability must be verified at run time'); }
        if (model.isDefault) { score += 5; reasons.push('runtime default'); }
        if (profile.schedulerAuto !== false) score += 10;

        const required = this.runtimeRequirements(request);
        const matched = required.filter((capability) => profile.capabilitySnapshot?.[capability] === true).length;
        score += matched * 3;
        if (matched) reasons.push(`${matched}/${required.length} requested capabilities matched`);
        if (request.role === 'orchestrator') score += model.supportedReasoning.includes('high') ? 15 : 0;
        if (request.role === 'builder' && ['codex', 'claude_code', 'opencode'].includes(profile.runtimeType)) score += 8;
        if (request.role === 'researcher' && model.inputModalities.includes('image')) score += 3;

        const requestedReasoning = useConfiguredPreferences ? request.preferredReasoning : undefined;
        const reasoningLevel = requestedReasoning && model.supportedReasoning.includes(requestedReasoning)
          ? requestedReasoning
          : this.bestReasoning(model.supportedReasoning, request.role);
        if (requestedReasoning && requestedReasoning !== reasoningLevel) {
          reasons.push(`requested reasoning '${requestedReasoning}' is unsupported; runtime-compatible fallback selected`);
        } else if (requestedReasoning) {
          reasons.push(`reasoning '${requestedReasoning}' selected`);
        }

        routes.push({ adapterId: profile.runtimeType, profile, model, reasoningLevel, score, reasons });
      }
    }

    routes.sort((a, b) => b.score - a.score || String(a.model?.displayName).localeCompare(String(b.model?.displayName)));
    const selected = routes[0];
    if (!selected) {
      const hasFixedConstraint = selectionMode === 'fixed' && Boolean(request.preferredAccountProfileId || constrainedCatalogs.size);
      if (hasFixedConstraint) {
        throw new Error(
          `The fixed '${request.role}' execution policy has no runnable configured route. Verify the account and preferred/fallback models or change the role policy to Prefer/Auto.`,
        );
      }
      throw new Error(`No connected account/model route can fulfill the '${request.role}' role. Connect a runtime and refresh its model catalog.`);
    }
    return selected;
  }

  resolveAdapter(request: WorkerRequest): string {
    const templateRole = this.teamRoles.find((role) => role.role === request.role);
    void templateRole;
    const fallback = this.config.availableAdapters.includes('codex') ? 'codex' : this.config.availableAdapters[0];
    if (!fallback) throw new Error('No runtime adapters are registered.');
    return fallback;
  }

  canFulfill(request: WorkerRequest): boolean {
    try {
      // Capability snapshots are available during route resolution, not on this
      // legacy adapter-presence probe. Do not reject semantic task capabilities
      // or claim a runtime capability is missing without a selected profile.
      return Boolean(this.resolveAdapter(request));
    } catch { return false; }
  }

  private runtimeRequirements(request: WorkerRequest): string[] {
    const requirements = request.capabilities
      .map(normalizeRuntimeCapability)
      .filter((capability): capability is string => Boolean(capability));
    if (request.requiresWorktree) requirements.push('worktreeAwareness');
    return [...new Set(requirements)];
  }

  private bestReasoning(levels: CanonicalReasoning[], role: AgentRole): CanonicalReasoning | undefined {
    const preference: CanonicalReasoning[] = role === 'orchestrator' || role === 'reviewer'
      ? ['high', 'xhigh', 'max', 'medium', 'low', 'minimal', 'none']
      : ['medium', 'high', 'low', 'minimal', 'none', 'xhigh', 'max'];
    return preference.find((level) => levels.includes(level));
  }
}
