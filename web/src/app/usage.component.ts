import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { UsageLog } from './models';

/**
 * Usage Log — which clients/projects consume how many tokens and dollars.
 * Data is the llm_usage ledger (written by the /llm quota proxy), grouped by
 * project + provider + model, with the raw request log underneath.
 */
@Component({
  selector: 'app-usage',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2 class="page-title">Usage Log</h2>
      <p class="page-subtitle">
        Token and cost consumption per project/client from the LLM quota proxy ledger —
        who burns what, on which model, at what cost.
      </p>

      <div class="header-row">
        <div class="row">
          @for (p of periods; track p.id) {
            <button class="btn-ghost" [class.active]="period() === p.id" (click)="setPeriod(p.id)">{{ p.label }}</button>
          }
        </div>
        <select [ngModel]="project()" (ngModelChange)="setProject($event)">
          <option value="">all projects</option>
          @for (p of projects(); track p) {
            <option [value]="p">{{ p }}</option>
          }
        </select>
      </div>

      @if (loadError()) {
        <div class="card">
          <p class="error">Could not load the usage ledger.</p>
          <button class="btn-ghost" (click)="load()">Retry</button>
        </div>
      } @else if (loading() && !data()) {
        <div class="card"><p class="muted">Loading…</p></div>
      } @else if (data(); as d) {
        <div class="kpi-grid">
          <div class="kpi">
            <div class="label">Cost</div>
            <div class="val">\${{ d.totals.costUsd.toFixed(3) }}</div>
          </div>
          <div class="kpi">
            <div class="label">Requests</div>
            <div class="val">{{ d.totals.requests }}</div>
          </div>
          <div class="kpi">
            <div class="label">Tokens in / out</div>
            <div class="val">{{ fmt(d.totals.inputTokens) }} / {{ fmt(d.totals.outputTokens) }}</div>
          </div>
          <div class="kpi">
            <div class="label">Cached / reasoning</div>
            <div class="val">{{ fmt(d.totals.cachedTokens) }} / {{ fmt(d.totals.reasoningTokens) }}</div>
          </div>
          <div class="kpi">
            <div class="label">Errors</div>
            <div class="val">{{ d.totals.errors }}</div>
          </div>
        </div>

        <h3 class="section-title">By project &amp; model</h3>
        <table>
          <thead>
            <tr>
              <th>Project</th><th>Provider / model</th><th>Requests</th><th>In</th>
              <th>Out</th><th>Cached</th><th>Reasoning</th><th>Cost</th><th>Errors</th>
            </tr>
          </thead>
          <tbody>
            @for (b of d.breakdown; track b.project + b.model) {
              <tr>
                <td class="mono">{{ b.project }}</td>
                <td class="mono">{{ b.provider }} / {{ b.model }}</td>
                <td>{{ b.requests }}</td>
                <td class="mono">{{ fmt(b.inputTokens) }}</td>
                <td class="mono">{{ fmt(b.outputTokens) }}</td>
                <td class="mono">{{ fmt(b.cachedTokens) }}</td>
                <td class="mono">{{ fmt(b.reasoningTokens) }}</td>
                <td class="mono">\${{ b.costUsd.toFixed(3) }}</td>
                <td>
                  @if (b.errors) { <span class="badge danger">{{ b.errors }}</span> } @else { <span class="muted">—</span> }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="9" class="muted">No LLM usage recorded in this period.</td></tr>
            }
          </tbody>
        </table>

        <h3 class="section-title">Recent requests</h3>
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Project</th><th>Model</th><th>Tokens (in/out)</th>
              <th>Cost</th><th>Latency</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            @for (e of d.entries; track e.ts + e.model + e.latencyMs) {
              <tr>
                <td class="mono">{{ e.ts.slice(0, 16).replace('T', ' ') }}</td>
                <td class="mono">{{ e.project }}</td>
                <td class="mono">{{ e.model }}</td>
                <td class="mono">{{ fmt(e.inputTokens) }} / {{ fmt(e.outputTokens) }}</td>
                <td class="mono">\${{ e.costUsd.toFixed(4) }}</td>
                <td class="mono">{{ (e.latencyMs / 1000).toFixed(1) }}s</td>
                <td>
                  @if (e.status === 'ok') {
                    <span class="badge ok">ok</span>
                  } @else {
                    <span class="badge danger" [title]="e.error || ''">{{ e.status }}</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="7" class="muted">Nothing in this period.</td></tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: `
    .header-row { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); margin: var(--sp-3) 0; }
    .row { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
    button.btn-ghost { font: inherit; font-weight: 600; background: transparent; color: var(--accent-strong); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); cursor: pointer; }
    button.btn-ghost.active { background: var(--accent-bg); border-color: var(--accent); }
  `,
})
export class UsageComponent implements OnInit {
  private api = inject(ApiService);

  readonly periods = [
    { id: '24h', label: 'Today' },
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
  ];

  readonly period = signal('24h');
  readonly project = signal('');
  readonly data = signal<UsageLog | null>(null);
  readonly loading = signal(false);
  readonly loadError = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  projects(): string[] {
    return [...new Set((this.data()?.breakdown ?? []).map((b) => b.project))].sort();
  }

  fmt(n: number): string {
    return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  setPeriod(p: string): void {
    this.period.set(p);
    void this.load();
  }

  setProject(p: string): void {
    this.project.set(p);
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await this.api.usageLog(this.period(), this.project() || undefined));
      this.loadError.set(false);
    } catch {
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
