import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { ClientRow } from './models';

@Component({
  selector: 'app-clients',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2 class="page-title">Machine Clients</h2>
      <p class="page-subtitle">Service tokens for headless callers — scope-limited, hashed at rest.</p>
      <p class="hint">
        Service tokens for MCP clients that can't do browser OAuth (e.g. opencode). The token is
        shown once; store it in the client's config.
      </p>
      <form class="row" (ngSubmit)="create()">
        <input [(ngModel)]="name" name="name" placeholder="client name (e.g. opencode)" required />
        <button [disabled]="busy()">Create token</button>
      </form>
      @if (newToken()) {
        <div class="token">
          <code>{{ newToken() }}</code>
          <button (click)="newToken.set('')">dismiss</button>
        </div>
      }
      <table>
        <thead><tr><th>Name</th><th>Id</th><th>Scopes</th><th>Created</th><th></th></tr></thead>
        <tbody>
          @for (c of clients(); track c.id) {
            <tr>
              <td>{{ c.name }}</td>
              <td class="mono">{{ c.id }}</td>
              <td>{{ c.scopes }}</td>
              <td class="muted">{{ c.createdAt }}</td>
              <td><button class="danger" (click)="remove(c)">revoke</button></td>
            </tr>
          } @empty {
            <tr><td colspan="5" class="muted">No clients.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .row { display: flex; gap: 8px; margin: 8px 0; }
    .hint { color: var(--text-muted); font-size: 13px; } .muted { color: var(--text-muted); } .mono { font-family: monospace; }
    .danger { color: var(--danger-text); }
    .token { display: flex; gap: 8px; align-items: center; background: color-mix(in srgb, var(--ok-graphic) 12%, transparent); padding: 8px; border-radius: 4px; margin: 8px 0; }
    .token code { word-break: break-all; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  `,
})
export class ClientsComponent {
  private api = inject(ApiService);
  clients = signal<ClientRow[]>([]);
  newToken = signal('');
  name = '';
  busy = signal(false);

  constructor() {
    void this.reload();
  }

  async reload() {
    const res = await this.api.clients();
    this.clients.set(res.clients);
  }

  async create() {
    if (!this.name.trim()) return;
    this.busy.set(true);
    try {
      const res = await this.api.createClient(this.name.trim());
      this.newToken.set(res.token);
      this.name = '';
      await this.reload();
    } finally {
      this.busy.set(false);
    }
  }

  async remove(c: ClientRow) {
    await this.api.deleteClient(c.id);
    await this.reload();
  }
}
