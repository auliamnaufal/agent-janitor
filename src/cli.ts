#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import * as readline from "node:readline/promises";
import { flagBool, flagList, flagNumber, flagString, parseArgs, type FlagSpec } from "./util/args.js";
import { expandHome, exists, readJson, writeJson } from "./util/fs.js";
import { formatBytes } from "./util/format.js";
import { scan } from "./engine/scan.js";
import { act, buildPlan, restore, restoreQuery } from "./engine/act.js";
import { classifyRestoreTarget, listManifests } from "./engine/catalog.js";
import { planToJson, renderPlan, renderScan, scanJson, totals } from "./engine/report.js";
import { cacheFile, stateDir } from "./engine/paths.js";
import { DEFAULT_RETENTION_DAYS } from "./engine/safety.js";
import { DRIVERS } from "./drivers/registry.js";
import { renderPrompt } from "./triggers/shell.js";
import { buildSchedule, runActivation } from "./triggers/schedule.js";
import { changedFiles, defaultChanged, gitHooksDir, prePushHookScript, runGuard } from "./engine/guard.js";
import type { Env, Summary } from "./engine/types.js";
import { VERSION } from "./version.js";

const FLAGS: FlagSpec[] = [
  { name: "help", type: "boolean", alias: "h" },
  { name: "version", type: "boolean", alias: "v" },
  { name: "json", type: "boolean" },
  { name: "prune", type: "boolean" },
  { name: "dry-run", type: "boolean" },
  { name: "yes", type: "boolean", alias: "y" },
  { name: "force", type: "boolean" },
  { name: "apply", type: "boolean" },
  { name: "list", type: "boolean" },
  { name: "strict", type: "boolean" },
  { name: "hook", type: "boolean" },
  { name: "home", type: "string" },
  { name: "root", type: "string", multiple: true },
  { name: "only", type: "string", multiple: true },
  { name: "keep", type: "string", multiple: true },
  { name: "grace", type: "number" },
  { name: "days", type: "number" },
  { name: "no-secrets", type: "boolean" },
  { name: "scan-bytes", type: "number" },
  { name: "max-deletes", type: "number" },
  { name: "limit", type: "number" },
  { name: "at", type: "string" },
];

const HELP = `agent-janitor ${VERSION} — cross-agent guardian for your machine

USAGE
  agent-janitor <command> [options]

COMMANDS
  scan                 Read-only survey; prints the machine receipt
  clean                Archive safely (and optionally prune regenerable caches)
  restore <what>       Restore archived items: a manifest, "latest", or a query
  guard                Repo-scoped pre-push checks (worktrees, artifacts, secrets)
  install              Print/emit the recurring surfaces (prompt, weekly watch)
  watch                Headless run for the scheduler; writes the cached summary
  prompt               Print the shell-prompt segment (reads cache, no scan)
  drivers              List supported agents and detection status

OPTIONS
  --json               Machine-readable output
  --prune              Delete regenerable caches (default: archive only)
  --dry-run            Show the plan, change nothing (also for restore)
  --yes, -y            Skip the confirmation prompt
  --force              Overwrite existing files on restore
  --list               (restore) list archived batches and items
  --keep <substr>      (clean) never archive paths containing this (repeatable)
  --strict             (guard) exit non-zero on warnings too
  --hook               (install) also write the pre-push gate
  --apply              Actually write scheduler files (install)
  --home <dir>         Override home ($AGENT_GC_HOME)
  --root <dir>         Repo root to scan for worktrees (repeatable)
  --only <driver>      Restrict to a driver (repeatable)
  --days <n>           Only act on items older than n days (clean, default 30)
  --grace <minutes>    Treat items touched within N min as active (default 15)
  --no-secrets         Skip the content-based secret scan during scan/clean
  --scan-bytes <n>     Head/tail bytes scanned per file for secrets (default 1 MB / 256 KB)
  --max-deletes <n>    Cap mutations in a single run
  --at <HH:MM>         Weekly watch time (install, default 12:00)

RESTORE
  agent-janitor restore --list                  show archived batches
  agent-janitor restore latest                  restore the most recent batch
  agent-janitor restore 9b97c704                restore any batch containing "9b97c704"
  agent-janitor restore strike-api --dry-run    preview restoring a project's sessions
`;

