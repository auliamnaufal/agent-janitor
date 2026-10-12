import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { classifyRestoreTarget, matchArchived, type ArchivedItem } from "../src/engine/catalog.js";

function item(p: string): ArchivedItem {
  return {
    manifestPath: "/m/2026.json",
    archive: "/a.tar.gz",
    entry: { path: p, bytes: 1, verdict: "reclaimable", storedAs: "items/00000", action: "archive" },
  };
}

describe("matchArchived", () => {
  const items = [
    item("/home/u/.claude/projects/x/9b97c704-1234.jsonl"),
    item("/home/u/.claude/projects/strike-api/abc.jsonl"),
  ];

  it("matches a session id substring", () => {
    expect(matchArchived(items, "9b97c704")).toHaveLength(1);
  });

  it("matches a project substring case-insensitively", () => {
    expect(matchArchived(items, "STRIKE")).toHaveLength(1);
  });

  it("returns nothing when there is no match", () => {
    expect(matchArchived(items, "zzz")).toHaveLength(0);
  });
});

describe("classifyRestoreTarget", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agc-cls-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("treats a query containing a path separator as a query, not a manifest", async () => {
    expect(await classifyRestoreTarget("beta/sessionB")).toEqual({
      kind: "query",
      query: "beta/sessionB",
    });
  });

  it("treats a non-existent .json path as a query", async () => {
    expect(await classifyRestoreTarget(path.join(dir, "nope.json"))).toEqual({
      kind: "query",
      query: path.join(dir, "nope.json"),
    });
  });

  it("treats an existing .json file as a manifest", async () => {
    const file = path.join(dir, "manifest.json");
    await fs.writeFile(file, "{}");
    expect(await classifyRestoreTarget(file)).toEqual({ kind: "manifest", path: file });
  });

  it("treats 'latest' as the latest batch", async () => {
    expect(await classifyRestoreTarget("latest")).toEqual({ kind: "latest" });
  });
});
