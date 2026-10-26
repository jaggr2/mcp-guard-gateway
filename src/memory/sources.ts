/** Skill source tracking — `source_url` frontmatter in SKILL.md.
 *
 * Powers the "Skill Updates" page: each skill can declare where it came from;
 * the page checks whether the local SKILL.md still matches its source and can
 * refresh it (write + commit). Local adaptations intentionally deviate — the
 * diff is the review artifact before updating.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeMemoryFile } from "./files";

export interface SkillSourceInfo {
  name: string;
  sourceUrl: string;
  version: string;
}

export interface SkillCheckResult {
  name: string;
  sourceUrl: string;
  status: "up-to-date" | "deviated" | "no-source" | "fetch-error";
  localLines: number;
  sourceLines: number;
  diff: string[];
}

function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0 && !line.startsWith(" ")) {
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

export function listSkillSources(agentMemoryDir: string): SkillSourceInfo[] {
  const skillsDir = join(agentMemoryDir, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((name: string) => existsSync(join(skillsDir, name, "SKILL.md")))
    .sort()
    .map((name: string) => {
      const fm = frontmatter(readFileSync(join(skillsDir, name, "SKILL.md"), "utf8"));
      return {
        name,
        sourceUrl: fm.source_url ?? fm["source-url"] ?? "",
        version: fm.version ?? "",
      };
    });
}

function naiveDiff(local: string, source: string): string[] {
  const a = local.split("\n");
  const b = source.split("\n");
  const lines: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && lines.length < 24; i++) {
    if ((a[i] ?? "") !== (b[i] ?? "")) {
      lines.push(`@@ line ${i + 1}`);
      lines.push(`- ${(a[i] ?? "(eof)").slice(0, 120)}`);
      lines.push(`+ ${(b[i] ?? "(eof)").slice(0, 120)}`);
    }
  }
  return lines;
}

async function fetchSource(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "warden-github-manager" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

export async function checkSkillSource(
  agentMemoryDir: string,
  name: string
): Promise<SkillCheckResult> {
  const skillMd = join(agentMemoryDir, "skills", name, "SKILL.md");
  const base: SkillCheckResult = {
    name,
    sourceUrl: "",
    status: "no-source",
    localLines: 0,
    sourceLines: 0,
    diff: [],
  };
  if (!existsSync(skillMd)) return { ...base, status: "fetch-error" };
  const local = readFileSync(skillMd, "utf8");
  base.localLines = local.split("\n").length;
  const fm = frontmatter(local);
  const url = fm.source_url ?? fm["source-url"] ?? "";
  base.sourceUrl = url;
  if (!url) return base;

  try {
    const source = await fetchSource(url);
    // Only text that looks like a SKILL.md (frontmatter) is checkable — a repo
    // landing page URL is informational and must not read as "deviated".
    if (!source.trimStart().startsWith("---")) {
      return { ...base, status: "fetch-error" };
    }
    base.sourceLines = source.split("\n").length;
    const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
    if (norm(local) === norm(source)) {
      base.status = "up-to-date";
    } else {
      base.status = "deviated";
      base.diff = naiveDiff(local, source);
    }
    return base;
  } catch {
    return { ...base, status: "fetch-error" };
  }
}

export async function updateSkillFromSource(
  agentMemoryDir: string,
  name: string
): Promise<{ ok: true; commitRef: string | null } | { error: string }> {
  const check = await checkSkillSource(agentMemoryDir, name);
  if (!check.sourceUrl) return { error: "skill has no source_url" };
  if (check.status === "fetch-error") return { error: "could not fetch the source" };
  if (check.status === "up-to-date") return { ok: true, commitRef: null };
  try {
    const source = await fetchSource(check.sourceUrl);
    const res = writeMemoryFile(agentMemoryDir, `skills/${name}/SKILL.md`, source, true);
    if ("error" in res) return res;
    return { ok: true, commitRef: res.commitRef };
  } catch (err) {
    return { error: `update failed: ${String(err).slice(0, 200)}` };
  }
}
