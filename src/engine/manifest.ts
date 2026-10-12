import { promises as fs } from "node:fs";
import { readJson, writeJson } from "../util/fs.js";
import type { Manifest, ManifestEntry } from "./types.js";

export async function writeManifest(filePath: string, manifest: Manifest): Promise<void> {
  await writeJson(filePath, manifest);
}

function validEntry(e: unknown): e is ManifestEntry {
  if (typeof e !== "object" || e === null) return false;
  const entry = e as ManifestEntry;
  return (
    typeof entry.path === "string" &&
    typeof entry.bytes === "number" &&
    (entry.verdict === "regenerable" ||
      entry.verdict === "reclaimable" ||
      entry.verdict === "stateful") &&
    (entry.storedAs === null || typeof entry.storedAs === "string") &&
    (entry.action === "archive" || entry.action === "prune")
  );
}

export async function readManifest(filePath: string): Promise<Manifest | null> {
  const data = await readJson<Manifest>(filePath);
  if (!data || data.version !== 1 || !Array.isArray(data.entries)) return null;
  if (data.archive !== null && typeof data.archive !== "string") return null;
  // Reject malformed entries loudly (as an unusable manifest) instead of
  // crashing later in matchArchived / restore.
  if (!data.entries.every(validEntry)) return null;
  return data;
}

export async function removePath(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}
