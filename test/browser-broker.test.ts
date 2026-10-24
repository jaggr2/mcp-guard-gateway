import { describe, expect, it } from "vitest";
import { bootstrap, ensureBrowserPolicies } from "../src/bootstrap";
import { enforceBrowserBoundary } from "../src/guards/security";
import type { ProjectRow } from "../src/store/config";
import { UpstreamClientImpl } from "../src/upstream/client";
import { makeDeps, registerUpstream, testConfig } from "./helpers";

function project(browserAllowedDomains = "", browserInternalTargets = ""): ProjectRow {
  return {
    slug: "rsearch",
    displayName: "rsearch",
    repoUrl: "https://github.com/jaggr2/rsearch",
    template: "fullstack",
    lifecycleMode: "auto-stop",
    idleTimeoutMinutes: 120,
    dailyBudgetUsd: 5,
    monthlyBudgetUsd: 30,
    hourlyTokenCap: 500_000,
    dailyTokenCap: 2_500_000,
    awsRoleArn: null,
    awsDeployRoleArn: null,
    allowedUpstreams: "github,aws,playwright,devtools",
    browserAllowedDomains,
    browserInternalTargets,
    tokenHash: null,
    status: "running",
    branch: "main",
    dirtyFiles: 0,
    lastActiveAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function navigate(url: unknown, tool = "playwright_browser_navigate", proj = project()) {
  return enforceBrowserBoundary(proj, tool, { url });
}

describe("enforceBrowserBoundary (Browser Broker)", () => {
  it("allows http/https navigation to public destinations", () => {
    expect(navigate("https://example.com/docs").ok).toBe(true);
    expect(navigate("http://example.org/").ok).toBe(true);
  });

  it("denies dangerous URL schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "view-source:https://example.com",
      "chrome://settings",
      "ftp://example.com",
    ]) {
      expect(navigate(url).ok, url).toBe(false);
    }
  });

  it("denies literal private/loopback/link-local destinations", () => {
    for (const url of [
      "http://10.0.0.5/admin",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://127.0.0.1:8080/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:3000/",
      "http://[fd00::1]/",
      "http://localhost:8080/",
    ]) {
      expect(navigate(url).ok, url).toBe(false);
    }
    // 172.32/16 is outside 172.16/12 and stays public
    expect(navigate("http://172.32.0.1/").ok).toBe(true);
  });

  it("denies .internal/.lan hostnames", () => {
    expect(navigate("http://foo.internal/").ok).toBe(false);
    expect(navigate("http://foo.internal:8080/").ok).toBe(false);
    expect(navigate("http://printer.lan/").ok).toBe(false);
  });

  it("allows private destinations listed in browserInternalTargets", () => {
    const proj = project("", "192.168.30.10:8123,ha.internal");
    expect(navigate("http://192.168.30.10:8123/lovelace", "playwright_browser_navigate", proj).ok).toBe(true);
    expect(navigate("http://ha.internal/", "playwright_browser_navigate", proj).ok).toBe(true);
    // exact match: same host on another port, or another host, stays denied
    expect(navigate("http://192.168.30.10:9999/", "playwright_browser_navigate", proj).ok).toBe(false);
    expect(navigate("http://other.internal/", "playwright_browser_navigate", proj).ok).toBe(false);
    // the exception also unblocks the devtools navigation tool
    expect(navigate("http://192.168.30.10:8123/", "devtools_navigate_page", proj).ok).toBe(true);
  });

  it("'*' allows any domain", () => {
    const proj = project("*");
    expect(navigate("https://anything.example/", "playwright_browser_navigate", proj).ok).toBe(true);
    expect(navigate("http://weird-name.test:9000/x", "playwright_browser_navigate", proj).ok).toBe(true);
  });

  it("default '' policy allows public and denies private", () => {
    expect(navigate("https://example.com/").ok).toBe(true);
    expect(navigate("http://10.0.0.5/").ok).toBe(false);
    expect(navigate("http://foo.internal/").ok).toBe(false);
  });

  it("matches exact domains and *.suffix wildcards, denies the rest", () => {
    const proj = project("*.example.com, example.org");
    expect(navigate("https://www.example.com/", "playwright_browser_navigate", proj).ok).toBe(true);
    expect(navigate("https://a.b.example.com/", "playwright_browser_navigate", proj).ok).toBe(true);
    expect(navigate("https://example.org/", "playwright_browser_navigate", proj).ok).toBe(true);
    // wildcard covers subdomains only — the apex needs its own exact entry
    expect(navigate("https://example.com/", "playwright_browser_navigate", proj).ok).toBe(false);
    expect(navigate("https://notexample.com/", "playwright_browser_navigate", proj).ok).toBe(false);
    expect(navigate("https://example.net/", "playwright_browser_navigate", proj).ok).toBe(false);
  });

  it("checks browser_goto, browser_tabs(open) and devtools_navigate_page; other tools pass through", () => {
    expect(navigate("file:///etc/passwd", "playwright_browser_goto").ok).toBe(false);
    expect(enforceBrowserBoundary(project(), "playwright_browser_tabs", { action: "open", url: "file:///etc/passwd" }).ok).toBe(false);
    expect(enforceBrowserBoundary(project(), "playwright_browser_tabs", { action: "open", url: "https://example.com" }).ok).toBe(true);
    expect(navigate("file:///etc/passwd", "devtools_navigate_page").ok).toBe(false);
    expect(navigate("https://example.com", "devtools_navigate_page").ok).toBe(true);
    // non-navigation tools are untouched
    expect(navigate("file:///etc/passwd", "playwright_browser_click").ok).toBe(true);
    expect(enforceBrowserBoundary(project(), "playwright_browser_tabs", { action: "close", url: "file:///etc/passwd" }).ok).toBe(true);
    expect(navigate("file:///etc/passwd", "github_push_files").ok).toBe(true);
  });

  it("denies missing/invalid url arguments on navigation tools and names the fix", () => {
    expect(navigate(undefined).ok).toBe(false);
    expect(navigate(42).ok).toBe(false);
    expect(navigate("not a url").ok).toBe(false);
    const missing = navigate(undefined);
    if (!missing.ok) expect(missing.reason).toContain("url");
    const priv = navigate("http://10.0.0.5/");
    if (!priv.ok) expect(priv.reason).toContain("browserInternalTargets");
    const domain = navigate("https://nope.example/", "playwright_browser_navigate", project("yes.example"));
    if (!domain.ok) expect(domain.reason).toContain("browserAllowedDomains");
  });
});

