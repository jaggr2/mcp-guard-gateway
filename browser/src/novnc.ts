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

/** Shared helper for the viewer UI: mode API (Warden proxy first, direct as fallback). */
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
    const body = JSON.stringify({ mode: mode });
    // 1) Warden's same-origin proxy (works behind Authelia — no token needed).
    let res = await fetch('/api/browser/sessions/' + encodeURIComponent(slug) + '/mode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body,
    });
    // 2) Direct orchestrator API (LAN access without the Warden UI) — token needed.
    if (res.status === 404) {
      const token = apiToken();
      if (!token) return null;
      res = await fetch('/api/sessions/' + encodeURIComponent(slug) + '/mode', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body,
      });
    }
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) { alert('mode change failed: ' + (data.error || res.status)); return null; }
    return data;
  }
</script>`;

/**
 * Standalone per-session viewer page (`/p/:project/view`). This page OWNS its
 * connection lifecycle — it is intentionally plain HTML/JS with no app framework:
 * embedded in the Warden UI (iframe, src set once) or opened full-screen, no
 * framework state change can ever re-trigger the live connection. It connects
 * via the noVNC RFB API with exponential-backoff auto-reconnect, and the Take
 * Over / Release buttons flip the session mode and reconnect to pick up the
 * mode's WS route (view-only x11vnc in agent, interactive x11vnc in operator).
 */
export function sessionViewPage(project: string): string {
  const slug = JSON.stringify(project).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>session ${project}</title>
<style>
  body { margin: 0; font-family: sans-serif; display: flex; flex-direction: column; height: 100vh; background: #0d1117; color: #e6edf3; }
  .bar { padding: .5rem 1rem; border-bottom: 1px solid #30363d; display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; }
  .bar .spacer { flex: 1; }
  .bar button { padding: .35rem .9rem; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; }
  .bar button:disabled { opacity: .5; cursor: default; }
  #status { color: #9da7b3; }
  #screen { flex: 1; overflow: hidden; background: #000; }
</style></head>
<body>
  <div class="bar">
    <strong>session: ${project}</strong>
    <span id="mode">mode: …</span>
    <span id="status">connecting…</span>
    <span class="spacer"></span>
    <span>watching is passive — take over to drive the browser</span>
    <button id="takeover" onclick="takeOver()">Take Over</button>
    <button id="release" onclick="releaseSession()">Release</button>
  </div>
  <div id="screen"></div>
${VIEWER_JS}
  <script type="module">
    const slug = ${slug};
    let rfb = null, retries = 0, timer = null, wantConnection = true;

    function setStatus(text) { document.getElementById('status').textContent = text; }
    function show(info) { if (info) document.getElementById('mode').textContent = 'mode: ' + info.mode; }

    async function connect() {
      clearTimeout(timer);
      wantConnection = true;
      setStatus(retries ? 'reconnecting (attempt ' + retries + ')…' : 'connecting…');
      let RFB;
      try {
        RFB = (await import('/novnc/core/rfb.js')).default;
      } catch (e) {
        setStatus('noVNC client assets not available');
        return;
      }
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = scheme + '//' + location.host + '/p/' + encodeURIComponent(slug) + '/vnc';
      rfb = new RFB(document.getElementById('screen'), url);
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener('connect', function () { retries = 0; setStatus('connected'); });
      rfb.addEventListener('disconnect', function (ev) {
        const clean = ev.detail && ev.detail.clean;
        if (clean || !wantConnection) { setStatus('disconnected'); return; }
        retries += 1;
        const delay = Math.min(15000, 1000 * Math.pow(2, retries - 1));
        setStatus('connection lost — retrying in ' + Math.round(delay / 1000) + 's…');
        timer = setTimeout(connect, delay);
      });
    }

    function restart() {
      wantConnection = false;
      if (rfb) { try { rfb.disconnect(); } catch (e) {} }
      setTimeout(connect, 250);
    }

    async function takeOver() {
      show(await setMode(slug, 'operator'));
      restart();
    }
    async function releaseSession() {
      show(await setMode(slug, 'agent'));
      restart();
    }
    window.takeOver = takeOver;
    window.releaseSession = releaseSession;
    connect();
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
