# mcp-guard-gateway-browser — `browser-orchestrator`

Self-contained implementation of the **Browser Broker** design
(`x64-rack-server/docs/BROWSER_BROKER.md`, Part 10) as a single Node 24 + Hono
process running on the `browser-host` Incus instance. Per-project sessions, each
owning:

```
Xvfb :N → headed Chromium (--remote-debugging-port=922N)
        → x11vnc (view-only, localhost:590N)      ← passive watchers
        → x11vnc (interactive, localhost:609N)    ← operator takeover input
        → websockify (608N → 590N, raw WS endpoint for the view-only port)
        → npx @playwright/mcp   (--isolated --cdp-endpoint=http://127.0.0.1:922N)
        → npx chrome-devtools-mcp (--browserUrl=http://127.0.0.1:922N)
```

Static pool mapping `display :N ↔ CDP 922N ↔ vnc 590N ↔ ws 608N ↔ vnc input 609N`,
`N ∈ 1..8`, mutex-allocated. Listens on `ORCHESTRATOR_PORT` (default 8940).

**Watching is passive, takeover is explicit.** Opening `WS /p/:project/vnc`
never changes the session mode: while the session is in `agent` mode the WS is
relayed to the **view-only** x11vnc (`-viewonly` — keyboard/mouse input is
dropped and never reaches Chromium). `POST /api/sessions/:slug/mode
{"mode":"operator"}` is the only takeover trigger; after it (and after
reconnecting the WS, which picks the route at connect time) the WS is relayed to
the **interactive** x11vnc and viewer input drives the browser. `{"mode":"agent"}`
releases back to the agent. Auto-release after `IDLE_OPERATOR_MINUTES` counts
only **interactive** (takeover) WS connections — a lingering passive watcher
never holds `operator` mode.

## Layout

