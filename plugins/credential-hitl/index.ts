// credential-hitl — OpenCode V2 server plugin.
//
// Adds a `get_credential` tool whose release is gated by human approval (HITL):
//
//   approval: "ui"     — interactive OpenCode permission prompt (the same UX as the
//                        question tool). Permission rules and saved approvals apply;
//                        "Allow always" remembers the credential name per project.
//   approval: "warden" — Warden/HA approval only: the call parks until the human
//                        taps [Approve]/[Deny] in the HA notification / Warden UI.
//   approval: "both"   — either answer unblocks: the in-UI prompt and the HA push
//                        are parallel channels for the same decision; whichever the
//                        human answers first wins.
//
// After the gate passes, the credential is fetched from a configured broker
// endpoint (Warden /aws-creds, /git-creds, a secrets API, ...) and returned as
// short-lived tool output.
//
// Warden-side API contract + full setup docs: see README.md next to this file.

import { Plugin } from "@opencode/plugin"

type ApprovalMode = "ui" | "warden" | "both"
type WardenStatus = "approved" | "denied" | "expired"

interface WardenConfig {
  /** Base URL of the Warden gateway, e.g. "http://127.0.0.1:8080". */
  url: string
  /** Env var holding the bearer token (default "WARDEN_TOKEN"). */
  tokenEnv?: string
  /** Value for the X-Warden-Caller header (default "opencode"). */
  caller?: string
  /** Status poll interval in ms (default 3000). */
  pollMs?: number
  /** Approval create path (default "/api/approvals"). */
  createPath?: string
  /** Approval status path, "{id}" is substituted (default "/api/approvals/{id}"). */
  statusPath?: string
}

interface CredentialConfig {
  /** Which gate(s) decide. Default "ui". */
  approval?: ApprovalMode
  /** Broker URL returning the credential payload (required). */
  endpoint: string
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: unknown
  /** Approval TTL in minutes (default 30). */
  ttlMinutes?: number
  /** Resource pattern proposed to "Allow always" (default: the credential name). */
  savePattern?: string
}

interface Options {
  warden?: WardenConfig
  credentials?: Record<string, CredentialConfig>
}

interface ToolExecutionContext {
  sessionID: string
  agent?: string
  messageID: string
  id: string
  signal: AbortSignal
  progress(update: { status?: string }): Promise<void>
}

