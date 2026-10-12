import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runGuard } from "../src/engine/guard.js";
import type { Env } from "../src/engine/types.js";

const exec = promisify(execFile);
let base: string;
let repo: string;
const env: Env = { home: "/tmp", roots: [], now: Date.now(), graceMs: 0 };

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aj-guard-")));
  repo = path.join(base, "repo");
  await fs.mkdir(repo, { recursive: true });
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t.co"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  await fs.writeFile(path.join(repo, "readme.md"), "hi");
  await exec("git", ["-C", repo, "add", "readme.md"]);
  await exec("git", ["-C", repo, "commit", "-qm", "init"]);
  // create a worktree, then delete its directory → dangling registration
  await exec("git", ["-C", repo, "worktree", "add", "-q", path.join(repo, ".wt/x"), "-b", "x"]);
  await fs.rm(path.join(repo, ".wt/x"), { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("runGuard", () => {
  it("flags orphaned worktree registrations", async () => {
    const result = await runGuard(env, { repo, changed: [] });
    expect(result.issues.some((i) => i.check === "worktree")).toBe(true);
  });

  it("flags an agent artifact in the changeset", async () => {
    const result = await runGuard(env, { repo, changed: [".claude/settings.json"] });
    expect(result.issues.some((i) => i.check === "artifact")).toBe(true);
  });

  it("flags a likely secret in a changed file as an error", async () => {
    await fs.writeFile(path.join(repo, "leak.txt"), "key=AKIAABCDEFGHIJKLMNOP\n");
    const result = await runGuard(env, { repo, changed: ["leak.txt"] });
    expect(result.issues.some((i) => i.check === "secret" && i.level === "error")).toBe(true);
  });

  it("is clean for an ordinary changeset once orphaned registrations are pruned", async () => {
    await exec("git", ["-C", repo, "worktree", "prune"]);
    const result = await runGuard(env, { repo, changed: ["readme.md"] });
    expect(result.issues).toHaveLength(0);
  });
});
