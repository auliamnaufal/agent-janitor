import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export interface Measure {
  bytes: number;
  mtimeMs: number;
  fileCount: number;
}

/** Recursively size a file or directory. Returns null if it does not exist. */
export async function measure(p: string): Promise<Measure | null> {
  let st;
  try {
    st = await fs.lstat(p);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    return { bytes: 0, mtimeMs: st.mtimeMs, fileCount: 0 };
  }
  if (!st.isDirectory()) {
    return { bytes: st.size, mtimeMs: st.mtimeMs, fileCount: 1 };
  }
  let bytes = 0;
  let mtimeMs = 0;
  let fileCount = 0;
  let entries;
  try {
    entries = await fs.readdir(p, { withFileTypes: true });
  } catch {
    return { bytes: 0, mtimeMs: st.mtimeMs, fileCount: 0 };
  }
  for (const entry of entries) {
    const child = await measure(path.join(p, entry.name));
    if (!child) continue;
    bytes += child.bytes;
    fileCount += child.fileCount;
    if (child.mtimeMs > mtimeMs) mtimeMs = child.mtimeMs;
  }
  // Use content age, not the directory's own mtime (which bumps on every write).
  if (fileCount === 0) mtimeMs = st.mtimeMs;
  return { bytes, mtimeMs, fileCount };
}

/**
 * A path is "locked" when a sibling lock/index/WAL file exists, or it is itself a
 * lock. Invariant #4: the actor refuses such paths.
 */
export async function isLocked(p: string): Promise<boolean> {
  if (p.endsWith(".lock")) return true;
  const candidates = [`${p}.lock`, `${p}-wal`, `${p}-shm`, path.join(p, "index.lock")];
  for (const c of candidates) {
    if (await exists(c)) return true;
  }
  return false;
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/** Compact, filesystem-safe timestamp, e.g. "2026-10-12T10-20-30". */
export function stamp(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
}

/** Recursively collect files under `dir`, optionally filtered by name/path. */
export async function walkFiles(
  dir: string,
  match?: (name: string, full: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  async function rec(p: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        await rec(full);
      } else if (entry.isFile() && (!match || match(entry.name, full))) {
        out.push(full);
      }
    }
  }
  await rec(dir);
  return out;
}

export async function listDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}

export async function listDirEntries(p: string) {
  try {
    return await fs.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}
