import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2>Settings</h2>
      <h3>Hermes</h3>
      <div class="row">
        <label>Conversation key</label>
        <input [(ngModel)]="conversationKey" placeholder="telegram:123456789" class="grow" />
        <button (click)="saveSettings()">Save</button>
      </div>
      <p class="hint">Where approval cards are delivered (Hermes messages_send target).</p>

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
    .hint { color: #888; font-size: 13px; } .muted { color: #888; } .mono { font-family: monospace; }
    .danger { color: #c0392b; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
  `,
})
export class SettingsComponent {
  private api = inject(ApiService);
  conversationKey = '';
  secretName = '';
  secretValue = '';
  secrets = signal<{ name: string; created_at: string }[]>([]);

  constructor() {
    void this.init();
  }

  async init() {
    const res = await this.api.settings();
    this.conversationKey = res.settings['hermes.conversationKey'] ?? '';
    await this.reloadSecrets();
  }

  async saveSettings() {
    await this.api.saveSettings({ 'hermes.conversationKey': this.conversationKey });
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