const log = (msg: string) => console.log(`[credential-hitl] ${msg}`)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default Plugin.define({
  id: "credential-hitl",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const credentials = options.credentials ?? {}
    const warden = options.warden

    const wardenHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Warden-Caller": warden?.caller ?? "opencode",
      }
      const token = process.env[warden?.tokenEnv ?? "WARDEN_TOKEN"]
      if (token) headers.Authorization = `Bearer ${token}`
      return headers
    }

    // POST {warden}/api/approvals -> { approvalId } — starts an HA approval
    // (actionable push + Warden UI row). See README.md for the contract.
    const wardenCreate = async (
      req: { name: string; reason: string; ttlMinutes: number },
      signal: AbortSignal,
    ): Promise<string> => {
      if (!warden?.url) throw new Error("warden approval requested but no 'warden.url' configured")
      const url = new URL(warden.createPath ?? "/api/approvals", warden.url).toString()
      const res = await fetch(url, {
        method: "POST",
        headers: wardenHeaders(),
        body: JSON.stringify({
          tool: req.name,
          reason: req.reason,
          ttlMinutes: req.ttlMinutes,
        }),
        signal,
      })
      if (!res.ok) throw new Error(`warden create approval: HTTP ${res.status}`)
      const data = (await res.json()) as Record<string, unknown>
      const id = data.approval_id ?? data.approvalId ?? data.id
      if (typeof id !== "string" || !id) throw new Error("warden create approval: no approval id in response")
      return id
    }

    // GET {warden}/api/approvals/{id} -> { status } — poll until decided or TTL.
    const wardenAwait = async (
      req: { name: string; reason: string; ttlMinutes: number },
      signal: AbortSignal,
    ): Promise<WardenStatus> => {
      const id = await wardenCreate(req, signal)
      log(`approval ${id} started for '${req.name}' (${req.ttlMinutes}m TTL)`)
      const statusPath = warden?.statusPath ?? "/api/approvals/{id}"
      const pollMs = warden?.pollMs ?? 3000
      const deadline = Date.now() + req.ttlMinutes * 60_000
      while (Date.now() < deadline) {
        if (signal.aborted) throw new DOMException("approval wait aborted", "AbortError")
        const url = new URL(statusPath.replace("{id}", encodeURIComponent(id)), warden?.url).toString()
        const res = await fetch(url, { headers: wardenHeaders(), signal })
        if (res.ok) {
          const data = (await res.json()) as Record<string, unknown>
          const status = String(data.status ?? "pending")
          log(`approval ${id} status: ${status}`)
          if (status === "approved" || status === "denied" || status === "expired") return status
        }
        await sleep(pollMs)
      }
      return "expired"
    }

    // Locate the pending permission request created by ctx.permission.assert so a
    // Warden decision can resolve it. The list() item shape is probed defensively:
    // match on the tool-call source first, fall back to a single pending request.
    const findPendingRequestID = async (
      sessionID: string,
      source: { messageID: string; id: string },
      signal: AbortSignal,
    ): Promise<string | undefined> => {
      for (let attempt = 0; attempt < 15; attempt++) {
        if (signal.aborted) return undefined
        try {
          const res = (await ctx.permission.list({ sessionID })) as unknown
          const items: Record<string, unknown>[] = Array.isArray(res)
            ? (res as Record<string, unknown>[])
            : (((res as Record<string, unknown> | undefined)?.requests ??
                (res as Record<string, unknown> | undefined)?.items) as Record<string, unknown>[] | undefined) ?? []
          const bySource = items.find((item) => {
            const s = item.source as { messageID?: string; id?: string } | undefined
            return s?.messageID === source.messageID && s?.id === source.id
          })
          const req = bySource ?? (items.length === 1 ? items[0] : undefined)
          const id = (req?.requestID ?? req?.id) as string | undefined
          if (typeof id === "string" && id.length > 0) return id
        } catch (err) {
          log(`permission.list failed: ${(err as Error).message}`)
        }
        await sleep(400)
      }
      return undefined
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "get_credential",
        description:
          "Request a short-lived credential that is gated by human approval (HITL). " +
          "Every call is reviewed by a person - either as an interactive question in the " +
          "OpenCode UI or as a Home Assistant approval via Warden. Use only when the task " +
          "genuinely needs the credential and state a specific reason. The returned value " +
          "is sensitive and usually short-lived: use it directly, never write it to files " +
          "or echo it into logs.",
        input: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Credential id to request. Known ids: " +
                (Object.keys(credentials).length ? Object.keys(credentials).join(", ") : "(none configured)"),
            },
            reason: {
              type: "string",
              description: "Why this credential is needed right now (shown to the reviewer).",
            },
          },
          required: ["name", "reason"],
          additionalProperties: false,
        },
        execute: async (input: unknown, toolCtx: ToolExecutionContext) => {
          const { name, reason } = input as { name: string; reason: string }
          const cfg = credentials[name]
          if (!cfg) {
            const known = Object.keys(credentials)
            throw new Error(
              `credential-hitl: unknown credential '${name}'. Known: ${known.length ? known.join(", ") : "(none configured)"}`,
            )
          }
          if (!cfg.endpoint) throw new Error(`credential-hitl: credential '${name}' has no broker endpoint`)

          const mode: ApprovalMode = cfg.approval ?? "ui"
          const ttlMinutes = cfg.ttlMinutes ?? 30
          const useWarden = mode !== "ui" && warden?.url != null
          if (mode === "warden" && !useWarden) {
            throw new Error("credential-hitl: approval 'warden' requires the 'warden' plugin options")
          }

          await toolCtx.progress({ status: "requesting approval" })

          if (mode === "ui" || (mode === "both" && !useWarden)) {
            if (mode === "both") log("warden not configured - falling back to the UI prompt")
            await ctx.permission.assert({
              sessionID: toolCtx.sessionID,
              agent: toolCtx.agent,
              source: { type: "tool", messageID: toolCtx.messageID, id: toolCtx.id },
              action: "credential",
              resources: [name],
              save: [cfg.savePattern ?? name],
              metadata: { reason },
            })
          } else if (useWarden && mode === "both") {
            // Parallel answer channels: the in-UI prompt and the HA push describe the
            // same decision. Whichever the human answers first wins; the Warden
            // decision resolves the OpenCode permission request via permission.reply.
            const source = { type: "tool" as const, messageID: toolCtx.messageID, id: toolCtx.id }
            const assertPromise = ctx.permission.assert({
              sessionID: toolCtx.sessionID,
              agent: toolCtx.agent,
              source,
              action: "credential",
              resources: [name],
              save: [cfg.savePattern ?? name],
              metadata: { reason },
            })

            const controller = new AbortController()
            const onAbort = () => controller.abort()
            toolCtx.signal.addEventListener("abort", onAbort, { once: true })
            const bridgePromise = (async () => {
              try {
                const status = await wardenAwait({ name, reason, ttlMinutes }, controller.signal)
                const requestID = await findPendingRequestID(toolCtx.sessionID, source, controller.signal)
                if (requestID) {
                  await ctx.permission.reply({
                    sessionID: toolCtx.sessionID,
                    requestID,
                    decision: status === "approved" ? "once" : "reject",
                  })
                } else if (status !== "approved") {
                  log(`no pending request found to reject for '${name}' - UI prompt stays active`)
                }
                return status
              } catch (err) {
                log(`warden bridge unavailable: ${(err as Error).message}`)
                return "unavailable" as const
              }
            })()

            const winner = await Promise.race([
              assertPromise.then(() => "ui" as const),
              bridgePromise as Promise<WardenStatus | "unavailable">,
            ])
            if (winner === "ui") controller.abort()
            // The gate is always the permission assert: a Warden deny/expire already
            // replied `reject`, which makes this throw a Tool.Error the model sees.
            await assertPromise
            toolCtx.signal.removeEventListener("abort", onAbort)
          } else {
            // approval: "warden" — HA/Warden tap only, no in-UI prompt.
            await toolCtx.progress({ status: "waiting for Warden approval (HA)" })
            const status = await wardenAwait({ name, reason, ttlMinutes }, toolCtx.signal)
            if (status !== "approved") {
              throw new Error(`credential-hitl: '${name}' was ${status} by the reviewer (Warden HITL)`)
            }
          }

          await toolCtx.progress({ status: "fetching credential" })
          const res = await fetch(cfg.endpoint, {
            method: cfg.method ?? "GET",
            headers: { ...(cfg.headers ?? {}) },
            body: cfg.body !== undefined ? JSON.stringify(cfg.body) : undefined,
            signal: toolCtx.signal,
          })
          if (!res.ok) throw new Error(`credential-hitl: broker for '${name}' returned HTTP ${res.status}`)
          return { content: await res.text() }
        },
      })
    })
  },
})
