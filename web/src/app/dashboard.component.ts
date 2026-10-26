import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from './api.service';
import type { StatusInfo } from './models';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="page">
      <h2 class="page-title">Warden · AI Control Plane</h2>
      <p class="page-subtitle">Cost &amp; quota telemetry, sandbox fleet and MCP trust at a glance — live from the control plane.</p>
      @if (authError()) {
        <p class="error">Authentication required — this UI is behind Authelia forward-auth.</p>
      }
      @if (info()) {
        @if (info()!.globalUsage; as g) {
          <div class="kpi-grid">
            <div class="kpi">
              <div class="label">LLM Spend Today</div>
              <div class="val">\${{ g.costTodayUsd.toFixed(3) }}</div>
            </div>
            <div class="kpi">
              <div class="label">LLM Spend Month</div>
              <div class="val">\${{ g.costMonthUsd.toFixed(2) }}</div>
            </div>
            <div class="kpi">
              <div class="label">OpenCode Go Tokens Today</div>
              <div class="val">{{ g.opencodeGoTokensToday.toLocaleString() }}</div>
            </div>
            <div class="kpi">
              <div class="label">MCP Calls Today</div>
              <div class="val">{{ g.mcpCallsToday }}</div>
            </div>
          </div>
        }

        <h3><a routerLink="/sandboxes">OpenCode Project Sandboxes</a></h3>
        <table>
          <thead><tr><th>Project</th><th>Status</th><th>Lifecycle</th><th>Today Spend / Budget</th><th>IDE</th></tr></thead>
          <tbody>
            @for (s of info()!.sandboxes || []; track s.slug) {
              <tr>
                <td class="mono">{{ s.displayName }} ({{ s.slug }})</td>
                <td>{{ s.status }}</td>
                <td>{{ s.lifecycleMode }}</td>
                <td>\${{ s.costTodayUsd.toFixed(3) }} / \${{ s.dailyBudgetUsd.toFixed(2) }}</td>
                <td><a [href]="'https://oc.jaggi.xyz/s/' + s.slug" target="_blank" rel="noopener">Open Web IDE ↗</a></td>
              </tr>
            }
          </tbody>
        </table>

        <h3>MCP Upstreams</h3>
        <table>
          <thead><tr><th>Namespace</th><th>Enabled</th><th>Trust</th></tr></thead>
          <tbody>
            @for (u of info()!.upstreams; track u.namespace) {
              <tr><td class="mono">{{ u.displayName }}</td><td>{{ u.enabled ? 'yes' : 'no' }}</td><td>{{ u.trust }}</td></tr>
            }
          </tbody>
        </table>
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
  styles: `
    .error { color: var(--danger-text); } .muted { color: var(--text-muted); } .mono { font-family: monospace; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 14px 0 22px; }
    .kpi { background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: 8px; padding: 12px 14px; }
    .kpi .label { font-size: 0.78rem; color: var(--text-muted); }
    .kpi .val { font-size: 1.35rem; font-weight: 600; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 20px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
    a { color: var(--accent); text-decoration: none; }
  `,
})
export class DashboardComponent {
  private api = inject(ApiService);
  info = signal<StatusInfo | null>(null);
  authError = signal(false);

  constructor() {
    void this.load();
  }

  async load() {
    try {
      this.info.set(await this.api.status());
    } catch {
      this.authError.set(this.api.authError);
    }
  }
}
