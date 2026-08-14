import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { ToolEntry, Upstream } from './models';

@Component({
  selector: 'app-upstreams',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2>Upstreams</h2>

      <form class="row" (ngSubmit)="add()">
        <input [(ngModel)]="newName" name="newName" placeholder="namespace (e.g. nanokvm)" required />
        <input [(ngModel)]="newUrl" name="newUrl" placeholder="https://…/mcp" required class="grow" />
        <button [disabled]="busy()">Register + pin</button>
      </form>
      <p class="hint">Registering auto-pins the upstream's current tools as the trust baseline. Tools are disabled until enabled below.</p>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <table>
        <thead>
          <tr><th>Namespace</th><th>URL</th><th>State</th><th>Tools</th><th>Drift</th><th></th></tr>
        </thead>
        <tbody>
          @for (up of upstreams(); track up.namespace) {
            <tr>
              <td>
                <button class="link" (click)="select(up)">{{ up.displayName }}</button>
                <span class="muted" [class.off]="!up.enabled">[{{ up.enabled ? 'on' : 'off' }}]</span>
              </td>
              <td class="mono">{{ up.url }}</td>
              <td>{{ up.trust?.state ?? 'unpinned' }}</td>
              <td>{{ up.toolCount }}</td>
              <td>{{ up.driftAction }}</td>
              <td>
                <button (click)="toggleEnabled(up)">{{ up.enabled ? 'disable' : 'enable' }}</button>
                <button class="danger" (click)="remove(up)">delete</button>
              </td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="muted">No upstreams configured.</td></tr>
          }
        </tbody>
      </table>

      @if (selected()) {
        <section>
          <h3>{{ selected()!.displayName }} — pinned tools</h3>
          <div class="row">
            <span class="muted">state: {{ toolsState() }}</span>
            <button (click)="rePin()">Re-pin baseline</button>
          </div>
          <table>
            <thead>
              <tr><th>Tool</th><th>Enabled</th><th>Guard</th><th>Timeout</th><th>TTL min</th></tr>
            </thead>
            <tbody>
              @for (t of tools(); track t.name) {
                <tr>
                  <td>
                    <span class="mono">{{ t.name }}</span>
                    <div class="muted small">{{ t.description }}</div>
                  </td>
                  <td><input type="checkbox" [checked]="t.enabled" (change)="toggleTool(t)" /></td>
                  <td>
                    <select [ngModel]="t.guard" (ngModelChange)="setGuard(t, $event)">
                      <option value="none">none</option>
                      <option value="reason">reason</option>
                      <option value="hitl">hitl</option>
                    </select>
                  </td>
                  <td>
                    <select [ngModel]="t.timeoutAction ?? ''" (ngModelChange)="setTimeout(t, $event)">
                      <option value="">—</option>
                      <option value="deny">deny</option>
                      <option value="approve">approve</option>
                    </select>
                  </td>
                  <td><input type="number" [ngModel]="t.ttlMinutes ?? ''" (ngModelChange)="setTtl(t, $event)" /></td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="muted">No pinned tools yet — register/pin the upstream.</td></tr>
              }
            </tbody>
          </table>
        </section>
      }
    </div>
  `,
  styles: `
    .grow { flex: 1; } .row { display: flex; gap: 8px; margin: 8px 0; }
    .row input { padding: 6px; } .muted { color: #888; } .off { opacity: .5; }
    .small { font-size: 12px; } .mono { font-family: monospace; }
    .link { background: none; border: none; color: #4a9eff; cursor: pointer; padding: 0; font-size: 14px; }
    .danger { color: #c0392b; } .error { color: #c0392b; } .hint { color: #888; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
    section { margin-top: 24px; }
  `,
})
export class UpstreamsComponent {
  private api = inject(ApiService);

  upstreams = signal<Upstream[]>([]);
  selected = signal<Upstream | null>(null);
  tools = signal<ToolEntry[]>([]);
  toolsState = signal('');
  busy = signal(false);
  error = signal('');
  newName = '';
  newUrl = '';

  constructor() {
    void this.reload();
  }

  async reload() {
    try {
      const res = await this.api.listUpstreams();
      this.upstreams.set(res.upstreams);
    } catch {
      this.error.set('Failed to load upstreams (authentication required).');
    }
  }

  async add() {
    const namespace = this.newName.trim();
    const url = this.newUrl.trim();
    if (!namespace || !url) return;
    this.busy.set(true);
    try {
      await this.api.createUpstream({ namespace, url });
      this.newName = '';
      this.newUrl = '';
      await this.reload();
      const up = this.upstreams().find((u) => u.namespace === namespace);
      if (up) {
        await this.select(up);
        await this.api.pinUpstream(namespace);
        await this.refreshTools();
      }
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async select(up: Upstream) {
    this.selected.set(up);
    await this.refreshTools();
  }

  async refreshTools() {
    const up = this.selected();
    if (!up) return;
    try {
      const res = await this.api.tools(up.namespace);
      this.tools.set(res.tools);
      this.toolsState.set(res.state);
    } catch {
      this.tools.set([]);
      this.toolsState.set('unpinned');
    }
  }

  async rePin() {
    const up = this.selected();
    if (!up) return;
    await this.api.pinUpstream(up.namespace);
    await this.refreshTools();
    await this.reload();
  }

  async toggleEnabled(up: Upstream) {
    await this.api.updateUpstream(up.namespace, { enabled: !up.enabled });
    await this.reload();
  }

  async remove(up: Upstream) {
    await this.api.deleteUpstream(up.namespace);
    if (this.selected()?.namespace === up.namespace) {
      this.selected.set(null);
      this.tools.set([]);
    }
    await this.reload();
  }

  async toggleTool(t: ToolEntry) {
    await this.savePolicy(t, { enabled: !t.enabled });
  }

  async setGuard(t: ToolEntry, guard: string) {
    await this.savePolicy(t, { guard: guard as ToolEntry['guard'] });
  }

  async setTimeout(t: ToolEntry, action: string) {
    await this.savePolicy(t, { timeoutAction: action || null } as Partial<ToolEntry>);
  }

  async setTtl(t: ToolEntry, minutes: string) {
    await this.savePolicy(t, { ttlMinutes: minutes === '' ? null : Number(minutes) });
  }

  private async savePolicy(t: ToolEntry, patch: Partial<ToolEntry>) {
    const up = this.selected();
    if (!up) return;
    await this.api.setToolPolicy(up.namespace, t.name, patch);
    await this.refreshTools();
  }
}
