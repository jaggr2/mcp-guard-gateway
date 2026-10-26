import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { Approval } from './models';

@Component({
  selector: 'app-approvals',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2 class="page-title">HITL Approvals</h2>
      <p class="page-subtitle">Human-in-the-loop gates for sensitive tool calls — approve or deny with a TTL, from this UI or the HA approval card.</p>
      <div class="row">
        <label>Status</label>
        <select [(ngModel)]="status" (ngModelChange)="reload()">
          <option value="">all</option>
          <option value="pending">pending</option>
          <option value="approved">approved</option>
          <option value="denied">denied</option>
          <option value="expired">expired</option>
        </select>
        <button (click)="reload()">Refresh</button>
      </div>
      <table>
        <thead>
          <tr><th>Tool</th><th>Reason</th><th>Status</th><th>Created</th><th>Expires</th><th></th></tr>
        </thead>
        <tbody>
          @for (a of approvals(); track a.approval_id) {
            <tr>
              <td class="mono">{{ a.tool }}</td>
              <td>{{ a.reason }}</td>
              <td>{{ a.status }}</td>
              <td class="muted">{{ a.created_at }}</td>
              <td class="muted">{{ a.expires_at ?? '—' }}</td>
              <td>
                @if (a.status === 'pending') {
                  <button (click)="resolve(a, 'approve')">approve</button>
                  <button class="danger" (click)="resolve(a, 'deny')">deny</button>
                }
              </td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="muted">No approvals.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
    .muted { color: #888; } .mono { font-family: monospace; } .danger { color: #c0392b; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
  `,
})
export class ApprovalsComponent {
  private api = inject(ApiService);
  approvals = signal<Approval[]>([]);
  status = '';

  constructor() {
    void this.reload();
  }

  async reload() {
    const res = await this.api.approvals(this.status || undefined);
    this.approvals.set(res.approvals);
  }

  async resolve(a: Approval, action: 'approve' | 'deny') {
    await this.api.resolveApproval(a.approval_id, action);
    await this.reload();
  }
}
