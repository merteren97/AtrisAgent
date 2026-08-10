# Contributing

Thank you for helping improve AtrisAgent. The project is a Windows-first
Developer Preview, and changes should preserve the local-first, approval-first
security model.

## Local setup

Use a supported Node.js 22 LTS installation, npm 10 or newer, Git 2.40 or
newer, Rust stable, and the Tauri platform prerequisites. Then run:

```bash
npm ci
npm run preflight
npm run check
```

Do not commit generated output from development servers, package caches,
`node_modules`, Tauri binaries, local runtime data, `.mertcode`, scratch files,
or deployment notes from a private environment. The repository's ignore rules
contain the known local paths; verify with `git status --ignored` before staging.

## Security and secrets

- Never commit `.env` files, credentials, API keys, access tokens, private keys,
  certificates, database files, logs, or production dumps.
- Keep real AtrisHub, GitHub, provider, SSH, release, and updater values in the
  appropriate OS credential store, server environment, or GitHub Actions secret.
- Keep examples and tests deterministic and use placeholders such as
  `example.test` or `ExampleUser`.
- If a secret is discovered, stop sharing it, rotate it, and follow
  [the security policy](SECURITY.md) rather than opening a public issue.

## Tests and pull requests

Run the smallest relevant checks while iterating, then run the repository gate:

```bash
npm run typecheck
npm test
npm run check
```

Runtime-host changes should also pass its focused suite:

```bash
npm run test -w @atris-agent-code/runtime-host
npm run typecheck -w @atris-agent-code/runtime-host
```

Pull requests should describe the behavior change, security or migration
implications, and the commands used for verification. Keep unrelated formatting
or generated-file churn out of the diff. Do not commit, push, or publish release
artifacts from a local development checkout.

## License of contributions

Unless explicitly stated otherwise, contributions intentionally submitted for
inclusion in AtrisAgent are provided under the [Apache License 2.0](LICENSE),
consistent with Section 5 of that license.
