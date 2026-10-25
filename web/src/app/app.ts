import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="shell">
      <nav>
        <div class="brand">🛡️ Warden</div>
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Overview</a>
        <a routerLink="/sandboxes" routerLinkActive="active">Sandboxes</a>
        <a routerLink="/browser" routerLinkActive="active">Browser Sessions</a>
        <a routerLink="/memory" routerLinkActive="active">Memory & Cron</a>
        <a routerLink="/upstreams" routerLinkActive="active">MCP Upstreams</a>
        <a routerLink="/approvals" routerLinkActive="active">HITL Approvals</a>
        <a routerLink="/audit" routerLinkActive="active">Audit Log</a>
        <a routerLink="/clients" routerLinkActive="active">Clients</a>
        <a routerLink="/settings" routerLinkActive="active">Settings & Secrets</a>
      </nav>
      <main>
        <router-outlet />
      </main>
    </div>
  `,
  styles: `
    .shell { display: flex; min-height: 100vh; }
    nav { width: 210px; padding: 16px; display: flex; flex-direction: column; gap: 6px; border-right: 1px solid #2a2a2a; background: #141414; }
    .brand { font-weight: 700; font-size: 1.1rem; margin-bottom: 12px; color: #58a6ff; }
    nav a { color: #ccc; text-decoration: none; padding: 6px 8px; border-radius: 4px; }
    nav a.active { background: #1f3a5f; color: #fff; }
    main { flex: 1; padding: 24px; }
  `,
})
export class App {}
