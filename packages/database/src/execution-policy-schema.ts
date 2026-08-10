import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  AgentRole,
  CanonicalReasoning,
  RouteSelectionMode,
  RoutingPreferenceSource,
} from '@atris-agent-code/domain';

export type ExecutionPolicyScope = 'team_template' | 'workspace' | 'mission';

/**
 * Scoped routing rules are deliberately separate from team_roles. This keeps
 * role permissions/access concerns independent from model/runtime selection and
 * gives us one persistence primitive for template, workspace and mission
 * overrides.
 */
export const executionPolicies = sqliteTable('execution_policies', {
  id: text('id').primaryKey(),
  scopeType: text('scope_type').$type<ExecutionPolicyScope>().notNull(),
  scopeId: text('scope_id').notNull(),
  role: text('role').$type<AgentRole>().notNull(),
  modelCatalogId: text('model_catalog_id'),
  accountProfileId: text('account_profile_id'),
  reasoningLevel: text('reasoning_level').$type<CanonicalReasoning>(),
  fallbackCatalogIds: text('fallback_catalog_ids', { mode: 'json' }).$type<string[]>().notNull(),
  selectionMode: text('selection_mode').$type<RouteSelectionMode>().notNull().default('auto'),
  source: text('source').$type<RoutingPreferenceSource>().notNull().default('team_template'),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  scopeRoleUnique: uniqueIndex('idx_execution_policies_scope_role').on(table.scopeType, table.scopeId, table.role),
}));

export type ExecutionPolicySelect = typeof executionPolicies.$inferSelect;
export type ExecutionPolicyInsert = typeof executionPolicies.$inferInsert;
