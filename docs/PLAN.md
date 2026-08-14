# Implementation Plan — MCP Guard Gateway

> **Status: SUPERSEDED.** This plan described the original Cloudflare Workers + Telegram
> target. The project pivoted to a **self-hosted** deployment (Podman Quadlets on the home
> server) with **Hermes** for HITL, **Authelia (OIDC)** for auth, multi-upstream + trust
> pinning, and an Angular UI. Phases 1–5 are implemented in `src/`; deployment steps and
> the current config checklist live in `docs/DEPLOYMENT.md`. The protocol decisions below
> (async handleId, stateless gateway, server-side secrets) remain valid.

## Phase 1 — Scaffold Worker project

- `git clone https://github.com/jaggr2/mcp-guard-gateway.git`
- `npm init -y && npm install @modelcontextprotocol/sdk`
- `npm install -D wrangler typescript vitest`
- `tsconfig.json`, `wrangler.jsonc` skeleton:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mcp-guard-gateway",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "d1_databases": [
    { "binding": "DB", "database_name": "mcp-guard", "database_id": "REPLACE_AFTER_CREATE" }
  ],
  "vars": { "DISCORD_INTERACTIONS_PATH": "/discord" }
}
```

- Verify: `wrangler dev` boots with a 404 handler.

## Phase 2 — Provider-agnostic core modules

Directory layout:

```
src/
  index.ts            // fetch() router: /mcp, /discord
  mcp.ts              // createMcpHandler wiring, tools/list merge
  policy.ts           // policy.jsonc load + per-tool resolution + reason-schema injection
  guards/
    reason.ts         // Guard 1: validate reason, write audit
    hitl.ts           // Guard 2: approvals row, Discord card, poll/execute
  store/
    d1.ts             // D1 impl of audit+approvals (target for this deployment)
    types.ts          // store interface + row types
  discord/
    client.ts         // sendMessage / editMessage via REST
    interactions.ts   // button interaction -> store (Ed25519 verified)
  upstream/
    nanokvm.ts        // fetch proxy to NanoKVM with injected secrets, namespacing
  config.ts           // reads env + Workers Secrets
```

Store interface (implement in `d1.ts`, swap in `types.ts` for AWS later):

```ts
interface Store {
  insertAudit(row: AuditRow): Promise<void>
  queryAudit(filter): Promise<AuditRow[]>
  createApproval(row: ApprovalRow): Promise<void>
  getApproval(id): Promise<ApprovalRow | undefined>
  setApprovalStatus(id, status, tgUserId?, result?): Promise<void>
  listApprovals(status?): Promise<ApprovalRow[]>
}
```

## Phase 3 — Guard 1 (reason + audit)

- [x] `policy.ts`: parse `examples/policy.jsonc`; `resolvePolicy(tool)` → `{guard, timeout_action, ttl_minutes}`
- [x] Inject required `reason` schema into guarded tools before returning `tools/list`
- [x] `tools/call` → `guards/reason.ts`: missing/blank reason → `-32602` error
- [x] Else insert audit row then continue to forward/HITL
- [x] `audit_query` tool implemented

## Phase 4 — Guard 2 (HITL + Discord)

- [x] `guards/hitl.ts`: create approval row, send Discord card (Approve/Deny buttons)
- [x] `check_approval_status` tool: pending → wait/retry; approved → execute upstream, store result; denied/expired → error
- [x] Expiry check honors per-tool `timeout_action` (deny default / approve)
- [x] `discord/interactions.ts`: button `approve:<id>` / `deny:<id>` → store update + card edit (type-7 response, Ed25519-verified)
- [x] `approvals_list` tool implemented

## Phase 5 — Upstream proxy (NanoKVM)

- [x] `upstream/nanokvm.ts`: forward `tools/list`, `tools/call` (initialize is handled locally by the SDK Server)
- [x] Namespace tool names: `nanokvm_<name>`; strip prefix on forward
- [x] Inject headers from Workers Secrets: `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `Authorization: Bearer <NANOKVM_API_KEY>`
- [x] Preserve JSON / SSE upstream response parsing (screenshots pass through)

## Phase 6 — Cloudflare deploy

- [ ] Create D1: `wrangler d1 create mcp-guard`; paste `database_id` into `wrangler.jsonc`
- [ ] D1 migration `migrations/0001_init.sql` (audit + approvals tables per ARCHITECTURE §5)
- [ ] `wrangler secret put CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` / `NANOKVM_API_KEY` / `DISCORD_BOT_TOKEN` / `DISCORD_PUBLIC_KEY`
- [ ] `wrangler deploy`
- [ ] Cloudflare Access app on the Worker route (service-token policy) — follow existing `nanokvm-uttigen.jaggi.xyz` pattern

## Phase 7 — Discord bot setup

- [ ] Discord Developer Portal → new application → copy bot token (`DISCORD_BOT_TOKEN`) and public key (`DISCORD_PUBLIC_KEY`)
- [ ] Invite the bot to the operator server with `Send Messages` permission; copy channel id (`DISCORD_CHANNEL_ID`)
- [ ] Register Interactions endpoint URL: `https://<worker>/discord` (must end in `/discord`)
- [ ] Verify button interaction parsing + card edit on resolve

## Phase 8 — End-to-end test matrix

- [ ] `tools/call` Guard 1 tool with no `reason` → `-32602`
- [ ] with `reason` → audit row present; `audit_query` returns it
- [ ] Guard 2: approve via Discord button → `check_approval_status` returns real upstream result
- [ ] Guard 2: deny → error result
- [ ] Guard 2: TTL expiry with `timeout_action: deny` → `expired`/denied (no execution)
- [ ] Guard 2: TTL expiry with `timeout_action: approve` → executes (per-tool config)
- [ ] `nanokvm_screenshot` passthrough returns image bytes
- [ ] Client config: point `nanokvm-go` remote MCP at gateway URL with Access token (existing Windows Credential Manager setup)

## Phase 9 — Docs + handoff

- [ ] `README.md` usage section: client config, policy editing, audit queries
- [ ] Update `docs/AWS_ALTERNATIVE.md` with anything learned
- [ ] Commit and push
