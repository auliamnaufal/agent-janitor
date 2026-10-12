import { promises as fs } from "node:fs";
import path from "node:path";
import { exists, ensureDir, stamp } from "../util/fs.js";
import { extractTarGz, writeTarGz } from "./archive.js";
import { readManifest, removePath, writeManifest } from "./manifest.js";
import { archiveDir, manifestDir } from "./paths.js";
import { listArchived, matchArchived, type ArchivedItem } from "./catalog.js";
import { applyMaxDeletes, guard, planFindings } from "./safety.js";
import type {
  Env,
  Finding,
  Manifest,
  ManifestEntry,
  Plan,
  PlannedFinding,
} from "./types.js";
import {
  gitWorktreeAdd,
  gitWorktreePaths,
  gitWorktreePrune,
  isWorktreeClean,
} from "../drivers/worktrees.js";

export function buildPlan(
  findings: Finding[],
  opts: { prune: boolean; now?: number; minAgeMs?: number; keep?: string[] },
): Plan {
  return planFindings(findings, {
    prune: opts.prune,
    now: opts.now ?? Date.now(),
    minAgeMs: opts.minAgeMs ?? 0,
    ...(opts.keep ? { keep: opts.keep } : {}),
  });
}

export interface ActOptions {
  prune: boolean;
  maxDeletes?: number;
  /** Skip reclaimable items newer than this. Default 0 (act on everything). */
  minAgeMs?: number;
  /** Never archive items whose path contains any of these substrings. */
  keep?: string[];
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
    ...(opts.keep ? { keep: opts.keep } : {}),
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
      // A removed worktree leaves a dangling git registration behind: prune it.
      if (item.kind === "worktree" && item.gitRepo) {
        await gitWorktreePrune(item.gitRepo);
      }
      archived.push({
        path: item.path,
        bytes: item.bytes,
        verdict: item.verdict,
        storedAs: storedName(i, item.path),
        action: "archive",
        ...(item.kind === "worktree" && item.gitRepo
          ? {
              worktree: {
                repo: item.gitRepo,
                branch: item.gitBranch ?? null,
                head: item.gitHead ?? null,
              },
            }
          : {}),
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

export interface RestoreOptions {
  force?: boolean;
  dryRun?: boolean;
  stagingRoot: string;
}

/**
 * Restore a set of archived items. Groups by archive so each tarball is
 * extracted once, then moves each file back to its original path.
 */
export async function restoreItems(
  items: ArchivedItem[],
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const restored: string[] = [];
  const skipped: Skipped[] = [];

  const groups = new Map<string, ArchivedItem[]>();
  for (const item of items) {
    const group = groups.get(item.archive) ?? [];
    group.push(item);
    groups.set(item.archive, group);
  }

  const staging = path.join(opts.stagingRoot, `restore-${Date.now()}`);
  let index = 0;

  for (const [archive, group] of groups) {
    if (opts.dryRun) {
      for (const item of group) {
        if ((await exists(item.entry.path)) && !opts.force) {
          skipped.push({ path: item.entry.path, reason: "destination exists (use --force)" });
        } else {
          restored.push(item.entry.path);
        }
      }
      continue;
    }

    const sub = path.join(staging, String(index++));
    await ensureDir(sub);
    await extractTarGz(archive, sub);

    for (const item of group) {
      const storedAs = item.entry.storedAs;
      if (storedAs === null) continue;
      const src = path.join(sub, storedAs);
      if (!(await exists(src))) {
        skipped.push({ path: item.entry.path, reason: "missing in archive" });
        continue;
      }
      if ((await exists(item.entry.path)) && !opts.force) {
        skipped.push({ path: item.entry.path, reason: "destination exists (use --force)" });
        continue;
      }
      await ensureDir(path.dirname(item.entry.path));
      try {
        await fs.rename(src, item.entry.path);
      } catch {
        await fs.cp(src, item.entry.path, { recursive: true });
        await fs.rm(src, { recursive: true, force: true });
      }
      if (item.entry.worktree) {
        const ok = await ensureWorktreeRegistered(item.entry.worktree, item.entry.path);
        if (!ok) {
          skipped.push({
            path: item.entry.path,
            reason: "restored but not re-registered with git",
          });
        }
      }
      restored.push(item.entry.path);
    }
  }

  if (!opts.dryRun) await fs.rm(staging, { recursive: true, force: true });
  return { restored, skipped };
}

/**
 * Ensure a restored worktree directory is registered with git again. Moves the
 * dir aside, re-adds the worktree from its recorded branch/head, then overlays
 * the archived files onto the fresh checkout.
 */
async function ensureWorktreeRegistered(
  meta: { repo: string; branch: string | null; head: string | null },
  wtPath: string,
): Promise<boolean> {
  const registered = await gitWorktreePaths(meta.repo);
  if (registered.includes(wtPath)) return true;

  const ref = meta.branch ?? meta.head;
  if (!ref) return false;

  const aside = `${wtPath}.agent-janitor-aside`;
  try {
    await fs.rename(wtPath, aside);
  } catch {
    return false;
  }

  const added = await gitWorktreeAdd(meta.repo, wtPath, ref, meta.branch === null);
  if (!added) {
    await fs.rename(aside, wtPath).catch(() => undefined);
    return false;
  }

  await fs.cp(aside, wtPath, { recursive: true, force: true });
  await fs.rm(aside, { recursive: true, force: true });
  return true;
}

/** Restore every archived item recorded in one manifest. */
export async function restore(manifestPath: string, opts: RestoreOptions): Promise<RestoreResult> {
  const manifest = await readManifest(manifestPath);
  if (!manifest) throw new Error(`no valid manifest at ${manifestPath}`);
  if (!manifest.archive) return { restored: [], skipped: [] };
  const archive = manifest.archive;
  const items: ArchivedItem[] = manifest.entries
    .filter((entry) => entry.action === "archive" && entry.storedAs !== null)
    .map((entry) => ({ manifestPath, archive, entry }));

  const result = await restoreItems(items, opts);
  if (!opts.dryRun) await compactAfterRestore(items, new Set(result.restored));
  return result;
}

/** Restore archived items across all manifests whose original path matches `query`. */
export async function restoreQuery(
  home: string,
  query: string,
  opts: RestoreOptions,
): Promise<RestoreResult & { matched: number }> {
  const items = matchArchived(await listArchived(home), query);
  const result = await restoreItems(items, opts);
  if (!opts.dryRun) await compactAfterRestore(items, new Set(result.restored));
  return { ...result, matched: items.length };
}

/**
 * Drop restored entries from their manifests so `--list` stays accurate; remove a
 * manifest (and its now-empty tarball) once nothing references it.
 */
async function compactAfterRestore(
  items: ArchivedItem[],
  restoredPaths: Set<string>,
): Promise<void> {
  const byManifest = new Map<string, ArchivedItem[]>();
  for (const item of items) {
    const group = byManifest.get(item.manifestPath) ?? [];
    group.push(item);
    byManifest.set(item.manifestPath, group);
  }

  for (const [manifestPath, group] of byManifest) {
    const manifest = await readManifest(manifestPath);
    if (!manifest) continue;
    const remaining = manifest.entries.filter(
      (entry) => !(entry.action === "archive" && restoredPaths.has(entry.path)),
    );
    if (remaining.length === manifest.entries.length) continue;

    if (remaining.length === 0) {
      await removePath(manifestPath);
      if (manifest.archive) await removePath(manifest.archive);
    } else {
      await writeManifest(manifestPath, { ...manifest, entries: remaining });
    }
  }
}
