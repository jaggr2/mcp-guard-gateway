import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { SandboxEntry } from './models';

@Component({
  selector: 'app-sandboxes',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="header-row">
        <div>
          <h2>OpenCode Project Sandboxes</h2>
          <p class="muted">Isolated Incus sandboxes on <code>*.oc.jaggi.xyz</code> with zero stored secrets, LLM budget caps, and native LocalStack/Docker support.</p>
        </div>
        <button class="btn-primary" (click)="showCreate.set(!showCreate())">
          {{ showCreate() ? 'Cancel' : '+ New / Import Project' }}
        </button>
      </div>

      @if (createdToken()) {
        <div class="banner">
          <strong>Sandbox provisioned!</strong> Scoped token (auto-injected into <code>/etc/sandbox.env</code>):
          <code>{{ createdToken() }}</code>
        </div>
      }

      @if (showCreate()) {
        <div class="card form-card">
          <h3>Provision OpenCode Sandbox</h3>
          <div class="grid-form">
            <label>
              Project Slug (GitHub repo under <code>jaggr2/</code>)
              <input [(ngModel)]="form.slug" placeholder="e.g. rsearch or my-new-app" />
            </label>
            <label>
              Display Name
              <input [(ngModel)]="form.displayName" placeholder="e.g. rsearch" />
            </label>
            <label>
              Blueprint / Source
              <select [(ngModel)]="form.template">
                <option value="import">Import existing jaggr2/&lt;slug&gt; repo</option>
                <option value="fullstack">Create new: Full-Stack AWS + TS + Angular (rsearch style)</option>
                <option value="cdk">Create new: AWS CDK + TypeScript Lambda (calendar-sync style)</option>
                <option value="minimal">Create new: Minimal TypeScript + Node 24</option>
              </select>
            </label>
            <label>
              Lifecycle Mode
              <select [(ngModel)]="form.lifecycleMode">
                <option value="auto-stop">Auto-stop after 2h idle (wake on HTTP visit)</option>
                <option value="always-on">Always-on container</option>
              </select>
            </label>
            <label>
              Daily Budget (USD)
              <input type="number" step="0.5" [(ngModel)]="form.dailyBudgetUsd" />
            </label>
            <label>
              Monthly Budget (USD)
              <input type="number" step="1" [(ngModel)]="form.monthlyBudgetUsd" />
            </label>
            <label>
              Allowed MCP Upstreams (CSV or <code>*</code>)
              <input [(ngModel)]="form.allowedUpstreams" placeholder="github,aws,playwright" />
            </label>
            <label>
              AWS IAM Role ARN (optional, for Roles Anywhere STS broker)
              <input [(ngModel)]="form.awsRoleArn" placeholder="arn:aws:iam::123456789012:role/..." />
            </label>
          </div>
          <div class="actions">
            <button class="btn-primary" (click)="provision()">Provision Sandbox & Repo</button>
          </div>
        </div>
      }

      <div class="cards">
        @for (s of sandboxes(); track s.slug) {
          <div class="card">
            <div class="card-top">
              <div>
                <span class="badge" [class.running]="s.status === 'running'">{{ s.status }}</span>
                <span class="badge mode">{{ s.lifecycleMode }}</span>
                <h3>{{ s.displayName }}</h3>
                <div class="mono muted">{{ s.slug }} · branch {{ s.branch }} ({{ s.dirtyFiles }} dirty)</div>
              </div>
              <div class="ide-links">
                <a class="btn-ide" [href]="s.url" target="_blank" rel="noopener">Open OpenCode Web ↗</a>
                <a class="btn-link" [href]="s.repoUrl" target="_blank" rel="noopener">GitHub ↗</a>
              </div>
            </div>

            <div class="metrics">
              <div>
                <div class="label">Today Spend / Cap</div>
                <div class="val">\${{ s.usage.costTodayUsd.toFixed(3) }} / \${{ s.dailyBudgetUsd.toFixed(2) }}</div>
              </div>
              <div>
                <div class="label">Month Spend / Cap</div>
                <div class="val">\${{ s.usage.costMonthUsd.toFixed(2) }} / \${{ s.monthlyBudgetUsd.toFixed(2) }}</div>
              </div>
              <div>
                <div class="label">OpenCode Go Tokens (Today)</div>
                <div class="val">{{ s.usage.opencodeGoTokensToday.toLocaleString() }}</div>
              </div>
              <div>
                <div class="label">Allowed MCPs</div>
                <div class="val mono">{{ s.allowedUpstreams }}</div>
              </div>
            </div>

            <div class="card-actions">
              @if (s.status !== 'running') {
                <button (click)="act(s.slug, 'start')">▶ Start</button>
              } @else {
                <button (click)="act(s.slug, 'stop')">⏹ Stop</button>
              }
              <button (click)="act(s.slug, 'restart')">↻ Restart</button>
              <button (click)="act(s.slug, 'snapshot')">📸 Snapshot</button>
              <button class="danger" (click)="remove(s.slug)">Delete</button>
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .muted { color: #8b949e; font-size: 0.9rem; }
    .mono { font-family: monospace; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; }
    .form-card { margin-bottom: 20px; }
    .grid-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 12px 0; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; color: #c9d1d9; }
    input, select { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; padding: 7px 10px; border-radius: 6px; }
    .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .card-top h3 { margin: 6px 0 2px; font-size: 1.1rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; background: #30363d; color: #c9d1d9; margin-right: 6px; text-transform: uppercase; }
    .badge.running { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb; }
    .Ide-links, .ide-links { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
    .btn-ide { background: #238636; color: #fff; text-decoration: none; padding: 6px 12px; border-radius: 6px; font-size: 0.85rem; font-weight: 600; }
    .btn-link { color: #58a6ff; text-decoration: none; font-size: 0.8rem; }
    .btn-primary { background: #1f6feb; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 14px 0; padding: 10px; background: #0d1117; border-radius: 8px; }
    .metrics .label { font-size: 0.75rem; color: #8b949e; }
    .metrics .val { font-size: 0.95rem; font-weight: 600; margin-top: 2px; }
    .card-actions { display: flex; gap: 8px; }
    .card-actions button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 5px 10px; border-radius: 6px; cursor: pointer; }
    .card-actions button.danger { color: #f85149; }
    .banner { background: #1f6feb22; border: 1px solid #1f6feb; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; }
  `,
})
export class SandboxesComponent {
  private api = inject(ApiService);
  sandboxes = signal<SandboxEntry[]>([]);
  showCreate = signal(false);
  createdToken = signal<string | null>(null);

  form = {
    slug: '',
    displayName: '',
    template: 'import',
    lifecycleMode: 'auto-stop',
    dailyBudgetUsd: 5.0,
    monthlyBudgetUsd: 30.0,
    allowedUpstreams: 'github,aws,playwright',
    awsRoleArn: '',
  };

  constructor() {
    void this.load();
  }

  async load() {
    const res = await this.api.listSandboxes();
    this.sandboxes.set(res.sandboxes);
  }

  async provision() {
    if (!this.form.slug.trim()) return;
    const res = await this.api.createSandbox(this.form);
    this.createdToken.set(res.sandboxToken);
    this.showCreate.set(false);
    this.form.slug = '';
    this.form.displayName = '';
    await this.load();
  }

  async act(slug: string, action: 'start' | 'stop' | 'restart' | 'snapshot') {
    await this.api.sandboxAction(slug, action);
    await this.load();
  }

  async remove(slug: string) {
    await this.api.deleteSandbox(slug);
    await this.load();
  }
}
