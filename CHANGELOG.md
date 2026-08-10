# Changelog

## 0.2.0 — Developer Preview

### Added

- Real local API Gateway with SQLite persistence, SSE and WebSocket events
- Account profile lifecycle and runtime status screens
- Live account-scoped model catalog and reasoning selection
- Codex CLI, Claude Code, Antigravity CLI and OpenCode adapters
- Global Inbox and nested workspace missions
- Mission timeline, Kanban, Agents, Changes, Checks and Artifacts views
- Direct `@agent` and `/command` composer routing
- Worktree isolation, non-Git managed mirrors, review packs and checkpoints
- Runtime permission approval routing
- Developer Mode console and persisted event restoration
- Product audit, architecture, runtime and release documentation

### Changed

- Adopted the Apache License 2.0 and added public contribution/security guidance
- Separated reusable public landing/release source from private production operations
- Removed demo/random usage values and fake mission timers
- Orchestrator apply flow now uses persisted approvals and deterministic merge
- Reviewer revisions return to the same Builder task and reuse the existing worktree
- OpenCode sessions run in the actual workspace/worktree cwd
- Reviewer and QA tasks resolve their upstream Builder worktree instead of reading the untouched main workspace
- Candidate mode creates a local comparison pack, pauses before QA, and applies only the manually selected Builder result
- Codex reasoning options are no longer invented when the live runtime does not report them
- Antigravity routes are limited to Builder/QA until a verified read-only runtime mode exists
- Git commands use argument-safe process execution and validate target branch/dirty state
- Runtime sessions are removed from the host registry on terminal task events
- Role-based tool policy now defaults to least privilege

### Known release blockers

- Live Windows contract tests for all supported CLI versions/accounts
- Signed MSI/NSIS installers, updater signing and physical clean-install/upgrade tests
- Real AtrisHub production-session and exact-release acceptance
