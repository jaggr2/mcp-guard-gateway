# credential-hitl — HITL-gated credential tool for OpenCode V2

An OpenCode **server plugin** that adds one tool, `get_credential`: the model can
ask for a credential, a **human approves or denies** (like a question), and only
after approval the value is fetched from a configured broker endpoint and
returned as short-lived tool output.

It is the OpenCode side of Warden's HITL approvals and ships **inside the
mcp-guard-gateway repo** because it is driven by Warden's approvals REST API
(`POST /api/approvals`, `GET /api/approvals/:id`, see below).

Two approval channels exist and can be combined:

| `approval` | Gate | UX |
|---|---|---|
| `"ui"` (default) | OpenCode permission prompt | Interactive question in TUI/GUI/web UI; "Allow always" is remembered per project |
| `"warden"` | Warden HITL only | HA actionable push `[✅ Approve 30m]` / `[❌ Deny]` + Warden UI buttons; the call parks until decided |
| `"both"` | Either tap unblocks | UI prompt **and** HA push are parallel answer channels for the same decision — whichever the human answers first wins |

Rules and saved approvals always apply: a configured `deny` for
`action: "credential"` blocks every call, no channel can override it.

## How a call flows

```
model: get_credential { name, reason }
  → ctx.permission.assert(action: "credential", resources: [name])   # prompt like a question
  → [mode "both"]  parallel: Warden approval + HA push
                   Warden decision resolves the permission request
                   via ctx.permission.reply(once | reject)
  → gate passed → GET/POST <broker endpoint> → short-lived credential as tool output
```

A denial surfaces to the model as a tool error with the reason, so it can
continue working without the credential.

## Install

The plugin is a local OpenCode plugin directory — either reference this
directory from `opencode.json(c)` (below) or copy it to
`.opencode/plugins/credential-hitl/` of a project (auto-loads).

**oc-server** (roger@derog-server): the homelab repo's
`setup/25-oc-server-instance.sh` (step 3b) installs this directory from
`~/dev/mcp-guard-gateway/plugins/credential-hitl` into
`~/.config/opencode/plugins/credential-hitl` and wires the config below
idempotently. Re-run it after plugin updates.

**Sandboxes** (`oc-<project>`): usually not needed — their tooling already gets
credentials brokered via Warden (`AWS_CONTAINER_CREDENTIALS_FULL_URI`, git
credential-helper) and risky MCP tools can be `guard=hitl` in Warden's policy
table. Add the plugin there only when the *model itself* should request
credentials explicitly.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/roger/.config/opencode/plugins/credential-hitl",
      "options": {
        "warden": {
          "url": "http://127.0.0.1:8080",
          "tokenEnv": "WARDEN_TOKEN",
          "caller": "oc-server"
        },
        "credentials": {
          "aws-deploy": {
            "approval": "both",
            "ttlMinutes": 30,
            "endpoint": "http://127.0.0.1:8080/aws-creds?mode=deploy"
          },
          "git:repo-token": {
            "approval": "ui",
            "endpoint": "http://127.0.0.1:8080/git-creds?repo=jaggr2/home-control-server-config"
          }
        }
      }
    }
  ],
  "permissions": [
    { "action": "credential", "resource": "*", "effect": "ask" }
    // last match wins — pin individual credentials down when useful:
    // { "action": "credential", "resource": "git:*", "effect": "allow" }
  ]
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `credentials.<name>.endpoint` | — (required) | Broker URL returning the credential payload |
| `credentials.<name>.approval` | `"ui"` | `"ui"` \| `"warden"` \| `"both"` |
| `credentials.<name>.method` | `"GET"` | `GET` or `POST` |
| `credentials.<name>.headers` / `.body` | — | Extra request headers / JSON body for `POST` |
| `credentials.<name>.ttlMinutes` | `30` | Warden approval TTL |
| `credentials.<name>.savePattern` | credential name | Pattern proposed to "Allow always" |
| `warden.url` | — | Warden gateway base URL (required for `warden`/`both`) |
| `warden.tokenEnv` | `"WARDEN_TOKEN"` | Env var with the bearer token (`Authorization: Bearer …`) |
| `warden.caller` | `"opencode"` | `X-Warden-Caller` header value (informational) |
| `warden.pollMs` | `3000` | Approval status poll interval |
| `warden.createPath` | `"/api/approvals"` | Approval create endpoint |
| `warden.statusPath` | `"/api/approvals/{id}"` | Approval status endpoint (`{id}` substituted) |

