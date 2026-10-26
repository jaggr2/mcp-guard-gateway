import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from './api.service';
import type { SkillCheckResult, SkillSource } from './models';

/**
 * Skill Updates — compare each skill's SKILL.md against its `source_url`
 * and refresh ones that deviated. Divergence is normal here (skills carry
 * local adaptations) — the diff is the review artifact before updating.
 */
@Component({
  selector: 'app-skill-updates',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="page">
      <h2 class="page-title">Skill Updates</h2>
      <p class="page-subtitle">
        Each skill can declare a <code>source_url</code> in its SKILL.md frontmatter. Check whether
        local skills still match their upstream source and refresh the ones that drifted.
        <a routerLink="/memory">← Memory &amp; Skills</a>
      </p>

      <div class="header-row">
        <div class="row">
          <button class="btn-primary" (click)="checkAll()" [disabled]="checking()">Check all</button>
          @if (checking()) { <span class="muted">checking…</span> }
          @if (lastRun(); as t) { <span class="muted mono">checked {{ t }}</span> }
        </div>
        <span class="muted">{{ sources().length }} skills · {{ noSourceCount() }} without source</span>
      </div>

      @if (loadError()) {
        <div class="card"><p class="error">Could not load the skill list.</p></div>
      } @else if (!loaded()) {
        <div class="card"><p class="muted">Loading…</p></div>
      } @else {
        <table>
          <thead>
            <tr><th>Skill</th><th>Source</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            @for (s of rows(); track s.name) {
              <tr>
                <td>
                  <a [routerLink]="['/editor']" [queryParams]="{ path: 'skills/' + s.name + '/SKILL.md' }" class="mono">{{ s.name }}</a>
                </td>
                <td>
                  @if (s.sourceUrl) {
                    <a [href]="s.sourceUrl" target="_blank" rel="noopener" class="mono small">source</a>
                  } @else {
                    <span class="muted">local</span>
                  }
                </td>
                <td>
                  <span class="badge" [class.ok]="statusOf(s.name) === 'up-to-date'"
                        [class.warn]="statusOf(s.name) === 'deviated' || statusOf(s.name) === 'fetch-error'">
                    {{ statusOf(s.name) || 'unchecked' }}
                  </span>
                </td>
                <td class="row">
                  <button class="btn-ghost" (click)="checkOne(s)" [disabled]="busy() === s.name">Check</button>
                  @if (hasDiff(s.name)) {
                    <button class="btn-ghost" (click)="toggleDiff(s.name)">{{ expanded() === s.name ? 'Hide diff' : 'Diff' }}</button>
                    <button class="btn-primary" (click)="update(s)" [disabled]="busy() === s.name">
                      {{ busy() === s.name ? 'Updating…' : 'Update' }}
                    </button>
                  }
                </td>
              </tr>
              @if (expanded() === s.name && resultFor(s.name); as r) {
                <tr>
                  <td colspan="4">
                    <pre class="diff">{{ r.diff.join('\\n') }}</pre>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: `
    .header-row { display: flex; justify-content: space-between; align-items: center; margin: var(--sp-3) 0; }
    .row { display: flex; gap: var(--sp-2); align-items: center; }
    .small { font-size: var(--fs-xs); }
    .diff { background: var(--bg-inset); border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--sp-3); font-family: var(--font-mono); font-size: var(--fs-xs); overflow-x: auto; }
    .btn-primary, .btn-ghost { font: inherit; font-weight: 600; border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-3); cursor: pointer; }
    .btn-primary { background: var(--accent); color: var(--text-on-accent); border: none; }
    .btn-ghost { background: transparent; color: var(--accent-strong); border: 1px solid var(--border-strong); }
  `,
})
export class SkillUpdatesComponent implements OnInit {
  private api = inject(ApiService);

  readonly sources = signal<SkillSource[]>([]);
  readonly results = signal<SkillCheckResult[]>([]);
  readonly loaded = signal(false);
  readonly loadError = signal(false);
  readonly checking = signal(false);
  readonly busy = signal<string | null>(null);
  readonly expanded = signal<string | null>(null);
  readonly lastRun = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const res = await this.api.skillSources();
      this.sources.set(res.skills);
      this.loaded.set(true);
    } catch {
      this.loadError.set(true);
    }
  }

  rows(): SkillSource[] {
    return this.sources();
  }

  noSourceCount(): number {
    return this.sources().filter((s) => !s.sourceUrl).length;
  }

  resultFor(name: string): SkillCheckResult | undefined {
    return this.results().find((r) => r.name === name);
  }

  statusOf(name: string): string {
    return this.resultFor(name)?.status ?? '';
  }

  hasDiff(name: string): boolean {
    return this.statusOf(name) === 'deviated';
  }

  toggleDiff(name: string): void {
    this.expanded.set(this.expanded() === name ? null : name);
  }

  private upsert(result: SkillCheckResult): void {
    this.results.set([result, ...this.results().filter((r) => r.name !== result.name)]);
    this.lastRun.set(new Date().toLocaleTimeString());
  }

  async checkOne(s: SkillSource): Promise<void> {
    this.busy.set(s.name);
    try {
      const res = await this.api.checkSkills(s.name);
      if (res.results[0]) this.upsert(res.results[0]);
    } finally {
      this.busy.set(null);
    }
  }

  async checkAll(): Promise<void> {
    this.checking.set(true);
    try {
      const res = await this.api.checkSkills();
      this.results.set(res.results);
      this.lastRun.set(new Date().toLocaleTimeString());
    } catch {
      this.loadError.set(true);
    } finally {
      this.checking.set(false);
    }
  }

  async update(s: SkillSource): Promise<void> {
    this.busy.set(s.name);
    try {
      await this.api.updateSkill(s.name);
      const res = await this.api.checkSkills(s.name);
      if (res.results[0]) this.upsert(res.results[0]);
    } catch {
      const current = this.resultFor(s.name);
      if (current) this.upsert({ ...current, status: 'fetch-error' });
    } finally {
      this.busy.set(null);
    }
  }
}
