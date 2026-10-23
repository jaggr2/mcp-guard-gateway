import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConfigStore, ProjectRow } from "../store/config";

const execFileAsync = promisify(execFile);

/** Base64url of `/home/opencode/workspace` used by OpenCode Web's `/:dir/session` router. */
export const WORKSPACE_PATH = "/home/opencode/workspace";
export const WORKSPACE_B64 = Buffer.from(WORKSPACE_PATH, "utf8").toString("base64url");

const initializedProjects = new Set<string>();

/**
 * Wake-on-Visit Reverse Proxy, Auto-Project Initializer & Idle Sandbox Manager.
 *
 * Supports three routing modes simultaneously (so no Cloudflare wildcard is required!):
 *   1. Single-hostname mode on `oc.jaggi.xyz` (and `derog-opencode.jaggi.xyz`):
 *      - `GET /s/<project>` sets cookie `warden_sandbox=<project>` and redirects to `/<WORKSPACE_B64>/session`
 *      - All subsequent requests on `/*` proxy to the active `warden_sandbox` cookie!
 *      - `GET /picker` (or `/` with no cookie) renders a fast Sandbox Switcher page.
 *   2. Flat subdomain mode (`oc-<project>.jaggi.xyz`).
 *   3. Nested subdomain mode (`<project>.oc.jaggi.xyz`).
 */

export function extractSandboxSlugFromHost(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(":")[0].trim().toLowerCase();
  const nested = /^([a-z0-9][a-z0-9-]{0,48}[a-z0-9])\.oc\.jaggi\.xyz$/.exec(host);
  if (nested) return nested[1];
  const flat = /^oc-([a-z0-9][a-z0-9-]{0,48}[a-z0-9])\.jaggi\.xyz$/.exec(host);
  if (flat) return flat[1];
  return null;
}

export function extractSandboxCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "warden_sandbox") {
      const val = rest.join("=").trim().toLowerCase();
      if (/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(val)) {
        return val;
      }
    }
  }
  return null;
}

