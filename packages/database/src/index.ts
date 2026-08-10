import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import * as coreSchema from './schema';
import * as executionPolicySchema from './execution-policy-schema';

export * from './schema';
export * from './execution-policy-schema';

type DatabaseSchema = typeof coreSchema & typeof executionPolicySchema;

export type AtrisDatabase = BaseSQLiteDatabase<'sync' | 'async', any, DatabaseSchema>;
