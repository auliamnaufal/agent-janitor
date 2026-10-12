# agent-gc — Design

## 1. The problem

Coding agents persist state *outside* the repository, and nothing owns it:

- **Session transcripts** — plaintext conversation logs, regularly 100 MB+ per project. Often contain secrets.
- **Worktrees** — parallel runs spawn git worktrees that are never deregistered.
- **Scratchpads** — per-session temp dirs.
- **Install caches** — `npx`/`uv`/MCP-server caches that regenerate.
- **Traces / state** — OTel spans, indexes, debug logs.

A year of heavy use leaves tens of gigabytes. "When did the agent create this, and is
it safe to delete?" is unanswerable with the tools people have.

## 2. The honest landscape

The niche is **contested**, not empty. Anyone reviewing this project will find these;
so we name them first.

| Tool | Surface | Form | Gap it leaves |
|---|---|---|---|
| `ishizakahiroshi/ai-log-clean` | session logs (7+ agents) | CLI | logs only; no worktrees/caches; silent headless schedule |
| `jvroth18/agent-footprint` | footprint + worktrees + caches + procs | Python dashboard | deliberately **excludes transcripts**; manual |
| `blain3white/clean-my-agent` | sessions (5 agents) | Electron app | GUI, not CLI; session-scoped |
| `meistrari/clean-worktrees` | worktrees | CLI | worktrees only |
| `0xelitesystem/agent-leaks` | transcript secrets | CLI | secrets only, no reclaim |
| `ccusage` / CodeBurn | token cost | CLI | cost, not disk |

All are low-adoption (<25★ ceiling). None is *wired into the developer's loop*.

### The wedge

Unify the **full surface** — transcripts + worktrees + scratchpads + caches + traces —
into **one composable CLI** whose headline feature is the **safety model**, and make it
**ambient** via recurring surfaces instead of a command you remember once a year.

## 3. Distribution thesis

Disk cleanup is an *episodic* need; a one-shot tool churns. Adoption here comes from
**trigger + surface + shareability**, not from feature depth:

- **Zero-install:** `npx agent-gc` (no runtime deps) / `brew install`.
- **Runs itself:** `install` wires a shell-prompt segment, a weekly digest, a repo gate.
- **Shareable:** a redacted receipt designed to be screenshotted.

## 4. Architecture

```
cli.ts ──▶ engine ──▶ drivers
             │          └─ each driver: detect() + scan() → Finding[]
             ├─ scan     (orchestrate, size)
             ├─ safety   (invariants, gate the actor)
             ├─ report   (receipt: text | json)
             ├─ archive  (tar.gz + manifest)
             └─ act      (execute plan; only place that mutates the fs)
```

**Rule:** the engine contains no agent-specific knowledge. All of it lives in drivers.

### Driver interface

```ts
interface Driver {
  id: string;                      // "claude-code"
  name: string;                    // "Claude Code"
  detect(env: Env): Promise<boolean>;
  scan(env: Env): Promise<Finding[]>;
}
```

### Finding

```ts
interface Finding {
  agent: string;
  path: string;
  kind: "transcript" | "cache" | "log" | "worktree" | "scratch" | "state" | "trace";
  bytes: number;
  mtimeMs: number;
  verdict: "regenerable" | "reclaimable" | "stateful";
  secretRisk: "none" | "possible" | "likely";
  reason: string;
}
```

### Classification model

| verdict | meaning | default action |
|---|---|---|
| `regenerable` | rebuilt on demand (caches, logs) | prune (with `--prune`) |
| `reclaimable` | transcript / worktree; valuable, may hold secrets | archive |
| `stateful` | config, auth, indexes | **never touched** |

`secretRisk` is a **content-based** heuristic for scannable kinds (transcripts, scratch,
logs): `scan` reads the head of each file and matches known credential shapes. Credential
files (`auth.json`, `.credentials.json`) are flagged by name. It exists to surface, not to
redact. It reads only the first 256 KB per file, so a secret late in a huge transcript may
be missed — deliberately bounded, and adjustable (`enrichSecrets({ maxBytes })`).

### Retention

`planFindings` applies a **retention gate**: reclaimable items newer than `minAgeMs` are
skipped. The CLI defaults this to 30 days (`--days`), so `clean` never archives recent or
active work. `--days 0` disables the gate.

## 5. Safety invariants (enforced in `engine/safety.ts`)

1. `scan` performs no writes.
2. `clean` is archive-first; nothing is unrecoverable.
3. `--prune` acts only on the regenerable allowlist; transcripts/state are refused.
4. Paths with lockfile siblings (`.lock`, `-wal`, `-shm`) or touched within the grace
   window are skipped.
5. `--max-deletes N` caps a run; a per-item failure never aborts the remaining items.
6. Every mutation is recorded in a manifest; `restore` reverses it.
7. Archives are written `0600` (dir `0700`); `extract` refuses path-traversal members.
8. Reclaimable items newer than the retention window are skipped.

## 6. Restore & the archive index

Archiving removes a transcript from the agent's resume list, so recovery must be
*trivial* or the tool is resented. Manifests already record each item's original path, so
`engine/catalog.ts` reads them all and offers:

- `restore --list` — every batch (date, count, size) and its items.
- `restore <query>` — substring match on the original path (session id **or** project),
  restoring only matching items across **all** batches — not just the newest.
- `restore latest | <manifest>` — a whole batch; `--dry-run` previews.

After a restore, affected manifests are compacted (restored entries dropped) so the index
stays truthful; a batch whose archive entries are all restored removes its own tarball.
`clean --keep <substr>` lets users protect specific sessions up front.

## 7. Triggers

| Surface | Cadence | Mechanism |
|---|---|---|
| shell prompt segment | every prompt | `agent-gc prompt` reads cached summary (no scan) |
| weekly digest | weekly | `watch` via launchd / systemd --user / Task Scheduler |
| repo gate | on push | `pre-push` warns on orphaned worktrees / stray agent artifacts |

`install` **prints** what it will register and writes files under `~/.agent-gc/`; it does
not silently modify system schedulers unless given `--apply`.

## 8. Non-goals

Cost tracking, general disk cleaning, a resident daemon, secret *redaction* (surface only).

## 9. Known risks

- **Misclassifying state as regenerable.** Mitigated by archive-first + allowlist.
- **Adapter maintenance is forever.** Agent layouts change; the driver registry is a
  living cost, not a one-time build.
- **Vendor absorption.** Agents are shipping their own retention (Claude Code's
  `cleanupPeriodDays`, VS Code's worktree cleanup). The durable value is *cross-agent
  aggregation*, which vendors won't build.
