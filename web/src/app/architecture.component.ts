import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import type { BrowserSession, StatusInfo } from './models';

type Health = 'ok' | 'warn' | 'danger' | 'neutral';

/**
 * Architecture — live "cockpit" map of the Warden control plane.
 *
 * Static SVG landmap (architecture-diagram visual language: slate-950 grid,
 * semantic fills, mono labels, arrows behind boxes) with live state overlaid
 * per node: status dots + metric chips polled from the API every 30s.
 *
 * Geometry rules (learned from an overlap bug with 5 upstreams / 5 sandboxes):
 * dynamic rows WRAP via chipX/chipY/sandX/sandY and are capped; the left
 * margin (x < 290) is reserved for vertical flow routing so paths never cross
 * boxes. Verify any geometry change with the DOM overlap audit (see
 * agent-memory: ui-state-and-verification) — and re-run the WCAG audit for
 * touched colors (ui-contrast-measurement).
 */
@Component({
  selector: 'app-architecture',
  standalone: true,
  template: `
    <div class="page">
      <h2 class="page-title">Warden Architecture</h2>
      <p class="page-subtitle">
        Live map of the AI control plane — trust edge, sandbox fleet, brokers and
        every flow — with current state overlaid. Dashed rose paths cross a trust
        boundary; pulsing paths carry traffic right now.
      </p>

      <div class="hud">
        <span class="hud-live">
          <span class="pulse-dot" [class.live]="loaded() && !loadError()"></span>
          {{ loadError() ? 'DEGRADED' : loading() ? 'CONNECTING' : 'LIVE' }}
        </span>
        <span class="muted mono">
          @if (lastRefresh(); as t) { refreshed {{ t }} }
          @else { awaiting first poll }
        </span>
      </div>

      @if (loadError()) {
        <div class="card">
          <p class="error">Could not reach the Warden API — showing the static map only.</p>
          <button class="btn btn-ghost" (click)="load()">Retry</button>
        </div>
      } @else if (loading() && !loaded()) {
        <div class="card"><p class="muted">Loading live state…</p></div>
      }

      <div class="map-frame">
        <svg viewBox="0 0 1280 1000" role="img" aria-label="Warden architecture map">
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="0.5" />
            </pattern>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#94a3b8" />
            </marker>
            <marker id="arrow-rose" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#fb7185" />
            </marker>
            <marker id="arrow-green" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#34d399" />
            </marker>
          </defs>

          <rect x="0" y="0" width="1280" height="1000" fill="var(--bg-canvas)" />
          <rect x="0" y="0" width="1280" height="1000" fill="url(#grid)" />

          <!-- ══ flows (behind boxes) ══════════════════════════════════ -->
          <g class="flows">
            <path class="flow-sec" d="M 228 112 H 276" />
            <path class="flow-sec" d="M 476 112 H 524" />
            <path class="flow-sec" d="M 694 112 H 742" />
            <path class="flow-sec" d="M 832 144 V 186 H 580 V 252" />
            <path class="flow" d="M 580 482 V 522" marker-end="url(#arrow)" />
            <path class="flow" d="M 330 482 H 130 V 662 H 296" marker-end="url(#arrow)" />
            <path class="flow" d="M 318 426 H 260 V 904 H 360" marker-end="url(#arrow)" />
            <path class="flow ok" [class.live]="mcpCalls() > 0" d="M 860 300 H 984" marker-end="url(#arrow-green)" />
            <path class="flow-sec" d="M 860 396 H 984" />
            <path class="flow" d="M 860 470 H 984" marker-end="url(#arrow)" />
            <path class="flow warn" d="M 860 482 H 940 V 576 H 984" marker-end="url(#arrow)" />
            <path class="flow" d="M 782 872 H 920 V 470 H 860" marker-end="url(#arrow)" />
            <path class="flow ok" [class.live]="loaded()" d="M 1106 668 V 612" marker-end="url(#arrow-green)" />
          </g>

          <!-- ══ zone: public edge ═════════════════════════════════════ -->
          <g>
            <rect class="zone" x="24" y="24" width="1232" height="150" rx="12" />
            <text class="zone-label" x="40" y="48">PUBLIC EDGE — CLOUDFLARE TUNNEL + FORWARD-AUTH</text>

            <g class="node ext">
              <rect x="48" y="80" width="180" height="64" rx="6" />
              <text class="node-name" x="62" y="106">Users / Agents</text>
              <text class="node-sub" x="62" y="126">browser · opencode</text>
            </g>
            <g class="node sec">
              <rect x="276" y="80" width="200" height="64" rx="6" />
              <text class="node-name" x="290" y="106">Cloudflare Access</text>
              <text class="node-sub" x="290" y="126">warden.jaggi.xyz</text>
            </g>
            <g class="node ext">
              <rect x="524" y="80" width="170" height="64" rx="6" />
              <text class="node-name" x="538" y="106">Traefik</text>
              <text class="node-sub" x="538" y="126">reverse proxy</text>
            </g>
            <g class="node sec">
              <rect x="742" y="80" width="190" height="64" rx="6" />
              <text class="node-name" x="756" y="106">Authelia</text>
              <text class="node-sub" x="756" y="126">OIDC · 2FA · forwardAuth</text>
            </g>
          </g>

          <!-- ══ zone: derog-server (left margin x<290 stays free for flows) ══ -->
          <g>
            <rect class="zone" x="24" y="208" width="900" height="756" rx="12" />
            <text class="zone-label" x="40" y="232">DEROG-SERVER — INCUS</text>

            <!-- Warden core -->
            <g class="node core">
              <rect x="300" y="252" width="560" height="230" rx="8" />
              <circle class="status" [attr.class]="'status ' + coreHealth()" cx="836" cy="272" r="6" />
              <text class="node-name" x="318" y="282">Warden — AI Control Plane (:8080)</text>
              <text class="node-sub" x="318" y="302">Hono API + Angular UI · SQLite gateway.db</text>

              <g class="chip">
                <rect x="318" y="318" width="168" height="44" rx="6" />
                <text class="chip-name" x="330" y="338">LLM Cost &amp; Quota Proxy</text>
                <text class="chip-sub" x="330" y="354">{{ spendLabel() }}</text>
              </g>
              <g class="chip">
                <rect x="496" y="318" width="168" height="44" rx="6" />
                <text class="chip-name" x="508" y="338">MCP Security Gateway</text>
                <text class="chip-sub" x="508" y="354">{{ mcpLabel() }}</text>
              </g>
              <g class="chip">
                <rect x="674" y="318" width="168" height="44" rx="6" />
                <text class="chip-name" x="686" y="338">Credential Brokers</text>
                <text class="chip-sub" x="686" y="354">/aws-creds · /git-creds</text>
              </g>
              <g class="chip">
                <rect x="318" y="372" width="168" height="44" rx="6" />
                <text class="chip-name" x="330" y="392">HITL Approvals</text>
                <text class="chip-sub" x="330" y="408">{{ approvalsLabel() }}</text>
              </g>
              <g class="chip">
                <rect x="496" y="372" width="168" height="44" rx="6" />
                <text class="chip-name" x="508" y="392">Sandbox Orchestrator</text>
                <text class="chip-sub" x="508" y="408">wake-on-visit · sandbox-ctl</text>
              </g>
              <g class="chip">
                <rect x="674" y="372" width="168" height="44" rx="6" />
                <text class="chip-name" x="686" y="392">Memory Sync</text>
                <text class="chip-sub" x="686" y="408">learn-skill → git push</text>
              </g>
              <g class="chip">
                <rect x="318" y="426" width="168" height="44" rx="6" />
                <text class="chip-name" x="330" y="446">Browser Broker</text>
                <text class="chip-sub" x="330" y="462">{{ browserLabel() }}</text>
              </g>
            </g>

            <!-- MCP upstream chips (live trust) — 4 per row, wrapping -->
            <text class="row-label" x="300" y="512">MCP UPSTREAMS (TRUST-PINNED)</text>
            @for (u of visibleUpstreams(); track u.namespace) {
              <g class="node mini" [attr.transform]="'translate(' + chipX($index) + ',' + chipY($index) + ')'">
                <rect width="144" height="32" rx="6" />
                <circle class="status" [attr.class]="'status ' + trustHealth(u.trust)"
                        cx="14" cy="16" r="5" />
                <text class="chip-name" x="28" y="20">{{ u.displayName }}</text>
              </g>
            } @empty {
              <text class="node-sub" x="300" y="542">no upstreams registered</text>
            }
            @if (hiddenUpstreamCount() > 0) {
              <text class="node-sub" x="300" y="618">+{{ hiddenUpstreamCount() }} more upstreams</text>
            }

            <!-- Sandboxes (live) — 2 per row, wrapping -->
            @for (s of visibleSandboxes(); track s.slug) {
              <g class="node svc" [attr.transform]="'translate(' + sandX($index) + ',' + sandY($index) + ')'">
                <rect width="300" height="64" rx="6" />
                <circle class="status" [attr.class]="'status ' + sandboxHealth(s.status)"
                        cx="278" cy="20" r="6" />
                <text class="node-name" x="16" y="26">{{ s.slug }}</text>
                <text class="node-sub" x="16" y="46">{{ s.status }} · {{ s.lifecycleMode }}</text>
              </g>
            } @empty {
              <text class="node-sub" x="300" y="662">no sandboxes provisioned</text>
            }
            @if (hiddenSandboxCount() > 0) {
              <text class="node-sub" x="300" y="862">+{{ hiddenSandboxCount() }} more sandboxes</text>
            }

            <!-- host row -->
            <g class="node ext">
              <rect x="64" y="872" width="260" height="64" rx="6" />
              <text class="node-name" x="80" y="898">browser-host (Incus)</text>
              <text class="node-sub" x="80" y="918">Chromium · noVNC takeover</text>
            </g>
            <g class="node ext">
              <rect x="364" y="872" width="260" height="64" rx="6" />
              <text class="node-name" x="380" y="898">oc-server (:4097)</text>
              <text class="node-sub" x="380" y="918">host OpenCode · /opt/homelab</text>
            </g>
            <g class="node db">
              <rect x="664" y="872" width="236" height="64" rx="6" />
              <text class="node-name" x="680" y="898">agent-memory</text>
              <text class="node-sub" x="680" y="918">/var/lib/warden · git (jaggr2)</text>
            </g>
          </g>

          <!-- ══ zone: external ════════════════════════════════════════ -->
          <g>
            <rect class="zone" x="956" y="208" width="300" height="756" rx="12" />
            <text class="zone-label" x="972" y="232">EXTERNAL</text>

            <g class="node ext">
              <rect x="984" y="252" width="244" height="72" rx="6" />
              <circle class="status" [attr.class]="'status ' + coreHealth()" cx="1204" cy="272" r="6" />
              <text class="node-name" x="1000" y="282">LLM Providers</text>
              <text class="node-sub" x="1000" y="302">opencode-go · openai · anthropic ·</text>
              <text class="node-sub" x="1000" y="318">openrouter</text>
            </g>
            <g class="node sec">
              <rect x="984" y="356" width="244" height="64" rx="6" />
              <text class="node-name" x="1000" y="382">AWS STS</text>
              <text class="node-sub" x="1000" y="402">IAM Roles Anywhere · deploy HITL</text>
            </g>
            <g class="node db">
              <rect x="984" y="452" width="244" height="64" rx="6" />
              <text class="node-name" x="1000" y="478">GitHub</text>
              <text class="node-sub" x="1000" y="498">agent-memory · ghcr images</text>
            </g>
            <g class="node svc">
              <rect x="984" y="548" width="244" height="64" rx="6" />
              <circle class="status" [attr.class]="'status ' + coreHealth()" cx="1204" cy="568" r="6" />
              <text class="node-name" x="1000" y="574">Home Assistant</text>
              <text class="node-sub" x="1000" y="594">192.168.30.10 · notify · HITL cards</text>
            </g>
            <g class="node ext">
              <rect x="984" y="668" width="244" height="64" rx="6" />
              <circle class="status" [attr.class]="'status ' + coreHealth()" cx="1204" cy="688" r="6" />
              <text class="node-name" x="1000" y="694">GitHub Actions</text>
              <text class="node-sub" x="1000" y="714">scheduled agent-*.yml → HA digest</text>
            </g>
          </g>

          <!-- flow labels (kept in free corridors) -->
          <g class="flow-labels">
            <text x="592" y="224">/api · forward-auth</text>
            <text x="592" y="508">/mcp tool calls</text>
            <text x="140" y="520">wake-on-visit (*.oc)</text>
            <text x="120" y="700">oc-server proxy</text>
            <text x="872" y="292">/llm (quota)</text>
            <text x="872" y="388">/aws-creds</text>
            <text x="872" y="462">/git-creds · push</text>
            <text x="872" y="508">approve ⇄ notify</text>
            <text x="640" y="862">learn-skill ⇄ mount</text>
            <text x="1116" y="648">morning digest</text>
          </g>
        </svg>
      </div>

      <div class="legend">
        <span><span class="swatch ext"></span>compute / generic</span>
        <span><span class="swatch svc"></span>service</span>
        <span><span class="swatch sec"></span>trust boundary</span>
        <span><span class="swatch db"></span>data / repo</span>
        <span><span class="dot ok"></span>running / pinned</span>
        <span><span class="dot warn"></span>degraded / unpinned</span>
        <span><span class="dot danger"></span>failing / drift</span>
        <span><span class="dot"></span>stopped / idle</span>
        <span class="legend-note">dashed rose = crosses a trust boundary · pulsing = live traffic</span>
      </div>
    </div>
  `,
  styles: `
    .hud {
      display: flex;
      gap: var(--sp-4);
      align-items: center;
      margin-bottom: var(--sp-3);
      font-size: var(--fs-xs);
    }

    .hud-live {
      display: inline-flex;
      align-items: center;
      gap: var(--sp-2);
      font-weight: 700;
      letter-spacing: 0.12em;
    }

    .pulse-dot {
      width: 9px;
      height: 9px;
      border-radius: var(--r-pill);
      background: var(--neutral-graphic);
    }

    .pulse-dot.live {
      background: var(--ok-graphic);
      animation: pulse 1.6s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(46, 160, 67, 0.55); }
      50% { box-shadow: 0 0 0 6px rgba(46, 160, 67, 0); }
    }

    .map-frame {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
      overflow-x: auto;
    }

    svg { display: block; width: 100%; height: auto; }

    /* phones: keep the map legible — pan it horizontally instead of shrinking text */
    @media (max-width: 820px) {
      svg { min-width: 1080px; }
    }

    /* zones */
    .zone { fill: rgba(15, 23, 42, 0.35); stroke: var(--border-strong); stroke-dasharray: 8 4; }
    .zone-label { fill: var(--text-muted); font: 600 12px var(--font-mono); letter-spacing: 0.12em; }

    /* nodes */
    .node rect { fill: #0f172a; stroke-width: 1.5; }
    .node.core rect { fill: #0f172a; stroke: #34d399; stroke-width: 2; }
    .node.svc rect { stroke: #34d399; }
    .node.ext rect { stroke: #94a3b8; }
    .node.sec rect { stroke: #fb7185; }
    .node.db rect { stroke: #a78bfa; }
    .node.mini rect { fill: #0f172a; stroke: #334155; }

    .node-name { fill: var(--text); font: 650 13px var(--font-mono); }
    .node-sub { fill: var(--text-muted); font: 11.5px var(--font-mono); }
    .chip rect { fill: var(--bg-elevated); stroke: var(--border-strong); }
    .chip-name { fill: var(--text); font: 600 11.5px var(--font-mono); }
    .chip-sub { fill: var(--text-muted); font: 11px var(--font-mono); }
    .row-label { fill: var(--text-muted); font: 600 11.5px var(--font-mono); letter-spacing: 0.1em; }

    /* status dots — graphic tokens (3:1 on their fills) */
    .status.ok { fill: var(--ok-graphic); }
    .status.warn { fill: var(--warn-graphic); }
    .status.danger { fill: var(--danger-graphic); }
    .status.neutral { fill: var(--neutral-graphic); }

    /* flows */
    .flow { fill: none; stroke: var(--text-muted); stroke-width: 1.5; }
    .flow-sec { fill: none; stroke: #fb7185; stroke-width: 1.5; stroke-dasharray: 5 5; }
    .flow.ok { stroke: var(--ok-graphic); }

    .flow.live {
      stroke-dasharray: 6 8;
      animation: flow 1.1s linear infinite;
    }

    @keyframes flow {
      to { stroke-dashoffset: -28; }
    }

    .flow-labels text { fill: var(--text-muted); font: 11px var(--font-mono); }

    /* legend */
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: var(--sp-2) var(--sp-5);
      align-items: center;
      margin-top: var(--sp-3);
      font-size: var(--fs-xs);
      color: var(--text-muted);
    }

    .legend span { display: inline-flex; align-items: center; gap: var(--sp-2); }

    .swatch {
      width: 14px;
      height: 10px;
      border-radius: 3px;
      border: 1.5px solid var(--neutral-graphic);
    }

    .swatch.ext { border-color: #94a3b8; }
    .swatch.svc { border-color: #34d399; }
    .swatch.sec { border-color: #fb7185; }
    .swatch.db { border-color: #a78bfa; }
    .legend-note { margin-left: auto; }
  `,
})
export class ArchitectureComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly loadError = signal(false);
  readonly lastRefresh = signal<string | null>(null);
  readonly info = signal<StatusInfo | null>(null);
  readonly pendingApprovals = signal(0);
  readonly browserSessions = signal<BrowserSession[]>([]);

  readonly sandboxes = computed(() => this.info()?.sandboxes ?? []);
  readonly upstreams = computed(() => this.info()?.upstreams ?? []);

  /* Dynamic rows wrap inside the server zone; anything past the caps is
   * summarized as "+N more" so the map can never overflow its boundaries. */
  readonly visibleUpstreams = computed(() => this.upstreams().slice(0, 8));
  readonly hiddenUpstreamCount = computed(() => Math.max(0, this.upstreams().length - 8));
  readonly visibleSandboxes = computed(() => this.sandboxes().slice(0, 6));
  readonly hiddenSandboxCount = computed(() => Math.max(0, this.sandboxes().length - 6));

  chipX(i: number): number {
    return 300 + (i % 4) * 152;
  }

  chipY(i: number): number {
    return 522 + Math.floor(i / 4) * 40;
  }

  sandX(i: number): number {
    return 300 + (i % 2) * 312;
  }

  sandY(i: number): number {
    return 630 + Math.floor(i / 2) * 76;
  }

  readonly mcpCalls = computed(() => this.info()?.globalUsage?.mcpCallsToday ?? 0);

  readonly spendLabel = computed(() => {
    const g = this.info()?.globalUsage;
    return g ? `$${g.costTodayUsd.toFixed(2)} today · $${g.costMonthUsd.toFixed(0)} mo` : 'cost & quota caps';
  });

  readonly mcpLabel = computed(() => `${this.mcpCalls()} calls today`);

  readonly approvalsLabel = computed(() => {
    const n = this.pendingApprovals();
    return n > 0 ? `${n} pending decision` : '0 pending';
  });

  readonly browserLabel = computed(() => {
    const sessions = this.browserSessions();
    const ready = sessions.filter((s) => s.state === 'ready').length;
    return sessions.length ? `${ready}/${sessions.length} sessions ready` : 'no sessions';
  });

  readonly coreHealth = computed<Health>(() => (this.loadError() ? 'warn' : this.loaded() ? 'ok' : 'neutral'));

  ngOnInit(): void {
    void this.load();
    this.timer = setInterval(() => void this.load(), 30_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [info, approvalsResp, sessionsResp] = await Promise.all([
        this.api.status(),
        this.api.approvals('pending'),
        this.api.listBrowserSessions(),
      ]);
      this.info.set(info);
      this.pendingApprovals.set(approvalsResp.approvals.length);
      this.browserSessions.set(sessionsResp.sessions);
      this.loadError.set(false);
      this.lastRefresh.set(new Date().toLocaleTimeString());
      this.loaded.set(true);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  trustHealth(state: string | undefined): Health {
    if (!state) return 'neutral';
    if (state === 'ok' || state === 'pinned' || state === 'verified') return 'ok';
    if (state === 'unpinned' || state === 'warn' || state === 'degraded') return 'warn';
    if (state === 'drift' || state === 'drifted' || state === 'error' || state === 'down') return 'danger';
    // Unknown non-empty state: degrade to warn, never paint the map red.
    return 'warn';
  }

  sandboxHealth(status: string | undefined): Health {
    if (status === 'running') return 'ok';
    if (status === 'error') return 'danger';
    return 'neutral';
  }
}
