import { formatBytes } from "../util/format.js";
import type { Summary } from "../engine/types.js";

/**
 * Renders the shell-prompt segment. Reads only the cached summary — no scanning —
 * so it stays fast enough to run on every prompt.
 */
export function renderPrompt(summary: Summary | null, opts: { warnSecrets?: boolean } = {}): string {
  if (!summary) return "";
  const parts: string[] = [];
  if (summary.reclaimable > 0) parts.push(`🧹 ${formatBytes(summary.reclaimable)}`);
  if (opts.warnSecrets && summary.secrets > 0) parts.push(`⚠ ${summary.secrets} secret`);
  return parts.join(" ");
}
