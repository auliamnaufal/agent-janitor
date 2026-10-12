export type Verdict = "regenerable" | "reclaimable" | "stateful";

export type FindingKind =
  | "transcript"
  | "cache"
  | "log"
  | "worktree"
  | "scratch"
  | "state"
  | "trace";

export type SecretRisk = "none" | "possible" | "likely";

/** A single classified item on disk. Produced by drivers, never mutated by them. */
export interface Finding {
  /** Driver id that produced this, e.g. "claude-code". */
  agent: string;
  /** Absolute path. */
  path: string;
  kind: FindingKind;
  bytes: number;
  mtimeMs: number;
  verdict: Verdict;
  secretRisk: SecretRisk;
  /** Labels of secret patterns matched during the content scan, if any. */
  secretHits?: string[];
  /** Worktree provenance, set only by the git-worktrees driver. */
  gitRepo?: string;
  gitBranch?: string | null;
  gitHead?: string | null;
  /** Human-readable justification shown in the receipt. */
  reason: string;
}

/** Runtime environment, injected so drivers and the engine stay testable. */
export interface Env {
  home: string;
  /** Repo roots to scan for worktrees / stray artifacts. */
  roots: string[];
  /** Current time in ms (injected clock). */
  now: number;
  /** Skip anything touched within this window; protects active sessions. */
  graceMs: number;
}

export interface Driver {
  id: string;
  name: string;
  detect(env: Env): Promise<boolean>;
  scan(env: Env): Promise<Finding[]>;
}

export type Action = "archive" | "prune" | "skip";

export interface PlannedFinding extends Finding {
  action: Action;
  /** Why the item was skipped (retention, stateful, safety), when action is "skip". */
  skipReason?: string;
}

export interface Plan {
  items: PlannedFinding[];
}

export interface ManifestEntry {
  path: string;
  bytes: number;
  verdict: Verdict;
  /** Relative path inside the archive, or null when the item was pruned. */
  storedAs: string | null;
  action: "archive" | "prune";
  /** For worktrees: how to re-register with git on restore. */
  worktree?: { repo: string; branch: string | null; head: string | null };
}

export interface Manifest {
  version: 1;
  createdAt: string;
  archive: string | null;
  entries: ManifestEntry[];
}

/** Compact result cached by `watch` and read by the prompt segment. */
export interface Summary {
  generatedAt: string;
  total: number;
  reclaimable: number;
  secrets: number;
  items: number;
}
