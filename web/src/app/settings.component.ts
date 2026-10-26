import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2 class="page-title">Secrets</h2>
      <p class="page-subtitle">
        Encrypted credentials for upstreams (AES-256-GCM, server-side only). Approval cards
        and alerts are delivered to the Home Assistant notify service — that target is static
        config (<code>HASS_NOTIFY_SERVICE</code> in <code>warden.env</code>), not editable here.
      </p>

      <h3>Upstream secrets</h3>
      <p class="hint">
        Secrets are encrypted at rest (AES-256-GCM). Reference them in an upstream's header map as
        <code>$SECRET:NAME</code>, e.g. <code>Authorization: $SECRET:NANOKVM_API_KEY</code>.
      </p>
      <div class="row">
        <input [(ngModel)]="secretName" placeholder="secret name (e.g. NANOKVM_API_KEY)" class="grow" />
        <input [(ngModel)]="secretValue" type="password" placeholder="value" class="grow" />
        <button (click)="saveSecret()">Store</button>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Stored at</th><th></th></tr></thead>
        <tbody>
          @for (s of secrets(); track s.name) {
            <tr>
              <td class="mono">{{ s.name }}</td>
              <td class="muted">{{ s.created_at }}</td>
              <td><button class="danger" (click)="removeSecret(s.name)">delete</button></td>
            </tr>
          } @empty {
            <tr><td colspan="3" class="muted">No secrets stored.</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .grow { flex: 1; } .row { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
    .hint { color: var(--text-muted); font-size: 13px; } .muted { color: var(--text-muted); } .mono { font-family: monospace; }
    .danger { color: var(--danger-text); }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  `,
})
export class SettingsComponent {
  private api = inject(ApiService);
  secretName = '';
  secretValue = '';
  secrets = signal<{ name: string; created_at: string }[]>([]);

  constructor() {
    void this.reloadSecrets();
  }

  async reloadSecrets() {
    const res = await this.api.secrets();
    this.secrets.set(res.secrets);
  }

  async saveSecret() {
    if (!this.secretName.trim() || !this.secretValue) return;
    await this.api.saveSecret(this.secretName.trim(), this.secretValue);
    this.secretName = '';
    this.secretValue = '';
    await this.reloadSecrets();
  }

  async removeSecret(name: string) {
    await this.api.deleteSecret(name);
    await this.reloadSecrets();
  }
}
