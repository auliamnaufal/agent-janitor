import { describe, expect, it } from "vitest";
import { parseWorktreePorcelain } from "../src/drivers/worktrees.js";

describe("parseWorktreePorcelain", () => {
  it("parses the main tree and linked worktrees", () => {
    const out = [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.wt/feature",
      "HEAD def456",
      "branch refs/heads/feat/x",
      "",
    ].join("\n");

    const trees = parseWorktreePorcelain(out);
    expect(trees).toHaveLength(2);
    expect(trees[0]).toEqual({ path: "/repo", branch: "main", head: "abc123", prunable: false });
    expect(trees[1]).toEqual({
      path: "/repo/.wt/feature",
      branch: "feat/x",
      head: "def456",
      prunable: false,
    });
  });

  it("handles detached worktrees", () => {
    const out = "worktree /repo/wt\nHEAD 111\ndetached\n";
    const trees = parseWorktreePorcelain(out);
    expect(trees[0]).toEqual({ path: "/repo/wt", branch: null, head: "111", prunable: false });
  });

  it("marks prunable registrations", () => {
    const out = "worktree /repo/gone\nHEAD 222\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n";
    const trees = parseWorktreePorcelain(out);
    expect(trees[0]?.prunable).toBe(true);
  });
});
