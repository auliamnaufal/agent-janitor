#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import * as readline from "node:readline/promises";
import { flagBool, flagList, flagNumber, flagString, parseArgs, type FlagSpec } from "./util/args.js";
import { expandHome, readJson, writeJson } from "./util/fs.js";
import { formatBytes } from "./util/format.js";
import { scan } from "./engine/scan.js";
import { act, buildPlan, restore } from "./engine/act.js";
import { planToJson, renderPlan, renderScan, scanJson, totals } from "./engine/report.js";
import { cacheFile, manifestDir, stateDir } from "./engine/paths.js";
import { DEFAULT_RETENTION_DAYS } from "./engine/safety.js";
import { DRIVERS } from "./drivers/registry.js";
import { renderPrompt } from "./triggers/shell.js";
import { buildSchedule } from "./triggers/schedule.js";
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
  { name: "home", type: "string" },
  { name: "root", type: "string", multiple: true },
  { name: "only", type: "string", multiple: true },
  { name: "grace", type: "number" },
  { name: "days", type: "number" },
  { name: "no-secrets", type: "boolean" },
  { name: "max-deletes", type: "number" },
  { name: "limit", type: "number" },
  { name: "at", type: "string" },
];

const HELP = `agent-gc ${VERSION} — cross-agent guardian for your machine

USAGE
  agent-gc <command> [options]

COMMANDS
  scan                 Read-only survey; prints the machine receipt
  clean                Archive safely (and optionally prune regenerable caches)
  restore <manifest>   Reverse a previous clean ("latest" for the newest)
  install              Print/emit the recurring surfaces (prompt, weekly watch)
  watch                Headless run for the scheduler; writes the cached summary
  prompt               Print the shell-prompt segment (reads cache, no scan)
  drivers              List supported agents and detection status

OPTIONS
  --json               Machine-readable output
  --prune              Delete regenerable caches (default: archive only)
  --dry-run            Show the plan, change nothing
  --yes, -y            Skip the confirmation prompt
  --force              Overwrite existing files on restore
  --apply              Actually write scheduler files (install)
  --home <dir>         Override home ($AGENT_GC_HOME)
  --root <dir>         Repo root to scan for worktrees (repeatable)
  --only <driver>      Restrict to a driver (repeatable)
  --days <n>           Only act on items older than n days (clean, default 30)
  --grace <minutes>    Treat items touched within N min as active (default 15)
  --no-secrets         Skip the content-based secret scan during scan/clean
  --max-deletes <n>    Cap mutations in a single run
  --at <HH:MM>         Weekly watch time (install, default 12:00)
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
  const result = await scan(env, {
    only: flagList(args, "only"),
    secrets: !flagBool(args, "no-secrets"),
  });
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
  const result = await scan(env, {
    only: flagList(args, "only"),
    secrets: !flagBool(args, "no-secrets"),
  });
  const plan = buildPlan(result.findings, { prune, now: env.now, minAgeMs });

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
      process.stdout.write(`Undo with: agent-gc restore "${outcome.manifest}"\n`);
    }
    if (outcome.skipped.length > 0) {
      process.stdout.write(`Skipped ${outcome.skipped.length} item(s) (safety).\n`);
    }
  }
  return 0;
}

async function commandRestore(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const target = args.positionals[0];
  if (!target) {
    process.stderr.write("usage: agent-gc restore <manifest|latest>\n");
    return 2;
  }

  let manifestPath = target;
  if (target === "latest") {
    const dir = manifestDir(home);
    const files = (await fs.readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".json"))
      .sort();
    const newest = files[files.length - 1];
    if (!newest) {
      process.stderr.write("No manifests found.\n");
      return 1;
    }
    manifestPath = path.join(dir, newest);
  }

  const result = await restore(manifestPath, {
    force: flagBool(args, "force"),
    stagingRoot: path.join(stateDir(home), "tmp"),
  });
  process.stdout.write(`Restored ${result.restored.length} item(s).\n`);
  for (const skip of result.skipped) {
    process.stdout.write(`  skipped ${skip.path} — ${skip.reason}\n`);
  }
  return 0;
}

async function commandInstall(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const binPath = process.argv[1] ?? "agent-gc";
  const at = flagString(args, "at") ?? "12:00";
  const plan = buildSchedule({ home, binPath, at });

  process.stdout.write("\nagent-gc · install\n" + "─".repeat(60) + "\n");
  process.stdout.write("Weekly watch:\n");
  for (const file of plan.files) {
    process.stdout.write(`  write  ${file.path}\n`);
  }
  process.stdout.write("Activate with:\n");
  for (const cmd of plan.activate) {
    process.stdout.write(`  ${cmd}\n`);
  }
  process.stdout.write("\nPrompt segment (add to your shell prompt):\n");
  process.stdout.write(`  $(agent-gc prompt)\n`);

  if (flagBool(args, "apply")) {
    for (const file of plan.files) {
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await fs.writeFile(file.path, file.content, { mode: 0o644 });
      process.stdout.write(`\nWrote ${file.path}\n`);
    }
    process.stdout.write("Run the activate command(s) above to enable.\n");
  } else {
    process.stdout.write("\n(dry) nothing written — pass --apply to emit the files.\n");
  }
  return 0;
}

async function commandWatch(args: ReturnType<typeof parseArgs>): Promise<number> {
  const home = resolveHome(args);
  const env = buildEnv(args, home);
  const result = await scan(env, {
    only: flagList(args, "only"),
    secrets: !flagBool(args, "no-secrets"),
  });
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
    `agent-gc watch · reclaimable ${formatBytes(t.reclaimable)}` +
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
  process.stdout.write("\nagent-gc · drivers\n" + "─".repeat(60) + "\n");
  for (const driver of DRIVERS) {
    const detected = await driver.detect(env);
    process.stdout.write(`  ${detected ? "✓" : "·"} ${driver.id.padEnd(14)} ${driver.name}\n`);
  }
  process.stdout.write(`\n  home: ${home}\n`);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), FLAGS);

  if (!args.command || flagBool(args, "help") || args.command === "help") {
    process.stdout.write(HELP);
    return args.command ? 0 : 0;
  }
  if (flagBool(args, "version") || args.command === "version") {
    process.stdout.write(VERSION + "\n");
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
    process.stderr.write(`agent-gc: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
