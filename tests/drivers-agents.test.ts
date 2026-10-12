import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { scan } from "../src/engine/scan.js";
import { opencodeDataDir } from "../src/drivers/opencode.js";
import type { Env } from "../src/engine/types.js";

let home: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "aj-agents-"));

  // Gemini CLI
  await fs.mkdir(path.join(home, ".gemini", "tmp", "hash", "chats"), { recursive: true });
  await fs.writeFile(path.join(home, ".gemini", "tmp", "hash", "chats", "session.json"), "{}");
  await fs.writeFile(path.join(home, ".gemini", "oauth_creds.json"), "{}");

  // opencode (OS-specific data dir)
  const oc = opencodeDataDir(home);
  await fs.mkdir(path.join(oc, "storage", "session"), { recursive: true });
  await fs.writeFile(path.join(oc, "storage", "session", "s1.json"), "{}");
  await fs.mkdir(path.join(oc, "log"), { recursive: true });
  await fs.writeFile(path.join(oc, "log", "app.log"), "hello");
});

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const env = (): Env => ({ home, roots: [], now: Date.now() + 60_000, graceMs: 0 });

describe("gemini driver", () => {
  it("classifies session transcripts and credential state", async () => {
    const result = await scan(env(), { only: ["gemini"], secrets: false });
    const kinds = result.findings.map((f) => `${f.kind}:${f.verdict}`);
    expect(kinds).toContain("transcript:reclaimable");
    expect(kinds).toContain("state:stateful");
  });
});

describe("opencode driver", () => {
  it("classifies sessions and logs", async () => {
    const result = await scan(env(), { only: ["opencode"], secrets: false });
    expect(result.findings.some((f) => f.kind === "transcript")).toBe(true);
    expect(result.findings.some((f) => f.kind === "log")).toBe(true);
  });
});
