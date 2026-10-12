# Launch notes

Internal — how to introduce `agent-janitor`, and where. (Not shipped in the npm tarball.)

## One-liner

Cross-agent CLI that inspects, classifies, and safely reclaims what AI coding agents
(Claude Code, Codex, Cursor, Gemini, opencode) leave on your machine — with a receipt,
reversible archives, and a pre-push gate.

## The hook (the thing that gets shared)

Run `npx agent-janitor scan` and you get a **machine receipt**:

```
AGENT        KIND              SIZE      TOUCHED  VERDICT     NOTE
claude-code  transcript (204)  431.6 MB  19m ago  archive     secret-bearing
codex        transcript (193)  298.5 MB  25d ago  archive
claude-code  state (3)           8.4 MB  4h ago   keep
```

It's a screenshot. Lead with it.

## Why it's different (say this honestly)

The space is crowded — `agent-gc` (Rust/TUI), `ai-log-clean`, `agent-footprint`,
`clean-my-agent`, `agent-leaks`. None of them **run themselves** and none **unify** the
full surface. The three things to lead with:

1. **It runs itself** — a registered weekly watch + a pre-push gate, not a command you
   remember once a year.
2. **Archive, not delete** — everything is restorable (`restore <session-id-or-project>`),
   which is why the default is safe.
3. **It surfaces secrets** in your transcripts, across agents.

## Show HN

**Title:** Show HN: Agent-janitor – reclaim what AI coding agents leave on your machine

**Body:**

> A year of heavy agent use leaves tens of GB in your home dir — session transcripts
> (often 100 MB+ each), duplicate worktrees, install caches, trace files. Some of it is
> plaintext secrets. Nothing owns it, and "when did the agent create this, and is it safe
> to delete?" is unanswerable.
>
> agent-janitor surveys every agent's known layout (Claude Code, Codex, Cursor, Gemini,
> opencode), classifies each store as regenerable / reclaimable / stateful, and prints a
> receipt. `clean` archives before it deletes; `restore <session-id>` brings a session
> back. It also content-scans transcripts for leaked credentials.
>
> It's cross-agent by construction — the engine has no agent-specific logic, each agent is
> a driver. Zero runtime deps. `npx agent-janitor scan` is read-only if you just want to
> look.
>
> There are similar tools (agent-gc, ai-log-clean, …); the bet here is on "runs itself"
> (registered watch + pre-push gate) plus reversible archives. Feedback welcome.

## Where to post

- **r/ClaudeAI** — the recurring "why is `~/.claude` 40 GB" threads (answer the question,
  link the tool as the answer, don't just drop a link).
- **Session-viewer repos** — file issues/PRs offering GC (they own the audience).
- **Show HN** — above.
- **lobste.rs** (tag: `tools` / `vibecoding`).

## Guardrails

- Lead with the receipt; don't oversell. Say "early, v0.x".
- Be upfront about the crowded field — it reads as confidence, not weakness.
- Never claim it deletes safely by default without the archive/restore caveat.