| Path | What |
|---|---|
| `src/machine.ts` | Pure session state machine (`stopped/booting/ready/error` × `agent/operator`), crash-loop rules |
| `src/supervisor.ts` | One session's process tree: spawn specs, boot readiness gate, crash policy, shutdown order, stdio facade |
| `src/manager.ts` | project → supervisor map, boot queue vs `MAX_SESSIONS`, RAM floor, idle GC, operator auto-release |
| `src/rpc.ts` | Newline-delimited JSON-RPC over stdio (id matching, timeouts) + `McpChild` with cached `initialize` handshake |
| `src/spawner.ts` / `src/host.ts` | `ProcessSpawner` / `SupervisorPorts` interfaces + real implementations — **all** process/fs/network access is behind them so tests run without Xvfb/Chromium |
| `src/server.ts` | Hono HTTP surface (facade, management, viewer routes) |
| `src/wsproxy.ts` | WS upgrade handler: `/p/:project/vnc` (RFB relay — view-only 590N in `agent` mode, interactive 609N in `operator` mode, picked at connect time) + `/p/:project/cast` |
| `src/screencast.ts` / `src/cdp.ts` | Screencast engine (raw CDP, `Page.startScreencast` webp q60 ≤1280×720, ~5 fps token bucket, latest-frame-only fan-out) |
| `src/artifacts.ts` | Artifact store: capture playwright `--output-dir` output, content ids, GC (14 days / 5 GB LRU) |
| `src/profiles.ts` | Browser profiles (Phase 3): lock files (0600, one session at a time), storage-state snapshots |
| `test/` | vitest unit tests (self-contained — the parent repo's vitest does not pick them up) |

## API

**MCP facade** (auth: `Authorization: Bearer $ORCHESTRATOR_TOKEN`):

- `POST /mcp` / `POST /devtools` — project from `X-Warden-Caller`, fallback `_default`
- `POST /p/:project/mcp` (→ `@playwright/mcp`) and `POST /p/:project/devtools` (→ `chrome-devtools-mcp`)
- Stateless JSON-RPC over HTTP: one message per request, forwarded over the
  child's newline-delimited stdio framing, response matched by id. `initialize`
  is **synthesized** from a per-child cached handshake (never re-forwarded);
  `tools/list` / `tools/call` are forwarded verbatim. First call for a project
  boots the session and waits (~2–3 s target, 10 s budget). After each
  `tools/call` new files in the session's `--output-dir` are captured and
  `result._meta.artifact_id` (+ `artifact_ids`) is attached.

**Management** (same token): `GET /api/sessions`, `GET|POST|DELETE /api/sessions/:slug`,
`POST /api/sessions/:slug/mode` `{mode:'agent'|'operator'}`,
`POST /api/sessions/:slug/profile` `{action:'attach'|'commit'|'detach', name}`,
`GET /api/sessions/:slug/artifacts`, `GET /artifacts/:id`, `GET /healthz`,
`GET /metrics`. Session info carries `viewers` (passive noVNC watchers) and
`takeoverViewers` (interactive noVNC connections) as separate counts.

**Viewer** (no token — Authelia forwardAuth at the reverse proxy):
`WS /p/:project/vnc` (RFB over WS; **passive** in `agent` mode — routed to the
view-only x11vnc, input dropped — and interactive in `operator` mode, routed to
the interactive x11vnc; the route is picked at connect time),
`WS /p/:project/cast` (screencast frames: JSON header `{type:'frame',url,ts}` +
binary WebP), `/novnc/*` (real noVNC assets from `NOVNC_PATH`, dev placeholder
otherwise), `GET /` (minimal session picker with **Take Over**/**Release**
buttons), `GET /p/:project/view` (fallback view page: noVNC in an iframe +
**Take Over**/**Release** buttons that call the mode API and then reconnect the
noVNC WS to pick up the new route — the fallback UI prompts once for
`ORCHESTRATOR_TOKEN` and keeps it in localStorage), `GET /p/:project/vnc`
(redirects to the preconfigured noVNC client).

## Implemented

- Full session lifecycle: boot readiness gate (Xvfb → CDP `/json/version` →
  vnc/input/ws ports listening → MCP `initialize` handshakes → `ready`), stuck-boot
  retry once then `error`, teardown in spec order (MCP children → Chromium
  SIGTERM→SIGKILL after 5 s → both x11vncs → websockify → Xvfb).
- Crash policy: Chromium death errors in-flight calls and auto-reboots the
  session; >3 crashes within 5 min → `error` state, boots refused until
  `DELETE` + `POST`. A dead MCP stdio child is restarted with only its
  in-flight calls failing.
- Mode gate: `operator` is entered **only** via the API (`POST
  /api/sessions/:slug/mode`) or the fallback UI's **Take Over** button — opening
  the noVNC WS is passive and never blocks the agent (input gating is two x11vnc
  processes per display: `-viewonly` 590N for watchers, interactive 609N for
  takeovers). Facade calls reject with `taken over by operator — retry after
  release` (`tools/call` gets a clean `isError` result, other methods a JSON-RPC
  error). Released via the API / **Release** button or after 5 min with no
  *interactive* viewer WS (passive watchers don't hold the mode).
  Takeovers/releases/crashes/boots go into a per-session timeline
  (`GET /api/sessions/:slug`).
- Idle GC (30 min without tool call or WS viewer → teardown), operator idle
  (5 min without an interactive viewer → auto-release), Chromium RSS watchdog (restart at 1.5 GB), boot queue
  (`MAX_SESSIONS`, 30 s then error), RAM floor refusal (1.5 GB free).
- Artifact capture + content-addressed ids + on-disk index rebuild + daily GC
  (14 days and 5 GB, LRU eviction first).
- Screencast engine (Phase 2) as specified: orchestrator-owned flattened CDP
  session, `Page.startScreencast` webp q60 ≤1280×720, frame acks, ~5 fps token
  bucket, latest-frame-only per viewer, stops with the last viewer, re-arms on
  target creation.
- Structured JSON lifecycle logs.

## Stubbed / deferred

- **Profiles (Phase 3) are partial.** `attach`/`detach` enforce the 0600 +
  one-session-at-a-time lock and restart Chromium with
  `--user-data-dir=<PROFILES_DIR>/<name>`; `commit` snapshots **cookies only**
  (CDP `Storage.getCookies`) into `storage-state-<name>.json` in Playwright's
  shape — the `origins` (localStorage) list is left empty. HITL gating of
  profile attach is Warden-side (Part 11) and not implemented here.
- **Session `title`** in `GET /api/sessions` is currently always `null`
  (`currentUrl` is tracked from the screencast/CDP navigation events).
- **Orphan PID cleanup from a pidfile dir** (Part 10.2) is not implemented: all
  session processes are direct children of the orchestrator and the container's
  PID namespace reaps them when it exits; state is intentionally not durable.
- **`/api/ha-summary`** (Part 9 telemetry) is not implemented.
- Not in this package by design: Warden-side changes (`X-Warden-Caller`
  propagation, `enforceBrowserBoundary`, policy seeding, `/api/browser/*`
  proxy), the nftables egress filter (Part 12.4) and Traefik/instances.yaml
  wiring (Part 12.1/12.3).

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `ORCHESTRATOR_TOKEN` | *(required)* | Bearer token for management + facade endpoints (fail closed) |
| `ORCHESTRATOR_PORT` | `8940` | Listen port |
| `ORCHESTRATOR_HOSTNAME` | `0.0.0.0` | Listen address |
| `ARTIFACTS_DIR` | `/var/lib/browser-host/artifacts` | Artifact store root (staging under `<root>/_staging`) |
| `PROFILES_DIR` | `/var/lib/browser-host/profiles` | Browser profile store root |
| `MAX_SESSIONS` | `2` | Concurrent live sessions; further boots queue then error after 30 s |
| `POOL_SIZE` | `8` | Display/port pool (`N ∈ 1..POOL_SIZE`) |
| `IDLE_SESSION_MINUTES` | `30` | Teardown after this long with no tool call / WS viewer (watchers and takeover viewers both count) |
| `IDLE_OPERATOR_MINUTES` | `5` | Auto-release from `operator` with no **interactive** (takeover) viewer WS — passive watchers don't hold the mode |
| `BOOT_TIMEOUT_MS` | `10000` | Boot readiness budget per attempt |
| `BOOT_QUEUE_TIMEOUT_MS` | `30000` | Queued boot wait before erroring |
| `SHUTDOWN_GRACE_MS` | `5000` | SIGTERM → SIGKILL grace |
| `RAM_FLOOR_BYTES` | `1500000000` | Refuse new boots below this much free RAM |
| `CHROMIUM_RAM_LIMIT_BYTES` | `1500000000` | Per-session Chromium RSS watchdog |
| `REQUEST_TIMEOUT_MS` | `120000` | Facade → MCP child request timeout |
| `CRASH_WINDOW_MS` / `CRASH_LIMIT` | `300000` / `3` | Crash-loop policy (>3 in window → `error`) |
| `SCREENCAST_FPS` | `5` | Screencast fan-out token bucket |
| `GC_MAX_AGE_DAYS` / `GC_MAX_BYTES` | `14` / `5000000000` | Artifact GC thresholds |
| `CHROMIUM_BIN` | `chromium` | Chromium binary |
| `NOVNC_PATH` | `/usr/share/novnc` | noVNC client assets (dev: placeholder page) |
| `FALLBACK_DISPLAY` | `0` | Entrypoint: start a debug Xvfb `:0` + openbox + x11vnc |
| `ROLE` | *(unset → gateway)* | Entrypoint role switch (root `entrypoint.sh`): `browser` runs the browser-orchestrator instead of the gateway |

## Development

```
npm install
npm run build     # tsc → dist/
npm test          # vitest (mocked ProcessSpawner/SupervisorPorts — no Xvfb needed)
```

## Deployment

**One image, two instances.** The orchestrator ships inside the merged Warden
image `ghcr.io/jaggr2/mcp-guard-gateway` (root `Dockerfile`, built by
`.github/workflows/publish.yml`) together with the gateway and the browser
runtime (Xvfb/openbox/x11vnc/noVNC/Chromium). The `warden` and `browser-host`
Incus instances run the **same** image with different entrypoint roles
(root `entrypoint.sh`):

- `warden` — default CMD → gateway (`node dist/index.js`, port 8080)
- `browser-host` — `ROLE=browser` → browser-orchestrator
  (`node /app/browser/dist/index.js`, port `ORCHESTRATOR_PORT`)

The standalone `ghcr.io/jaggr2/mcp-guard-gateway-browser` image,
`.github/workflows/publish-browser.yml` and this directory's own
`Dockerfile`/`entrypoint.sh` are gone; the orchestrator's dependency tree and
build live in the root Dockerfile's `browser-build` stage. The package itself
still builds and tests independently (`npm run build`, `npm test`).