describe("X-Warden-Caller propagation", () => {
  const client = new UpstreamClientImpl({
    namespace: "playwright",
    displayName: "Playwright Browser",
    url: "http://browser-host:8940/mcp",
    protocolVersion: null,
    headers: {},
  });

  it("sets X-Warden-Caller when a caller is provided and omits it otherwise", async () => {
    const original = globalThis.fetch;
    const seen: Record<string, string>[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } }), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await client.callTool("browser_navigate", { url: "https://example.com" }, "rsearch");
      await client.callTool("browser_navigate", { url: "https://example.com" });
      await client.callTool("browser_navigate", { url: "https://example.com" }, "");
    } finally {
      globalThis.fetch = original;
    }
    expect(seen[0]["X-Warden-Caller"]).toBe("rsearch");
    expect(seen[1]["X-Warden-Caller"]).toBeUndefined();
    expect(seen[2]["X-Warden-Caller"]).toBeUndefined();
  });
});

describe("Browser Broker seeding", () => {
  it("seeds the playwright/devtools upstream rows pointing at the orchestrator", () => {
    const deps = makeDeps();
    bootstrap(testConfig(), deps.db);
    expect(deps.configStore.getUpstream("playwright")?.url).toBe("http://browser-host:8940/mcp");
    expect(deps.configStore.getUpstream("playwright")?.displayName).toBe("Playwright Browser");
    expect(deps.configStore.getUpstream("devtools")?.url).toBe("http://browser-host:8940/devtools");
    expect(deps.configStore.getUpstream("devtools")?.displayName).toBe("Chrome DevTools");
    expect(deps.configStore.getProject("rsearch")?.allowedUpstreams).toBe("github,aws,playwright,devtools");
  });

  it("ensureBrowserPolicies seeds browser policies once and never overwrites operator changes", () => {
    const deps = makeDeps();
    registerUpstream(deps, "playwright", "http://browser-host:8940/mcp");
    registerUpstream(deps, "devtools", "http://browser-host:8940/devtools");
    ensureBrowserPolicies(deps.configStore);

    expect(deps.configStore.getPolicy("playwright", "*")).toMatchObject({ enabled: true, guard: "reason" });
    expect(deps.configStore.getPolicy("playwright", "playwright_browser_evaluate")?.enabled).toBe(false);
    expect(deps.configStore.getPolicy("playwright", "playwright_browser_file_upload")).toMatchObject({
      enabled: true,
      guard: "hitl",
      timeoutAction: "deny",
      ttlMinutes: 60,
    });
    expect(deps.configStore.getPolicy("playwright", "playwright_browser_close")).toMatchObject({ enabled: true, guard: "none" });
    expect(deps.configStore.getPolicy("devtools", "*")).toMatchObject({ enabled: true, guard: "reason" });
    expect(deps.configStore.getPolicy("devtools", "devtools_evaluate_script")?.enabled).toBe(false);

    // operator changed the row in the UI — re-running the seed must not stomp it
    deps.configStore.upsertPolicy({
      upstream: "playwright",
      tool: "playwright_browser_file_upload",
      enabled: true,
      guard: "none",
      timeoutAction: null,
      ttlMinutes: null,
    });
    ensureBrowserPolicies(deps.configStore);
    expect(deps.configStore.getPolicy("playwright", "playwright_browser_file_upload")?.guard).toBe("none");
  });
});
