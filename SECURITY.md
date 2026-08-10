# Security Policy

## Supported versions

AtrisAgent is currently a Developer Preview. Security fixes are handled on the
following lines:

| Version | Support |
| --- | --- |
| `0.2.x` | Supported for security fixes while the preview is active |
| `main` | Pre-release; fixes may land here first |
| `< 0.2` | Unsupported |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting flow: open the repository's
**Security** tab and choose **Report a vulnerability**. Do not put credentials,
tokens, private keys, database dumps, or a full exploit in a public issue or pull
request.

If private vulnerability reporting is not enabled for the repository, contact a
repository owner through GitHub and ask them to enable it. Do not disclose
secret values while requesting access to the private channel.

Include, when safe to share privately:

- the affected commit, version, or platform;
- a minimal reproduction and security impact;
- sanitized logs or screenshots; and
- any suggested mitigation.

The maintainers will acknowledge a report through GitHub, triage its severity,
and coordinate a fix or mitigation in a private channel before public
disclosure whenever practical.

## Secret exposure and history

If a credential may have entered a working tree, build artifact, issue, log, or
Git ref:

1. Revoke or rotate it at the issuing provider first.
2. Remove local copies and prevent the file from being staged.
3. Treat every reachable commit, branch, and tag as exposed until verified.
4. Use GitHub's sensitive-data removal procedure or an approved history-rewrite
   tool, then coordinate any required force-update with repository owners.
5. Re-run secret scanning after the rewrite and check downstream clones.

Deleting a file only from the latest commit does not remove older Git objects.
Never paste a raw AtrisHub, GitHub, provider, signing, SSH, or runtime token
into a report.

## Scope

Security reports are especially useful for AtrisHub authentication and
entitlement boundaries, local runtime-token handling, session persistence,
worktree isolation, command execution, release/update proxies, and secret
redaction. See [the public-repository readiness note](docs/PUBLIC_REPOSITORY_READINESS.md)
for the current publication blockers and audit boundary.
