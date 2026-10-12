import { promises as fs } from "node:fs";
import path from "node:path";
import { exists, ensureDir, stamp } from "../util/fs.js";
import { extractTarGz, writeTarGz } from "./archive.js";
import { readManifest, removePath, writeManifest } from "./manifest.js";
import { archiveDir, manifestDir } from "./paths.js";
import { applyMaxDeletes, guard, planFindings } from "./safety.js";
import type {
  Env,
  Finding,
  Manifest,
  ManifestEntry,
  Plan,
  PlannedFinding,
} from "./types.js";
import { isWorktreeClean } from "../drivers/worktrees.js";

export function buildPlan(
  findings: Finding[],
  opts: { prune: boolean; now?: number; minAgeMs?: number },
): Plan {
  return planFindings(findings, {
    prune: opts.prune,
    now: opts.now ?? Date.now(),
    minAgeMs: opts.minAgeMs ?? 0,
  });
}

export interface ActOptions {
  prune: boolean;
  maxDeletes?: number;
  /** Skip reclaimable items newer than this. Default 0 (act on everything). */
  minAgeMs?: number;
  env: Env;
  home: string;
}

export interface Skipped {
  path: string;
  reason: string;
}

export interface ActResult {
  archive: string | null;
  manifest: string | null;
  archived: ManifestEntry[];
  pruned: ManifestEntry[];
  skipped: Skipped[];
}

function storedName(index: number, original: string): string {
  const base = path.basename(original).replace(/[^A-Za-z0-9._-]/g, "_") || "item";
  return `items/${String(index).padStart(5, "0")}-${base}`;
}

/**
 * The only function in the codebase that mutates the filesystem. Every candidate
 * passes the safety gate first; archives are written before originals are removed.
 */
export async function act(findings: Finding[], opts: ActOptions): Promise<ActResult> {
  const plan = buildPlan(findings, {
    prune: opts.prune,
    now: opts.env.now,
    minAgeMs: opts.minAgeMs ?? 0,
  });
  const skipped: Skipped[] = [];
  const candidates: PlannedFinding[] = [];

  for (const item of plan.items) {
    if (item.action === "skip") {
      skipped.push({ path: item.path, reason: item.skipReason ?? item.reason });
      continue;
    }
    const decision = await guard(item, opts.env);
    if (!decision.allowed) {
      skipped.push({ path: item.path, reason: decision.reason });
      continue;
    }
    if (item.kind === "worktree" && !(await isWorktreeClean(item.path))) {
      skipped.push({ path: item.path, reason: "worktree has uncommitted changes" });
      continue;
    }
    candidates.push(item);
  }

  const { kept, dropped } = applyMaxDeletes(candidates, opts.maxDeletes);
  for (const item of candidates.slice(kept.length)) {
    skipped.push({ path: item.path, reason: "exceeds --max-deletes" });
  }

  const archiveItems = kept.filter((i) => i.action === "archive");
  const pruneItems = kept.filter((i) => i.action === "prune");

  const timestamp = stamp();
  const archived: ManifestEntry[] = [];
  const pruned: ManifestEntry[] = [];
  let archivePath: string | null = null;

  if (archiveItems.length > 0) {
    archivePath = path.join(archiveDir(opts.home), `${timestamp}.tar.gz`);
    const entries = archiveItems.map((item, i) => ({
      absPath: item.path,
      storedAs: storedName(i, item.path),
    }));
    try {
      await writeTarGz(archivePath, entries);
    } catch (e) {
      // Archive-first invariant: if the archive fails, nothing is removed.
      const reason = `archive failed: ${e instanceof Error ? e.message : String(e)}`;
      for (const item of archiveItems) skipped.push({ path: item.path, reason });
      archivePath = null;
      return finalize(opts.home, timestamp, archivePath, archived, pruned, skipped);
    }

    for (let i = 0; i < archiveItems.length; i++) {
      const item = archiveItems[i];
      if (!item) continue;
      try {
        await removePath(item.path);
      } catch (e) {
        skipped.push({
          path: item.path,
          reason: `remove failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      archived.push({
        path: item.path,
        bytes: item.bytes,
        verdict: item.verdict,
        storedAs: storedName(i, item.path),
        action: "archive",
      });
    }
  }

  for (const item of pruneItems) {
    try {
      await removePath(item.path);
    } catch (e) {
      skipped.push({
        path: item.path,
        reason: `remove failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    pruned.push({
      path: item.path,
      bytes: item.bytes,
      verdict: item.verdict,
      storedAs: null,
      action: "prune",
    });
  }

  return finalize(opts.home, timestamp, archivePath, archived, pruned, skipped);
}

async function finalize(
  home: string,
  timestamp: string,
  archivePath: string | null,
  archived: ManifestEntry[],
  pruned: ManifestEntry[],
  skipped: Skipped[],
): Promise<ActResult> {
  let manifestPath: string | null = null;
  if (archived.length > 0 || pruned.length > 0) {
    const manifest: Manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      archive: archivePath,
      entries: [...archived, ...pruned],
    };
    manifestPath = path.join(manifestDir(home), `${timestamp}.json`);
    await writeManifest(manifestPath, manifest);
  }
  return { archive: archivePath, manifest: manifestPath, archived, pruned, skipped };
}

export interface RestoreResult {
  restored: string[];
  skipped: Skipped[];
}

export async function restore(
  manifestPath: string,
  opts: { force?: boolean; stagingRoot: string },
): Promise<RestoreResult> {
  const manifest = await readManifest(manifestPath);
  if (!manifest) throw new Error(`no valid manifest at ${manifestPath}`);

  const restored: string[] = [];
  const skipped: Skipped[] = [];
  const entries = manifest.entries.filter((e) => e.action === "archive" && e.storedAs !== null);
  if (!manifest.archive || entries.length === 0) {
    return { restored, skipped };
  }

  const staging = path.join(opts.stagingRoot, `restore-${Date.now()}`);
  await ensureDir(staging);
  await extractTarGz(manifest.archive, staging);

  for (const entry of entries) {
    if (entry.storedAs === null) continue;
    const src = path.join(staging, entry.storedAs);
    if (!(await exists(src))) {
      skipped.push({ path: entry.path, reason: "missing in archive" });
      continue;
    }
    if ((await exists(entry.path)) && !opts.force) {
      skipped.push({ path: entry.path, reason: "destination exists (use --force)" });
      continue;
    }
    await ensureDir(path.dirname(entry.path));
    try {
      await fs.rename(src, entry.path);
    } catch {
      await fs.cp(src, entry.path, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
    }
    restored.push(entry.path);
  }

  await fs.rm(staging, { recursive: true, force: true });
  return { restored, skipped };
}
