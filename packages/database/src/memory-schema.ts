import { integer, real, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import type {
  MemoryEdgeType,
  MemoryNodeStatus,
  MemoryNodeType,
  MemoryProvenance,
  MemorySourceType,
  ProjectIdentityStatus,
} from '@atris-agent-code/domain';

/**
 * Stable project identity intentionally lives outside the workspace FK tree.
 * Removing a local workspace must never delete accumulated project memory.
 */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  normalizedPath: text('normalized_path'),
  repositoryFingerprint: text('repository_fingerprint'),
  status: text('status').$type<ProjectIdentityStatus>().notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  detachedAt: text('detached_at'),
}, (table) => ({
  fingerprintIdx: uniqueIndex('idx_projects_repository_fingerprint').on(table.repositoryFingerprint),
  pathIdx: index('idx_projects_normalized_path').on(table.normalizedPath),
  statusIdx: index('idx_projects_status').on(table.status),
}));

/**
 * Attachment history is not FK-cascaded from workspaces. A deleted workspace is
 * merely a detached local view of a project whose memory remains durable.
 */
export const projectWorkspaceLinks = sqliteTable('project_workspace_links', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull(),
  workspacePath: text('workspace_path').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  attachedAt: text('attached_at').notNull(),
  detachedAt: text('detached_at'),
}, (table) => ({
  workspaceIdx: index('idx_project_workspace_links_workspace').on(table.workspaceId),
  projectIdx: index('idx_project_workspace_links_project').on(table.projectId),
  projectWorkspaceIdx: uniqueIndex('idx_project_workspace_links_unique').on(table.projectId, table.workspaceId),
}));

export const projectMemorySpaces = sqliteTable('project_memory_spaces', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').$type<'active' | 'archived'>().notNull().default('active'),
  nodeCount: integer('node_count').notNull().default(0),
  edgeCount: integer('edge_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  projectIdx: uniqueIndex('idx_project_memory_spaces_project').on(table.projectId),
}));

export const memoryNodes = sqliteTable('memory_nodes', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  type: text('type').$type<MemoryNodeType>().notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  body: text('body'),
  status: text('status').$type<MemoryNodeStatus>().notNull().default('active'),
  confidence: real('confidence').notNull().default(0.7),
  importance: real('importance').notNull().default(0.5),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  provenance: text('provenance', { mode: 'json' }).$type<MemoryProvenance[]>().notNull().default([]),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastVerifiedAt: text('last_verified_at'),
}, (table) => ({
  projectIdx: index('idx_memory_nodes_project').on(table.projectId),
  typeIdx: index('idx_memory_nodes_project_type').on(table.projectId, table.type),
  statusIdx: index('idx_memory_nodes_project_status').on(table.projectId, table.status),
}));

export const memoryEdges = sqliteTable('memory_edges', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  fromNodeId: text('from_node_id')
    .notNull()
    .references(() => memoryNodes.id, { onDelete: 'cascade' }),
  toNodeId: text('to_node_id')
    .notNull()
    .references(() => memoryNodes.id, { onDelete: 'cascade' }),
  type: text('type').$type<MemoryEdgeType>().notNull(),
  confidence: real('confidence').notNull().default(0.7),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').$type<MemoryProvenance['createdBy']>().notNull(),
}, (table) => ({
  projectIdx: index('idx_memory_edges_project').on(table.projectId),
  fromIdx: index('idx_memory_edges_from').on(table.projectId, table.fromNodeId),
  toIdx: index('idx_memory_edges_to').on(table.projectId, table.toNodeId),
  uniqueEdgeIdx: uniqueIndex('idx_memory_edges_unique').on(table.projectId, table.fromNodeId, table.toNodeId, table.type),
}));

/**
 * Immutable salient-event ledger. `sourceId` is normally the canonical event id,
 * making ingestion idempotent even when the local event stream is replayed.
 */
export const memoryEvidence = sqliteTable('memory_evidence', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').$type<MemorySourceType>().notNull(),
  sourceId: text('source_id'),
  missionId: text('mission_id'),
  taskId: text('task_id'),
  agentInstanceId: text('agent_instance_id'),
  eventType: text('event_type').notNull(),
  content: text('content').notNull().default(''),
  contentHash: text('content_hash').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
  curatedAt: text('curated_at'),
}, (table) => ({
  projectIdx: index('idx_memory_evidence_project_created').on(table.projectId, table.createdAt),
  missionIdx: index('idx_memory_evidence_mission').on(table.missionId),
  sourceIdx: uniqueIndex('idx_memory_evidence_project_source').on(table.projectId, table.sourceId),
}));

export type ProjectSelect = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type ProjectWorkspaceLinkSelect = typeof projectWorkspaceLinks.$inferSelect;
export type ProjectWorkspaceLinkInsert = typeof projectWorkspaceLinks.$inferInsert;
export type ProjectMemorySpaceSelect = typeof projectMemorySpaces.$inferSelect;
export type ProjectMemorySpaceInsert = typeof projectMemorySpaces.$inferInsert;
export type MemoryNodeSelect = typeof memoryNodes.$inferSelect;
export type MemoryNodeInsert = typeof memoryNodes.$inferInsert;
export type MemoryEdgeSelect = typeof memoryEdges.$inferSelect;
export type MemoryEdgeInsert = typeof memoryEdges.$inferInsert;
export type MemoryEvidenceSelect = typeof memoryEvidence.$inferSelect;
export type MemoryEvidenceInsert = typeof memoryEvidence.$inferInsert;
