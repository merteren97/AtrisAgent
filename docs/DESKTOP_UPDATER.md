# AtrisAgent Desktop Updater

AtrisAgent uses Tauri's signed desktop updater and the public GitHub Releases channel.

## Runtime behavior

- Signed release builds check `releases/latest/download/latest.json` on startup.
- The default preference is **Notify before installing**.
- Users can switch to **Install automatically** in Settings.
- Settings also exposes a manual **Check now** action.
- Update packages are signature-verified by Tauri before installation.
- Development and normal CI builds do not contain an updater public key and therefore fail closed instead of accepting unsigned updates.

## One-time signing setup

Create one long-lived updater key pair on a trusted machine. Keep the private key outside the repository and in a backed-up secret store.

```bash
npx @tauri-apps/cli@2.10.1 signer generate -w ~/.tauri/atris-agent.key
```

Configure these GitHub Actions secrets for `merteren97/AtrisAgent`:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the generated private key.
- `TAURI_UPDATER_PUBLIC_KEY`: contents of the generated public key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: only when the private key was generated with a password.

Never commit the private key or its password. Do not rotate or lose the updater key pair casually: installed applications trust the public key embedded in the release that installed them.

## Publishing

Use the existing **Release AtrisAgent Desktop** workflow from `main`.

A stable tag such as `v0.3.0` produces signed Windows and Linux update artifacts and publishes a `latest.json` manifest with the stable GitHub Release. Prerelease tags remain downloadable releases but are intentionally excluded from the stable auto-update channel.

The workflow fails before publishing when signing configuration or signatures are missing.

## Bootstrap release

Versions released before updater support cannot update themselves. The first updater-enabled stable build must therefore be installed once through the normal GitHub Release installer. Every later signed stable release can then be discovered and installed in-app.
