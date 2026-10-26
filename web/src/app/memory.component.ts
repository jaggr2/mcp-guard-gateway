import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import type { LearningEntry } from './models';

@Component({
  selector: 'app-memory',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page">
      <h2>Central Agent Memory (<code>jaggr2/agent-memory</code>) & Cron</h2>
      <p class="muted">
        Skills (<code>SKILL.md</code>) and engineering gotchas submitted via <code>/learn-skill</code> (<code>warden_propose_learning</code>), mounted read-only into all OpenCode sandboxes.
      </p>

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
    .muted { color: #8b949e; }
    .mono { font-family: monospace; }
    .section { margin-top: 24px; }
    .header-row { display: flex; justify-content: space-between; align-items: center; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px; margin: 12px 0; }
    .grid-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
    input, select, textarea { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; padding: 6px 8px; border-radius: 6px; }
    .btn-primary { background: #1f6feb; color: #fff; border: none; padding: 7px 12px; border-radius: 6px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #2a2a2a; }
  `,
})
export class MemoryComponent {
  private api = inject(ApiService);
  learnings = signal<LearningEntry[]>([]);
  showAddLearning = signal(false);

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
  }

  async load() {
    const l = await this.api.listLearnings();
    this.learnings.set(l.learnings);
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
