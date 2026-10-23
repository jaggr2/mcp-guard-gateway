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
      <h2>Warden · AI Control Plane Overview</h2>
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
                <td><a [href]="'https://' + s.slug + '.oc.jaggi.xyz'" target="_blank" rel="noopener">Open Web IDE ↗</a></td>
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
    .error { color: #c0392b; } .muted { color: #888; } .mono { font-family: monospace; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 14px 0 22px; }
    .kpi { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; }
    .kpi .label { font-size: 0.78rem; color: #8b949e; }
    .kpi .val { font-size: 1.35rem; font-weight: 600; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 20px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
    a { color: #58a6ff; text-decoration: none; }
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
