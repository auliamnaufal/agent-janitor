import path from "node:path";
import { exists, measure, walkFiles } from "../util/fs.js";
import type { Env, Finding, FindingKind, SecretRisk, Verdict } from "../engine/types.js";

export interface LayoutEntry {
  /** Path relative to the agent root. */
  sub: string;
  kind: FindingKind;
  verdict: Verdict;
  secretRisk?: SecretRisk;
  reason?: string;
  /** Emit one finding per matching file instead of one for the whole entry. */
  perFile?: boolean;
  match?: (name: string) => boolean;
}

export const isJsonl = (name: string): boolean => name.endsWith(".jsonl");

/**
 * Shared scanner for the common "known fixed subpaths under a root" layout.
 * Keeps each concrete driver to a small, declarative table.
 */
export async function scanLayout(
  agent: string,
  root: string,
  layout: LayoutEntry[],
  _env: Env,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const entry of layout) {
    const base = path.join(root, entry.sub);
    if (!(await exists(base))) continue;

    if (entry.perFile) {
      const files = await walkFiles(base, (name) => (entry.match ? entry.match(name) : true));
      for (const file of files) {
        const m = await measure(file);
        if (!m) continue;
        findings.push({
          agent,
          path: file,
          kind: entry.kind,
          bytes: m.bytes,
          mtimeMs: m.mtimeMs,
          verdict: entry.verdict,
          secretRisk: entry.secretRisk ?? "none",
          reason: entry.reason ?? entry.kind,
        });
      }
      continue;
    }

    const m = await measure(base);
    if (!m) continue;
    findings.push({
      agent,
      path: base,
      kind: entry.kind,
      bytes: m.bytes,
      mtimeMs: m.mtimeMs,
      verdict: entry.verdict,
      secretRisk: entry.secretRisk ?? "none",
      reason: entry.reason ?? entry.kind,
    });
  }
  return findings;
}
