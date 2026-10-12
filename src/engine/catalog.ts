import path from "node:path";
import { promises as fs } from "node:fs";
import { exists } from "../util/fs.js";
import { manifestDir } from "./paths.js";
import { readManifest } from "./manifest.js";
import type { Manifest, ManifestEntry } from "./types.js";

export interface ManifestRecord {
  path: string;
  manifest: Manifest;
}

/** A single archived item, with the manifest and archive it lives in. */
export interface ArchivedItem {
  manifestPath: string;
  archive: string;
  entry: ManifestEntry;
}

/** Read every manifest under `<home>/.agent-janitor/manifests`, oldest first. */
export async function listManifests(home: string): Promise<ManifestRecord[]> {
  const dir = manifestDir(home);
  const files = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .sort();

  const records: ManifestRecord[] = [];
  for (const file of files) {
    const manifestPath = path.join(dir, file);
    const manifest = await readManifest(manifestPath);
    if (manifest) records.push({ path: manifestPath, manifest });
  }
  return records;
}

export function archivedItems(records: ManifestRecord[]): ArchivedItem[] {
  const items: ArchivedItem[] = [];
  for (const record of records) {
    if (!record.manifest.archive) continue;
    for (const entry of record.manifest.entries) {
      if (entry.action === "archive" && entry.storedAs !== null) {
        items.push({ manifestPath: record.path, archive: record.manifest.archive, entry });
      }
    }
  }
  return items;
}

/** Every archived item across all manifests. */
export async function listArchived(home: string): Promise<ArchivedItem[]> {
  return archivedItems(await listManifests(home));
}

/** Case-insensitive substring match against the original path (session id, project, …). */
export function matchArchived(items: ArchivedItem[], query: string): ArchivedItem[] {
  const q = query.toLowerCase();
  return items.filter((item) => item.entry.path.toLowerCase().includes(q));
}

export type RestoreTarget =
  | { kind: "latest" }
  | { kind: "manifest"; path: string }
  | { kind: "query"; query: string };

/**
 * Decide how to interpret a `restore` argument. A manifest is only assumed when
 * the argument is an *existing* `.json` file; everything else — including paths
 * that merely contain a separator — is treated as a search query.
 */
export async function classifyRestoreTarget(target: string): Promise<RestoreTarget> {
  if (target === "latest") return { kind: "latest" };
  if (target.endsWith(".json") && (await exists(target))) {
    return { kind: "manifest", path: target };
  }
  return { kind: "query", query: target };
}
