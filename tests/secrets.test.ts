import { describe, expect, it } from "vitest";
import { riskFromHits, scanTextForSecrets } from "../src/engine/secrets.js";

describe("scanTextForSecrets", () => {
  it("detects well-known credential shapes", () => {
    expect(scanTextForSecrets('key = "AKIAABCDEFGHIJKLMNOP"')).toContain("aws-access-key");
    expect(scanTextForSecrets("sk-ant-abc123def456ghi789jkl")).toContain("anthropic-key");
    expect(scanTextForSecrets("ghp_" + "a".repeat(36))).toContain("github-token");
    expect(scanTextForSecrets("-----BEGIN RSA PRIVATE KEY-----")).toContain("private-key");
    expect(scanTextForSecrets("AIza" + "b".repeat(35))).toContain("google-api-key");
  });

  it("returns nothing for benign text", () => {
    expect(scanTextForSecrets("the quick brown fox jumps over the lazy dog")).toEqual([]);
  });
});

describe("riskFromHits", () => {
  it("maps strong hits to likely, weak hits to possible", () => {
    expect(riskFromHits(["aws-access-key"])).toBe("likely");
    expect(riskFromHits(["jwt"])).toBe("possible");
    expect(riskFromHits([])).toBe("none");
  });
});
