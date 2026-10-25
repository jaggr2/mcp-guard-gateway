import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { ConfigStore, LearningRow } from "../store/config";
import { scanOutboundSecrets } from "../guards/security";

export interface ProposeLearningInput {
  sourceProject: string;
  kind: "gotcha" | "memory" | "skill";
  targetPath: string;
  title: string;
  content: string;
  mode?: "append" | "replace";
  rationale?: string;
}

/**
 * Compose the `append` block: a `## <title>` heading followed by the content.
 *
 * If the content already starts with a heading that repeats the title verbatim,
 * strip that line — `append` emits the heading itself, and a repeated heading
 * corrupts the memory file (seen in production 2026-10-25 on
 * `memories/homelab-incus.md`: a duplicated `## ...` line plus a stray blank).
 */
export function composeAppendBlock(title: string, content: string): string {
  const body = content.trim();
  const firstLine = body.split("\n", 1)[0];
  const heading = firstLine.match(/^#{1,6}\s+(.*?)\s*$/);
  if (heading && heading[1].toLowerCase() === title.trim().toLowerCase()) {
    const rest = body.slice(firstLine.length).trim();
    return `\n\n## ${title}\n${rest ? `${rest}\n` : ""}`;
  }
  return `\n\n## ${title}\n${body}\n`;
}

/**
 * Validates and persists a learning or skill update proposed via `warden_propose_learning`
 * (invoked by the `learn-skill` OpenCode skill inside any sandbox).
 *
 * 1. Rejects path traversal or leaked secrets.
 * 2. Writes to the local `jaggr2/agent-memory` checkout (when present on disk) + journal entry,
 *    commits with author `oc-<project>[bot]`, and pushes to origin/main.
 * 3. Records the entry in the SQLite `learnings` table for the Warden UI & audit trail.
 */
export function processLearningProposal(
  configStore: ConfigStore,
  agentMemoryDir: string | null,
  input: ProposeLearningInput,
  knownSecrets: string[] = []
): { ok: true; learning: LearningRow } | { ok: false; error: string } {
  const cleanTarget = normalize(input.targetPath).replace(/^(\.\.(\/|\\|$))+/, "").replace(/\\/g, "/");
  if (
    !cleanTarget.startsWith("memories/") &&
    !cleanTarget.startsWith("skills/") &&
    !cleanTarget.startsWith("journal/")
  ) {
    return {
      ok: false,
      error: "target_path must start with 'memories/', 'skills/', or 'journal/'",
    };
  }

  const secretScan = scanOutboundSecrets({ title: input.title, content: input.content }, knownSecrets);
  if (!secretScan.ok) {
    return {
      ok: false,
      error: `[Warden Memory Guard] Rejected learning proposal containing potential secret (${secretScan.match})`,
    };
  }

  const mode = input.mode === "replace" ? "replace" : "append";
  let commitRef: string | null = null;

  if (agentMemoryDir && existsSync(agentMemoryDir)) {
    try {
      const fullPath = join(agentMemoryDir, cleanTarget);
      mkdirSync(dirname(fullPath), { recursive: true });

      if (mode === "append" && existsSync(fullPath)) {
        const existing = readFileSync(fullPath, "utf8");
        writeFileSync(fullPath, existing.trimEnd() + composeAppendBlock(input.title, input.content), "utf8");
      } else {
        writeFileSync(fullPath, input.content.trim() + "\n", "utf8");
      }

      // Also write a provenance journal entry
      const now = new Date();
      const ym = now.toISOString().slice(0, 7);
      const ymd = now.toISOString().slice(0, 10);
      const slug = input.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      const journalDir = join(agentMemoryDir, "journal", ym);
      mkdirSync(journalDir, { recursive: true });
      const journalFile = join(journalDir, `${ymd}-${input.sourceProject}-${slug}.md`);
      writeFileSync(
        journalFile,
        `# ${input.title}\n\n- **Source Sandbox:** \`${input.sourceProject}\`\n- **Kind:** \`${input.kind}\`\n- **Target:** \`${cleanTarget}\`\n- **Timestamp:** ${now.toISOString()}\n- **Rationale:** ${input.rationale ?? "n/a"}\n\n---\n\n${input.content.trim()}\n`,
        "utf8"
      );

      if (existsSync(join(agentMemoryDir, ".git"))) {
        execFileSync("git", ["-C", agentMemoryDir, "add", "-A"], { stdio: "ignore" });
        execFileSync(
          "git",
          [
            "-C",
            agentMemoryDir,
            "-c",
            `user.name=oc-${input.sourceProject}[bot]`,
            "-c",
            "user.email=opencode@jaggi.xyz",
            "commit",
            "-m",
            `learn(${input.sourceProject}): ${input.title}`,
          ],
          { stdio: "ignore" }
        );
        commitRef = execFileSync("git", ["-C", agentMemoryDir, "rev-parse", "--short", "HEAD"], {
          encoding: "utf8",
        }).trim();
        try {
          execFileSync("git", ["-C", agentMemoryDir, "push", "origin", "main"], {
            stdio: "ignore",
            timeout: 15_000,
          });
        } catch {
          // Diverged from origin (e.g. a host-side push landed first): rebase the
          // learning commit on top and retry once. Push stays best-effort when
          // offline, but a real failure must show up in the logs — it used to be
          // swallowed silently and left learn-commits stranded on one disk.
          try {
            execFileSync("git", ["-C", agentMemoryDir, "pull", "--rebase", "origin", "main"], {
              stdio: "ignore",
              timeout: 20_000,
            });
            execFileSync("git", ["-C", agentMemoryDir, "push", "origin", "main"], {
              stdio: "ignore",
              timeout: 15_000,
            });
          } catch (pushError) {
            console.warn(
              `[warden memory] learning committed as ${commitRef} but push to origin/main failed:`,
              pushError instanceof Error ? pushError.message : pushError
            );
          }
        }
      }
    } catch {
      /* disk/git errors fall back to SQLite record */
    }
  }

  const learning = configStore.insertLearning({
    sourceProject: input.sourceProject,
    kind: input.kind,
    targetPath: cleanTarget,
    title: input.title,
    content: input.content,
    mode,
    rationale: input.rationale ?? null,
    status: "committed",
    commitRef,
  });

  return { ok: true, learning };
}
