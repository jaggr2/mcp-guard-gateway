# MCP Guard Gateway

Cloudflare Workers gateway that wraps HTTP MCP servers (starting with NanoKVM) and applies
per-tool governance before execution:

- **Guard 1 — Reason + Audit**: guarded tools require a `reason`; every call is written to a
  durable audit log (D1).
- **Guard 2 — Human-in-the-Loop**: guarded tools pause and require approval via Telegram
  inline buttons before execution.

> **Status**: Architecture + implementation plan only. No source code yet.
> See `docs/ARCHITECTURE.md` (spec) and `docs/PLAN.md` (execution contract).

## Repo layout

```
docs/
  ARCHITECTURE.md      # Target architecture spec (authoritative)
  PLAN.md              # Step-by-step implementation plan for a future session
  AWS_ALTERNATIVE.md   # Documented AWS/Lambda migration path
examples/
  policy.jsonc         # Sample per-tool guard table
```

## Security model

- Client holds only the Cloudflare Access service token.
- Upstream secrets (CF service token, NanoKVM API key, Telegram bot token) live in
  Workers Secrets, injected server-side.
- HITL uses the async handleId pattern (never blocks the MCP request) so it works with
  every MCP client and keeps the gateway stateless.

## Roadmap

1. Provider-agnostic core (policy engine, Guard 1, Guard 2, upstream proxy)
2. Cloudflare deploy (Worker + D1 + Access)
3. Telegram bot wiring
4. End-to-end test matrix
5. UniFi upstream (deferred: needs stdio→HTTP bridge + tunnel)
