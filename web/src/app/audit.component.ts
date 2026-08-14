import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { AuditRow } from './models';

@Component({
  selector: 'app-audit',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2>Audit log</h2>
      <div class="row">
        <input [(ngModel)]="tool" placeholder="tool filter (e.g. nanokvm_…)" />
        <button (click)="reload()">Query</button>
      </div>
      <table>
        <thead>
          <tr><th>#</th><th>Time</th><th>Caller</th><th>Tool</th><th>Reason</th><th>Decision</th><th>By</th><th>Upstream</th></tr>
        </thead>
        <tbody>
          @for (r of rows(); track r.id) {
            <tr>
              <td class="muted">{{ r.id }}</td>
              <td class="muted">{{ r.ts }}</td>
              <td class="mono">{{ r.caller_id }}</td>
              <td class="mono">{{ r.tool }}</td>
              <td>{{ r.reason ?? '—' }}</td>
              <td>{{ r.decision }}</td>
              <td>{{ r.approved_by ?? '—' }}</td>
              <td class="muted">{{ r.upstream_status ?? '—' }}</td>
            </tr>
          } @empty {
            <tr><td colspan="8" class="muted">No audit rows.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .row { display: flex; gap: 8px; margin: 8px 0; }
    .muted { color: #888; } .mono { font-family: monospace; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #2a2a2a; }
  `,
})
export class AuditComponent {
  private api = inject(ApiService);
  rows = signal<AuditRow[]>([]);
  tool = '';

  constructor() {
    void this.reload();
  }

  async reload() {
    const res = await this.api.audit({ tool: this.tool || undefined, limit: 200 });
    this.rows.set(res.rows);
  }
}