function resolveHome(args: ReturnType<typeof parseArgs>): string {
  const home = flagString(args, "home") ?? process.env["AGENT_GC_HOME"] ?? os.homedir();
  return expandHome(home);
}

function buildEnv(args: ReturnType<typeof parseArgs>, home: string): Env {
  const graceMinutes = flagNumber(args, "grace") ?? 15;
  const roots = flagList(args, "root").map((r) => expandHome(r, home));
  return {
    home,
    roots: roots.length > 0 ? roots : [process.cwd()],
    now: Date.now(),
    graceMs: graceMinutes * 60_000,
  };
}

function scanOptions(args: ReturnType<typeof parseArgs>): {
  only: string[];
  secrets: boolean;
  scanBytes?: number;
} {
  const only = flagList(args, "only");
  const secrets = !flagBool(args, "no-secrets");
  const scanBytes = flagNumber(args, "scan-bytes");
  return scanBytes !== undefined ? { only, secrets, scanBytes } : { only, secrets };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function commandScan(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const env = buildEnv(args, home);
  const result = await scan(env, scanOptions(args));
  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(scanJson(result, env), null, 2) + "\n");
  } else {
    process.stdout.write(renderScan(result, env) + "\n");
  }
  return 0;
}

async function commandClean(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const env = buildEnv(args, home);
  const dryRun = flagBool(args, "dry-run");
  const prune = flagBool(args, "prune");
  const retentionDays = flagNumber(args, "days") ?? DEFAULT_RETENTION_DAYS;
  const minAgeMs = retentionDays * 86_400_000;
  const keep = flagList(args, "keep");
  const result = await scan(env, scanOptions(args));
  const plan = buildPlan(result.findings, {
    prune,
    now: env.now,
    minAgeMs,
    ...(keep.length > 0 ? { keep } : {}),
  });

  if (dryRun) {
    if (flagBool(args, "json")) {
      process.stdout.write(JSON.stringify(planToJson(plan), null, 2) + "\n");
    } else {
      process.stdout.write(
        renderPlan(plan, env, { dryRun: true, limit: flagNumber(args, "limit") ?? 40 }) + "\n",
      );
    }
    return 0;
  }

  const active = plan.items.filter((i) => i.action !== "skip");
  if (active.length === 0) {
    process.stdout.write("Nothing to reclaim. Your machine is clean.\n");
    return 0;
  }

  if (!flagBool(args, "json")) {
    process.stdout.write(
      renderPlan(plan, env, { dryRun: false, limit: flagNumber(args, "limit") ?? 40 }) + "\n",
    );
  }

  const autoYes = flagBool(args, "yes");
  if (!autoYes) {
    const ok = await confirm("Archive these items? [y/N] ");
    if (!ok) {
      process.stdout.write("Aborted. Nothing changed.\n");
      return 1;
    }
  }

  const outcome = await act(result.findings, {
    prune,
    env,
    home,
    minAgeMs,
    ...(keep.length > 0 ? { keep } : {}),
    ...(flagNumber(args, "max-deletes") !== undefined
      ? { maxDeletes: flagNumber(args, "max-deletes") as number }
      : {}),
  });

  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
  } else {
    const archivedBytes = outcome.archived.reduce((s, e) => s + e.bytes, 0);
    const prunedBytes = outcome.pruned.reduce((s, e) => s + e.bytes, 0);
    process.stdout.write(
      `\nArchived ${outcome.archived.length} item(s) (${formatBytes(archivedBytes)})` +
        (outcome.pruned.length > 0
          ? ` · pruned ${outcome.pruned.length} (${formatBytes(prunedBytes)})`
          : "") +
        `\n`,
    );
    if (outcome.manifest) {
      process.stdout.write(`Manifest: ${outcome.manifest}\n`);
      process.stdout.write(`Undo with: agent-janitor restore "${outcome.manifest}"\n`);
    }
    if (outcome.skipped.length > 0) {
      process.stdout.write(`Skipped ${outcome.skipped.length} item(s) (safety).\n`);
    }
  }
  return 0;
}

