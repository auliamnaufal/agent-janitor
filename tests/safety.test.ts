import { describe, expect, it } from "vitest";
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
  it("denies stateful stores", async () => {
    expect((await guard({ ...base, verdict: "stateful" }, env)).allowed).toBe(false);
  });

  it("denies protected paths", async () => {
    const settings = { ...base, path: "/home/u/.claude/settings.json" };
    expect((await guard(settings, env)).allowed).toBe(false);
  });

  it("denies recently-touched items (grace window)", async () => {
    const recent = { ...base, mtimeMs: env.now - 1_000 };
    expect((await guard(recent, { ...env, graceMs: 60_000 })).allowed).toBe(false);
  });

  it("allows an ordinary old transcript", async () => {
    expect((await guard(base, env)).allowed).toBe(true);
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
