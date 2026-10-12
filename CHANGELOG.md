# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-10-12

### Fixed

- **Manifest is atomic and written before deletion** — the undo record is now
  written (temp file + rename) *before* any original is removed, so a crash,
  Ctrl-C, or disk-full mid-delete can no longer leave removed data without a
  restorable pointer. The manifest is rewritten with the actual outcome after
  deletion; when nothing was really removed, the intent record and tarball are
  dropped instead of left as residue.
- **The scan→confirm→act race is closed** — the pre-mutation guard re-stats the
  file from disk and compares against the act-time clock, so a session that kept
  writing while the user sat at the confirm prompt is denied by the grace window
  instead of being archived mid-write. Vanished files are skipped ("no longer
  exists") instead of being removed as a no-op.
- **The archive-first invariant has no holes** — a file that vanishes between
  plan and archive fails the run instead of silently producing an incomplete
  backup; the tarball is deleted on any archive failure; the writer opens each
  file once, stats the handle, caps reads at that size, and verifies the byte
  count, so a transcript growing mid-archive can no longer corrupt the headers.
- **`restore` on a missing/unreadable tarball now fails fast** instead of
  hanging forever; disk-full/EPERM on the archive output stream surfaces as a
  normal error instead of an unhandled `'error'` crash.
- Staging directories are cleaned up even when restore throws; a failed worktree
  overlay recovers the data from `.agent-janitor-aside`.
- A failed driver now prints `! <id>: scan failed — <error>` in the receipt
  (including when nothing else was found) instead of masquerading as a clean
  machine; a typo in `--only` errors loudly with the available driver list.
- `readManifest` rejects malformed entries instead of crashing `matchArchived`;
  `--at` validates HH:MM ranges instead of writing an invalid plist.
- Archive/manifest stamps include PID + a monotonic counter, so concurrent
  `clean` runs can no longer clobber each other's tarball.
- Symlinks now survive the archive→restore round trip; files >8 GiB fail with a
  clear message instead of silently corrupting the ustar size field; restore
  preserves file modes.

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

[0.2.1]: https://github.com/auliamnaufal/agent-janitor/releases/tag/v0.2.1
[0.2.0]: https://github.com/auliamnaufal/agent-janitor/releases/tag/v0.2.0
[0.1.0]: https://github.com/auliamnaufal/agent-janitor/releases/tag/v0.1.0
