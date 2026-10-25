# MCP Guard Gateway

Self-hosted gateway that secures **HTTP MCP servers** (NanoKVM and any other) with
per-tool governance, trust pinning, OIDC auth, Hermes-based human-in-the-loop approvals,
and an Angular admin UI. Runs locally in **Podman Quadlets** on the home server, with
Cloudflare Tunnel as the TLS edge.

- **Multi-upstream** — a DB-configured registry namespaces every upstream (`nanokvm_*`, …).
- **Per-tool policy** — each tool is `enabled` or not, with guards `none | reason | hitl`
  (+ timeout action/TTL). New tools are **disabled until reviewed** (fail-closed).
- **Trust pinning** — the upstream's serverInfo + instructions + tool schemas are hashed
  into a baseline; any drift is flagged and (by default) **blocks** the upstream + notifies
  via Hermes. A hijacked remote MCP server can't smuggle in tools.
- **Guard 1 — reason + audit** — guarded tools require `reason`; every call is audited.
- **Guard 2 — HITL** — guarded calls return `{approval_id, pending}` immediately; the
  operator approves/denies in their **Hermes Telegram DM**; the agent polls
  `check_approval_status`.
- **Auth** — MCP clients authenticate with **OAuth 2.1 against Authelia** (OIDC, PKCE,
  WebAuthn 2FA); the admin UI sits behind Authelia forward-auth (Traefik). Machine clients
  that can't do browser OAuth get gateway-issued service tokens.
- **Angular admin UI** — upstreams, policy editor, trust/re-pin, audit, approvals, clients,
  secrets (encrypted at rest), settings.

## Status

Implemented: core gateway (Hono + SQLite), multi-upstream registry + policies, trust
pinning, OIDC/service-token auth, Hermes bridge client, admin API, Angular UI,
hermes-bridge relay, GitOps quadlets, and Authelia provisioned on the server (user
`roger`). **Not yet deployed** (needs CI image push + Cloudflare hostnames + quadlet
start) — see `docs/DEPLOYMENT.md` for the full checklist.

## Repo layout

```
src/                     # gateway (Node 24 + Hono + SQLite)
  app.ts                 # Hono app: /mcp, /.well-known/*, /api/*, Angular SPA
  mcp.ts                 # SDK Server: tools/list merge + tools/call guards
  config.ts              # env -> GatewayConfig (issuers, hermes, upstreams)
  policy.ts              # per-tool {enabled, guard, timeout, ttl} resolution
  auth/                  # multi-issuer JWT verify (jose), RFC 9728 metadata, middleware
  trust/                 # baseline hashing + drift detection/blocking
  upstream/              # generic MCP upstream client + DB-backed registry
  hermes/bridge.ts       # Hermes MCP bridge client (cards + events)
  guards/                # Guard 1 (reason+audit), Guard 2 (HITL)
  store/                 # Store interface + SQLite + config repository
  api/                   # admin REST API
  db/schema.ts           # SQLite schema
bridge/                  # hermes-bridge relay (`hermes mcp serve` over Streamable HTTP)
web/                     # Angular 20 admin UI (standalone, signals)
scripts/, test/, docs/   # smoke test, vitest suite, docs (ARCHITECTURE/PLAN/DEPLOYMENT)
```

## Development

```bash
npm install
npm run check            # typecheck + vitest
npm run dev              # tsx watch (local, DB at ./data/gateway.db)
(cd web && npm run build)# build the admin UI
npm run build            # bundle the gateway
```

Secrets/env: see `.env.example` and `docs/DEPLOYMENT.md`.

## Deployment

Full step-by-step + config checklist: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.
