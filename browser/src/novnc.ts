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
     (proxied to websockify on port 608N); point any noVNC client at that path to
     watch or take over the session.</p>
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
