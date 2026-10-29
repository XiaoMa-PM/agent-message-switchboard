# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-29

First release.

### Added

- Messaging between DSH desktop, Claude Code and Codex sessions on one Mac, through the background daemon `msd` and one plugin per harness. Replies go back to the session that sent the letter.
- `ms` command line, installed with `npm i -g agent-message-switchboard`:
  - `ms install` (with `--dry-run` and `--harness`) and `ms uninstall` (with `--dry-run`, `--keep-data` and `--harness`), which revert exactly what the install recorded; `--keep-data` keeps the address book, the message records and the settings;
  - `ms upgrade` (with `--dry-run`), which replaces the installed version in one command and keeps the address book, records and settings;
  - `ms daemon start|stop|status`;
  - `ms status`, `ms sessions`, `ms projects`, `ms links`, `ms messages`, `ms alias` and `ms config get|set`;
  - `ms repin`, to re-pin the Python interpreter after it is updated.
- Session registration in each harness (`/ms:register`, `/ms-register`, `$ms-register`), with optional auto-registration, optionally limited to listed projects.
- An address book of registered sessions (harness, title, alias, project, online state) that models use to find a target, asking you when the choice is ambiguous.
- Reply modes per harness: `direct`, `confirm` and `act`. In `act`, a fixed L0–L3 risk tiering with the `read-only`, `workspace-write` and `full-access` presets gates every tool call in a letter's turn. L3, sending to a third session, spawning sub-agents and starting lasting background work are always refused, and harness permissions are never loosened.
- No-reply receipts: when the receiving turn of an `act` letter ends without a reply, the sender gets a short receipt with the likely reason.
- `ms ui`, a read-only status page on 127.0.0.1 with a one-time sign-in code.
- A per-link push budget, which pauses a link that sends too many letters in a short time until you run `ms links resume <linkId>`.

### Supported

- Officially supported: macOS on Apple Silicon (accepted on macOS 26); Claude Code CLI 2.1.309 or later (tested on 2.1.309 to 2.1.311), Claude desktop app local sessions, and agent view and `/bg` background sessions; DSH desktop 0.2.0-rc.2 or later (tested on 0.2.1-rc.2 and 0.2.1-rc.3); Codex CLI 0.164.0 or later (tested on 0.164.0).
- Experimental: Codex in the ChatGPT desktop app.
- Not supported: Intel Macs, ChatGPT desktop Local Work threads, DSH Web, and messaging between computers.
- Requires Node.js 24.16.0 or a later 24.x, and Python 3.13.14 or later owned by you or root, such as Homebrew's `python@3.13` in the account that installed Homebrew. Another account on the same Mac installs its own, for example with uv.

### Known limitations

- The macOS user name must be at most 19 bytes, because of the Unix socket path limit.
- Claude Code agent view: ← and `/bg` fork the conversation into a new session id, so the background session has to register again.
- Letters to an offline session are not queued.
- Settings carry over an upgrade or a `--keep-data` reinstall only when the kept settings file has the same schema version and passes the new version's checks; otherwise they return to their defaults, and the result lists each one.
- Letter headers, in-session replies, the status page and the user guide are in Chinese.
