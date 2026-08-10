# Updater Release Pipeline

AtrisAgent keeps updater signing material out of the repository while still providing Tauri with the complete updater configuration required when `bundle.createUpdaterArtifacts` is enabled.

## Release-only configuration

The owner-controlled release workflow reads `TAURI_UPDATER_PUBLIC_KEY` from GitHub Actions secrets and runs:

```bash
node .github/scripts/create-updater-build-config.mjs apps/desktop/src-tauri/tauri.release.conf.json
```

The generated file is ephemeral and exists only on the Actions runner. It merges these release-only values into the normal Tauri configuration:

- `bundle.createUpdaterArtifacts: true`
- `plugins.updater.pubkey`
- `plugins.updater.endpoints`

The private signing key is never written to this configuration. Tauri receives `TAURI_SIGNING_PRIVATE_KEY` and its optional password only through the build process environment.

Normal development and CI bundles do not require updater signing secrets and continue to build from the checked-in `tauri.conf.json`.

## Stable release contract

Stable releases publish signed Windows and Linux installers together with `latest.json`. The desktop updater checks the stable GitHub Releases endpoint and verifies downloaded updater artifacts with the public key embedded in the signed release build.

If the generated updater configuration is incomplete, the release workflow must fail before publishing any GitHub Release.
