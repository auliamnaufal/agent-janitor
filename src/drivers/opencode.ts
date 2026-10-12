import path from "node:path";
import type { Driver } from "../engine/types.js";
import { exists } from "../util/fs.js";
import { scanLayout, type LayoutEntry } from "./layout.js";

/** opencode follows the XDG/OS data-dir convention. */
export function opencodeDataDir(home: string): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "opencode");
  }
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "opencode");
  }
  return path.join(home, ".local", "share", "opencode");
}

const LAYOUT: LayoutEntry[] = [
  {
    sub: path.join("storage", "session"),
    kind: "transcript",
    verdict: "reclaimable",
    perFile: true,
    match: (name) => name.endsWith(".json"),
    secretRisk: "possible",
    reason: "session",
  },
  { sub: "log", kind: "log", verdict: "regenerable", reason: "logs" },
];

export const opencode: Driver = {
  id: "opencode",
  name: "opencode",
  async detect(env) {
    return exists(opencodeDataDir(env.home));
  },
  async scan(env) {
    return scanLayout("opencode", opencodeDataDir(env.home), LAYOUT, env);
  },
};
