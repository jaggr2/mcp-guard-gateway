# Implementation Plan — MCP Guard Gateway (Cloudflare)

> **Purpose**: Step-by-step execution contract for a future opencode session.
> Source of truth for behavior: `docs/ARCHITECTURE.md`.

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
  "vars": { "TG_WEBHOOK_PATH": "/tg-webhook" }
}
```

- Verify: `wrangler dev` boots with a 404 handler.

## Phase 2 — Provider-agnostic core modules

Directory layout:

```
src/
  index.ts            // fetch() router: /mcp, /tg-webhook
  mcp.ts              // createMcpHandler wiring, tools/list merge
  policy.ts           // policy.jsonc load + per-tool resolution + reason-schema injection
  guards/
    reason.ts         // Guard 1: validate reason, write audit
    hitl.ts           // Guard 2: approvals row, Telegram card, poll/execute
  store/
    d1.ts             // D1 impl of audit+approvals (target for this deployment)
    types.ts          // store interface + row types
  telegram/
    client.ts         // sendMessage / editMessageReplyMarkup via fetch
    webhook.ts        // inline-button callback -> store
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

- [ ] `policy.ts`: parse `examples/policy.jsonc`; `resolvePolicy(tool)` → `{guard, timeout_action, ttl_minutes}`
- [ ] Inject required `reason` schema into guarded tools before returning `tools/list`
- [ ] `tools/call` → `guards/reason.ts`: missing/blank reason → `-32602` error
- [ ] Else insert audit row then continue to forward/HITL
- [ ] `audit_query` tool implemented

## Phase 4 — Guard 2 (HITL + Telegram)

- [ ] `guards/hitl.ts`: create approval row, send Telegram card (Approve/Deny inline keyboard)
- [ ] `check_approval_status` tool: pending → wait/retry; approved → execute upstream, store result; denied/expired → error
- [ ] Expiry check honors per-tool `timeout_action` (deny default / approve)
- [ ] `telegram/webhook.ts`: callback `approval_id` + `approve|deny` → store update + edit card
- [ ] `approvals_list` tool implemented

## Phase 5 — Upstream proxy (NanoKVM)

- [ ] `upstream/nanokvm.ts`: forward `initialize`, `tools/list`, `tools/call`
- [ ] Namespace tool names: `nanokvm_<name>`; strip prefix on forward, re-add on response
- [ ] Inject headers from Workers Secrets: `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `Authorization: Bearer <NANOKVM_API_KEY>`
- [ ] Preserve SSE / JSON response content-types (screenshots pass through)

## Phase 6 — Cloudflare deploy

- [ ] Create D1: `wrangler d1 create mcp-guard`; paste `database_id` into `wrangler.jsonc`
- [ ] D1 migration `migrations/0001_init.sql` (audit + approvals tables per ARCHITECTURE §5)
- [ ] `wrangler secret put CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` / `NANOKVM_API_KEY` / `TG_BOT_TOKEN`
- [ ] `wrangler deploy`
- [ ] Cloudflare Access app on the Worker route (service-token policy) — follow existing `nanokvm-uttigen.jaggi.xyz` pattern

## Phase 7 — Telegram bot setup

- [ ] BotFather → create bot → copy `TG_BOT_TOKEN`
- [ ] Register webhook: `POST https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<worker>/tg-webhook`
- [ ] Verify callback payload parsing + card edit on resolve

## Phase 8 — End-to-end test matrix

- [ ] `tools/call` Guard 1 tool with no `reason` → `-32602`
- [ ] with `reason` → audit row present; `audit_query` returns it
- [ ] Guard 2: approve via Telegram button → `check_approval_status` returns real upstream result
- [ ] Guard 2: deny → error result
- [ ] Guard 2: TTL expiry with `timeout_action: deny` → `expired`/denied (no execution)
- [ ] Guard 2: TTL expiry with `timeout_action: approve` → executes (per-tool config)
- [ ] `nanokvm_screenshot` passthrough returns image bytes
- [ ] Client config: point `nanokvm-go` remote MCP at gateway URL with Access token (existing Windows Credential Manager setup)

## Phase 9 — Docs + handoff

- [ ] `README.md` usage section: client config, policy editing, audit queries
- [ ] Update `docs/AWS_ALTERNATIVE.md` with anything learned
- [ ] Commit and push
