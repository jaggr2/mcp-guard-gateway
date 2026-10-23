import type { HermesBridge } from "../hermes/bridge";
import type { Store } from "../store/types";

export interface HomeAssistantNotifierOptions {
  hassUrl: string | null;
  hassToken: string | null;
  notifyService?: string;
  publicUrl?: string;
  store: Store;
}

/**
 * Native Home Assistant Notification & HITL Approval Adapter (replaces Hermes + hermes-bridge).
 *
 * - Sends Actionable Notifications to the HA Companion App (/api/services/notify/<service>)
 *   with inline [Approve (30m)] and [Deny] action buttons bound to the exact approvalId.
 * - Creates Persistent Notifications in the Home Assistant UI (/api/services/persistent_notification/create).
 */
export class HomeAssistantNotifier implements HermesBridge {
  private readonly hassUrl: string | null;
  private readonly hassToken: string | null;
  private readonly notifyService: string;

  constructor(opts: HomeAssistantNotifierOptions) {
    this.hassUrl = opts.hassUrl ? opts.hassUrl.replace(/\/$/, "") : null;
    this.hassToken = opts.hassToken || null;
    this.notifyService = opts.notifyService || "notify";
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendApprovalCard(
    tool: string,
    reason: string,
    args: Record<string, unknown>,
    approvalId: string
  ): Promise<string | null> {
    if (!this.hassUrl || !this.hassToken) {
      return null;
    }

    const title = `🛡️ Warden Approval: ${tool}`;
    const message = `${reason}\nArgs: ${JSON.stringify(args).slice(0, 240)}\nID: ${approvalId}`;

    try {
      await fetch(`${this.hassUrl}/api/services/notify/${this.notifyService}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.hassToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          message,
          data: {
            tag: `warden-${approvalId}`,
            importance: "high",
            actions: [
              { action: `WARDEN_APPROVE_${approvalId}`, title: "✅ Approve (30m)" },
              { action: `WARDEN_DENY_${approvalId}`, title: "❌ Deny" },
            ],
          },
        }),
      });

      await fetch(`${this.hassUrl}/api/services/persistent_notification/create`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.hassToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          notification_id: `warden_${approvalId}`,
          title,
          message: `${message}\n\nApprove in Home Assistant (AI & Sandboxes view) or at warden.jaggi.xyz/approvals.`,
        }),
      }).catch(() => undefined);

      return `ha:${approvalId}`;
    } catch {
      return null;
    }
  }

  async notify(message: string): Promise<void> {
    if (!this.hassUrl || !this.hassToken) {
      return;
    }
    try {
      await fetch(`${this.hassUrl}/api/services/notify/${this.notifyService}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.hassToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "🛡️ Warden Control Plane",
          message,
        }),
      });
    } catch {
      /* best-effort */
    }
  }
}
