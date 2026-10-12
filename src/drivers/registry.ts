import type { Driver } from "../engine/types.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { gitWorktrees } from "./worktrees.js";

/**
 * The driver registry. Adding an agent = adding one file that exports a Driver
 * and listing it here. The engine itself contains no agent-specific knowledge.
 */
export const DRIVERS: Driver[] = [claudeCode, codex, cursor, gitWorktrees];

export function getDriver(id: string): Driver | undefined {
  return DRIVERS.find((d) => d.id === id);
}
