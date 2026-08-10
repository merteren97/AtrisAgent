# Public Repository Readiness

## Current status

The current 0.2.0 tree has completed its public-source hardening pass and is
licensed under the Apache License 2.0. A bounded scan found no confirmed
committed credentials, private keys, JWTs, or provider tokens. That result is
time- and ref-scoped; it is not a guarantee that future changes or external
systems are secret-free.

## Remaining owner decision

Before making the repository public, the owner must **decide whether to rewrite
history and clean refs**. Reachable legacy refs currently include the old
backup/tag and migration branch. The initial `d170445` history contains
approximately 185 MB of generated Next dev-cache blobs, and an older
`services/orchestrator/src/agent/tools.ts` implementation constructs a Git push
URL containing a runtime token. No token value was found in the bounded scan,
but the code pattern and generated artifacts are unsuitable for a clean public
history.

If the owner chooses a rewrite, remove the generated cache and legacy token-in-
URL code from every intended public branch/tag, then verify the ref set and run
secret scanning again. Coordinate any force-update with collaborators and
invalidate or rotate credentials if a future scan finds a live value.

## Publication hygiene

- Keep `.env.example` and other templates free of real credentials.
- Keep local runtime databases, logs, caches, binaries, scratch output, and
  machine-specific paths ignored; do not stage them with `git add .`.
- Keep the reusable landing and release-proxy source public, while production
  deployment credentials, infrastructure configuration, and environment policy
  remain outside this repository behind a separate private operations boundary.
- Review every branch and tag, not only the default branch.
- Enable GitHub secret scanning and push protection after the owner has chosen a
  publication policy.
- Treat release signing keys, deploy SSH keys, AtrisHub secrets, user tokens,
  and provider credentials as external secrets; none belong in this repository.

Signed installer, updater-key, clean-install, and production-deployment
acceptance are product-release gates. They should remain visible in release
planning, but they are separate from the source-visibility decision above.

## Verification record

The audit used a clean worktree and inspected the current tree plus reachable
local/remote branches and tags. It included redacted pattern checks for private
keys, JWTs, common provider tokens, credential URLs, environment files, binary
artifacts, and large blobs. Re-run the checks after the history/ref decision;
the result above must not be treated as a future-proof security claim.