The plugin reads `process.env[tokenEnv]` at call time; the token is never part of
the tool output. Tool output lands in the session transcript — only short-lived
broker responses should be behind this tool.

## Warden API contract

Implemented in this repo (`src/api/index.ts`), e2e-locked by
`test/approvals-e2e.test.ts` (which walks the exact requests the plugin sends):

```
POST /api/approvals
  headers: Authorization: Bearer <sandbox-or-client token>
  body:    { "tool": "aws-deploy", "reason": "…", "ttlMinutes": 30,
             "args": { … }, "timeoutAction": "deny" | "approve" }
  200:     { "ok": true, "approval_id": "apr_…", "status": "pending",
             "expires_at": "…" }

GET /api/approvals/<id>
  200:     { "approval_id", "tool", "reason",
             "status": "pending|approved|denied|expired",
             "created_at", "expires_at", "timeout_action", "decided_by" }
  404:     { "error": "not found" }
```

Semantics (all handled by Warden):

- **Identity comes from the token**, not headers: a sandbox token authenticates
  as its project slug. Creating is open to any authenticated caller
  (`anyAuth`); **deciding is operator-only** (`POST /api/approvals/:id/resolve`,
  `GET /api/approvals/:id/decide?action=…`, `POST /api/approvals/latest-decision`
  — the same endpoints the HA dashboard and ha-bridge already use).
- **Generic approvals**: `POST /api/approvals` rows are `kind: "generic"` — the
  approval itself is the outcome, nothing executes upstream on approve. They get
  the same HA actionable push / Warden UI row / resolution cards as
  `guard=hitl` MCP approvals and are visible in `approvals_list`.
- **Lazy expiry**: `GET /api/approvals/<id>` applies the timeout policy
  snapshotted on the row (`timeoutAction: "deny"` default → `expired`), so a
  parked tool call always terminates.
- **Result is not returned over REST** (it may hold upstream output for other
  approval kinds) — this endpoint is a status channel only.

If Warden runs behind a different base URL, set `warden.url`; the path
conventions (`createPath`/`statusPath`) are configurable.

## Behaviour notes & gotchas

- **Saved approvals**: "Allow always" stores `{ action: "credential",
  resource: <savePattern> }` as a project-scoped allow. Review and prune them
  like any other saved approval.
- **`reject` is session-wide**: OpenCode's reject replies "reject it and every
  other pending permission request in that session". A Warden deny in `both`
  mode therefore also dismisses other pending prompts — rare, but know it.
- **Orphaned Warden approvals**: if the human answers in the UI first, the HA
  push is not cancelled; it expires via its TTL (`timeout_action=deny` semantics
  on the Warden side).
- **Unknown `permission.list` item shape**: the bridge matches the pending
  request by tool-call `source` and falls back to "exactly one pending request".
  If no match is found and the Warden decision was a deny, the UI prompt stays
  active instead of hanging the call.
- **Non-interactive sessions** (`opencode run --auto`, CI agents): use
  `approval: "warden"` and let the human tap on the watch; `ui` prompts have no
  one to answer them. Configured `deny` rules are enforced regardless.
- **Warden down**: `both` degrades to the UI prompt and logs
  `[credential-hitl] warden bridge unavailable`; `warden` fails the tool call.

## Development

`types.d.ts` is a hand-maintained shim of the `@opencode/plugin` surface used
here (for offline typechecking only). Verify with:

```sh
cd plugins/credential-hitl && bun x tsc --noEmit
```

Warden side: `npm run check` (typecheck + vitest, includes
`test/approvals-e2e.test.ts`).

API reference: <https://opencode.ai/v2/docs/build/plugins/server> (Tools,
Permissions) and <https://opencode.ai/v2/docs/permissions> (rules, approvals).
