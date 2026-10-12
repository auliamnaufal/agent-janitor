import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Driver, Finding } from "../engine/types.js";
import { exists, measure } from "../util/fs.js";

const exec = promisify(execFile);

interface Worktree {
  path: string;
  branch: string | null;
}

export function parseWorktreePorcelain(out: string): Worktree[] {
  const blocks = out
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const result: Worktree[] = [];
  for (const block of blocks) {
    let wtPath: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch "))
        branch = line.slice("branch ".length).trim().replace("refs/heads/", "");
      else if (line.startsWith("detached")) branch = null;
    }
    if (wtPath) result.push({ path: wtPath, branch });
  }
  return result;
}

async function gitWorktreeList(repo: string): Promise<Worktree[]> {
  try {
    const { stdout } = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      timeout: 5000,
    });
    return parseWorktreePorcelain(stdout);
  } catch {
    return [];
  }
}

/** A worktree is only reclaimable when it has no uncommitted changes. */
export async function isWorktreeClean(dir: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["-C", dir, "status", "--porcelain"], { timeout: 5000 });
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
}

async function findRepos(root: string, maxDepth = 2): Promise<string[]> {
  const repos: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    if (await exists(path.join(dir, ".git"))) {
      repos.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await rec(path.join(dir, entry.name), depth + 1);
    }
  }
  await rec(root, 0);
  return repos;
}

export const gitWorktrees: Driver = {
  id: "git-worktrees",
  name: "Git worktrees",
  async detect(env) {
    return env.roots.length > 0;
  },
  async scan(env) {
    const seen = new Set<string>();
    const findings: Finding[] = [];
    for (const root of env.roots) {
      for (const repo of await findRepos(root)) {
        const worktrees = await gitWorktreeList(repo);
        for (let i = 0; i < worktrees.length; i++) {
          const wt = worktrees[i];
          if (!wt || i === 0) continue; // git lists the main working tree first
          if (seen.has(wt.path)) continue;
          seen.add(wt.path);
          const m = await measure(wt.path);
          if (!m) continue;
          findings.push({
            agent: "git-worktrees",
            path: wt.path,
            kind: "worktree",
            bytes: m.bytes,
            mtimeMs: m.mtimeMs,
            verdict: "reclaimable",
            secretRisk: "none",
            reason: wt.branch ? `worktree on ${wt.branch}` : "detached worktree",
          });
        }
      }
    }
    return findings;
  },
};
