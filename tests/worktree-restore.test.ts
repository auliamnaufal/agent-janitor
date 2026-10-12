import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scan } from "../src/engine/scan.js";
import { act, restore } from "../src/engine/act.js";
import { gitWorktreePaths } from "../src/drivers/worktrees.js";
import { exists } from "../src/util/fs.js";

const exec = promisify(execFile);
let base: string;
let repo: string;
let home: string;
const wt = (): string => path.join(repo, ".wt", "feat");

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agc-wt-")));
  repo = path.join(base, "repo");
  home = path.join(base, "home");
  await fs.mkdir(repo, { recursive: true });
  await exec("git", ["-C", repo, "init", "-q"]);
  await exec("git", ["-C", repo, "config", "user.email", "t@t.co"]);
  await exec("git", ["-C", repo, "config", "user.name", "t"]);
  await fs.writeFile(path.join(repo, "f.txt"), "hi");
  await exec("git", ["-C", repo, "add", "f.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "init"]);
  await exec("git", ["-C", repo, "worktree", "add", "-q", wt(), "-b", "feat"]);
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("worktree archive → prune → restore", () => {
  it("re-registers the restored worktree with git", async () => {
    const env = { home, roots: [repo], now: Date.now() + 60_000, graceMs: 0 };

    const scanned = await scan(env, { only: ["git-worktrees"], secrets: false });
    const finding = scanned.findings.find((f) => f.kind === "worktree");
    expect(finding).toBeTruthy();
    expect(finding?.gitRepo).toBe(repo);

    const outcome = await act(scanned.findings, { prune: false, env, home, minAgeMs: 0 });
    expect(await exists(wt())).toBe(false);
    expect(outcome.archived).toHaveLength(1);

    // Archiving prunes the now-dangling registration.
    expect(await gitWorktreePaths(repo)).not.toContain(wt());

    const result = await restore(outcome.manifest as string, {
      stagingRoot: path.join(home, ".agent-gc", "tmp"),
    });

    expect(result.restored).toContain(wt());
    expect(await exists(wt())).toBe(true);
    // The restored directory is a real worktree again, not an orphan.
    expect(await gitWorktreePaths(repo)).toContain(wt());
  });
});
