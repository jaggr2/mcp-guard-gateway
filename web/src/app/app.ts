import { Component, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar">
      <button class="burger" (click)="navOpen.set(!navOpen())" aria-label="Toggle navigation">
        <span></span><span></span><span></span>
      </button>
      <span class="brand-mini">◈ Warden</span>
    </header>

    <div class="shell">
      <nav [class.open]="navOpen()" (click)="navOpen.set(false)">
        <div class="brand">
          <span class="brand-mark">◈</span>
          <span class="brand-name">Warden</span>
          <span class="brand-sub">AI Control Plane</span>
        </div>

        <div class="nav-group">
          <div class="nav-label">Operate</div>
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Overview</a>
          <a routerLink="/usage" routerLinkActive="active">Usage Log</a>
          <a routerLink="/sandboxes" routerLinkActive="active">Sandboxes</a>
          <a routerLink="/browser" routerLinkActive="active">Browser Sessions</a>
          <a routerLink="/memory" routerLinkActive="active">Memory &amp; Skills</a>
          <a routerLink="/skill-updates" routerLinkActive="active">Skill Updates</a>
        </div>

        <div class="nav-group">
          <div class="nav-label">Govern</div>
          <a routerLink="/upstreams" routerLinkActive="active">MCP Upstreams</a>
          <a routerLink="/approvals" routerLinkActive="active">HITL Approvals</a>
          <a routerLink="/audit" routerLinkActive="active">Audit Log</a>
        </div>

        <div class="nav-group">
          <div class="nav-label">System</div>
          <a routerLink="/architecture" routerLinkActive="active">Architecture</a>
          <a routerLink="/clients" routerLinkActive="active">Clients</a>
          <a routerLink="/settings" routerLinkActive="active">Secrets</a>
        </div>
      </nav>
      @if (navOpen()) {
        <div class="backdrop" (click)="navOpen.set(false)"></div>
      }
      <main>
        <router-outlet />
      </main>
    </div>
  `,
  styles: `
    .shell { display: flex; min-height: 100vh; }

    nav {
      width: 232px;
      flex: none;
      padding: var(--sp-4) var(--sp-3);
      display: flex;
      flex-direction: column;
      gap: var(--sp-5);
      border-right: 1px solid var(--border);
      background: var(--bg-surface);
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
    }

    .brand {
      display: flex;
      flex-direction: column;
      padding: var(--sp-2) var(--sp-3) var(--sp-3);
      border-bottom: 1px solid var(--border);
    }

    .brand-mark { color: var(--accent); font-size: var(--fs-lg); line-height: 1; }
    .brand-name { font-size: var(--fs-lg); font-weight: 750; letter-spacing: -0.01em; margin-top: var(--sp-1); }
    .brand-sub { color: var(--text-muted); font-size: var(--fs-xs); letter-spacing: 0.06em; text-transform: uppercase; }

    .nav-group { display: flex; flex-direction: column; gap: 2px; }

    .nav-label {
      color: var(--text-muted);
      font-size: var(--fs-xs);
      font-weight: 650;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 0 var(--sp-3);
      margin-bottom: var(--sp-1);
    }

    nav a {
      color: var(--text-muted);
      text-decoration: none;
      padding: var(--sp-2) var(--sp-3);
      border-radius: var(--r-sm);
      font-size: var(--fs-sm);
      font-weight: 550;
    }

    nav a:hover { color: var(--text); background: var(--bg-elevated); }
    nav a.active { background: var(--accent-bg); color: var(--accent-strong); }

    main { flex: 1; padding: var(--sp-6) var(--sp-8); min-width: 0; }

    /* mobile: hamburger + off-canvas drawer */
    .topbar { display: none; }
    .backdrop { display: none; }

    .burger {
      display: inline-flex;
      flex-direction: column;
      gap: 4px;
      background: none;
      border: none;
      padding: var(--sp-2);
      cursor: pointer;
    }

    .burger span { width: 20px; height: 2px; background: var(--text); border-radius: 2px; }
    .brand-mini { font-weight: 750; font-size: var(--fs-md); }

    @media (max-width: 820px) {
      .topbar {
        display: flex;
        align-items: center;
        gap: var(--sp-2);
        position: sticky;
        top: 0;
        z-index: 30;
        background: var(--bg-surface);
        border-bottom: 1px solid var(--border);
        padding: var(--sp-1) var(--sp-2);
      }

      .shell { display: block; }

      nav {
        position: fixed;
        z-index: 40;
        left: 0;
        top: 0;
        height: 100vh;
        width: 248px;
        transform: translateX(-100%);
        transition: transform 0.18s ease;
      }

      nav.open { transform: translateX(0); }

      .backdrop {
        display: block;
        position: fixed;
        inset: 0;
        z-index: 35;
        background: rgba(2, 6, 23, 0.6);
      }

      main { padding: var(--sp-4) var(--sp-3); }
    }
  `,
})
export class App {
  readonly navOpen = signal(false);
}
