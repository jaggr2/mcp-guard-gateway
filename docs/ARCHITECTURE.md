# MCP Guard Gateway — Target Architecture

> **Status**: Implementation pending. This document is the authoritative spec that a
> future opencode session will implement. Follow `docs/PLAN.md` for the execution order.

## 1. Goal

Expose a single Model Context Protocol (MCP) **Streamable HTTP** endpoint that wraps the
NanoKVM MCP server (`https://nanokvm-uttigen.jaggi.xyz/api/mcp`) and applies per-tool
governance before any tool executes:

- **Guard 1 — Reason + Audit**: a guarded tool call MUST supply a `reason`; every call is
  recorded in an immutable audit log.
- **Guard 2 — Human-in-the-Loop**: a guarded tool call is paused, the operator is notified
  (Telegram inline buttons), and the call only executes after explicit approval (or the
  per-tool timeout policy resolves it).

The gateway is **provider-agnostic in core** and ships with a **Cloudflare Workers** target
deployment. An AWS equivalent is documented as a migration path in `docs/AWS_ALTERNATIVE.md`.

## 2. Scope

| Upstream | Status | Notes |
|---|---|---|
| NanoKVM MCP | **In scope** | HTTP MCP, already public via Cloudflare tunnel |
| UniFi MCP | Deferred | Local stdio process (`uvx unifi-network-mcp`); requires stdio→HTTP bridge (`mcp-remote`) + Cloudflare Tunnel before it can be a gateway upstream |

## 3. Architecture

```
opencode (MCP client)
   │  POST /mcp   (Streamable HTTP, stateless)
   │  header: Authorization: Bearer <Cloudflare Access service token>
   ▼
Cloudflare Access (existing Zero Trust app, service-token policy)
   ▼
Workers Gateway (single stateless Worker)
   ├── Tool registry: merges upstream tools, prefix-namespaced `nanokvm_*`
   ├── Policy engine: per-tool { guard, timeout_action, ttl_minutes }
   ├── intercepts tools/call
   │    ├─ Guard 1  → validate reason → D1 audit row
   │    ├─ Guard 2  → approvals row + Telegram card → return { approval_id, status: "pending" }
   │    └─ approved / no-guard → forward to upstream with injected server-side secrets
   └── gateway-native tools: check_approval_status, audit_query, approvals_list
        │
        ▼
https://nanokvm-uttigen.jaggi.xyz/api/mcp   (NanoKVM, reached server-side by the Worker)
```

### 3.1 Routing

- `POST /mcp` — MCP Streamable HTTP endpoint (client-facing).
- `POST /tg-webhook` — Telegram bot update webhook (inline-button callbacks).
- All other paths → 404.

## 4. Protocol decisions (non-negotiable)

### 4.1 HITL must be ASYNC (handleId pattern), never a blocking call

The MCP TypeScript SDK hardcodes a 60-second client timeout, and upstream proxies
(API Gateway/Lambda) impose their own limits. Therefore:

- A guarded `tools/call` **returns immediately**: `{ approval_id, status: "pending" }`.
- The agent polls the gateway-native tool `check_approval_status(approval_id)` until it
  observes `approved`, `denied`, or `expired`.
- On `approved`, the gateway executes the upstream call and stores the result; the next
  poll returns it.
- Never hold the HTTP request open waiting for a human.

### 4.2 Gateway is stateless

Approval and audit state lives in durable storage (D1), not in Worker memory. No Durable
Objects are required. The Worker can be freely redeployed/evicted.

### 4.3 Secrets stay server-side

- Client holds **only** the Cloudflare Access service token (already stored in the operator's
  Windows Credential Manager).
