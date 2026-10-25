import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { ApiService } from './api.service';
import type { BrowserSession, BrowserSessionMode } from './models';

/** Pull a readable message out of the API's `{ error }` JSON bodies. */
function describeError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const body = err.error as { error?: unknown; detail?: unknown } | string | null;
    const detail =
      body && typeof body === 'object'
        ? [body.error, body.detail].find((v): v is string => typeof v === 'string')
        : typeof body === 'string' && body
          ? body
          : undefined;
    return detail ? `${detail} (HTTP ${err.status})` : err.message || `HTTP ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}

@Component({
  selector: 'app-browser',
  standalone: true,
  template: `
    <div class="page">
      <h2>Browser Sessions</h2>
      <p class="muted">
        Live Chromium sessions driven by agents via the Browser Broker. Watching is passive: the
        agent keeps control of the browser until you explicitly take over.
      </p>

      @if (authError()) {
        <p class="error">Authentication required - this UI is behind Authelia forward-auth.</p>
      }
      @if (loadError()) {
        <div class="banner error-banner">{{ loadError() }}</div>
      }

      @if (!loaded()) {
        <p class="muted">Loading...</p>
      } @else {
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>State</th>
              <th>Mode</th>
              <th>Current page</th>
              <th>Viewers (watch / control)</th>
              <th>RAM</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            @for (s of sessions(); track s.project) {
              <tr
                [class]="s.project === selected() ? 'clickable selected' : 'clickable'"
                tabindex="0"
                (click)="select(s.project)"
                (keydown.enter)="select(s.project)"
              >
                <td class="mono">{{ s.project }}</td>
                <td><span [class]="'dot ' + s.state"></span>{{ s.state }}</td>
                <td><span [class]="s.mode === 'operator' ? 'mode operator' : 'mode'">{{ s.mode }}</span></td>
                <td>
                  <div class="page-title">{{ s.title || s.currentUrl || '-' }}</div>
                  @if (s.title && s.currentUrl) {
                    <div class="muted mono url">{{ s.currentUrl }}</div>
                  }
                </td>
                <td>{{ s.viewers }} / {{ s.takeoverViewers }}</td>
                <td>{{ fmtRam(s.ramBytes) }}</td>
                <td class="muted">{{ fmtAgo(s.lastActivityAt) }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="7" class="muted">
                  <strong>No browser sessions</strong>
                  <div>
                    Sessions appear here when an agent calls browser tools
                    (<span class="mono">playwright_*</span> / <span class="mono">devtools_*</span>)
                    for a project.
                  </div>
                </td>
              </tr>
            }
          </tbody>
        </table>
      }

      @if (selectedSession(); as s) {
        <div class="viewer-card">
          <div class="viewer-head">
            <div>
              <h3>{{ s.project }}</h3>
              <div class="muted">
                <span [class]="'dot ' + s.state"></span>
                {{ s.state }}
                &middot;
                @if (s.mode === 'operator') {
                  operator has control
                } @else {
                  agent has control
                }
              </div>
            </div>
            <div class="viewer-actions">
              @if (s.mode === 'agent') {
                <button
                  class="btn-takeover"
                  [disabled]="busy() || s.state !== 'ready'"
                  (click)="setMode('operator')"
                >
                  Take Over (agent pauses)
                </button>
              } @else {
                <button class="btn-release" [disabled]="busy() || s.state !== 'ready'" (click)="setMode('agent')">
                  Release (back to agent)
                </button>
              }
            </div>
          </div>

          @if (actionError()) {
            <div class="banner error-banner">{{ actionError() }}</div>
          }

          @if (s.mode === 'agent') {
            <p class="hint">
              You are watching passively - nothing you do in the view reaches the page, and the
              agent is not interrupted. Take over only when you want to drive the browser yourself.
            </p>
          } @else {
            <p class="hint">
              You have taken over - keyboard and mouse input in the view goes to the browser and the
              agent is paused. Release to hand control back.
            </p>
          }

          @if (viewerUrl(); as url) {
            <iframe class="vnc" [src]="url" title="Browser session viewer"></iframe>
          } @else {
            <div class="viewer-off">Viewer unavailable - session is {{ s.state }}.</div>
          }

          <div class="meta muted">
            profile {{ s.profile || 'default' }} &middot; started {{ fmtTime(s.startedAt) }} &middot;
            boots {{ s.bootCount }} &middot; crashes {{ s.crashCount }} &middot; artifacts
            {{ s.artifactCount }}
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .muted { color: #8b949e; font-size: 0.9rem; }
    .mono { font-family: monospace; }
    .error { color: #c0392b; }
    .banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; }
    .error-banner { background: #f8514922; border: 1px solid #f85149; color: #f85149; }

    table { width: 100%; border-collapse: collapse; margin: 8px 0 20px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
    tr.clickable { cursor: pointer; }
    tr.clickable:hover { background: #161b22; }
    tr.selected { background: #1f3a5f; }
    .page-title { font-size: 0.9rem; }
    .url { font-size: 0.75rem; max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .dot.ready { background: #3fb950; }
    .dot.booting { background: #d29922; }
    .dot.stopped { background: #8b949e; }
    .dot.error { background: #f85149; }

    .mode { padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; background: #30363d; color: #c9d1d9; text-transform: uppercase; }
    .mode.operator { background: #d2992233; color: #d29922; border: 1px solid #d29922; }

    .viewer-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 16px; margin-bottom: 24px; }
    .viewer-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .viewer-head h3 { margin: 0 0 4px; font-size: 1.1rem; }
    .viewer-actions { display: flex; gap: 8px; }
    .viewer-actions button { border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .viewer-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-takeover { background: #d29922; color: #0d1117; }
    .btn-release { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
    .hint { font-size: 0.85rem; color: #8b949e; margin: 10px 0; }
    iframe.vnc { width: 100%; height: 540px; border: 1px solid #30363d; border-radius: 8px; background: #000; display: block; }
    .viewer-off { height: 200px; display: flex; align-items: center; justify-content: center; border: 1px dashed #30363d; border-radius: 8px; color: #8b949e; }
    .meta { margin-top: 10px; font-size: 0.8rem; }
  `,
})
export class BrowserComponent {
  private api = inject(ApiService);
  private sanitizer = inject(DomSanitizer);
  private destroyRef = inject(DestroyRef);

  sessions = signal<BrowserSession[]>([]);
  selected = signal<string | null>(null);
  loaded = signal(false);
  authError = signal(false);
  loadError = signal<string | null>(null);
  actionError = signal<string | null>(null);
  busy = signal(false);
  /** Bumped after a mode change so the embedded noVNC client reconnects. */
  private reconnectNonce = signal(0);

  selectedSession = computed(
    () => this.sessions().find((s) => s.project === this.selected()) ?? null,
  );

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    void this.refresh();
    if (!document.hidden) this.startPolling();
    const onVisibility = () => (document.hidden ? this.stopPolling() : this.resumePolling());
    document.addEventListener('visibilitychange', onVisibility);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      this.stopPolling();
    });
  }

  async refresh() {
    try {
      const res = await this.api.listBrowserSessions();
      this.sessions.set(res.sessions);
      this.loadError.set(null);
      this.authError.set(false);
      const selected = this.selected();
      if (selected && !res.sessions.some((s) => s.project === selected)) {
        this.selected.set(null);
      }
    } catch (err) {
      this.authError.set(this.api.authError);
      this.loadError.set(this.api.authError ? null : describeError(err));
    } finally {
      this.loaded.set(true);
    }
  }

  select(project: string) {
    if (this.selected() === project) return;
    this.selected.set(project);
    this.actionError.set(null);
    this.reconnectNonce.set(0);
  }

  /**
   * The raw WS route (view-only vs interactive) is chosen at connect time from
   * the session mode, so the noVNC embed must reconnect after a mode change.
   */
  viewerUrl(): SafeResourceUrl | null {
    const s = this.selectedSession();
    if (!s || s.state !== 'ready') return null;
    // Same-origin URL built from encodeURIComponent(project) + a numeric nonce;
    // Angular still requires an explicit trust for iframe src (NG0904).
    return this.sanitizer.bypassSecurityTrustResourceUrl(
      `/novnc/vnc.html?autoconnect=true&resize=scale&path=p/${encodeURIComponent(s.project)}/vnc` +
        `&r=${this.reconnectNonce()}`
    );
  }

  async setMode(mode: BrowserSessionMode) {
    const s = this.selectedSession();
    if (!s || this.busy() || s.state !== 'ready') return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await this.api.setBrowserSessionMode(s.project, mode);
      this.reconnectNonce.update((n) => n + 1);
      await this.refresh();
    } catch (err) {
      this.actionError.set(describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  fmtRam(bytes: number | null): string {
    if (bytes == null) return '-';
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }

  fmtTime(ts: number | null): string {
    return ts == null ? '-' : new Date(ts).toLocaleString();
  }

  fmtAgo(ts: number | null): string {
    if (ts == null) return '-';
    const min = Math.floor(Math.max(0, Date.now() - ts) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hours = Math.floor(min / 60);
    return hours < 24 ? `${hours}h ago` : new Date(ts).toLocaleString();
  }

  private startPolling() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.refresh(), 5000);
  }

  private stopPolling() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private resumePolling() {
    void this.refresh();
    this.startPolling();
  }
}
