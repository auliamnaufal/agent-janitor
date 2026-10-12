import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import path from "node:path";
import { ensureDir, walkFiles } from "../util/fs.js";

const BLOCK = 512;

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const clamped = Math.max(0, Math.floor(value));
  const s = clamped.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buf.write(s, offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

function splitName(name: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(name, "utf8") <= 100) return { name, prefix: "" };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== "/") continue;
    const suffix = name.slice(i + 1);
    const prefix = name.slice(0, i);
    const sb = Buffer.byteLength(suffix, "utf8");
    const pb = Buffer.byteLength(prefix, "utf8");
    if (sb > 0 && sb <= 100 && pb <= 155) return { name: suffix, prefix };
  }
  return null;
}

function createHeader(name: string, prefix: string, size: number, mtimeMs: number, typeflag = "0"): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(name, 0, 100, "utf8");
  writeOctal(buf, 100, 8, 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, Math.floor(mtimeMs / 1000));
  buf.write("        ", 148, 8, "ascii");
  buf.write(typeflag, 156, 1, "ascii");
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  if (prefix) buf.write(prefix, 345, 155, "utf8");

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i] ?? 0;
  buf.write(sum.toString(8).padStart(6, "0").slice(-6), 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

async function writeBuf(stream: Writable, buf: Buffer): Promise<void> {
  if (!stream.write(buf)) await once(stream, "drain");
}

function pad(length: number): number {
  return (BLOCK - (length % BLOCK)) % BLOCK;
}

export interface ArchiveEntry {
  absPath: string;
  storedAs: string;
}

/** Expand directory entries into their files so a tarball only ever holds files. */
export async function expandEntries(entries: ArchiveEntry[]): Promise<ArchiveEntry[]> {
  const out: ArchiveEntry[] = [];
  for (const entry of entries) {
    const st = await fs.lstat(entry.absPath).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      const files = await walkFiles(entry.absPath);
      for (const file of files) {
        const rel = path.relative(entry.absPath, file).split(path.sep).join("/");
        out.push({ absPath: file, storedAs: `${entry.storedAs}/${rel}` });
      }
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** Write a gzip-compressed ustar archive. Zero dependencies. */
export async function writeTarGz(archivePath: string, entries: ArchiveEntry[]): Promise<number> {
  const dir = path.dirname(archivePath);
  await ensureDir(dir);
  // Archives hold transcripts (i.e. secrets): keep them owner-only.
  await fs.chmod(dir, 0o700).catch(() => {});
  const expanded = await expandEntries(entries);
  const gzip = createGzip({ level: 6 });
  const out = createWriteStream(archivePath, { mode: 0o600 });
  gzip.pipe(out);

  let count = 0;
  for (const entry of expanded) {
    const st = await fs.lstat(entry.absPath).catch(() => null);
    if (!st || !st.isFile()) continue;
    const name = entry.storedAs.replace(/^\/+/, "");

    const split = splitName(name);
    if (!split) {
      const long = Buffer.from(`${name}\0`, "utf8");
      await writeBuf(gzip, createHeader("././@LongLink", "", long.length, st.mtimeMs, "L"));
      await writeBuf(gzip, long);
      await writeBuf(gzip, Buffer.alloc(pad(long.length), 0));
      await writeBuf(gzip, createHeader(name.slice(0, 100), "", st.size, st.mtimeMs));
    } else {
      await writeBuf(gzip, createHeader(split.name, split.prefix, st.size, st.mtimeMs));
    }

    for await (const chunk of createReadStream(entry.absPath)) {
      await writeBuf(gzip, chunk as Buffer);
    }
    const p = pad(st.size);
    if (p > 0) await writeBuf(gzip, Buffer.alloc(p, 0));
    count++;
  }

  await writeBuf(gzip, Buffer.alloc(BLOCK * 2, 0));
  gzip.end();
  await once(out, "close");
  return count;
}

class ByteReader {
  private leftover: Buffer = Buffer.alloc(0);
  private finished = false;
  constructor(private readonly iterator: AsyncIterator<Buffer>) {}

  async readExact(n: number): Promise<Buffer | null> {
    while (this.leftover.length < n && !this.finished) {
      const next = await this.iterator.next();
      if (next.done) {
        this.finished = true;
        break;
      }
      this.leftover = Buffer.concat([this.leftover, next.value]);
    }
    if (this.leftover.length < n) return null;
    const out = this.leftover.subarray(0, n);
    this.leftover = this.leftover.subarray(n);
    return Buffer.from(out);
  }
}

function parseOctal(buf: Buffer, offset: number, length: number): number {
  const slice = buf.subarray(offset, offset + length);
  const str = slice.toString("ascii").replace(/\0.*$/, "").trim();
  const value = parseInt(str, 8);
  return Number.isNaN(value) ? 0 : value;
}

function readName(buf: Buffer): string {
  const name = buf.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = buf.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * Resolve an archive member name inside `destDir`, refusing to escape it.
 * Guards restore against `../` / absolute-path members in a tampered tarball.
 */
export function safeTarget(destDir: string, name: string): string | null {
  const root = path.resolve(destDir);
  const target = path.resolve(root, name.replace(/^\/+/, ""));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** Extract a tar.gz written by writeTarGz into destDir. Returns extracted names. */
export async function extractTarGz(archivePath: string, destDir: string): Promise<string[]> {
  const reader = new ByteReader(
    createReadStream(archivePath).pipe(createGunzip())[Symbol.asyncIterator](),
  );
  const extracted: string[] = [];
  let longName: string | null = null;

  for (;;) {
    const header = await reader.readExact(BLOCK);
    if (!header) break;
    if (header.every((b) => b === 0)) break;

    const size = parseOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const rawName = readName(header);
    const content = await reader.readExact(size);
    const padding = pad(size);
    if (padding > 0) await reader.readExact(padding);
    if (!content) break;

    if (typeflag === "L") {
      longName = content.toString("utf8").replace(/\0.*$/, "");
      continue;
    }

    const name = (longName ?? rawName).replace(/^\/+/, "");
    longName = null;
    if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      if (name.endsWith("/")) continue;
      const target = safeTarget(destDir, name);
      if (!target) continue; // path traversal attempt — refuse
      await ensureDir(path.dirname(target));
      await fs.writeFile(target, content);
      extracted.push(name);
    }
  }

  return extracted;
}
