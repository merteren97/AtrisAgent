# Production Readiness Hardening

This document records the first production-readiness hardening slice for AtrisAgent 0.2.0.

## Quality gate introduced in this slice

Every pull request is expected to pass a clean Node.js 22 install followed by the repository quality gate:

```bash
npm ci
npm run check
```

`npm run check` validates the TypeScript project-reference graph, runs all workspace test suites that expose a `test` script, and builds the desktop frontend.

The desktop package uses project-reference typechecking (`tsc -b`) so its application and Vite/Node configs cannot be skipped by an empty root `files` list. The production build repeats `tsc -b` before `vite build`, making the portable gate fail on both type-safety and bundling regressions.

The test suites are intentionally deterministic: CI does not require Codex CLI, Claude Code, Antigravity CLI, or OpenCode to be installed or authenticated. Live runtime and Windows installer verification belong to the release checklist, not the portable unit/integration gate.

## Hardening covered

- Coordination MCP exposes task-scoped `get_changed_files` using the Atris-managed worktree or mirror rather than accepting an arbitrary filesystem path.
- Existing orchestration and policy security suites are part of the repository-wide quality gate instead of remaining unexecuted source files.
- Runtime adapter tests validate unavailable-runtime fallback contracts and current structured-event normalization without depending on the CI host's local CLI state.
- API tests target the current runtime discovery endpoint and current HTTP creation semantics; stream events are persisted against a real test mission so successful tests do not hide foreign-key errors.
- Gateway request boundaries normalize Express route-parameter unions and sanitize model fallback inputs into deterministic string arrays instead of weakening strict TypeScript checks.
- Workspace checkpoint tests validate the current UUID identity contract.
- TypeScript project references are built in dependency order before desktop validation.
- Route parameter compatibility is handled by executable code rather than declaration-only type shims.
- Event-driven assertions use collection/counter state rather than callback-mutated literal booleans so strict TypeScript control-flow analysis and runtime intent agree.
- Wildcard event subscribers return `void` explicitly rather than leaking collection mutation return values into the event-bus contract.
- The desktop WebView baseline is ES2021, matching language features already used by the UI such as `String.replaceAll`.
- Workspace UI no longer invents a `main` branch, a `clean` Git state, or fake active worktrees when the workspace API has not probed that telemetry. It reports only persisted repository/isolation facts and labels live Git state as unavailable until a real probe is implemented.

## Windows runtime-routing validation

The runtime-routing hardening slice adds a second pull-request job on `windows-latest`. It typechecks and runs the runtime-host regression suite on Windows in addition to the normal Ubuntu repository quality gate. Runtime-host typechecking uses TypeScript build mode so referenced domain, event and workspace projects are built before the Windows-specific tests execute.

The Windows suite exercises the shared process-launch layer used by Codex CLI, Claude Code, Antigravity and OpenCode. In particular, it creates and runs a real npm-style `.cmd` wrapper whose path contains spaces and whose arguments contain quotes plus `&`, `|`, `>`, `%`, `^`, `!` and trailing backslashes. The test must prove that those values arrive as literal argv values and cannot become an injected command or redirected file.

Routing regressions also cover role-scoped manual overrides, `schedulerAuto` behavior, Auto/Prefer/Fixed semantics, reasoning selection, ordered fallbacks and explicit cross-account fallback routes. A preferred account constrains the primary route; explicitly configured fallback catalog IDs remain eligible across account/runtime boundaries.

This Windows CI coverage validates process-launch and scheduler behavior without requiring real vendor credentials. Live authentication, quota, cancellation and approval behavior for installed CLIs remains part of the platform release checklist.

## Release blockers not closed by a green portable CI run

A green CI run does **not** mean the application is ready for public production distribution. The following remain explicit release blockers:

1. Keep the locked production dependency audit free of unresolved high/critical advisories and review each dependency update before release.
2. Run Windows live tests for each supported CLI runtime, authentication flow, cancellation path, approval flow, and restart/recovery path.
3. Exercise the packaged API/runtime sidecar through a physical clean-install acceptance test on supported Windows versions.
4. Produce signed Windows installers and validate updater signing, clean install, upgrade, uninstall, rollback, and data preservation.
5. Complete remaining deterministic mission-event sequencing/replay, startup reconciliation, durable task-attempt recovery, database schema migrations/versioning, and readiness work tracked in the AtrisAgent plan.

Production readiness is reached only when both the portable CI gate and the platform release blockers are green.
