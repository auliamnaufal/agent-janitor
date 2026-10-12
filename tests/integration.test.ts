import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { scan } from "../src/engine/scan.js";
import { act, restore } from "../src/engine/act.js";
import { exists } from "../src/util/fs.js";
import type { Env } from "../src/engine/types.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-gc-home-"));
  await fs.mkdir(path.join(home, ".claude", "projects", "proj"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", "projects", "proj", "s1.jsonl"), "transcript");
  await fs.writeFile(path.join(home, ".claude", "settings.json"), "{}");
  await fs.mkdir(path.join(home, ".claude", "statsig"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", "statsig", "cache.bin"), "cache");
  await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "sessions", "roll.jsonl"), "rollout");
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function mkEnv(): Env {
  return { home, roots: [], now: Date.now() + 60_000, graceMs: 0 };
}

describe("scan → act → restore", () => {
  it("classifies transcripts, caches and state differently", async () => {
    const result = await scan(mkEnv(), { only: ["claude-code", "codex"] });
    const kinds = result.findings.map((f) => `${f.kind}:${f.verdict}`);
    expect(kinds).toContain("transcript:reclaimable");
    expect(kinds).toContain("cache:regenerable");
    expect(kinds).toContain("state:stateful");
  });

  it("archives reclaimable, prunes regenerable, never touches state, then restores", async () => {
    const env = mkEnv();
    const result = await scan(env, { only: ["claude-code"] });
    const outcome = await act(result.findings, { prune: true, env, home });

    expect(outcome.archived).toHaveLength(1); // the .jsonl transcript
    expect(outcome.pruned).toHaveLength(1); // the statsig cache
    expect(outcome.manifest).not.toBeNull();

    expect(await exists(path.join(home, ".claude", "projects", "proj", "s1.jsonl"))).toBe(false);
    expect(await exists(path.join(home, ".claude", "settings.json"))).toBe(true);

    const restored = await restore(outcome.manifest as string, {
      stagingRoot: path.join(home, ".agent-gc", "tmp"),
    });
    expect(restored.restored).toHaveLength(1);
    expect(await exists(path.join(home, ".claude", "projects", "proj", "s1.jsonl"))).toBe(true);
    expect(
      await fs.readFile(path.join(home, ".claude", "projects", "proj", "s1.jsonl"), "utf8"),
    ).toBe("transcript");
  });

  it("respects --max-deletes", async () => {
    const env = mkEnv();
    const result = await scan(env, { only: ["claude-code", "codex"] });
    const outcome = await act(result.findings, { prune: false, env, home, maxDeletes: 1 });
    expect(outcome.archived).toHaveLength(1);
    expect(outcome.skipped.some((s) => s.reason.includes("max-deletes"))).toBe(true);
  });

  it("leaves items inside the retention window alone", async () => {
    const env = mkEnv();
    const result = await scan(env, { only: ["claude-code"] });
    // Everything was written moments ago, so a 30-day retention skips it all.
    const outcome = await act(result.findings, {
      prune: false,
      env,
      home,
      minAgeMs: 30 * 86_400_000,
    });
    expect(outcome.archived).toHaveLength(0);
    expect(outcome.skipped.some((s) => s.reason.includes("retention"))).toBe(true);
    expect(await exists(path.join(home, ".claude", "projects", "proj", "s1.jsonl"))).toBe(true);
  });
});