async function commandRestore(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const stagingRoot = path.join(stateDir(home), "tmp");
  const dryRun = flagBool(args, "dry-run");
  const force = flagBool(args, "force");

  if (flagBool(args, "list")) {
    const records = await listManifests(home);
    if (records.length === 0) {
      process.stdout.write("No archives found.\n");
      return 0;
    }
    process.stdout.write("\nagent-janitor · archived\n" + "─".repeat(60) + "\n");
    for (const record of records.slice().reverse()) {
      const items = record.manifest.entries.filter((e) => e.action === "archive");
      const bytes = items.reduce((sum, e) => sum + e.bytes, 0);
      process.stdout.write(
        `  ${record.manifest.createdAt}   ${items.length} item(s)   ${formatBytes(bytes)}\n`,
      );
      for (const entry of items.slice(0, 5)) {
        process.stdout.write(`    · ${entry.path.replace(home, "~")}\n`);
      }
      if (items.length > 5) process.stdout.write(`    … and ${items.length - 5} more\n`);
    }
    process.stdout.write("");
    return 0;
  }

  const target = args.positionals[0];
  if (!target) {
    process.stderr.write(
      "usage: agent-janitor restore <manifest|latest|query> [--list] [--dry-run] [--force]\n",
    );
    return 2;
  }

  let result: { restored: string[]; skipped: { path: string; reason: string }[] };
  let matched: number | null = null;

  const resolved = await classifyRestoreTarget(target);
  if (resolved.kind === "latest") {
    const records = await listManifests(home);
    const newest = records[records.length - 1];
    if (!newest) {
      process.stderr.write("No manifests found.\n");
      return 1;
    }
    result = await restore(newest.path, { force, dryRun, stagingRoot });
  } else if (resolved.kind === "manifest") {
    result = await restore(resolved.path, { force, dryRun, stagingRoot });
  } else {
    const outcome = await restoreQuery(home, resolved.query, { force, dryRun, stagingRoot });
    if (outcome.matched === 0) {
      process.stderr.write(`No archived item matches "${resolved.query}". Try: agent-janitor restore --list\n`);
      return 1;
    }
    result = outcome;
    matched = outcome.matched;
  }

  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify({ ...result, matched, dryRun }, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(
    `${dryRun ? "Would restore" : "Restored"} ${result.restored.length} item(s)` +
      (matched !== null ? ` (matched ${matched})` : "") +
      ".\n",
  );
  for (const p of result.restored.slice(0, 20)) {
    process.stdout.write(`  ${p.replace(home, "~")}\n`);
  }
  if (result.restored.length > 20) {
    process.stdout.write(`  … and ${result.restored.length - 20} more\n`);
  }
  for (const skip of result.skipped) {
    process.stdout.write(`  skipped ${skip.path.replace(home, "~")} — ${skip.reason}\n`);
  }
  return 0;
}

async function commandInstall(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const binPath = process.argv[1] ?? "agent-janitor";
  const at = flagString(args, "at") ?? "12:00";
  const apply = flagBool(args, "apply");
  const wantHook = flagBool(args, "hook");
  const plan = buildSchedule({ home, binPath, at });

  process.stdout.write("\nagent-janitor · install\n" + "─".repeat(60) + "\n");
  process.stdout.write("Weekly watch:\n");
  for (const file of plan.files) process.stdout.write(`  write  ${file.path}\n`);
  process.stdout.write("Activate with:\n");
  for (const cmd of plan.activate) process.stdout.write(`  ${cmd}\n`);
  process.stdout.write("\nPrompt segment (add to your shell prompt):\n  $(agent-janitor prompt)\n");
  if (wantHook) {
    const dir = await gitHooksDir(process.cwd());
    process.stdout.write(`\nPre-push gate:\n  write  ${path.join(dir, "pre-push")}\n`);
  }

  if (!apply) {
    process.stdout.write("\n(dry) nothing written — pass --apply to write files and register.\n");
    return 0;
  }

  for (const file of plan.files) {
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.content, { mode: 0o644 });
    process.stdout.write(`  wrote ${file.path}\n`);
  }

  const activation = await runActivation(plan);
  for (const cmd of activation.ran) process.stdout.write(`  ok    ${cmd}\n`);
  for (const err of activation.errors) process.stdout.write(`  fail  ${err}\n`);

  if (wantHook) {
    const dir = await gitHooksDir(process.cwd());
    await fs.mkdir(dir, { recursive: true });
    const hookPath = path.join(dir, "pre-push");
    if (await exists(hookPath)) {
      const existing = await fs.readFile(hookPath, "utf8").catch(() => "");
      if (!existing.includes("agent-janitor")) {
        process.stdout.write(`  skip  ${hookPath} (existing hook is not ours)\n`);
        return 0;
      }
    }
    await fs.writeFile(hookPath, prePushHookScript(), { mode: 0o755 });
    process.stdout.write(`  wrote ${hookPath}\n`);
  }
  return 0;
}

