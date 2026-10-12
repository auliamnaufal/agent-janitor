import { describe, expect, it } from "vitest";
import { matchArchived, type ArchivedItem } from "../src/engine/catalog.js";

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
