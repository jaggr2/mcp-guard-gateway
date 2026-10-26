/**
 * Contract between the gateway and the operator-notification bridge.
 *
 * Today the only implementation is `HomeAssistantNotifier`
 * (src/notify/homeassistant.ts), which posts actionable notifications to the
 * Home Assistant notify service — the target is static config
 * (`HASS_NOTIFY_SERVICE`, default `notify`), not a runtime setting. The legacy
 * Telegram `hermes mcp serve` bridge (HermesBridgeImpl + the
 * `hermes.conversationKey` setting) was retired 2026-10; the interface name is
 * kept to limit the blast radius.
 */
export interface HermesBridge {
  /** Posts an approval card; returns a message key, or null when unsupported. */
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

/** No-op bridge used when no notifier is wired. */
export class NoopHermesBridge implements HermesBridge {
  async sendApprovalCard(): Promise<string | null> {
    return null;
  }
  async sendResolutionCard(): Promise<void> {}
  async notify(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