async function readPushRefs(): Promise<{ from: string; to: string }[]> {
  if (process.stdin.isTTY) return [];
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return [];
  const refs: { from: string; to: string }[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4 && parts[1] && parts[3]) refs.push({ from: parts[3], to: parts[1] });
  }
  return refs;
}

async function commandGuard(args: ReturnType<typeof parseArgs>): Promise<number> {
  const repo = process.cwd();
  const env = buildEnv(args, resolveHome(args));
  const refs = await readPushRefs();
  const changed = refs.length > 0 ? await changedFiles(repo, refs) : await defaultChanged(repo);
  const result = await runGuard(env, { repo, changed });
  const errors = result.issues.filter((i) => i.level === "error");
  const warns = result.issues.filter((i) => i.level === "warn");

  if (flagBool(args, "json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write("\nagent-janitor · guard\n" + "─".repeat(60) + "\n");
    if (result.issues.length === 0) {
      process.stdout.write(`  clean — checked ${result.changed.length} changed file(s)\n`);
    } else {
      for (const issue of result.issues) {
        process.stdout.write(`  ${issue.level === "error" ? "✗" : "!"} ${issue.message}\n`);
        if (issue.hint) process.stdout.write(`      ${issue.hint}\n`);
      }
    }
    process.stdout.write("");
  }

  if (errors.length > 0 || (flagBool(args, "strict") && warns.length > 0)) return 1;
  return 0;
}

async function commandWatch(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const env = buildEnv(args, home);
  const result = await scan(env, scanOptions(args));
  const t = totals(result.findings);
  const summary: Summary = {
    generatedAt: new Date(env.now).toISOString(),
    total: t.total,
    reclaimable: t.reclaimable,
    secrets: t.secrets,
    items: t.items,
  };
  await writeJson(cacheFile(home), summary);
  process.stdout.write(
    `agent-janitor watch · reclaimable ${formatBytes(t.reclaimable)}` +
      (t.secrets > 0 ? ` · ${t.secrets} store(s) may hold secrets` : "") +
      "\n",
  );
  return 0;
}

async function commandPrompt(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const summary = await readJson<Summary>(cacheFile(home));
  const segment = renderPrompt(summary, { warnSecrets: true });
  if (segment) process.stdout.write(segment + "\n");
  return 0;
}

async function commandDrivers(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const env = buildEnv(args, home);
  process.stdout.write("\nagent-janitor · drivers\n" + "─".repeat(60) + "\n");
  for (const driver of DRIVERS) {
    let detected = false;
    try {
      detected = await driver.detect(env);
    } catch {
      detected = false;
    }
    process.stdout.write(`  ${detected ? "✓" : "·"} ${driver.id.padEnd(14)} ${driver.name}\n`);
  }
  process.stdout.write(`\n  home: ${home}\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS);

  if (flagBool(args, "version") || args.command === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (!args.command || flagBool(args, "help") || args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.errors.length > 0) {
    for (const err of args.errors) process.stderr.write(`error: ${err}\n`);
    return 2;
  }

  switch (args.command) {
    case "scan":
      return commandScan(args);
    case "clean":
      return commandClean(args);
    case "restore":
      return commandRestore(args);
    case "guard":
      return commandGuard(args);
    case "install":
      return commandInstall(args);
    case "watch":
      return commandWatch(args);
    case "prompt":
      return commandPrompt(args);
    case "drivers":
      return commandDrivers(args);
    default:
      process.stderr.write(`unknown command: ${args.command}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => {
    // Set exitCode instead of process.exit(): calling exit() truncates large
    // piped stdout (e.g. `scan --json`) before it flushes.
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`agent-janitor: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
