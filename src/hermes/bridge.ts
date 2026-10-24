import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ApprovalStatus, Store } from "../store/types";

/**
 * Contract between the gateway and the Hermes messaging bridge. The bridge
 * exposes `hermes mcp serve` over Streamable HTTP so the gateway can post
 * approval cards to the operator's conversation and watch for their
 * `approve`/`deny` reply.
 */
export interface HermesBridge {
  /** Posts an approval card; returns a message key, or null when Hermes is not configured. */
  sendApprovalCard(
    tool: string,
    reason: string,
    args: Record<string, unknown>,
    approvalId: string
  ): Promise<string | null>;

  /**
   * Replaces the pending approval card with a resolved-status card (same tag),
   * so mobile action buttons give immediate visual feedback.
   */
  sendResolutionCard(
    approvalId: string,
    tool: string,
    reason: string,
    status: "approved" | "denied" | "expired"
  ): Promise<void>;

  /** Sends a plain notification (drift alerts, etc.). */
  notify(message: string): Promise<void>;

  /** Connects to the bridge and starts watching for approval replies. */
  start(): Promise<void>;

  /** Stops the watcher and closes the connection. */
  stop(): Promise<void>;
}

export interface HermesBridgeOptions {
  bridgeUrl: string | null;
  /** Conversation target for approval cards, e.g. `telegram:<user-id>`. */
  conversationKey: string | null;
  store: Store;
}

/** No-op bridge used when Hermes is not configured. */
export class NoopHermesBridge implements HermesBridge {
  async sendApprovalCard(): Promise<string | null> {
    return null;
  }
  async sendResolutionCard(): Promise<void> {}
  async notify(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

interface EventMessage {
  type?: string;
  conversation?: string;
  from?: string;
  content?: string;
  author?: string;
  [key: string]: unknown;
}

const APPROVE_RE = /^\s*(approve|deny)\b/i;

function parseEvents(text: string | undefined): EventMessage[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : null;
    if (list) return list as EventMessage[];
    if (parsed && typeof parsed === "object") return [parsed as EventMessage];
  } catch {
    /* ignore malformed */
  }
  return [];
}

/**
 * Real Hermes bridge: an MCP client to the hermes-bridge relay (which fronts
 * `hermes mcp serve`). Sends cards via `messages_send` and long-polls
 * `events_wait` for the operator's approve/deny reply.
 */
export class HermesBridgeImpl implements HermesBridge {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private watching = false;
  private cursor: string | undefined;

  constructor(private opts: HermesBridgeOptions) {}

  async start(): Promise<void> {
    if (!this.opts.bridgeUrl || !this.opts.conversationKey) {
      return;
    }
    this.transport = new StreamableHTTPClientTransport(new URL(this.opts.bridgeUrl));
    this.client = new Client(
      { name: "mcp-guard-gateway", version: "0.1.0" },
      { capabilities: {} }
    );
    await this.client.connect(this.transport);
    this.watching = true;
    void this.watchLoop();
  }

  async stop(): Promise<void> {
    this.watching = false;
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }

  async sendApprovalCard(
    tool: string,
    reason: string,
    args: Record<string, unknown>,
    approvalId: string
  ): Promise<string | null> {
    if (!this.client || !this.opts.conversationKey) {
      return null;
    }
    const content =
      `⚠️ *${tool}* wants:\n${reason}\n\n` +
      "```json\n" +
      JSON.stringify(args, null, 2) +
      "\n```\n\n" +
      `Approval: \`${approvalId}\` — reply *approve* or *deny*.`;
    try {
      await this.client.callTool({ name: "messages_send", arguments: { target: this.opts.conversationKey, content } });
      return `hermes:${this.opts.conversationKey}`;
    } catch {
      return null;
    }
  }

  async sendResolutionCard(
    approvalId: string,
    tool: string,
    reason: string,
    status: "approved" | "denied" | "expired"
  ): Promise<void> {
    await this.notify(`\`${tool}\` ${status} — ${reason} (approval \`${approvalId}\`)`);
  }

  async notify(message: string): Promise<void> {
    if (!this.client || !this.opts.conversationKey) {
      return;
    }
    try {
      await this.client.callTool({ name: "messages_send", arguments: { target: this.opts.conversationKey, content: message } });
    } catch {
      /* notifications are best-effort */
    }
  }

  private async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    if (!this.client) {
      throw new Error("bridge not connected");
    }
    const result = await this.client.callTool({ name, arguments: arguments_ });
    const content = (result as { content?: Array<{ text?: string }> }).content;
    return content?.[0]?.text ?? result;
  }

  private async watchLoop(): Promise<void> {
    while (this.watching && this.client) {
      try {
        const text = (await this.callTool("events_wait", { after_cursor: this.cursor, timeout_ms: 30000 })) as string;
        const events = parseEvents(text);
        if (events.length > 0) {
          for (const event of events) {
            const cursor = typeof event.id === "string" ? event.id : undefined;
            if (cursor) this.cursor = cursor;
            await this.handleEvent(event);
          }
        }
      } catch {
        // long-poll timeout or disconnect — reconnect and keep watching
        if (this.watching && this.client) {
          try {
            await this.client.close();
          } catch {
            /* ignore */
          }
          this.client = null;
          await this.start().catch(() => undefined);
          return;
        }
      }
    }
  }

  private async handleEvent(event: EventMessage): Promise<void> {
    if (event.type !== "message" && event.type !== undefined) {
      return;
    }
    const content = typeof event.content === "string" ? event.content : "";
    const match = APPROVE_RE.exec(content);
    if (!match) {
      return;
    }
    const action = match[1].toLowerCase() as "approve" | "deny";
    const author = typeof event.from === "string" ? event.from : typeof event.author === "string" ? event.author : undefined;
    await this.resolvePending(action, author);
  }

  private async resolvePending(action: "approve" | "deny", userId: string | undefined): Promise<void> {
    const status: ApprovalStatus = action === "approve" ? "approved" : "denied";
    const pending = await this.opts.store.listApprovals("pending");
    // Prefer the most recent approval in the operator conversation.
    const target = this.opts.conversationKey ?? "";
    const candidates = pending
      .filter((a) => a.hermes_message_key === `hermes:${target}` || a.hermes_message_key === target)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const row = candidates[0];
    if (row) {
      await this.opts.store.setApprovalStatus(row.id, status, { hermesUserId: userId ?? "hermes" });
    }
  }
}
