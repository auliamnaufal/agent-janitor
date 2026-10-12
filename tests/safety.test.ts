import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  applyMaxDeletes,
  DEFAULT_RETENTION_DAYS,
  desiredAction,
  isProtectedPath,
  guard,
  planFindings,
} from "../src/engine/safety.js";
import type { Env, Finding } from "../src/engine/types.js";

const base: Finding = {
  agent: "claude-code",
  path: "/home/u/.claude/projects/p/s.jsonl",
  kind: "transcript",
  bytes: 1,
  mtimeMs: 0,
  verdict: "reclaimable",
  secretRisk: "possible",
  reason: "transcript",
};

const env: Env = { home: "/home/u", roots: [], now: 1_000_000, graceMs: 0 };

describe("desiredAction", () => {
  it("keeps state, archives reclaimable, prunes regenerable only with --prune", () => {
    expect(desiredAction(base, { prune: false })).toBe("archive");
    expect(desiredAction({ ...base, verdict: "stateful" }, { prune: true })).toBe("skip");
    expect(desiredAction({ ...base, verdict: "regenerable" }, { prune: false })).toBe("archive");
    expect(desiredAction({ ...base, verdict: "regenerable" }, { prune: true })).toBe("prune");
  });
});

describe("guard", () => {
  let dir: string;
  let oldFile: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "aj-guard-"));
    oldFile = path.join(dir, "old.jsonl");
    await fs.writeFile(oldFile, "x");
    // The file is genuinely old on disk, whatever the finding claims.
    const stale = new Date(Date.now() - 40 * 86_400_000);
    await fs.utimes(oldFile, stale, stale);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const mkEnv = (graceMs = 0): Env => ({ home: "/tmp", roots: [], now: Date.now(), graceMs });

  it("denies stateful stores", async () => {
    expect((await guard({ ...base, verdict: "stateful" }, mkEnv())).allowed).toBe(false);
  });

  it("denies protected paths", async () => {
    const settings = { ...base, path: path.join(dir, "settings.json") };
    await fs.writeFile(settings.path, "{}");
    expect((await guard(settings, mkEnv())).allowed).toBe(false);
  });

  it("denies recently-touched items (grace window) from fresh disk mtime", async () => {
    // The finding still carries a stale scan-time mtimeMs (0); the file on
    // disk is fresh. The gate must trust the disk — this is the scan→confirm→act race.
    const freshFile = path.join(dir, "fresh.jsonl");
    await fs.writeFile(freshFile, "x");
    const fresh = { ...base, path: freshFile, mtimeMs: 0 };
    expect((await guard(fresh, mkEnv(60_000))).allowed).toBe(false);
  });

  it("allows an ordinary old transcript", async () => {
    expect((await guard({ ...base, path: oldFile, mtimeMs: 0 }, mkEnv())).allowed).toBe(true);
  });

  it("denies items that no longer exist", async () => {
    const gone = { ...base, path: path.join(dir, "deleted.jsonl") };
    const decision = await guard(gone, mkEnv());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no longer exists");
  });
});

describe("isProtectedPath", () => {
  it("flags credential and config files", () => {
    expect(isProtectedPath("/home/u/.claude/.credentials.json")).toBe(true);
    expect(isProtectedPath("/home/u/.codex/auth.json")).toBe(true);
    expect(isProtectedPath("/home/u/.claude/projects/p/s.jsonl")).toBe(false);
  });
});

describe("applyMaxDeletes", () => {
  it("caps the number of kept items", () => {
    expect(applyMaxDeletes([1, 2, 3, 4], 2)).toEqual({ kept: [1, 2], dropped: 2 });
    expect(applyMaxDeletes([1, 2], undefined)).toEqual({ kept: [1, 2], dropped: 0 });
  });
});

describe("planFindings", () => {
  it("skips reclaimable items inside the retention window", () => {
    const old = { ...base, mtimeMs: env.now - 40 * 86_400_000 };
    const recent = { ...base, mtimeMs: env.now - 1 * 86_400_000 };
    const plan = planFindings([old, recent], {
      prune: false,
      now: env.now,
      minAgeMs: DEFAULT_RETENTION_DAYS * 86_400_000,
    });
    expect(plan.items[0]?.action).toBe("archive");
    expect(plan.items[1]?.action).toBe("skip");
    expect(plan.items[1]?.skipReason).toContain("retention");
  });

  it("skips paths matching --keep", () => {
    const plan = planFindings([base], {
      prune: false,
      now: env.now,
      minAgeMs: 0,
      keep: ["s.jsonl"],
    });
    expect(plan.items[0]?.action).toBe("skip");
    expect(plan.items[0]?.skipReason).toContain("--keep");
  });
});
