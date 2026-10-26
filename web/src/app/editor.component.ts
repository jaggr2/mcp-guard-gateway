import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from './api.service';

/**
 * Editor — dedicated page for viewing/editing one agent-memory file.
 *
 * Save always writes AND commits (git commit + push); Delete commits too.
 * Reached from the Memory & Skills tree via /editor?path=... (no path = new
 * file mode). Sibling files of the same directory render as a chip strip.
 */
@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page">
      <h2 class="page-title">{{ creating() ? 'New file' : 'Edit file' }}</h2>
      <p class="page-subtitle">
        <a routerLink="/memory">← back to Memory &amp; Skills</a>
        · {{ selectedPath() || 'pick a path below' }}
        @if (!creating() && fileMeta(); as meta) {
          · {{ meta.size }} bytes · {{ meta.modifiedAt.slice(0, 16) }}
        }
      </p>

      <div class="header-row">
        <div class="row">
          @if (fileDirty()) { <span class="badge warn">unsaved</span> }
          @if (saveMsg(); as msg) { <span class="badge ok">{{ msg }}</span> }
          <button class="btn-primary" (click)="save()"
                  [disabled]="fileLoading() || (!fileDirty() && !creating())">Save</button>
          @if (!creating()) {
            <button class="btn-danger" (click)="remove()" [disabled]="fileLoading()">Delete</button>
          }
        </div>
      </div>

      @if (creating()) {
        <label class="new-path">
          Path (under memories/, skills/, journal/ — or a top-level .md)
          <input class="grow" [ngModel]="selectedPath()" (ngModelChange)="selectedPath.set($event)"
                 placeholder="memories/my-note.md" />
        </label>
      }

      @if (siblings().length > 1) {
        <div class="file-strip">
          @for (f of siblings(); track f) {
            <button class="file-chip" [class.active]="fileName() === f" (click)="openSibling(f)">{{ f }}</button>
          }
        </div>
      }

      @if (fileError(); as err) {
        <p class="error">{{ err }}</p>
      }
      @if (fileLoading()) {
        <p class="muted">Loading…</p>
      } @else {
        <textarea class="editor" rows="30" spellcheck="false"
                  [ngModel]="fileContent()" (ngModelChange)="onEdit($event)"></textarea>
        <p class="muted mono">{{ fileContent().length }} chars</p>
      }
    </div>
  `,
  styles: `
    .header-row { display: flex; justify-content: space-between; align-items: center; margin: var(--sp-3) 0; }
    .row { display: flex; gap: var(--sp-2); align-items: center; }
    .grow { flex: 1; }
    .new-path { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); margin-bottom: var(--sp-2); }
    .file-strip { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: var(--sp-2) 0; }
    .file-chip { font: inherit; font-size: var(--fs-xs); background: var(--bg-elevated); color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: var(--r-pill); padding: 2px var(--sp-2); cursor: pointer; }
    .file-chip.active { background: var(--accent-bg); color: var(--accent-strong); border-color: var(--accent); }
    .editor { width: 100%; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.5; background: var(--bg-inset); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: var(--sp-3); resize: vertical; }
    .btn-danger { background: transparent; color: var(--danger-text); border: 1px solid var(--danger-graphic); border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-4); font-weight: 600; cursor: pointer; }
  `,
})
export class EditorComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly creating = signal(false);
  readonly selectedPath = signal('');
  readonly fileContent = signal('');
  readonly fileLoading = signal(false);
  readonly fileError = signal<string | null>(null);
  readonly fileDirty = signal(false);
  readonly saveMsg = signal<string | null>(null);
  readonly siblings = signal<string[]>([]);
  readonly fileMeta = signal<{ size: number; modifiedAt: string } | null>(null);
  private loadedContent = '';

  fileName(): string {
    return this.selectedPath().split('/').pop() ?? '';
  }

  ngOnInit(): void {
    const path = this.route.snapshot.queryParamMap.get('path');
    if (path) {
      void this.load(path);
    } else {
      this.newFile();
    }
  }

  newFile(): void {
    this.creating.set(true);
    this.selectedPath.set('memories/');
    this.fileContent.set('');
    this.loadedContent = '';
    this.fileDirty.set(false);
    this.siblings.set([]);
    this.fileMeta.set(null);
  }

  async load(path: string): Promise<void> {
    this.creating.set(false);
    this.selectedPath.set(path);
    this.fileLoading.set(true);
    this.fileError.set(null);
    this.saveMsg.set(null);
    try {
      const f = await this.api.memoryFile(path);
      this.fileContent.set(f.content);
      this.loadedContent = f.content;
      this.fileDirty.set(false);
      this.siblings.set(f.siblings ?? []);
      this.fileMeta.set({ size: f.size, modifiedAt: f.modifiedAt });
    } catch {
      this.fileError.set('Could not load this file.');
    } finally {
      this.fileLoading.set(false);
    }
  }

  openSibling(name: string): void {
    const dir = this.selectedPath().split('/').slice(0, -1).join('/');
    void this.router.navigate(['/editor'], { queryParams: { path: `${dir}/${name}` } });
    void this.load(`${dir}/${name}`);
  }

  onEdit(value: string): void {
    this.fileContent.set(value);
    this.fileDirty.set(value !== this.loadedContent);
  }

  async save(): Promise<void> {
    const path = this.selectedPath().trim();
    if (!path) return;
    this.fileLoading.set(true);
    this.fileError.set(null);
    try {
      // Save always commits + pushes (single action per the operator's ask).
      const res = await this.api.saveMemoryFile(path, this.fileContent(), true);
      this.loadedContent = this.fileContent();
      this.fileDirty.set(false);
      this.creating.set(false);
      this.saveMsg.set(res.commitRef ? `committed ${res.commitRef}` : 'saved');
      this.fileMeta.set({ size: this.fileContent().length, modifiedAt: new Date().toISOString() });
      if (!this.siblings().length) {
        void this.load(path);
      }
    } catch {
      this.fileError.set(
        'Save failed — path must be under memories/, skills/, journal/ (or a top-level .md) and under 512KB.'
      );
    } finally {
      this.fileLoading.set(false);
    }
  }

  async remove(): Promise<void> {
    const path = this.selectedPath().trim();
    if (!path) return;
    if (!confirm(`Delete ${path}? This commits the deletion to agent-memory.`)) return;
    this.fileLoading.set(true);
    this.fileError.set(null);
    try {
      await this.api.deleteMemoryFile(path);
      await this.router.navigate(['/memory']);
    } catch {
      this.fileError.set('Delete failed.');
      this.fileLoading.set(false);
    }
  }
}
