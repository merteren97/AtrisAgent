# AtrisAgent Mobile

React/Tauri companion for existing desktop manual-agent conversations. Agents,
CLI accounts and project files remain on the computer. Both devices sign in to
the same AtrisHub account. They connect over the internet through a separately
deployed relay, without exposing the desktop loopback gateway.

## Required rollout

1. Deploy the relay and WSS route through the private AtrisHub operations repo.
   See `services/mobile-relay/README.md`. Updating only the landing site is not
   enough. The production endpoint is `wss://agent.atrishub.com/remote/v1/ws`.
2. Install the desktop build containing **Settings → Mobile access**.
3. Install the new mobile build. Sign in to AtrisHub.
4. Enable mobile access on desktop. Copy the private pairing code into the
   phone's **Connect** panel, then approve the phone on desktop.

Codes expire after 10 minutes. Desktop approval is required before reading or
controlling agents. Approved connections last while both apps remain connected;
restarting either app or changing the network may require pairing again. Disable
access to immediately disconnect phones and invalidate the current code. Closing
or signing out of desktop also disables access. Keep the desktop open (or use
its tray option) and prevent the computer from sleeping during remote work.

## Implemented

- Workspace/manual-agent listing, current status and recent conversation history.
- Sending messages into an existing open native terminal; duplicate command IDs
  do not write twice within the desktop process. Uncertain delivery is never
  retried automatically. Receipts are in memory, not a cross-restart guarantee.
- Same-runtime/account model and reasoning changes. OpenCode updates live;
  other CLIs restart only when not working/waiting, using desktop launch paths.
- Runtime-supported questions, OpenCode auto-approve, live Codex permissions,
  and reading conversation-scoped memory.
- Hub token storage through native iOS Keychain/Android Keystore. Browser previews
  stay memory-only. If native storage is unavailable (including some sideloading
  setups), sign-in still works in memory and account settings report it.

Cross-runtime/account agent creation, mobile attachments, Mission/Orchestrator
controls, durable device registration and background push notifications are not
implemented in this first remote-control increment. Native iOS/Android behavior
and LiveContainer compatibility must still be checked on actual devices.

## Development and verification

```sh
npm install
npm run build -w @atris-agent-code/mobile
npm test -w @atris-agent-code/remote
npm test -w @atris-agent-code/mobile-relay
npx playwright install chromium
npm run test:e2e -w @atris-agent-code/mobile
```

Playwright starts a real loopback WebSocket relay and encrypted host/client
channels. Hub authentication and CLI behavior are injected test fixtures; these
tests do not claim real provider or iPhone installation coverage. The production
desktop adapter uses the existing local gateway and Tauri terminal commands.

The Android release build is also exercised on PRs with an ephemeral test signing
key. The public mobile release workflow uses the configured production keystore
and creates independent `mobile-v0.1.0` prereleases. Android secrets are
`ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, and
`ANDROID_KEYSTORE_PASSWORD`. Preserve the keystore across updates. iOS is an
unsigned IPA for a compatible sideloading setup; no App Store distribution is
claimed. The release process checks signature/provisioning-profile absence.

## Android release credentials

`ANDROID_KEY_BASE64` must be the Base64 of an actual binary Android JKS/PKCS12
keystore, not a Tauri updater key, PEM, ZIP or Base64-encoded text file. Before
compilation, the release workflow opens the container and recovers the configured
private key with the same JDK used for Gradle. It reports missing alias, unreadable
store and unreadable private key separately, without printing credentials.
Signing properties are escaped for Java's Properties parser, including literal
backslashes, significant whitespace and Unicode passwords.

For a new signing identity, configure JDK 17 and run from the repository root:

```sh
node .github/scripts/create-local-mobile-keystore.mjs
```

This creates a verified PKCS12 file and secret bundles under the Git-ignored
`.docs/android-signing/` directory. It refuses to overwrite an existing identity
and never uploads secrets. Keep the complete bundle backed up for future app
updates. An authorized operator can import the four secrets without copying
them into a command line or a public issue:

```sh
gh secret set --repo merteren97/AtrisAgent --env-file .docs/android-signing/github-secrets.env
```

The mobile viewport intentionally disables pinch/double-tap zoom. Editable
controls use at least 16 CSS pixels to avoid iOS focus zoom. Native-device
behavior still needs verification after installing the updated package.
