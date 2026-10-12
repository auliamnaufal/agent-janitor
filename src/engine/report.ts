import type { Action, Env, Finding, FindingKind, Plan, Verdict } from "./types.js";
import type { ScanResult } from "./scan.js";
import { formatBytes, pad, padLeft, relativeTime } from "../util/format.js";

const VERDICT_LABEL: Record<Verdict, string> = {
  regenerable: "regenerate",
  reclaimable: "archive",
  stateful: "keep",
};

const ACTION_LABEL: Record<Action, string> = {
  archive: "archive",
  prune: "prune",
  skip: "skip",
};

export interface Row {
  agent: string;
  kind: FindingKind;
  verdict: Verdict;
  bytes: number;
  mtimeMs: number;
  count: number;
  secret: boolean;
}

export function aggregate(findings: Finding[]): Row[] {
  const map = new Map<string, Row>();
  for (const f of findings) {
    const key = `${f.agent}\u0000${f.kind}\u0000${f.verdict}`;
    const existing = map.get(key);
    if (existing) {
      existing.bytes += f.bytes;
      existing.count += 1;
      if (f.mtimeMs > existing.mtimeMs) existing.mtimeMs = f.mtimeMs;
      if (f.secretRisk !== "none") existing.secret = true;
    } else {
      map.set(key, {
        agent: f.agent,
        kind: f.kind,
        verdict: f.verdict,
        bytes: f.bytes,
        mtimeMs: f.mtimeMs,
        count: 1,
        secret: f.secretRisk !== "none",
      });
    }
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

export interface Totals {
  total: number;
  reclaimable: number;
  secrets: number;
  items: number;
}

export function totals(findings: Finding[]): Totals {
  let total = 0;
  let reclaimable = 0;
  let secrets = 0;
  for (const f of findings) {
    total += f.bytes;
    if (f.verdict !== "stateful") reclaimable += f.bytes;
    if (f.secretRisk !== "none") secrets++;
  }
  return { total, reclaimable, secrets, items: findings.length };
}

const SEPARATOR = "─".repeat(72);

function kindLabel(row: Row): string {
  return row.count > 1 ? `${row.kind} (${row.count})` : row.kind;
}

export function renderScan(result: ScanResult, env: Env): string {
  const rows = aggregate(result.findings);
  const lines: string[] = [];
  lines.push("");
  lines.push("agent-janitor · machine receipt");
  lines.push(SEPARATOR);

  if (rows.length === 0) {
    lines.push("");
    lines.push("  No agent stores found. Either nothing is installed, or your machine is clean.");
    lines.push("");
    return lines.join("\n");
  }

  const widths = {
    agent: Math.max(5, ...rows.map((r) => r.agent.length)),
    kind: Math.max(4, ...rows.map((r) => kindLabel(r).length)),
    size: Math.max(4, ...rows.map((r) => formatBytes(r.bytes).length)),
    touched: Math.max(7, ...rows.map((r) => relativeTime(r.mtimeMs, env.now).length)),
    verdict: Math.max(7, ...rows.map((r) => VERDICT_LABEL[r.verdict].length)),
  };

  lines.push(
    "  " +
      pad("AGENT", widths.agent + 2) +
      pad("KIND", widths.kind + 2) +
      pad("SIZE", widths.size + 2) +
      pad("TOUCHED", widths.touched + 2) +
      pad("VERDICT", widths.verdict + 2) +
      "NOTE",
  );

  for (const row of rows) {
    const note = row.secret ? "secret-bearing" : "";
    lines.push(
      "  " +
        pad(row.agent, widths.agent + 2) +
        pad(kindLabel(row), widths.kind + 2) +
        padLeft(formatBytes(row.bytes), widths.size) +
        "  " +
        pad(relativeTime(row.mtimeMs, env.now), widths.touched + 2) +
        pad(VERDICT_LABEL[row.verdict], widths.verdict + 2) +
        note,
    );
  }

  const t = totals(result.findings);
  lines.push(SEPARATOR);
  lines.push(
    `  total ${formatBytes(t.total)}   ·   reclaimable ~${formatBytes(t.reclaimable)}` +
      (t.secrets > 0 ? `   ·   ${t.secrets} store(s) hold possible secrets` : ""),
  );
  lines.push(
    "  " +
      "scan is read-only · run `agent-janitor clean` to archive safely · `--json` to script",
  );
  lines.push("");
  return lines.join("\n");
}

export function scanJson(result: ScanResult, env: Env): unknown {
  const t = totals(result.findings);
  return {
    generatedAt: new Date(env.now).toISOString(),
    home: env.home,
    totals: t,
    drivers: result.drivers,
    rows: aggregate(result.findings),
    findings: result.findings,
  };
}

export function renderPlan(plan: Plan, env: Env, opts: { dryRun: boolean; limit?: number }): string {
  const limit = opts.limit ?? 40;
  const lines: string[] = [];
  lines.push("");
  lines.push(opts.dryRun ? "agent-janitor · clean (dry run)" : "agent-janitor · clean");
  lines.push(SEPARATOR);

  const active = plan.items.filter((i) => i.action !== "skip");
  const actioned = plan.items.filter((i) => i.action === "skip");

  const show = active.slice(0, limit);
  for (const item of show) {
    lines.push(
      `  ${pad(ACTION_LABEL[item.action], 9)} ${formatBytes(item.bytes).padStart(9)}  ${item.path}`,
    );
  }
  if (active.length > show.length) {
    lines.push(`  … and ${active.length - show.length} more`);
  }

  const archiveBytes = active.filter((i) => i.action === "archive").reduce((s, i) => s + i.bytes, 0);
  const pruneBytes = active.filter((i) => i.action === "prune").reduce((s, i) => s + i.bytes, 0);

  lines.push(SEPARATOR);
  lines.push(
    `  ${active.length} item(s) → archive ${formatBytes(archiveBytes)}` +
      (pruneBytes > 0 ? ` · prune ${formatBytes(pruneBytes)}` : "") +
      ` · skipped ${actioned.length}`,
  );
  if (actioned.length > 0) {
    const reasons = new Map<string, number>();
    for (const item of actioned) {
      const reason = item.skipReason ?? "other";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const parts = [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, count]) => `${count} ${reason}`);
    lines.push(`  skipped: ${parts.join(" · ")}`);
  }
  lines.push(
    "  archive is restorable (`agent-janitor restore <manifest>`) · prune deletes regenerable caches only",
  );
  lines.push("");
  return lines.join("\n");
}

export function planToJson(plan: Plan): unknown {
  const archiveBytes = plan.items
    .filter((i) => i.action === "archive")
    .reduce((s, i) => s + i.bytes, 0);
  const pruneBytes = plan.items.filter((i) => i.action === "prune").reduce((s, i) => s + i.bytes, 0);
  return {
    items: plan.items,
    summary: {
      total: plan.items.length,
      archive: plan.items.filter((i) => i.action === "archive").length,
      prune: plan.items.filter((i) => i.action === "prune").length,
      skip: plan.items.filter((i) => i.action === "skip").length,
      archiveBytes,
      pruneBytes,
    },
  };
}
