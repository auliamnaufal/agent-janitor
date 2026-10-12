import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { exists } from "../util/fs.js";
import { scanFileForSecrets } from "./secrets.js";
import { parseWorktreePorcelain } from "../drivers/worktrees.js";
import type { Env } from "./types.js";

const exec = promisify(execFile);

export interface GuardIssue {
  level: "warn" | "error";
  check: "worktree" | "artifact" | "secret";
  message: string;
  hint?: string;
}

export interface GuardResult {
  repo: string;
  changed: string[];
  issues: GuardIssue[];
}

/** Repo-relative path patterns that should never be committed. */
const ARTIFACT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /(^|\/)\.claude\//, label: "Claude Code state" },
  { re: /(^|\/)\.cursor\//, label: "Cursor state" },
  { re: /(^|\/)\.codex\//, label: "Codex state" },
  { re: /(^|\/)\.aider/, label: "Aider state" },
  { re: /(^|\/)\.continue\//, label: "Continue state" },
  { re: /(^|\/)\.agent-janitor\//, label: "agent-janitor state" },
  { re: /(^|\/)\.env(\.|$)/, label: "env file" },
];

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function git(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", repo, ...args], { timeout: 10000 });
    return stdout;
  } catch {
    return "";
  }
}

/** Files changed across a set of push ranges (pre-push ref pairs). */
export async function changedFiles(
  repo: string,
  refs: { from: string; to: string }[],
): Promise<string[]> {
  const set = new Set<string>();
  for (const ref of refs) {
    const from = /^0+$/.test(ref.from) ? EMPTY_TREE : ref.from;
    const out = await git(repo, ["diff", "--name-only", "--diff-filter=ACM", `${from}..${ref.to}`]);
    for (const line of out.split("\n")) if (line.trim()) set.add(line.trim());
  }
  return [...set];
}

/** Fallback when not invoked as a pre-push hook: staged files, else the last commit. */
export async function defaultChanged(repo: string): Promise<string[]> {
  const staged = (await git(repo, ["diff", "--cached", "--name-only", "--diff-filter=ACM"])).trim();
  if (staged) return staged.split("\n");
  const last = (await git(repo, ["diff", "--name-only", "--diff-filter=ACM", "HEAD~1", "HEAD"])).trim();
  return last ? last.split("\n") : [];
}

export async function runGuard(
  _env: Env,
  opts: { repo?: string; changed?: string[] } = {},
): Promise<GuardResult> {
  const repo = opts.repo ?? process.cwd();
  const issues: GuardIssue[] = [];

  // 1. orphaned worktree registrations (dir gone, registration dangling)
  const porcelain = await git(repo, ["worktree", "list", "--porcelain"]);
  for (const wt of parseWorktreePorcelain(porcelain)) {
    if (wt.prunable) {
      issues.push({
        level: "warn",
        check: "worktree",
        message: `orphaned worktree registration: ${wt.path}`,
        hint: "git worktree prune",
      });
    }
  }

  // 2 + 3. changed files: agent artifacts and likely secrets
  const changed = opts.changed ?? (await defaultChanged(repo));
  for (const rel of changed) {
    for (const pattern of ARTIFACT_PATTERNS) {
      if (pattern.re.test(rel)) {
        issues.push({
          level: "warn",
          check: "artifact",
          message: `agent artifact in changeset: ${rel} (${pattern.label})`,
          hint: "unstage it — agent state should not be committed",
        });
        break;
      }
    }

    const abs = path.join(repo, rel);
    if (!(await exists(abs))) continue;
    try {
      const hits = await scanFileForSecrets(abs);
      if (hits.length > 0) {
        issues.push({
          level: "error",
          check: "secret",
          message: `possible secret in ${rel}`,
          hint: `matches: ${hits.join(", ")}`,
        });
      }
    } catch {
      // unreadable file: ignore
    }
  }

  return { repo, changed, issues };
}

/** Resolve the hooks directory, worktree-safe. */
export async function gitHooksDir(repo: string): Promise<string> {
  const out = (await git(repo, ["rev-parse", "--git-path", "hooks"])).trim();
  if (!out) return path.join(repo, ".git", "hooks");
  return path.isAbsolute(out) ? out : path.join(repo, out);
}

/** The pre-push hook script. No-ops if the CLI isn't on PATH. */
export function prePushHookScript(): string {
  return `#!/bin/sh
# agent-janitor pre-push gate — blocks pushes containing likely secrets.
# Remove this file to disable.
if command -v agent-janitor >/dev/null 2>&1; then
  exec agent-janitor guard
fi
exit 0
`;
}
