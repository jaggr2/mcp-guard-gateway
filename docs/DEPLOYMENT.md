# Deployment — MCP Guard Gateway (self-hosted, Podman Quadlets)

The gateway is now a self-hosted Node/Hono service on the rack server (`derog-server`),
alongside Hermes and opencode on the **AI VLAN (192.168.30.11)**, managed via GitOps
(`home-control-server-config`). Cloudflare is only the TLS edge (token tunnel → reverse
proxy); Cloudflare Workers/D1/Access are no longer involved on the gateway path.

## Architecture

```
opencode ──► https://mcp-guard.jaggi.xyz ──► cloudflared ──► traefik (192.168.30.11:80)
                                                             ├─ /mcp, /.well-known   → gateway (OAuth 2.1, Authelia JWT)
                                                             ├─ /, /api/*            → forwardAuth → authelia (web UI)
                                                             └─ auth.jaggi.xyz       → authelia
   gateway (podman) ──► hermes-bridge ──► `hermes mcp serve` ──► Hermes gateway ──► Telegram DM ("mcp-guard")
   gateway ──► SQLite (/data/gateway.db)  ·  upstreams (NanoKVM, …)  ·  trust pinning  ·  Angular admin UI
```

## What's already done (this session)

- [x] Gateway code: multi-upstream registry, per-tool `enabled`/`guard` policies (fail-closed discovery), trust pinning (SHA-256 baseline, drift → block+notify), OIDC Bearer auth (multi-issuer, `jose`), RFC 9728 metadata, admin REST API, Angular 20 admin UI, `hermes-bridge` relay.
- [x] `home-control-server-config`: quadlets for `traefik`, `authelia`, `mcp-guard-gateway`, `hermes-bridge`, `mcp-guard.network`, traefik dynamic config, `mcp-guard.env.example`, and `setup/15-authelia-setup.sh`.
- [x] **Authelia provisioned on the server**: user `roger` (groups `admins`, `operators`), OIDC key, JWT secret, config at `~/config/authelia`. **Password for first login was generated and given to you** — change it on first login and enroll a WebAuthn passkey (second factor = multiple passkeys).

## Config checklist (things you must provide)

1. **GitHub → CI:** push `mcp-guard-gateway` to build & publish `ghcr.io/jaggr2/mcp-guard-gateway` and `-bridge` (workflow `.github/workflows/publish.yml`). Needs the repo's `GITHUB_TOKEN` (auto) and `packages: write`.
2. **Cloudflare dashboard (token tunnel):** add public hostnames:
   - `mcp-guard.jaggi.xyz` → `http://192.168.30.11:80`
   - `auth.jaggi.xyz` → `http://192.168.30.11:80`
3. **`~/config/mcp-guard.env`** (chmod 600) — from `x64-rack-server/config/mcp-guard.env.example`:
   - `SECRET_MASTER_KEY` (`openssl rand -hex 32`)
   - `PUBLIC_URL=https://mcp-guard.jaggi.xyz`
   - `AUTHELIA_ISSUER=https://auth.jaggi.xyz`, `AUTHELIA_AUDIENCE=https://mcp-guard.jaggi.xyz`
   - `HERMES_BRIDGE_URL=http://hermes-bridge:8643`
   - `HERMES_CONVERSATION_KEY=telegram:<your telegram user id>`
4. **`~/config/traefik/dynamic.yml`** — from `x64-rack-server/config/traefik/dynamic.yml` (hostnames already match `jaggi.xyz`; adjust if different).
5. **Hermes:** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USERS` already in `~/config/hermes.env`. DM the Hermes bot so the pairing exists.

## Deploy (once CI images exist)

```bash
# commit + push home-control-server-config → auto-apply via webhookd, or manually:
cd /opt/homelab
git pull
systemctl --user daemon-reload
systemctl --user start mcp-guard-gateway.service authelia.service mcp-guard-traefik.service hermes-bridge.service
```

## First-run in the admin UI (https://mcp-guard.jaggi.xyz)

1. **Secrets** (Settings → Secrets): add `NANOKVM_API_KEY`, and the Cloudflare Access service-token parts.
2. **Upstreams** (Upstreams → Register + pin): `nanokvm` → `https://nanokvm-uttigen.jaggi.xyz/api/mcp`.
   In the upstream's header map reference the secrets: `CF-Access-Client-Id: $SECRET:CF_ACCESS_CLIENT_ID`, etc.
   Registration auto-pins the baseline; **tools start disabled** — enable each and set guards (hitl/reason).
3. **Settings → Hermes:** confirm `hermes.conversationKey` = `telegram:<id>`.
4. **opencode:** point its MCP config at `https://mcp-guard.jaggi.xyz/mcp`.

## opencode OAuth (open item)

Full OAuth needs opencode to use the pre-registered client `opencode-mcp` with redirect
`http://127.0.0.1:40481/callback`. If opencode's web client can't pin the loopback
redirect, fall back to a **machine client token** (UI → Clients → Create token) passed as
`Authorization: Bearer <token>` — the gateway hashes it and matches it against the `clients`
table (SHA-256 at rest). This works whether or not OIDC issuers are configured.

## Known risk

`hermes-bridge` runs `hermes mcp serve` in a **sibling** container sharing `~/config/hermes`.
`messages_send` needs the Hermes gateway's platform connections; if the sibling can't reach
them, run the relay inside the hermes container (same volume + `--ipc=host`). Verify with:
`curl http://192.168.30.11:8643/healthz` and a test approval card.
