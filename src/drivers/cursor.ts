import path from "node:path";
import type { Driver } from "../engine/types.js";
import { exists } from "../util/fs.js";
import { scanLayout, type LayoutEntry } from "./layout.js";

const ROOT = ".cursor";

const LAYOUT: LayoutEntry[] = [
  {
    sub: "chats",
    kind: "transcript",
    verdict: "reclaimable",
    secretRisk: "possible",
    reason: "chat session state",
  },
  { sub: "logs", kind: "log", verdict: "regenerable", reason: "logs" },
];

export const cursor: Driver = {
  id: "cursor",
  name: "Cursor",
  async detect(env) {
    return exists(path.join(env.home, ROOT));
  },
  async scan(env) {
    return scanLayout("cursor", path.join(env.home, ROOT), LAYOUT, env);
  },
};
