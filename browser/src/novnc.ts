import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { Context } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function placeholderNoVnc(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>noVNC (dev placeholder)</title></head>
<body style="font-family: sans-serif; margin: 2rem;">
  <h1>noVNC client assets not installed</h1>
  <p>This is the dev fallback page. In the container the real noVNC client is served
     from <code>/usr/share/novnc</code> (package <code>novnc</code>).</p>
  <p>The session's RFB WebSocket is exposed at <code>/p/&lt;project&gt;/vnc</code>
     and is routed per session mode: while the session is in <code>agent</code> mode
     it connects to the view-only x11vnc (input is dropped — watching is passive);
     after an explicit takeover (<code>operator</code> mode) it connects to the
     interactive x11vnc and keyboard/mouse input reaches Chromium.</p>
</body></html>`;
}

/** Tiny shared helper for the fallback UI: mode API calls + noVNC WS reconnect. */
export const VIEWER_JS = `
<script>
  function apiToken() {
    let t = localStorage.getItem('orchestratorToken');
    if (!t) {
      t = prompt('Orchestrator API token (ORCHESTRATOR_TOKEN):') || '';
      if (t) localStorage.setItem('orchestratorToken', t);
    }
    return t;
  }
  async function setMode(slug, mode) {
    const token = apiToken();
    if (!token) return null;
    const res = await fetch('/api/sessions/' + encodeURIComponent(slug) + '/mode', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode }),
    });
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok) { alert('mode change failed: ' + (body.error || res.status)); return null; }
    return body;
  }
</script>`;

/**
 * Minimal per-session view page (fallback UI — the polished Warden UI comes
 * later). Owns the noVNC connection in an iframe plus explicit **Take Over** /
 * **Release** buttons: they call `POST /api/sessions/:slug/mode` and then
 * reconnect the noVNC WS so it picks up the route for the new mode (view-only
 * x11vnc in `agent`, interactive x11vnc in `operator`).
 */
export function sessionViewPage(project: string): string {
  const slug = JSON.stringify(project).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>session ${project}</title>
<style>
  body { margin: 0; font-family: sans-serif; display: flex; flex-direction: column; height: 100vh; }
  .bar { padding: .5rem 1rem; border-bottom: 1px solid #ccc; display: flex; gap: .5rem; align-items: center; }
  .bar .spacer { flex: 1; }
  iframe { flex: 1; border: 0; width: 100%; }
</style></head>
<body>
  <div class="bar">
    <strong>session: ${project}</strong>
    <span id="mode">mode: …</span>
    <span class="spacer"></span>
    <span>watching is passive — take over to drive the browser</span>
    <button id="takeover" onclick="takeOver()">Take Over</button>
    <button id="release" onclick="releaseSession()">Release</button>
  </div>
  <iframe id="vnc" src="/novnc/vnc.html?path=p/${encodeURIComponent(project)}/vnc&autoconnect=1&resize=scale"></iframe>
${VIEWER_JS}
  <script>
    const slug = ${slug};
    const frame = document.getElementById('vnc');
    function show(info) {
      if (info) document.getElementById('mode').textContent = 'mode: ' + info.mode;
    }
    function reconnect() {
      // Tear down + re-establish the noVNC WS so it picks up the route for the
      // current mode (view-only x11vnc in agent, interactive x11vnc in operator).
      const base = frame.src.replace(/[?&]_reload=\\d+/, '');
      frame.src = base + (base.indexOf('?') >= 0 ? '&' : '?') + '_reload=' + Date.now();
    }
    async function takeOver() {
      show(await setMode(slug, 'operator'));
      reconnect();
    }
    async function releaseSession() {
      show(await setMode(slug, 'agent'));
      reconnect();
    }
  </script>
</body></html>`;
}

/**
 * Static noVNC client assets at `/novnc/` (viewer route — Authelia is in front).
 * In dev, when NOVNC_PATH does not exist, a tiny placeholder page is served.
 */
export function novncHandler(novncPath: string) {
  const root = path.resolve(novncPath);
  return async (c: Context): Promise<Response> => {
    const relRaw = c.req.path.replace(/^\/novnc\/?/, "");
    const rel = relRaw === "" ? "vnc.html" : relRaw;
    const resolved = path.resolve(root, path.posix.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, ""));
    if (!resolved.startsWith(root)) return c.text("not found", 404);
    try {
      await stat(resolved);
      const bytes = await readFile(resolved);
      const mime = MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
      return c.body(new Uint8Array(bytes), 200, { "content-type": mime });
    } catch {
      return c.html(placeholderNoVnc());
    }
  };
}