export async function runSandboxCtl(
  scriptPath: string,
  args: string[]
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    const { stdout } = await execFileAsync("python3", [scriptPath, ...args], { timeout: 60_000 });
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return { ok: parsed.ok !== false, data: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ensures the sandbox's OpenCode SQLite DB has initialized `/home/opencode/workspace`
 * and set its display name to `project.slug` (instead of "workspace").
 */
export async function ensureSandboxProjectInitialized(
  upstreamOrigin: string,
  project: ProjectRow
): Promise<void> {
  if (initializedProjects.has(project.slug)) return;
  try {
    const base = upstreamOrigin.replace(/\/$/, "");
    const curRes = await fetch(`${base}/project/current?directory=${encodeURIComponent(WORKSPACE_PATH)}`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!curRes.ok) return;
    const cur = (await curRes.json()) as { id?: string; name?: string };
    if (cur?.id && cur.name !== project.slug) {
      await fetch(`${base}/project/${encodeURIComponent(cur.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: project.slug }),
        signal: AbortSignal.timeout(2000),
      });
    }
    initializedProjects.add(project.slug);
  } catch {
    /* best-effort */
  }
}

/**
 * External JS served at `/__warden-init.js` (permitted by OpenCode's `script-src 'self'` CSP).
 * Pre-seeds `localStorage["opencode.global.dat:server"]` so `/home/opencode/workspace` is
 * immediately open & expanded in OpenCode Web's sidebar, and adds a floating project switcher pill.
 */
export function renderWardenInitJs(project: ProjectRow): string {
  const slugJson = JSON.stringify(project.slug);
  const titleJson = JSON.stringify(`${project.displayName} · OpenCode`);
  const wtJson = JSON.stringify(WORKSPACE_PATH);
  const b64Json = JSON.stringify(WORKSPACE_B64);

  return `(function(){
  try {
    var wt = ${wtJson};
    var b64 = ${b64Json};
    var slug = ${slugJson};
    var key = "opencode.global.dat:server";
    var raw = localStorage.getItem(key);
    var data = raw ? JSON.parse(raw) : { list: [], projects: {}, lastProject: {}, recentlyClosed: {} };
    data.projects = data.projects || {};
    data.lastProject = data.lastProject || {};
    data.recentlyClosed = data.recentlyClosed || {};
    var scopes = ["local", window.location.origin];
    for (var i = 0; i < scopes.length; i++) {
      var s = scopes[i];
      var list = Array.isArray(data.projects[s]) ? data.projects[s] : [];
      var existing = list.find(function(p) { return p && p.worktree === wt; });
      if (!existing) {
        list.unshift({ worktree: wt, expanded: true });
      } else {
        existing.expanded = true;
      }
      data.projects[s] = list;
      data.lastProject[s] = wt;
    }
    localStorage.setItem(key, JSON.stringify(data));
    document.title = ${titleJson};
    if (window.location.pathname === "/" && !window.location.search.includes("home=1")) {
      window.history.replaceState(null, "", "/" + b64 + "/session");
    }
    window.addEventListener("DOMContentLoaded", function() {
      if (document.getElementById("warden-switcher-pill")) return;
      var pill = document.createElement("div");
      pill.id = "warden-switcher-pill";
      pill.style.cssText = "position:fixed;bottom:10px;right:12px;z-index:99999;background:#161b22ee;border:1px solid #30363d;color:#e6edf3;padding:4px 10px;border-radius:999px;font:12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;display:flex;gap:8px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,0.4)";
      var label = document.createElement("span");
      label.textContent = "🛡️ " + slug;
      label.style.fontWeight = "600";
      var link = document.createElement("a");
      link.href = "/picker";
      link.textContent = "Switch Project";
      link.style.cssText = "color:#58a6ff;text-decoration:none";
      pill.appendChild(label);
      pill.appendChild(link);
      document.body.appendChild(pill);
    });
  } catch (e) {}
})();\n`;
}

export function renderSandboxPickerHtml(projects: ProjectRow[], activeSlug: string | null): string {
  const cards = projects
    .map(
      (p) => `
      <a class="card" href="/s/${p.slug}">
        <div class="row">
          <strong>${p.displayName}</strong>
          <span class="badge ${p.status === "running" ? "running" : ""}">${p.status}</span>
        </div>
        <div class="meta"><code>jaggr2/${p.slug}</code> · branch <code>${p.branch}</code> · ${p.lifecycleMode}</div>
      </a>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Sandboxes · oc.jaggi.xyz</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; padding: 2.5rem 1.5rem;
      background: #0d1117; color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; flex-direction: column; align-items: center;
    }
    .wrap { width: 100%; max-width: 680px; }
    h1 { font-size: 1.5rem; margin: 0 0 0.3rem; }
    p.sub { color: #8b949e; margin: 0 0 1.5rem; font-size: 0.92rem; }
    .grid { display: flex; flex-direction: column; gap: 0.75rem; }
    a.card {
      display: block; text-decoration: none; color: inherit;
      background: #161b22; border: 1px solid #30363d; border-radius: 12px;
      padding: 1rem 1.25rem; transition: border-color 0.15s, transform 0.12s;
    }
    a.card:hover { border-color: #58a6ff; transform: translateY(-2px); }
    .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; }
    .meta { color: #8b949e; font-size: 0.82rem; }
    .badge {
      padding: 2px 8px; border-radius: 10px; font-size: 0.72rem;
      background: #30363d; color: #c9d1d9; text-transform: uppercase;
    }
    .badge.running { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb; }
    .footer { margin-top: 1.75rem; font-size: 0.85rem; color: #8b949e; }
    .footer a { color: #58a6ff; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>🛡️ OpenCode Project Sandboxes</h1>
    <p class="sub">Select a project to open its pre-configured workspace on <code>oc.jaggi.xyz</code>${activeSlug ? ` (current: <code>${activeSlug}</code>)` : ""}.</p>
    <div class="grid">${cards}</div>
    <div class="footer">
      Manage budgets, MCP policies &amp; provision new repos in <a href="https://warden.jaggi.xyz/sandboxes">Warden Control Plane ↗</a>
    </div>
  </div>
</body>
</html>`;
}

export function renderWakeSplashHtml(project: ProjectRow): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="2">
  <title>Waking ${project.displayName} · Warden Sandbox</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: #0d1117; color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .card {
      background: #161b22; border: 1px solid #30363d; border-radius: 14px;
      padding: 2rem 2.5rem; text-align: center; max-width: 440px;
    }
    .spinner {
      width: 36px; height: 36px; margin: 0 auto 1.2rem;
      border: 3px solid #30363d; border-top-color: #58a6ff;
      border-radius: 50%; animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.2rem; margin: 0 0 0.5rem; }
    p { color: #8b949e; font-size: 0.9rem; margin: 0.3rem 0; }
    code { color: #58a6ff; }
    a { color: #58a6ff; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Waking up <code>${project.slug}</code> sandbox…</h1>
    <p>Incus is starting <code>oc-${project.slug}</code>. This page will connect automatically in ~2 seconds.</p>
    <p style="margin-top:1rem"><a href="/picker">Switch project</a></p>
  </div>
</body>
</html>`;
}

export async function handleSandboxReverseProxy(
  request: Request,
  slug: string,
  configStore: ConfigStore,
  sandboxCtlScript: string
): Promise<Response> {
  const project = configStore.getProject(slug);
  if (!project) {
    return new Response(
      `Sandbox '${slug}' is not registered in Warden. Provision it at https://warden.jaggi.xyz/sandboxes`,
      { status: 404 }
    );
  }

  const reqUrl = new URL(request.url);
  if (reqUrl.pathname === "/__warden-init.js") {
    return new Response(renderWardenInitJs(project), {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  configStore.touchProjectActivity(slug, "running");

  const upstreamOrigin =
    configStore.getSetting(`sandbox.${slug}.upstreamUrl`) ?? `http://oc-${slug}.warden.internal:4096`;
  const targetUrl = `${upstreamOrigin.replace(/\/$/, "")}${reqUrl.pathname}${reqUrl.search}`;

  // Use a 2.5s timeout ONLY for establishing the connection / receiving response headers
  // so long-lived SSE streams (/global/event, /event) stay connected indefinitely!
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), 2500);

  try {
    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete("accept-encoding"); // ensure plain text/html so we can inject `/__warden-init.js`

    const res = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    clearTimeout(connectTimer);

    void ensureSandboxProjectInitialized(upstreamOrigin, project);

    const contentType = res.headers.get("content-type") ?? "";
    if (request.method === "GET" && contentType.includes("text/html")) {
      const html = await res.text();
      const injected = html.replace(
        "<script type=\"module\"",
        `<script src="/__warden-init.js"></script><script type="module"`
      );
      const outHeaders = new Headers(res.headers);
      outHeaders.delete("content-length");
      outHeaders.delete("content-encoding");
      return new Response(injected, { status: res.status, headers: outHeaders });
    }

    return res;
  } catch {
    clearTimeout(connectTimer);
    initializedProjects.delete(slug);
    void runSandboxCtl(sandboxCtlScript, ["start", slug]);
    return new Response(renderWakeSplashHtml(project), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
}

/** Stops any `auto-stop` sandboxes whose `last_active_at` is older than `idle_timeout_minutes`. */
export async function sweepIdleSandboxes(
  configStore: ConfigStore,
  sandboxCtlScript: string,
  nowMs = Date.now()
): Promise<string[]> {
  const stopped: string[] = [];
  for (const proj of configStore.listProjects()) {
    if (proj.lifecycleMode !== "auto-stop" || proj.status !== "running") {
      continue;
    }
    const lastMs = proj.lastActiveAt ? Date.parse(proj.lastActiveAt) : 0;
    const timeoutMs = Math.max(5, proj.idleTimeoutMinutes) * 60_000;
    if (lastMs > 0 && nowMs - lastMs > timeoutMs) {
      await runSandboxCtl(sandboxCtlScript, ["stop", proj.slug]);
      configStore.upsertProject({ ...proj, status: "stopped" });
      stopped.push(proj.slug);
    }
  }
  return stopped;
}
