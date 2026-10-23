import { createHash } from "node:crypto";
import type { GatewayConfig } from "../config";
import type { HermesBridge } from "../hermes/bridge";
import type { SecretBox } from "../secrets";
import type { ConfigStore, ProjectRow } from "../store/config";

/**
 * Agent LLM Cost & Subscription Quota Gateway (`/llm/:provider/*`).
 *
 * Supported providers:
 *   - `opencode-go` -> OpenCode Go subscription upstream
 *   - `openai`      -> https://api.openai.com
 *   - `anthropic`   -> https://api.anthropic.com
 *   - `openrouter`  -> https://openrouter.ai/api
 *
 * Sandboxes authenticate with their `SANDBOX_TOKEN` (never holding real API keys).
 * Enforces per-project daily/monthly USD caps and hourly/daily token velocity caps.
 */

const PROVIDER_UPSTREAMS: Record<string, { baseUrl: string; secretName: string; envFallback: string }> = {
  warden: {
    baseUrl: "https://opencode.ai/inference/go/openai",
    secretName: "OPENCODE_GO_API_KEY",
    envFallback: "OPENCODE_GO_API_KEY",
  },
  "opencode-go": {
    baseUrl: "https://opencode.ai/inference/go/openai",
    secretName: "OPENCODE_GO_API_KEY",
    envFallback: "OPENCODE_GO_API_KEY",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    secretName: "DEEPSEEK_API_KEY",
    envFallback: "DEEPSEEK_API_KEY",
  },
  bitdeer: {
    baseUrl: "https://api-inference.bitdeer.ai",
    secretName: "BITDEER_API_KEY",
    envFallback: "BITDEER_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com",
    secretName: "OPENAI_API_KEY",
    envFallback: "OPENAI_API_KEY",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    secretName: "ANTHROPIC_API_KEY",
    envFallback: "ANTHROPIC_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api",
    secretName: "OPENROUTER_API_KEY",
    envFallback: "OPENROUTER_API_KEY",
  },
};

/** USD per 1M tokens (input / output) for cost accounting. */
const MODEL_PRICING_PER_1M: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "gpt-5": { input: 2.5, output: 10.0 },
  "gpt-5-mini": { input: 0.3, output: 1.2 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "glm-5.3-flash": { input: 0.1, output: 0.2 },
  "gemini-4-argon-contributor": { input: 0.0, output: 0.0 }, // OpenCode Go subscription (tracked by token caps)
};

export function estimateCostUsd(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  if (provider === "opencode-go") {
    return 0; // Subscription-based; guarded by hourly/daily token caps
  }
  const rate = MODEL_PRICING_PER_1M[model] ?? { input: 1.0, output: 3.0 };
  return Number(((inputTokens * rate.input + outputTokens * rate.output) / 1_000_000).toFixed(6));
}

export function extractBearerOrApiKey(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  const xKey = request.headers.get("x-api-key");
  if (xKey) {
    return xKey.trim();
  }
  return null;
}

export function resolveCallerProject(configStore: ConfigStore, rawToken: string | null): ProjectRow | null {
  if (!rawToken) return null;
  const hash = createHash("sha256").update(rawToken).digest("hex");
  return configStore.getProjectByTokenHash(hash) ?? null;
}

export function checkProjectBudgetAndQuota(
  configStore: ConfigStore,
  project: ProjectRow
): { ok: true } | { ok: false; reason: string; warning?: boolean } {
  const usage = configStore.getProjectUsageSummary(project.slug);

  if (project.dailyBudgetUsd > 0 && usage.costTodayUsd >= project.dailyBudgetUsd) {
    return {
      ok: false,
      reason: `[Warden Budget Guard] Project '${project.slug}' exceeded daily budget ($${usage.costTodayUsd.toFixed(2)} / $${project.dailyBudgetUsd.toFixed(2)})`,
    };
  }
  if (project.monthlyBudgetUsd > 0 && usage.costMonthUsd >= project.monthlyBudgetUsd) {
    return {
      ok: false,
      reason: `[Warden Budget Guard] Project '${project.slug}' exceeded monthly budget ($${usage.costMonthUsd.toFixed(2)} / $${project.monthlyBudgetUsd.toFixed(2)})`,
    };
  }
  if (project.hourlyTokenCap > 0 && usage.tokensHour >= project.hourlyTokenCap) {
    return {
      ok: false,
      reason: `[Warden Quota Guard] Project '${project.slug}' exceeded hourly token velocity cap (${usage.tokensHour} / ${project.hourlyTokenCap} tokens/hr)`,
    };
  }
  if (project.dailyTokenCap > 0 && usage.tokensToday >= project.dailyTokenCap) {
    return {
      ok: false,
      reason: `[Warden Quota Guard] Project '${project.slug}' exceeded daily token cap (${usage.tokensToday} / ${project.dailyTokenCap} tokens/day)`,
    };
  }
  return { ok: true };
}

