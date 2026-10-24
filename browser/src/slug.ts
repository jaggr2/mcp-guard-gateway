/** Slugs are validated before touching port allocation or any path (Part 10.1). */
export const SLUG_RE = /^[a-z0-9-]{1,32}$/;

/** The reserved shared-session project (Phase 0 / fallback). */
export const DEFAULT_PROJECT = "_default";

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** Project ids are slugs plus the reserved `_default` fallback name. */
export function isProjectId(value: string): boolean {
  return value === DEFAULT_PROJECT || SLUG_RE.test(value);
}

export class SlugError extends Error {
  constructor(value: string) {
    super(`invalid project slug: ${JSON.stringify(value)} (expected ^[a-z0-9-]{1,32}$)`);
    this.name = "SlugError";
  }
}

export function assertProjectId(value: string): string {
  if (!isProjectId(value)) throw new SlugError(value);
  return value;
}
