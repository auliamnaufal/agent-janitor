import { describe, expect, it } from "vitest";
import { flagList, flagNumber, parseArgs, type FlagSpec } from "../src/util/args.js";

const SPECS: FlagSpec[] = [
  { name: "json", type: "boolean" },
  { name: "prune", type: "boolean" },
  { name: "yes", type: "boolean", alias: "y" },
  { name: "root", type: "string", multiple: true },
  { name: "max-deletes", type: "number" },
];

describe("parseArgs", () => {
  it("parses command, positionals and booleans", () => {
    const a = parseArgs(["scan", "extra", "--json", "--prune"], SPECS);
    expect(a.command).toBe("scan");
    expect(a.positionals).toEqual(["extra"]);
    expect(a.flags["json"]).toBe(true);
    expect(a.flags["prune"]).toBe(true);
  });

  it("parses aliases and inline values", () => {
    const a = parseArgs(["clean", "-y", "--max-deletes=5"], SPECS);
    expect(a.flags["yes"]).toBe(true);
    expect(a.flags["max-deletes"]).toBe(5);
    expect(flagNumber(a, "max-deletes")).toBe(5);
  });

  it("collects repeated flags", () => {
    const a = parseArgs(["scan", "--root", "/a", "--root", "/b"], SPECS);
    expect(flagList(a, "root")).toEqual(["/a", "/b"]);
  });

  it("reports unknown flags", () => {
    const a = parseArgs(["scan", "--nope"], SPECS);
    expect(a.errors).toHaveLength(1);
  });
});
