# AtrisAgent mobile relay

This service authenticates both peers against AtrisHub `/api/auth/me`, requires
matching account IDs, and routes encrypted frames between desktop and phone.
It never receives the pairing secret. Desktop approval is checked after proof
of that secret and before any agent operation. Revalidation is fail-closed.

Messages use HKDF-SHA256 directional AES-256-GCM keys with fresh random nonces
from both endpoints, authenticated session/counter metadata, and replay checks.
Pairing secrets are generated using Web Crypto and transferred out of band by
the user. This is a new protocol implementation, not an independently audited
security claim. Pairing codes must be treated like private access credentials.

```sh
npm run build -w @atris-agent-code/mobile-relay
npm start -w @atris-agent-code/mobile-relay
```

The server binds only `127.0.0.1` (default `PORT=3015`). Production requires a TLS
reverse proxy for `/remote/v1/ws`. Private AtrisHub operations own PM2/Nginx and
the explicit deployment workflow. Do not copy production credentials or topology
into this public repo. `/health` is a non-sensitive loopback readiness endpoint.
Do not run the Playwright fixture server as a production relay.

Disconnecting desktop drops every phone session. There is no durable command
queue or offline execution. Relay reconnects require fresh session approval;
session/device registration currently lasts only for the active connection.
