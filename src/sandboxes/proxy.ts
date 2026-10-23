import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConfigStore, ProjectRow } from "../store/config";

const execFileAsync = promisify(execFile);

/**
 * Wake-on-Visit Reverse Proxy & Idle Sandbox Manager for `<project>.oc.jaggi.xyz`.
 *
 * - Extracts `<project>` from `Host: <project>.oc.jaggi.xyz`.
 * - Updates `last_active_at` on every visit.
 * - If the sandbox is stopped, triggers `sandbox-ctl.py start <project>` and serves
 *   an auto-refreshing dark-mode splash screen until OpenCode Web (:4096) responds.
 */

export function extractSandboxSlugFromHost(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(":")[0].trim().toLowerCase();
  const match = /^([a-z0-9][a-z0-9-]{0,48}[a-z0-9])\.oc\.jaggi\.xyz$/.exec(host);
  return match ? match[1] : null;
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
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Waking up <code>${project.slug}</code> sandbox…</h1>
    <p>Incus is starting <code>oc-${project.slug}</code>. This page will connect automatically in ~2 seconds.</p>
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
    return new Response(`Sandbox '${slug}' is not registered in Warden. Provision it at https://warden.jaggi.xyz/sandboxes`, {
      status: 404,
    });
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
    // Container is stopped or still booting -> trigger wake via sandbox-ctl.py and return splash HTML
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
