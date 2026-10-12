# agent-janitor

[![npm version](https://img.shields.io/npm/v/agent-janitor.svg)](https://www.npmjs.com/package/agent-janitor)
[![CI](https://github.com/auliamnaufal/agent-janitor/actions/workflows/ci.yml/badge.svg)](https://github.com/auliamnaufal/agent-janitor/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/agent-janitor.svg)](LICENSE)
[![node](https://img.shields.io/node/v/agent-janitor.svg)](package.json)

**The cross-agent guardian for your machine.** AI coding agents quietly litter your
home directory — session transcripts, duplicate worktrees, scratchpads, install caches,
trace files. `agent-janitor` finds it all, classifies what's safe to remove versus what
carries state, and reclaims it safely — with a receipt you can actually read.

Unlike the other tools in this space, `agent-janitor` doesn't wait for you to remember to
run it. It's designed to be *wired in*: a shell-prompt segment, a weekly digest, a
gate before you push.

```
$ agent-janitor scan

agent-janitor · machine receipt
──────────────────────────────────────────────────────────────────────
AGENT         KIND         SIZE     TOUCHED   VERDICT     NOTE
claude-code   transcript   38.2 GB  12d ago   archive     secret-bearing
claude-code   cache         1.1 GB  2h ago    regenerate
codex         transcript    6.4 GB  3d ago    archive
cursor        cache         2.0 GB  1d ago    regenerate
git           worktree      4.8 GB  41d ago   archive     no branch behind it
──────────────────────────────────────────────────────────────────────
total 52.5 GB   ·   reclaimable ~45.9 GB   ·   1 store needs review
```

## Why this exists

A year of heavy agent use leaves tens of gigabytes of stale state — some of it
plaintext secrets — and "when did the agent create this, and is it safe to delete?"
is a question nobody can answer. Generic cleaners (BleachBit, Czkawka) don't know
agent layouts. Agent-specific cleaners only handle one tool.

`agent-janitor` is cross-agent by construction: the engine holds **zero** agent-specific
logic. Every agent is a **driver** that knows its own layout and classification rules.

## Install

```bash
npx agent-janitor scan          # zero-install, read-only
npx agent-janitor clean         # archive what's safe, after a receipt
```

Or build a local binary:

```bash
git clone https://github.com/<you>/agent-janitor && cd agent-janitor
npm install && npm run build && npm link
```

## Commands

| Command | What it does |
|---|---|
| `agent-janitor scan` | Read-only survey. Sizes every store, classifies each item, and content-scans transcripts for secrets. `--json` for scripting. |
| `agent-janitor clean` | Archives everything it acts on to a restorable tarball, after showing the receipt. `--days N` sets retention (default 30). `--prune` also deletes *regenerable* caches. |
| `agent-janitor restore <what>` | Get archived items back: a manifest path, `latest`, `--list`, or a session-id/project **query**. `--dry-run` previews. |
| `agent-janitor install` | Wires the recurring surfaces (shell segment, weekly digest, repo gate). |
| `agent-janitor watch` | Headless run for the scheduler. Writes the cached summary the prompt reads. |
| `agent-janitor drivers` | Lists supported agents and whether each is detected on this machine. |

## Getting a session back

Archiving a transcript removes it from the agent's resume list — so `agent-janitor` makes
finding it again a one-liner. You don't need to remember which batch it went into:

```bash
agent-janitor restore --list          # what's archived, with dates and sizes
agent-janitor restore 9b97c704        # restore any archived session matching this id
agent-janitor restore strike-api      # …or a project name
agent-janitor restore latest          # restore the most recent batch
agent-janitor restore strike-api --dry-run   # preview first
```

Restore is selective (one session out of a batch) and the archive index stays accurate:
once everything in a batch is back, the tarball is cleaned up automatically. To *never*
archive something in the first place, protect it at clean time:

```bash
agent-janitor clean --keep "important-project" --keep 9b97c704
```

## Supported agents

| Driver | Layout |
|---|---|
| `claude-code` | `~/.claude` — session transcripts, debug/state/cache |
| `codex` | `~/.codex` — rollout sessions, logs |
| `cursor` | `~/.cursor` — chat/session state |
| `git-worktrees` | agent-created worktrees across repos under your scan roots |

Adding an agent is one file implementing the `Driver` interface — see
[`docs/DESIGN.md`](docs/DESIGN.md).

## Safety model

`agent-janitor` deletes files for a living, so it is conservative by design. These are
**invariants enforced in code**, not documentation promises:

1. **Read-only unless told otherwise.** `scan` never writes. `clean` requires the receipt and an explicit action.
2. **Retention gate.** `clean` only touches reclaimable items older than `--days` (default **30**). Recent or active work is skipped, never archived.
3. **Archive before delete.** `clean` moves candidates into a timestamped tarball + manifest. Nothing is unrecoverable.
4. **Prune only what regenerates.** `--prune` is restricted to an allowlist of regenerable paths. Transcripts and state are never pruned.
5. **Never touch a locked or open file.** Lockfile siblings (`.lock`, `-wal`, `-shm`) and recently-written paths are skipped.
6. **Bounded blast radius.** `--max-deletes N` caps a single run; a failure on one item never aborts the rest.
7. **Secrets stay private.** Archives are written `0600` (dir `0700`), and `restore` refuses `../` members in a tarball.
8. **Every run is reversible.** `restore <manifest>` undoes a batch.

Secrets are detected by content, not by filename: `scan` reads the head and tail of each
transcript (1 MB / 256 KB; widen with `--scan-bytes`) and flags known credential shapes
(AWS, Anthropic, OpenAI, GitHub, Google, Slack, Stripe, private keys, JWTs). It **surfaces**
exposure — it does not redact.

## How it differs from the rest

The space is not empty — that's the point. `williamjeong2/agent-gc` is a Rust/TUI
worktree-and-artifact GC (the closest rival, and the npm name we had to move off);
`ai-log-clean` trims session logs; `agent-footprint` is a footprint dashboard;
`clean-my-agent` is a desktop app; `clean-worktrees` handles worktrees; `agent-leaks`
redacts transcript secrets. **None of them unify the full surface into one CLI that runs
itself.** That's the gap `agent-janitor` targets. See [`docs/DESIGN.md`](docs/DESIGN.md)
for the honest landscape.

## Non-goals

- Not a token/cost tracker (see `ccusage`, CodeBurn).
- Not a general disk cleaner (see BleachBit, Czkawka).
- No daemon. `watch` is a scheduled one-shot, not a resident process.

## License

MIT
