import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  assertReason,
  extractReason,
  isValidReason,
  stripReason,
} from "../src/guards/reason";

describe("extractReason / stripReason", () => {
  it("extracts a non-blank reason and strips it from args", () => {
    const args = { x: 1, reason: "because" };
    expect(extractReason(args)).toBe("because");
    expect(stripReason(args)).toEqual({ x: 1 });
  });

  it("treats blank/absent reason as undefined", () => {
    expect(extractReason({ reason: "   " })).toBeUndefined();
    expect(extractReason({})).toBeUndefined();
    expect(extractReason({ reason: 42 })).toBeUndefined();
  });
});

describe("isValidReason", () => {
  it("accepts non-blank strings only", () => {
    expect(isValidReason("turn on the screen")).toBe(true);
    expect(isValidReason("")).toBe(false);
    expect(isValidReason("  \n ")).toBe(false);
    expect(isValidReason(undefined)).toBe(false);
  });
});

describe("assertReason", () => {
  it("throws JSON-RPC -32602 for missing reason", () => {
    try {
      assertReason(undefined);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    }
  });

  it("does not throw for a valid reason", () => {
    expect(() => assertReason("because")).not.toThrow();
  });
});
