import path from "node:path";
import type { Driver } from "../engine/types.js";
import { exists } from "../util/fs.js";
import { isJsonl, scanLayout, type LayoutEntry } from "./layout.js";

const ROOT = ".codex";

const LAYOUT: LayoutEntry[] = [
  {
    sub: "sessions",
    kind: "transcript",
    verdict: "reclaimable",
    perFile: true,
    match: isJsonl,
    secretRisk: "possible",
    reason: "rollout session",
  },
  { sub: "log", kind: "log", verdict: "regenerable", reason: "logs" },
  { sub: "history.jsonl", kind: "state", verdict: "stateful", reason: "command history" },
  { sub: "config.toml", kind: "state", verdict: "stateful", reason: "config" },
  {
    sub: "auth.json",
    kind: "state",
    verdict: "stateful",
    secretRisk: "likely",
    reason: "credentials",
  },
];

export const codex: Driver = {
  id: "codex",
  name: "Codex CLI",
  async detect(env) {
    return exists(path.join(env.home, ROOT));
  },
  async scan(env) {
    return scanLayout("codex", path.join(env.home, ROOT), LAYOUT, env);
  },
};
