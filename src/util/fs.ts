import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
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
  // Atomic: write a temp file and rename, so a crash mid-write can never leave
  // a truncated/corrupt file behind (manifests are the single pointer to the
  // user's backup).
  const tmp = `${p}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(tmp, p);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

let stampSeq = 0;

/** Compact, filesystem-safe, collision-proof timestamp, e.g. "2026-10-12T10-20-30-1k4z". */
export function stamp(d: Date = new Date()): string {
  const base = d.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  // PID + monotonic counter: two clean runs within the same second (scripted
  // --yes, overlapping schedulers) would otherwise share an archive filename
  // and silently clobber each other's tarball.
  return `${base}-${process.pid}-${(stampSeq++).toString(36)}`;
}

/** Fresh mtime straight from disk, or null when the path is gone. */
export async function freshMtimeMs(p: string): Promise<number | null> {
  try {
    return (await fs.lstat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** Recursively collect files under `dir`, optionally filtered by name/path. */
export async function walkFiles(
  dir: string,
  match?: (name: string, full: string) => boolean,
  includeSymlinks = false,
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
      } else if (
        (entry.isFile() || (includeSymlinks && entry.isSymbolicLink())) &&
        (!match || match(entry.name, full))
      ) {
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