- Upstream secrets live in **Workers Secrets** (encrypted at rest):
  - `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (for reaching NanoKVM behind Access)
  - `NANOKVM_API_KEY`
  - `TG_BOT_TOKEN`
- The Worker injects these when proxying to NanoKVM and when calling Telegram. They never
  appear in client config, environment files, or the repository.

## 5. Data model (D1)

### 5.1 `audit` table

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `ts` | TEXT (ISO-8601 UTC) | call time |
| `caller_id` | TEXT | client identity (Access sub / token id) |
| `tool` | TEXT | namespaced tool name, e.g. `nanokvm_click_mouse` |
| `args` | TEXT (JSON) | full arguments |
| `reason` | TEXT | required for Guard 1 tools |
| `decision` | TEXT | `auto-audited` \| `approved` \| `denied` \| `expired` |
| `approved_by` | TEXT NULL | Telegram user id when HITL approved |
| `upstream_status` | TEXT NULL | upstream result/error summary |
| `expires_at` | TEXT NULL | HITL deadline |

### 5.2 `approvals` table

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `approval_id` (crypto-random) |
| `tool` | TEXT | namespaced tool name |
| `args` | TEXT (JSON) | |
| `reason` | TEXT | |
| `status` | TEXT | `pending` \| `approved` \| `denied` \| `expired` |
| `timeout_action` | TEXT | `deny` \| `approve` (per-tool policy) |
| `ttl_minutes` | INTEGER | per-tool policy |
| `created_at` | TEXT | |
| `expires_at` | TEXT | |
| `result` | TEXT (JSON) NULL | upstream result once executed |
| `tg_message_id` | INTEGER NULL | for editing the card on resolution |
| `tg_user_id` | TEXT NULL | who resolved it |

## 6. Guard 1 — Reason + Audit

- Policy engine injects a required JSON-Schema property `reason` (type `string`, minLength ≥ 1,
  description "why is this action needed") into guarded tool definitions returned by `tools/list`.
- On `tools/call`:
  1. If `reason` missing/blank → JSON-RPC error `-32602` (Invalid Params) with a clear message.
  2. Else → insert audit row (`decision: 'auto-audited'`), then forward upstream.
- `audit_query(tool?, since?, caller_id?)` lets the operator inspect history.

## 7. Guard 2 — HITL via Telegram

1. `tools/call` on a Guard 2 tool → insert `approvals` row (`status: 'pending'`) →
   send Telegram card:
   `⚠ <tool> wants: <reason>` + `args: <json>` + inline buttons **Approve** / **Deny**.
2. Telegram callback → `POST /tg-webhook` → update row (`approved`/`denied`, record `tg_user_id`).
3. Agent polls `check_approval_status(id)`:
   - `pending` → wait and retry
   - `approved` → gateway executes upstream, stores `result`, poll returns it
   - `denied` → error result
   - `expired` → per-tool `timeout_action`: `deny` (default, fail-safe) or `approve`
4. On resolution, edit the Telegram card to reflect the outcome.

## 8. Policy configuration

Per-tool guard table — example (`examples/policy.jsonc`):

```jsonc
{
  "nanokvm_click_mouse":  { "guard": "hitl",   "timeout_action": "deny",   "ttl_minutes": 30 },
  "nanokvm_screenshot":   { "guard": "reason", "timeout_action": null,     "ttl_minutes": null },
  "nanokvm_type_text":    { "guard": "hitl",   "timeout_action": "deny",   "ttl_minutes": 30 },
  "nanokvm_press_keys":   { "guard": "hitl",   "timeout_action": "deny",   "ttl_minutes": 30 },
  "nanokvm_move_mouse":   { "guard": "reason", "timeout_action": null,     "ttl_minutes": null },
  "nanokvm_scroll_mouse": { "guard": "reason", "timeout_action": null,     "ttl_minutes": null }
}
```

- `guard: "reason"` → Guard 1 only.
- `guard: "hitl"` → Guard 1 + Guard 2 (reason is always collected and audited).
- `guard: "none"` → passthrough (still audited).
- Unknown/unlisted tools default to `{ "guard": "none" }`.

## 9. Gateway-native tools

| Tool | Description |
|---|---|
| `check_approval_status(approval_id)` | Poll HITL outcome; returns real result on approve |
| `approvals_list(status?)` | List pending/resolved approvals |
| `audit_query(tool?, since?, caller_id?)` | Query audit log |

## 10. Deployment target (Cloudflare)

- Worker: TypeScript, `@modelcontextprotocol/sdk` `createMcpHandler` (stateless) or raw SDK handler.
- Bindings: D1 (`MCP_GATEWAY`), Workers Secrets (see §4.3).
- Front door: Cloudflare Access application protecting the Worker route (service-token policy) —
  reuse the existing `nanokvm-uttigen.jaggi.xyz` Access setup pattern.
- Deploy: `wrangler deploy` (see `docs/PLAN.md` for config sketch).

## 11. Out of scope / future work

- UniFi upstream (stdio bridge + tunnel).
- AWS deployment (documented in `docs/AWS_ALTERNATIVE.md`).
- Multi-tenant / per-agent policy scopes.
