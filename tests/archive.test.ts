import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractTarGz, writeTarGz } from "../src/engine/archive.js";
import { exists } from "../src/util/fs.js";

const exec = promisify(execFile);
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-gc-tar-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("tar.gz round trip", () => {
  it("archives and extracts files, including a long path", async () => {
    const src = path.join(root, "src");
    await fs.mkdir(path.join(src, "nested"), { recursive: true });
    await fs.writeFile(path.join(src, "a.txt"), "hello");
    const longName = "x".repeat(140) + ".jsonl";
    await fs.writeFile(path.join(src, "nested", longName), "long content");

    const archive = path.join(root, "out.tar.gz");
    const count = await writeTarGz(archive, [{ absPath: src, storedAs: "items/00000" }]);
    expect(count).toBe(2);

    const dest = path.join(root, "extract");
    const names = await extractTarGz(archive, dest);
    expect(names).toHaveLength(2);
    expect(await fs.readFile(path.join(dest, "items/00000/a.txt"), "utf8")).toBe("hello");
    expect(
      await fs.readFile(path.join(dest, "items/00000/nested", longName), "utf8"),
    ).toBe("long content");
  });

  it("produces an archive that system tar can list", async () => {
    const src = path.join(root, "src2");
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, "b.txt"), "world");

    const archive = path.join(root, "out2.tar.gz");
    await writeTarGz(archive, [{ absPath: src, storedAs: "items/00000" }]);

    const { stdout } = await exec("tar", ["-tzf", archive]);
    expect(stdout).toContain("items/00000/b.txt");
  });

  it("refuses path-traversal members on extract", async () => {
    const src = path.join(root, "src3");
    await fs.mkdir(src, { recursive: true });
    const file = path.join(src, "c.txt");
    await fs.writeFile(file, "ok");

    const archive = path.join(root, "out3.tar.gz");
    await writeTarGz(archive, [{ absPath: file, storedAs: "../escape.txt" }]);

    const dest = path.join(root, "extract3");
    await extractTarGz(archive, dest);
    expect(await exists(path.join(root, "escape.txt"))).toBe(false);
  });

  it("writes the archive with owner-only permissions", async () => {
    const src = path.join(root, "src4");
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, "d.txt"), "x");

    const archive = path.join(root, "secure", "out4.tar.gz");
    await writeTarGz(archive, [{ absPath: src, storedAs: "items/00000" }]);

    const stat = await fs.stat(archive);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
