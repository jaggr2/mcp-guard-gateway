import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConfigStore, ProjectRow } from "../store/config";

const execFileAsync = promisify(execFile);

/**
 * Wake-on-Visit Reverse Proxy & Idle Sandbox Manager.
 *
 * Supports three routing modes simultaneously (so no Cloudflare wildcard is required!):
 *   1. Single-hostname mode on `oc.jaggi.xyz`:
 *      - `GET https://oc.jaggi.xyz/s/<project>` sets cookie `warden_sandbox=<project>` and redirects to `/`
 *      - All subsequent requests on `https://oc.jaggi.xyz/*` proxy to the active `warden_sandbox` cookie!
 *      - `GET https://oc.jaggi.xyz/picker` (or `/` with no cookie) renders a fast Sandbox Switcher page.
 *   2. Flat subdomain mode (`oc-<project>.jaggi.xyz`) — works with Cloudflare free `*.jaggi.xyz` SSL.
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
    <p class="sub">Select a project to switch <code>oc.jaggi.xyz</code> into that isolated sandbox${activeSlug ? ` (current: <code>${activeSlug}</code>)` : ""}.</p>
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

  configStore.touchProjectActivity(slug, "running");

  const upstreamOrigin =
    configStore.getSetting(`sandbox.${slug}.upstreamUrl`) ?? `http://oc-${slug}.warden.internal:4096`;
  const reqUrl = new URL(request.url);
  const targetUrl = `${upstreamOrigin.replace(/\/$/, "")}${reqUrl.pathname}${reqUrl.search}`;

  try {
    const res = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      duplex: "half",
      signal: AbortSignal.timeout(3000),
    } as RequestInit);
    return res;
  } catch {
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