export async function handleLlmProxy(
  request: Request,
  provider: string,
  subpath: string,
  config: GatewayConfig,
  configStore: ConfigStore,
  secrets: SecretBox,
  notifier: HermesBridge
): Promise<Response> {
  const startMs = Date.now();
  const providerSpec = PROVIDER_UPSTREAMS[provider];
  if (!providerSpec) {
    return Response.json({ error: `Unsupported LLM provider '${provider}'` }, { status: 404 });
  }

  const token = extractBearerOrApiKey(request);
  const project = resolveCallerProject(configStore, token);
  if (!project) {
    return Response.json({ error: "Invalid or missing sandbox token" }, { status: 401 });
  }

  configStore.touchProjectActivity(project.slug);

  const budgetCheck = checkProjectBudgetAndQuota(configStore, project);
  if (!budgetCheck.ok) {
    void notifier.notify(budgetCheck.reason);
    return Response.json({ error: { message: budgetCheck.reason, type: "budget_exceeded" } }, { status: 429 });
  }

  // Resolve real upstream API key from encrypted secrets table or environment
  let upstreamKey: string | null = null;
  const cipher = configStore.getSecret(providerSpec.secretName);
  if (cipher) {
    try {
      upstreamKey = secrets.decrypt(cipher);
    } catch {
      upstreamKey = null;
    }
  }
  if (!upstreamKey) {
    upstreamKey = process.env[providerSpec.envFallback] ?? null;
  }
  if (!upstreamKey) {
    return Response.json(
      { error: `Upstream secret '${providerSpec.secretName}' is not configured in Warden` },
      { status: 502 }
    );
  }

  const rawBody = request.method !== "GET" && request.method !== "HEAD" ? await request.text() : undefined;
  let parsedModel = "unknown";
  if (rawBody) {
    try {
      const b = JSON.parse(rawBody) as { model?: string };
      if (typeof b.model === "string") parsedModel = b.model;
    } catch {
      /* ignore */
    }
  }

  let upstreamBase = configStore.getSetting(`llm.${provider}.baseUrl`) ?? providerSpec.baseUrl;
  let cleanSubpath = subpath.replace(/^\//, "");
  if (provider === "opencode-go" || provider === "warden") {
    if (parsedModel.startsWith("gemini")) {
      upstreamBase = "https://opencode.ai/inference/go/google/v1beta";
      cleanSubpath = cleanSubpath.replace(/^v1\//, "");
    } else if (parsedModel.startsWith("claude")) {
      upstreamBase = "https://opencode.ai/inference/go/anthropic";
    }
  }
  const targetUrl = `${upstreamBase.replace(/\/$/, "")}/${cleanSubpath}`;

  const headers = new Headers();
  headers.set("Content-Type", request.headers.get("Content-Type") ?? "application/json");
  if (provider === "anthropic") {
    headers.set("x-api-key", upstreamKey);
    headers.set("anthropic-version", request.headers.get("anthropic-version") ?? "2023-06-01");
  } else {
    headers.set("Authorization", `Bearer ${upstreamKey}`);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: rawBody,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    configStore.recordLlmUsage({
      project: project.slug,
      provider,
      model: parsedModel,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: Date.now() - startMs,
      status: "error",
      error: msg,
    });
    return Response.json({ error: `Upstream fetch failed: ${msg}` }, { status: 502 });
  }

  const contentType = upstreamRes.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await upstreamRes.text();
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    try {
      const json = JSON.parse(text) as {
        model?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
          reasoning_tokens?: number;
        };
      };
      if (typeof json.model === "string") parsedModel = json.model;
      inputTokens = json.usage?.prompt_tokens ?? json.usage?.input_tokens ?? 0;
      outputTokens = json.usage?.completion_tokens ?? json.usage?.output_tokens ?? 0;
      reasoningTokens = json.usage?.reasoning_tokens ?? 0;
    } catch {
      /* non-json response */
    }

    const costUsd = estimateCostUsd(provider, parsedModel, inputTokens, outputTokens + reasoningTokens);
    configStore.recordLlmUsage({
      project: project.slug,
      provider,
      model: parsedModel,
      inputTokens,
      outputTokens,
      reasoningTokens,
      costUsd,
      latencyMs: Date.now() - startMs,
      status: upstreamRes.ok ? "ok" : `http_${upstreamRes.status}`,
    });

    // Notify at >=80% daily budget
    const afterUsage = configStore.getProjectUsageSummary(project.slug);
    if (
      project.dailyBudgetUsd > 0 &&
      afterUsage.costTodayUsd >= project.dailyBudgetUsd * 0.8 &&
      afterUsage.costTodayUsd - costUsd < project.dailyBudgetUsd * 0.8
    ) {
      void notifier.notify(
        `⚠️ Project '${project.slug}' reached 80% of daily LLM budget ($${afterUsage.costTodayUsd.toFixed(2)} / $${project.dailyBudgetUsd.toFixed(2)})`
      );
    }

    return new Response(text, {
      status: upstreamRes.status,
      headers: { "Content-Type": contentType || "application/json" },
    });
  }

  // Streaming SSE passthrough with usage extraction on finish
  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    return new Response(null, { status: upstreamRes.status });
  }

  let sseBuffer = "";
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        let inputTokens = 0;
        let outputTokens = 0;
        const matches = sseBuffer.matchAll(/"usage"\s*:\s*(\{[^}]+\})/g);
        for (const m of matches) {
          try {
            const u = JSON.parse(m[1]) as {
              prompt_tokens?: number;
              completion_tokens?: number;
              input_tokens?: number;
              output_tokens?: number;
            };
            inputTokens = u.prompt_tokens ?? u.input_tokens ?? inputTokens;
            outputTokens = u.completion_tokens ?? u.output_tokens ?? outputTokens;
          } catch {
            /* ignore */
          }
        }
        const costUsd = estimateCostUsd(provider, parsedModel, inputTokens, outputTokens);
        configStore.recordLlmUsage({
          project: project.slug,
          provider,
          model: parsedModel,
          inputTokens,
          outputTokens,
          costUsd,
          latencyMs: Date.now() - startMs,
          status: "ok",
        });
        controller.close();
        return;
      }
      sseBuffer += new TextDecoder().decode(value, { stream: true }).slice(-4096);
      controller.enqueue(value);
    },
  });

  return new Response(stream, {
    status: upstreamRes.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
