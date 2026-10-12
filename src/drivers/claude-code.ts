import path from "node:path";
import type { Driver } from "../engine/types.js";
import { exists } from "../util/fs.js";
import { isJsonl, scanLayout, type LayoutEntry } from "./layout.js";

const ROOT = ".claude";

/**
 * Claude Code layout under ~/.claude. Verdicts are intentionally conservative:
 * transcripts and credentials are never pruned, caches/logs regenerate.
 */
const LAYOUT: LayoutEntry[] = [
  {
    sub: "projects",
    kind: "transcript",
    verdict: "reclaimable",
    perFile: true,
    match: isJsonl,
    secretRisk: "possible",
    reason: "session transcript",
  },
  { sub: "todos", kind: "state", verdict: "stateful", reason: "todo state" },
  { sub: "file-history", kind: "state", verdict: "stateful", reason: "file edit history" },
  { sub: "history.jsonl", kind: "state", verdict: "stateful", reason: "command history" },
  { sub: "shell-snapshots", kind: "cache", verdict: "regenerable", reason: "shell snapshots" },
  { sub: "statsig", kind: "cache", verdict: "regenerable", reason: "telemetry cache" },
  { sub: "debug", kind: "log", verdict: "regenerable", reason: "debug logs" },
  { sub: "logs", kind: "log", verdict: "regenerable", reason: "logs" },
  {
    sub: "settings.json",
    kind: "state",
    verdict: "stateful",
    secretRisk: "possible",
    reason: "settings",
  },
  {
    sub: ".credentials.json",
    kind: "state",
    verdict: "stateful",
    secretRisk: "likely",
    reason: "credentials",
  },
];

export const claudeCode: Driver = {
  id: "claude-code",
  name: "Claude Code",
  async detect(env) {
    return exists(path.join(env.home, ROOT));
  },
  async scan(env) {
    return scanLayout("claude-code", path.join(env.home, ROOT), LAYOUT, env);
  },
};
