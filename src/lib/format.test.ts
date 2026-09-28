import { describe, expect, it } from "vitest";
import { parseAt } from "./format";

describe("parseAt", () => {
  it("reads flexrouter's offset-plus-Z times", () => {
    expect(parseAt("2026-09-26T10:00:00.000+00:00Z")).toBe(Date.UTC(2026, 8, 26, 10));
  });

  it("reads plain ISO times too", () => {
    expect(parseAt("2026-09-26T10:00:00.000Z")).toBe(Date.UTC(2026, 8, 26, 10));
  });
});
