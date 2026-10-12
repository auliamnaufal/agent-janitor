import path from "node:path";
import { isLocked } from "../util/fs.js";
import type { Action, Env, Finding, Plan, PlannedFinding, Verdict } from "./types.js";

/** Default retention: only act on reclaimable items older than this. */
export const DEFAULT_RETENTION_DAYS = 30;

export interface Decision {
  allowed: boolean;
  reason: string;
}

/**
 * Paths that must never be touched, as defense-in-depth beyond driver verdicts.
 * Matched case-insensitively against path segments.
 */
export const PROTECTED_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  "settings.json",
  "auth.json",
  ".credentials.json",
  "credentials.json",
  "config.toml",
  ".env",
]);

/** Invariant #3: only `regenerable` findings may be pruned. */
export const PRUNEABLE: ReadonlySet<Verdict> = new Set<Verdict>(["regenerable"]);

export function desiredAction(finding: Finding, opts: { prune: boolean }): Action {
  if (finding.verdict === "stateful") return "skip";
  if (PRUNEABLE.has(finding.verdict)) return opts.prune ? "prune" : "archive";
  return "archive"; // reclaimable
}

export interface PlanOptions {
  prune: boolean;
  /** Current time in ms. */
  now: number;
  /** Skip reclaimable items newer than this. 0 disables the age gate. */
  minAgeMs: number;
  /** Never act on items whose path contains any of these substrings. */
  keep?: string[];
}

/**
 * Chooses an action per finding. Enforces the retention gate (reclaimable items
 * newer than `minAgeMs` are skipped) and honours a user keep-list so specific
 * sessions or projects are never archived.
 */
export function planFindings(findings: Finding[], opts: PlanOptions): Plan {
  const keep = opts.keep?.map((k) => k.toLowerCase()).filter((k) => k.length > 0) ?? [];
  const items: PlannedFinding[] = findings.map((finding) => {
    if (finding.verdict === "stateful") {
      return { ...finding, action: "skip", skipReason: "stateful store — never touched" };
    }
    if (keep.length > 0 && keep.some((k) => finding.path.toLowerCase().includes(k))) {
      return { ...finding, action: "skip", skipReason: "kept (--keep)" };
    }
    if (opts.minAgeMs > 0 && opts.now - finding.mtimeMs < opts.minAgeMs) {
      const days = Math.round(opts.minAgeMs / 86_400_000);
      return { ...finding, action: "skip", skipReason: `within ${days}d retention` };
    }
    return { ...finding, action: desiredAction(finding, { prune: opts.prune }) };
  });
  return { items };
}

export function isProtectedPath(p: string): boolean {
  const segments = p.split(path.sep).filter(Boolean);
  return segments.some((s) => PROTECTED_SEGMENTS.has(s.toLowerCase()));
}

/**
 * The safety gate. Every item passes through here *immediately before* mutation.
 * Invariants #3 (no pruning state), #4 (never touch locked/recent), plus a
 * protected-path guard. Returns a reason when denied so the receipt can show it.
 */
export async function guard(finding: Finding, env: Env): Promise<Decision> {
  if (finding.verdict === "stateful") {
    return { allowed: false, reason: "stateful store — never touched" };
  }
  if (finding.path.endsWith(".lock")) {
    return { allowed: false, reason: "lock file" };
  }
  if (await isLocked(finding.path)) {
    return { allowed: false, reason: "locked (sibling lock present)" };
  }
  if (env.now - finding.mtimeMs < env.graceMs) {
    return { allowed: false, reason: "active — touched within grace window" };
  }
  if (isProtectedPath(finding.path)) {
    return { allowed: false, reason: "protected path" };
  }
  return { allowed: true, reason: "ok" };
}

/** Invariant #5: cap the number of mutations in a single run. */
export function applyMaxDeletes<T>(items: T[], max: number | undefined): { kept: T[]; dropped: number } {
  if (max === undefined || max < 0 || items.length <= max) {
    return { kept: items, dropped: 0 };
  }
  return { kept: items.slice(0, max), dropped: items.length - max };
}
