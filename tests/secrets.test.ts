import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { riskFromHits, scanFileForSecrets, scanTextForSecrets } from "../src/engine/secrets.js";

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

describe("scanFileForSecrets", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agc-sec-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("finds a secret beyond the old 256 KB head window", async () => {
    const file = path.join(dir, "late.jsonl");
    await fs.writeFile(
      file,
      "a".repeat(300_000) + "\nAWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\n",
    );
    expect(await scanFileForSecrets(file)).toContain("aws-access-key");
  });

  it("finds a secret in the tail of a file larger than the head window", async () => {
    const file = path.join(dir, "huge.jsonl");
    const small = { maxBytes: 1024, tailBytes: 512 };
    await fs.writeFile(file, "a".repeat(50_000) + "\nghp_" + "b".repeat(36) + "\n");
    expect(await scanFileForSecrets(file, small)).toContain("github-token");
  });

  it("returns nothing for a clean file", async () => {
    const file = path.join(dir, "clean.jsonl");
    await fs.writeFile(file, '{"text":"nothing to see"}');
    expect(await scanFileForSecrets(file)).toEqual([]);
  });
});
