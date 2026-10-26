/** Manual file access to the agent-memory repo (Warden UI detail view).
 *
 * Operator-trusted counterpart of `learn-skill`: read + write files under
 * `memories/`, `skills/`, `journal/` (plus top-level `*.md` like MEMORY.md)
 * with the same path-traversal guards, and an optional git commit+push using
 * the same best-effort push/rebase flow as learning proposals.
 *
 * Deliberately NOT secret-scanned: `processLearningProposal` scans because it
 * ingests agent output from sandboxes; these writes come from an
 * authenticated operator (forward-auth / operator token) editing by hand.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ALLOWED_ROOTS = ["memories/", "skills/", "journal/"];
const MAX_BYTES = 512 * 1024;

export interface MemoryFileInfo {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
}

/** Normalize + validate an operator-supplied repo path. Returns null when unsafe. */
export function cleanMemoryPath(raw: string): string | null {
  const clean = normalize(String(raw))
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .replace(/\\/g, "/");
  if (clean.includes("/../") || clean.endsWith("/..") || clean.startsWith("../")) return null;
  const inRoot = ALLOWED_ROOTS.some((r) => clean.startsWith(r));
  const topLevelMd = /^[^/]+\.md$/.test(clean);
  return inRoot || topLevelMd ? clean : null;
}

export function readMemoryFile(
  agentMemoryDir: string,
  rawPath: string
): MemoryFileInfo | { error: string } {
  const path = cleanMemoryPath(rawPath);
  if (!path) return { error: "path must be under memories/, skills/, journal/, or a top-level .md" };
  const full = join(agentMemoryDir, path);
  if (!existsSync(full)) return { error: "not found" };
  const st = statSync(full);
  if (!st.isFile()) return { error: "not a file" };
  if (st.size > MAX_BYTES) return { error: "file too large to edit (>512KB)" };
  return {
    path,
    content: readFileSync(full, "utf8"),
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
  };
}

export function writeMemoryFile(
  agentMemoryDir: string,
  rawPath: string,
  content: string,
  commit: boolean
): { path: string; commitRef: string | null } | { error: string } {
  const path = cleanMemoryPath(rawPath);
  if (!path) return { error: "path must be under memories/, skills/, journal/, or a top-level .md" };
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
    return { error: "content too large (>512KB)" };
  }

  const full = join(agentMemoryDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content.endsWith("\n") ? content : `${content}\n`, "utf8");

  if (!commit || !existsSync(join(agentMemoryDir, ".git"))) {
    return { path, commitRef: null };
  }

  let commitRef: string | null = null;
  try {
    execFileSync("git", ["-C", agentMemoryDir, "add", "-A"], { stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-C",
        agentMemoryDir,
        "-c",
        "user.name=warden-ui",
        "-c",
        "user.email=opencode@jaggi.xyz",
        "commit",
        "-m",
        `edit: ${path} (manual, Warden UI)`,
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
      // Same recovery as learn-skill: a concurrent push landed first.
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
        console.warn(`[warden memory] manual edit commit ${commitRef} not pushed:`, String(pushError));
      }
    }
  } catch (err) {
    return { error: `git commit failed: ${String(err).slice(0, 200)}` };
  }
  return { path, commitRef };
}
