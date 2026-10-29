# Agent Message Switchboard

English | [中文](https://github.com/XiaoMa-PM/agent-message-switchboard/blob/main/README.zh-CN.md)

![Claude Code, Codex and DSH connected through the Switchboard hub](https://raw.githubusercontent.com/XiaoMa-PM/agent-message-switchboard/main/docs/assets/hero-en.png)

Let AI coding agent sessions on your Mac message each other across harnesses: Claude Code, Codex and DSH desktop. A Claude Code session can ask a DSH session to check something, and the answer comes back to the exact session that asked.

![Sessions register on the msd board by project; a Claude Code session asks a DSH session to check some error codes, and the reply comes back](https://raw.githubusercontent.com/XiaoMa-PM/agent-message-switchboard/main/docs/assets/demo-en.gif)

- `ms` is the command-line client; `msd` is a small per-user background daemon that routes letters between sessions.
- Each harness gets one plugin. Sessions inside the same harness keep using that harness's own features.
- A letter from another session is information, not your permission: it cannot approve anything on your behalf.

## Supported

- macOS on Apple Silicon.
- Claude Code CLI 2.1.309 or later, including Claude desktop app local sessions, agent view and `/bg` sessions.
- DSH desktop 0.2.0-rc.2 or later.
- Codex CLI 0.164.0 or later. Codex in the ChatGPT desktop app is experimental.

## Requirements

- Node.js 24.16.0 or a later 24.x.
- Python 3.13.14 or later, first on `PATH` as `python3`, owned by you or root and not Developer ID signed. Homebrew's `python@3.13` works in the account that installed Homebrew; other accounts install their own, for example with uv ([how](docs/user-guide.md#前提)).
- A macOS user name of at most 19 bytes (a CJK character counts as 3).
- The harnesses you want to connect, installed and started at least once.

## Install

```bash
npm i -g agent-message-switchboard
ms install --dry-run   # lists every planned write; writes nothing
ms install
ms daemon start
```

Then restart DSH once, run `/reload-plugins` in Claude Code sessions that are already open, and in a new Codex session trust the six ms hooks in `/hooks`. `ms install` prints these steps for each harness it installed.

## Quick start

1. **Register** each session that should be reachable:

   | Harness | Register | Unregister |
   |---|---|---|
   | Claude Code | `/ms:register` | `/ms:unregister` |
   | DSH | `/ms-register` | `/ms-unregister` |
   | Codex | `$ms-register` | `$ms-unregister` |

2. **Send.** Ask your model in plain words, for example: "Send the DSH session that reviews the API a note: the schema changed, please re-check." When several sessions match, it asks you instead of guessing.
3. **Reply.** A letter arrives with a header naming the sending harness and session. Tell your model "reply to them" and the answer goes back to the original sender.
4. **Check** with `ms sessions` (the address book), `ms status`, or `ms ui` (a read-only status page).

## Reply modes

Each harness has a reply mode for incoming letters. All three start as `direct`.

| Mode | What the model does |
|---|---|
| `direct` | Answers right away from what the conversation already contains. It does not act on requests. |
| `confirm` | Asks you before replying. |
| `act` | May carry out the request within the session's own permissions. Every tool call is classified by fixed rules: dangerous ones are always refused, the rest follow a preset you choose. |

Switch with `/ms:reply`, `/ms-reply` or `$ms-reply` in a session, or `ms config set reply-mode`. Switchboard only ever tightens a harness's permissions. The full act rules are in the [user guide](docs/user-guide.md#act-档请收件会话动手).

## Privacy

- Everything stays on this Mac, in `~/Library/Application Support/agent-message-switchboard/` (readable only by you). Message bodies are never written to disk; only metadata is.
- No telemetry: `ms`, msd and the plugins make no network requests of their own.
- A letter becomes part of the receiving session's context, so it reaches that harness's model provider.

Details: [user guide, privacy](docs/user-guide.md#8-隐私).

## Upgrade and uninstall

```bash
npm i -g agent-message-switchboard@latest && ms upgrade   # keeps the address book and settings
ms uninstall && npm uninstall -g agent-message-switchboard
```

`ms uninstall` restores the harness files it changed byte for byte when nobody has changed them since. See the user guide for [upgrading](docs/user-guide.md#升级), [uninstalling](docs/user-guide.md#7-卸载) and [manual cleanup](docs/user-guide.md#manual-cleanup).

## Known limitations

- Letters to an offline session are not queued for later.
- After ← or `/bg` in Claude Code agent view, run `/ms:register` again in the new background session.
- In this release, letter headers, in-session replies, the status page and the user guide are in Chinese; the CLI output is in English.

## Documentation

- [User guide](docs/user-guide.md) (Chinese): manual installation, every command, the act rules, error codes.
- [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md)

Thanks to [GengDaPeng/dsh-agent-message](https://github.com/GengDaPeng/dsh-agent-message), the earlier DSH messaging work this project built on.

[MIT](LICENSE)
