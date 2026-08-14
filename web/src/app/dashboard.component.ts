import { Component, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import type { StatusInfo } from './models';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  template: `
    <div class="page">
      <h2>Status</h2>
      @if (authError()) {
        <p class="error">Authentication required — this UI is behind Authelia forward-auth.</p>
      }
      @if (info()) {
        <p>Public URL: <code>{{ info()!.publicUrl }}</code></p>
        <p>OIDC issuers: <code>{{ info()!.issuers.join(', ') || 'none' }}</code></p>
        <h3>Upstreams</h3>
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
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
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
