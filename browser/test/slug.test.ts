import { describe, expect, it } from "vitest";
import { assertProjectId, DEFAULT_PROJECT, isProjectId, isSlug, SlugError } from "../src/slug.js";

describe("slug validation", () => {
  it("accepts ^[a-z0-9-]{1,32}$", () => {
    for (const good of ["a", "0", "rsearch", "calendar-m365-google-sync", "a-b-c", "x".repeat(32)]) {
      expect(isSlug(good), good).toBe(true);
    }
  });

  it("rejects everything outside the charset or length range", () => {
    for (const bad of [
      "",
      "A",
      "Project",
      "x_y",
      "_default", // reserved name — not a plain slug
      "x y",
      "x.y",
      "x/y",
      "../etc",
      "x!".repeat(2),
      "-leading-dash-is-ok-but-uppercase-No",
      "ümlaut",
      "x".repeat(33),
    ]) {
      expect(isSlug(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("project ids additionally allow the reserved _default fallback", () => {
    expect(DEFAULT_PROJECT).toBe("_default");
    expect(isProjectId("_default")).toBe(true);
    expect(isProjectId("rsearch")).toBe(true);
    expect(isProjectId("_other")).toBe(false);
    expect(isProjectId("../x")).toBe(false);
    expect(isProjectId("UPPER")).toBe(false);
    expect(isProjectId("")).toBe(false);
  });

  it("assertProjectId throws SlugError for invalid ids", () => {
    expect(assertProjectId("proj-1")).toBe("proj-1");
    expect(() => assertProjectId("bad_slug")).toThrow(SlugError);
  });
});
