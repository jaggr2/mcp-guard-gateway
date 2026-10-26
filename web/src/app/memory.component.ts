import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { LearningEntry, MemoryTree, MemoryTreeSkill } from './models';

@Component({
  selector: 'app-memory',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2 class="page-title">Central Memory &amp; Skills</h2>
      <p class="page-subtitle">
        <code>jaggr2/agent-memory</code> — skills (<code>SKILL.md</code>) and engineering gotchas submitted
        via <code>learn-skill</code> (<code>warden_propose_learning</code>), mounted read-only into every
        OpenCode sandbox and pushed back to GitHub.
      </p>

      <div class="section">
        <div class="header-row">
          <h3>Library</h3>
          <div class="row">
            <button class="btn-ghost btn-primary" (click)="newFile()">+ New file</button>
            <button class="btn-ghost btn-primary" (click)="loadTree()">Refresh</button>
          </div>
        </div>
        @if (treeError()) {
          <p class="error">agent-memory is not mounted on the server.</p>
        } @else if (tree(); as t) {
          <p class="muted mono">{{ t.root }}</p>
          <div class="tree">
            <details open>
              <summary>skills ({{ t.skills.length }})</summary>
              <div class="tree-grid">
                @for (s of t.skills; track s.name) {
                  <div class="tree-item tree-click" (click)="openSkill(s)" [title]="s.description">
                    <span class="mono tree-name">{{ s.name }}</span>
                    <span class="muted">{{ s.description }}</span>
                  </div>
                } @empty {
                  <div class="muted">none yet</div>
                }
              </div>
            </details>
            <details>
              <summary>memories ({{ t.memories.length }})</summary>
              @for (m of t.memories; track m.name) {
                <div class="tree-file mono tree-click" (click)="openFile(m.path)">├─ {{ m.name }}</div>
              }
            </details>
            <details>
              <summary>journal ({{ t.journal.length }})</summary>
              @for (j of t.journal; track j.name) {
                <details class="tree-sub">
                  <summary class="mono">├─ {{ j.name }} ({{ j.count }} entries)</summary>
                  @for (f of j.files; track f) {
                    <div class="tree-file mono tree-click" (click)="openFile(j.path + '/' + f)">│  ├─ {{ f }}</div>
                  }
                </details>
              }
            </details>
            @if (t.other.length) {
              <details>
                <summary>root files ({{ t.other.length }})</summary>
                @for (o of t.other; track o) {
                  <div class="tree-file mono tree-click" (click)="openFile(o)">├─ {{ o }}</div>
                }
              </details>
            }
          </div>
        } @else {
          <p class="muted">Loading library…</p>
        }
      </div>

      @if (detailOpen()) {
        <div class="section">
          <div class="header-row">
            <h3 class="mono">{{ selectedPath() || 'New file' }}</h3>
            <div class="row">
              @if (fileDirty()) { <span class="badge warn">unsaved</span> }
              @if (saveMsg(); as msg) { <span class="badge ok">{{ msg }}</span> }
              <button class="btn-primary" (click)="saveFile(true)"
                      [disabled]="fileLoading() || (!fileDirty() && !creating())">Save &amp; commit</button>
              <button class="btn-ghost btn-primary" (click)="saveFile(false)"
                      [disabled]="fileLoading() || (!fileDirty() && !creating())">Save</button>
              <button class="btn-ghost" (click)="closeDetail()">Close</button>
            </div>
          </div>

          @if (creating()) {
            <label class="new-path">
              Path (under memories/, skills/, journal/ — or a top-level .md)
              <input class="grow" [ngModel]="selectedPath()" (ngModelChange)="selectedPath.set($event)"
                     placeholder="memories/my-note.md" />
            </label>
          }

          @if (skillFiles().length > 1) {
            <div class="file-strip">
              @for (f of skillFiles(); track f) {
                <button class="file-chip" [class.active]="selectedPath() === skillDir() + '/' + f"
                        (click)="openFile(skillDir() + '/' + f)">{{ f }}</button>
              }
            </div>
          }

          @if (fileError(); as err) {
            <p class="error">{{ err }}</p>
          }
          @if (fileLoading()) {
            <p class="muted">Loading…</p>
          } @else {
            <textarea class="editor" rows="24" spellcheck="false"
                      [ngModel]="fileContent()" (ngModelChange)="onEdit($event)"></textarea>
            <p class="muted mono">{{ fileContent().length }} chars</p>
          }
        </div>
      }

      <div class="section">
        <div class="header-row">
          <h3>Recent Learnings & Skill Updates</h3>
          <button class="btn-primary" (click)="showAddLearning.set(!showAddLearning())">
            {{ showAddLearning() ? 'Cancel' : '+ Add Memory / Skill' }}
          </button>
        </div>

        @if (showAddLearning()) {
          <div class="card">
            <div class="grid-form">
              <label>
                Kind
                <select [(ngModel)]="lForm.kind">
                  <option value="gotcha">Gotcha</option>
                  <option value="memory">Domain Memory</option>
                  <option value="skill">Skill (SKILL.md)</option>
                </select>
              </label>
              <label>
                Target Path in <code>jaggr2/agent-memory</code>
                <input [(ngModel)]="lForm.targetPath" placeholder="memories/aws-cdk-gotchas.md" />
              </label>
              <label>
                Title
                <input [(ngModel)]="lForm.title" placeholder="Short lesson title" />
              </label>
              <label>
                Rationale
                <input [(ngModel)]="lForm.rationale" placeholder="Why this is reusable" />
              </label>
            </div>
            <label>
              Markdown Content
              <textarea rows="4" [(ngModel)]="lForm.content"></textarea>
            </label>
            <button class="btn-primary" style="margin-top: 10px" (click)="submitLearning()">Commit to agent-memory</button>
          </div>
        }

        <table>
          <thead>
            <tr><th>Time</th><th>Sandbox</th><th>Kind</th><th>Target Path</th><th>Title</th><th>Commit</th></tr>
          </thead>
          <tbody>
            @for (l of learnings(); track l.id) {
              <tr>
                <td class="mono">{{ l.ts.slice(0, 16) }}</td>
                <td class="mono">{{ l.sourceProject }}</td>
                <td>{{ l.kind }}</td>
                <td class="mono">{{ l.targetPath }}</td>
                <td>{{ l.title }}</td>
                <td class="mono">{{ l.commitRef || 'sqlite' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: `
    .muted { color: var(--text-muted); }
    .mono { font-family: monospace; }
    .section { margin-top: 24px; }
    .header-row { display: flex; justify-content: space-between; align-items: center; }
    .card { background: var(--bg-surface); border: 1px solid var(--border-strong); border-radius: 8px; padding: 14px; margin: 12px 0; }
    .grid-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
    input, select, textarea { background: var(--bg-inset); border: 1px solid var(--border-strong); color: var(--text); padding: 6px 8px; border-radius: 6px; }
    .btn-primary { background: var(--accent); color: var(--text-on-accent); border: none; padding: 7px 12px; border-radius: 6px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
    .tree { margin-top: var(--sp-2); }
    .tree details { margin: var(--sp-2) 0; }
    .tree summary { cursor: pointer; font-weight: 650; color: var(--text); }
    .tree-sub summary { font-weight: 500; color: var(--text-muted); }
    .tree-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--sp-1) var(--sp-4); margin: var(--sp-2) 0 var(--sp-2) var(--sp-4); }
    .tree-item { display: flex; gap: var(--sp-2); font-size: var(--fs-sm); overflow: hidden; }
    .tree-name { color: var(--accent-strong); flex: none; }
    .tree-file { margin-left: var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); }
    .tree-click { cursor: pointer; }
    .tree-click:hover { color: var(--accent-strong); }
    .row { display: flex; gap: var(--sp-2); align-items: center; }
    .file-strip { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: var(--sp-2) 0; }
    .file-chip { font: inherit; font-size: var(--fs-xs); background: var(--bg-elevated); color: var(--text-muted); border: 1px solid var(--border-strong); border-radius: var(--r-pill); padding: 2px var(--sp-2); cursor: pointer; }
    .file-chip.active { background: var(--accent-bg); color: var(--accent-strong); border-color: var(--accent); }
    .new-path { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); margin-bottom: var(--sp-2); }
    .grow { flex: 1; }
    .editor { width: 100%; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.5; background: var(--bg-inset); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: var(--sp-3); resize: vertical; }
  `,
})
export class MemoryComponent {
  private api = inject(ApiService);
  learnings = signal<LearningEntry[]>([]);
  tree = signal<MemoryTree | null>(null);
  treeError = signal(false);
  showAddLearning = signal(false);

  // file detail view
  detailOpen = signal(false);
  creating = signal(false);
  selectedPath = signal('');
  skillDir = signal('');
  skillFiles = signal<string[]>([]);
  fileContent = signal('');
  fileLoading = signal(false);
  fileError = signal<string | null>(null);
  fileDirty = signal(false);
  saveMsg = signal<string | null>(null);
  private loadedContent = '';

  lForm: {
    kind: 'gotcha' | 'memory' | 'skill';
    targetPath: string;
    title: string;
    content: string;
    rationale: string;
  } = {
    kind: 'gotcha',
    targetPath: 'memories/aws-cdk-gotchas.md',
    title: '',
    content: '',
    rationale: '',
  };

  constructor() {
    void this.load();
    void this.loadTree();
  }

  async load() {
    const l = await this.api.listLearnings();
    this.learnings.set(l.learnings);
  }

  async loadTree() {
    try {
      this.tree.set(await this.api.memoryTree());
      this.treeError.set(false);
    } catch {
      this.treeError.set(true);
    }
  }

  openSkill(skill: MemoryTreeSkill) {
    this.skillDir.set(skill.path);
    this.skillFiles.set(skill.fileNames ?? []);
    void this.openFile(`${skill.path}/SKILL.md`);
  }

  async openFile(path: string) {
    this.detailOpen.set(true);
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
    } catch {
      this.fileError.set('Could not load this file.');
    } finally {
      this.fileLoading.set(false);
    }
  }

  newFile() {
    this.detailOpen.set(true);
    this.creating.set(true);
    this.selectedPath.set('memories/');
    this.skillFiles.set([]);
    this.fileContent.set('');
    this.loadedContent = '';
    this.fileDirty.set(false);
    this.fileError.set(null);
    this.saveMsg.set(null);
  }

  onEdit(value: string) {
    this.fileContent.set(value);
    this.fileDirty.set(value !== this.loadedContent);
  }

  closeDetail() {
    this.detailOpen.set(false);
  }

  async saveFile(commit: boolean) {
    const path = this.selectedPath().trim();
    if (!path) return;
    this.fileLoading.set(true);
    this.fileError.set(null);
    try {
      const res = await this.api.saveMemoryFile(path, this.fileContent(), commit);
      this.loadedContent = this.fileContent();
      this.fileDirty.set(false);
      this.creating.set(false);
      this.saveMsg.set(commit && res.commitRef ? `committed ${res.commitRef}` : 'saved');
      setTimeout(() => this.saveMsg.set(null), 5000);
      await this.loadTree();
    } catch {
      this.fileError.set(
        'Save failed — path must be under memories/, skills/, journal/ (or a top-level .md) and under 512KB.'
      );
    } finally {
      this.fileLoading.set(false);
    }
  }

  async submitLearning() {
    if (!this.lForm.title.trim() || !this.lForm.content.trim()) return;
    await this.api.createLearning(this.lForm);
    this.showAddLearning.set(false);
    this.lForm.title = '';
    this.lForm.content = '';
    await this.load();
  }
}
