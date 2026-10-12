import path from "node:path";
import type { Driver } from "../engine/types.js";
import { exists } from "../util/fs.js";
import { scanLayout, type LayoutEntry } from "./layout.js";

const ROOT = ".gemini";

const JSON_OR_JSONL = (name: string): boolean =>
  name.endsWith(".json") || name.endsWith(".jsonl");

const LAYOUT: LayoutEntry[] = [
  {
    sub: "tmp",
    kind: "transcript",
    verdict: "reclaimable",
    perFile: true,
    match: JSON_OR_JSONL,
    secretRisk: "possible",
    reason: "session transcript",
  },
  { sub: "settings.json", kind: "state", verdict: "stateful", reason: "settings" },
  {
    sub: "oauth_creds.json",
    kind: "state",
    verdict: "stateful",
    secretRisk: "likely",
    reason: "credentials",
  },
  {
    sub: "google_accounts.json",
    kind: "state",
    verdict: "stateful",
    secretRisk: "possible",
    reason: "accounts",
  },
];

export const gemini: Driver = {
  id: "gemini",
  name: "Gemini CLI",
  async detect(env) {
    return exists(path.join(env.home, ROOT));
  },
  async scan(env) {
    return scanLayout("gemini", path.join(env.home, ROOT), LAYOUT, env);
  },
};
