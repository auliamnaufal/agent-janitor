# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-12

### Added

- **`guard`** — repo-scoped pre-push checks: orphaned worktree registrations, staged
  agent artifacts, and likely secrets in changed files. Errors block the push; `--strict`
  fails on warnings too.
- **`install --apply`** now actually registers the schedule (`launchctl` / `systemctl
  --user` / `schtasks`), and `install --hook --apply` writes `.git/hooks/pre-push`.
- **Drivers for Gemini CLI and opencode**; the `cursor` driver is now per-file.
- Worktree parsing reports `prunable` registrations.

## [0.1.0] - 2026-10-12

First public release.

### Added

- **`scan`** — read-only survey that sizes every store and prints a machine receipt
  (text or `--json`), with a content-based secret scan over transcripts.
- **Drivers** for Claude Code, Codex CLI, Cursor, and agent-created git worktrees. The
  engine holds no agent-specific logic; adding an agent is one file.
- **Classification** into `regenerable` / `reclaimable` / `stateful`, plus a secret
  detector for AWS, Anthropic, OpenAI, GitHub, Google, Slack, Stripe, private keys and JWTs.
- **`clean`** — archive-before-delete to a restorable `tar.gz`, with a 30-day retention
  gate (`--days`), `--prune` for regenerable caches, `--keep` to protect paths, and
  `--max-deletes`.
- **`restore`** — `--list`, `latest`, a manifest path, or a session/project **query**;
  selective restore with manifest compaction.
- **Safety invariants enforced in code**: read-only scan, retention gate, archive-first,
  prune allowlist, lock/grace-window guards, per-item failure isolation, `0600` archives,
  and path-traversal refusal on extract.
- **Recurring surfaces**: shell-prompt segment, `watch` (launchd / systemd / Task
  Scheduler), and `install`.
- **Zero runtime dependencies** — hand-rolled `tar.gz` writer/reader and secret scanner.

[0.2.0]: https://github.com/auliamnaufal/agent-janitor/releases/tag/v0.2.0
[0.1.0]: https://github.com/auliamnaufal/agent-janitor/releases/tag/v0.1.0
