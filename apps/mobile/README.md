# AtrisAgent Mobile

React/Vite mobile companion and Tauri 2 application shell.

```sh
npm install
npm run dev -w @atris-agent-code/mobile
npm run build -w @atris-agent-code/mobile
npx playwright install chromium
npm run test:e2e -w @atris-agent-code/mobile
```

The Playwright tests use a mocked `/api/mobile` bridge; they do not connect to a real desktop or validate native iOS/Android behavior. They cover both iPhone- and Android-sized Chromium viewports.

**Connection is not implemented yet.** The client contract in `src/api.ts` requires a separately authenticated mobile bridge, paired-device identity, secure transport, and integration with the desktop manual-agent host. The existing desktop loopback gateway must not be exposed to the network to make this client work. The native project is a starting shell; Android/iOS platform projects, signing, native pairing and real-device verification remain to be completed.

## Mobile prereleases

The separate `Release AtrisAgent Mobile` workflow accepts a version such as `0.1.0` or `v0.1.0` and creates the independent `mobile-v0.1.0` GitHub prerelease. It runs mobile web and Playwright checks before building an Android arm64 APK and an unsigned iOS arm64 IPA. The iOS package must be signed or otherwise handled by a compatible sideloading environment before it can run; compatibility must be verified on a device.

Android release signing requires repository secrets `ANDROID_KEY_BASE64` (base64-encoded keystore), `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, and `ANDROID_KEYSTORE_PASSWORD`. Preserve the same keystore for future updates. The workflow verifies the APK signature and checks that the IPA has no embedded signature or provisioning profile. It publishes only after both builds succeed. Native builds and device installation have not yet been validated for this project.
