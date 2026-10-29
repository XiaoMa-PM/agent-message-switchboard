# Agent Message Switchboard

Let AI coding agent sessions on your Mac message each other across harnesses: DSH desktop, Claude Code and Codex.

A Claude Code session can ask a Codex session a question, a DSH session can answer one, and every reply goes back to the exact session that asked. Sessions inside the same harness keep using that harness's own features; Switchboard only carries messages between different harnesses.

- `ms` is the command-line client: install, uninstall, status and settings.
- `msd` is a small background daemon (a per-user LaunchAgent) that routes letters between sessions.
- Each harness gets one plugin, visible in that harness's own plugin manager.

A letter from another session is information, not your permission: it cannot approve anything on your behalf.

## Supported

Accepted on macOS 26.

Officially supported:

- macOS on Apple Silicon.
- Claude Code CLI 2.1.309 or later (tested on 2.1.309 to 2.1.311), Claude desktop app local sessions (including the CLI in the app's terminal panel), and Claude Code agent view and `/bg` background sessions (see [Known limitations](#known-limitations)).
- DSH desktop 0.2.0-rc.2 or later (tested on 0.2.1-rc.2 and 0.2.1-rc.3).
- Codex CLI 0.164.0 or later (tested on 0.164.0).

Experimental:

- Codex in the ChatGPT desktop app (local sessions).

Not supported: Intel Macs, ChatGPT desktop Local Work threads, DSH Web, and messaging between different computers.

## Requirements

- A Mac with Apple Silicon. On any other platform `ms install` stops with `MS_PLATFORM_UNSUPPORTED`.
- Node.js 24, version 24.16.0 or a later 24.x. Other versions stop with `MS_NODE_UNSUPPORTED`. msd runs on a copy of this Node taken at install time, so switching Node versions later (nvm, fnm, Homebrew) does not affect it.
- Python 3.13.14 or later, first on `PATH` as `python3`. The Claude Code hooks and the identity checks run on it. It must belong to you or root and must not be Developer ID signed:
  - Homebrew's `python@3.13` works in the account that installed Homebrew. Other accounts on the same Mac cannot use it, because it belongs to that account; `ms install` refuses it with `UNSUPPORTED_PYTHON_OWNER`. Install a Python for the account instead, for example with uv, put `~/.local/bin` first on `PATH`, then open a new terminal and check that `python3 --version` is 3.13.14 or later:

    ```bash
    curl -LsSf https://astral.sh/uv/install.sh | sh
    ~/.local/bin/uv python install 3.13 --default --preview
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
    ```

  - A Developer ID signed Python, such as the python.org installer, is refused with `UNSUPPORTED_PYTHON_SIGNATURE`.
- A macOS user name of at most 19 bytes in UTF-8 (a CJK character counts as 3). macOS limits a Unix socket path to 103 bytes, and the longest socket path Switchboard binds is 84 bytes plus your user name. A longer name stops with `MS_SOCKET_PATH_TOO_LONG`.
- The harnesses you want to connect, installed and started at least once: `claude` on `PATH` for Claude Code, an existing `~/.codex/config.toml` for Codex, and DSH desktop.

## Install

```bash
npm i -g agent-message-switchboard   # puts ms on PATH; writes no harness configuration and runs no install scripts
ms install --dry-run                 # lists every planned write; writes nothing
ms install
ms daemon start
```

`ms install` copies the package's runtime files to a private directory under the system temporary directory, runs the installer from there and deletes it afterwards. It then:

1. installs the core: the private root `~/Library/Application Support/agent-message-switchboard/`, a pinned bundle with a copy of your Node, the msd LaunchAgent, and a fallback launcher at `<private root>/bin/ms` that is not on `PATH`;
2. installs the DSH, Claude Code and Codex plugins, one result line each.

```text
ms installed: ~/Library/Application Support/agent-message-switchboard/bundles/<digest>
records: <n>
dsh: installed (restart DSH once so it loads agent-message-switchboard-dsh)
claude-code: installed (new Claude sessions load it; open sessions need /reload-plugins)
codex: installed (start a new Codex session and trust all six ms hooks in /hooks; until UserPromptSubmit, PreToolUse and PermissionRequest are trusted, act letters are handled as direct, and an untrusted Stop or Interrupt only means no no-reply receipts)
next: ms daemon start
```

- When a harness's preconditions are not met, only that harness is skipped. Its line says why and points to the manual steps in the user guide; the exit code stays 0. Fix the cause, then run `ms install --harness dsh` (or `claude-code`, `codex`).
- When the core cannot be installed, or a write fails, everything is rolled back and the exit code is 5.

What each harness needs after installing:

- **DSH**: restart DSH once. It loads the plugin only after a restart.
- **Claude Code**: new sessions load the plugin `ms@ms-local`. In sessions that are already open, run `/reload-plugins`. Desktop app local sessions load it too, without restarting the app.
- **Codex**: start a new Codex session, open `/hooks` and trust all six ms hooks: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, Stop and Interrupt. Until UserPromptSubmit, PreToolUse and PermissionRequest are all trusted, act letters are handled as direct.

## Quick start

1. **Register** each session that should be reachable. Registration is manual by default.

   | Harness | Register | Unregister | Auto-register |
   |---|---|---|---|
   | Claude Code | `/ms:register` | `/ms:unregister` | `/ms:auto on\|off\|status` |
   | DSH | `/ms-register` | `/ms-unregister` | `/ms-auto on\|off\|status` |
   | Codex | `$ms-register` | `$ms-unregister` | `$ms-auto on\|off\|status` |

   These commands are handled locally and never sent to the model. In Claude Code, type the colon: `/ms-register` is not a Claude command. In Codex the whole input must be exactly the command; Codex then shows "Blocked by hook" with the result, which means the command ran without reaching the model.

2. **Send.** Ask your model in plain words, for example: "Send the DSH session that reviews the API a note: the schema changed, please re-check." The model looks the target up in the address book first. When nothing matches, or several sessions match, it lists the candidates and asks you instead of guessing.

3. **Reply.** A letter arrives with a header naming the sending harness and session. To answer it, tell your model "reply to them": the reply goes back to the original letter's sender. Answering in your own session without replying does not reach them.

4. **Check** with `ms sessions` (the address book) and `ms status` (a summary of msd).

Good to know:

- "Written" or "queued" means delivered to the receiving session, not read.
- A letter to an offline session is not queued for later; the send fails with `TARGET_OFFLINE`.
- `ms alias <harness> <sessionId> <name>` gives a session a stable name that is easy to address.
- In this release the CLI output is in English, while letter headers, in-session command replies, the status page and the [user guide](docs/user-guide.md) are in Chinese.

## Reply modes

Each harness has a reply mode that decides what its model does with incoming letters. All three start as `direct`.

| Mode | Behaviour |
|---|---|
| `direct` | Answers questions, and letters that ask for a reply, right away, using only what the conversation already contains. |
| `confirm` | Asks you before replying. |
| `act` | May carry out what the letter asks, within the receiving session's permissions, gated by the risk rules below. |

In `direct` and `confirm` the model only answers. When a letter asks it to do something (edit files, run commands, register sessions and so on), it does not do it and does not promise to; it tells you what the letter asks and lets you decide.

Change a mode in a session with `/ms:reply` (Claude Code), `/ms-reply` (DSH) or `$ms-reply` (Codex), each followed by `direct`, `confirm`, `act` or `status`. Each of these switches only its own harness. From a terminal:

```bash
ms config set reply-mode --harness dsh confirm        # without --harness, all three
ms config set act-preset --harness claude-code read-only
ms config get
```

### act: the risk model

In an act letter's turn, every tool call is classified by fixed rules, not by the model:

| Tier | Meaning | Examples |
|---|---|---|
| L0 read-only | Reads that stay on this Mac | Reading ordinary files in the workspace, `ls`, `cat`, `git status`, file-name-only search such as `grep -rl` |
| L1 workspace write | Creating or changing files inside the workspace | Editing code, `printf 'hello' > note.txt` |
| L2 execute or network | Other commands, network reads, reading non-secret files outside the workspace, skills, MCP tools, unknown tools | Running tests, fetching a web page |
| L3 dangerous | Changing permissions, configuration or project instruction files; reading secrets or credentials; deleting outside the workspace; sending data out; commands that cannot be parsed; recursive searches that print matching content | `git push`, reading `~/.ssh`, `sudo`, `grep -r token .` |

The workspace is the receiving session's project root. A call that does several things counts at its highest tier. A preset, set per receiving harness, decides L0 to L2:

| Preset | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| `read-only` | allow | ask | ask | refuse |
| `workspace-write` (default) | allow | allow | ask | refuse |
| `full-access` | allow | allow | allow | refuse |

- **Always refused**, whatever the mode or preset: L3, sending to a third session, spawning sub-agents, and starting background work that would outlive the turn (background commands, `&`, `nohup`, `launchctl` jobs and the like).
- **Only tightens.** "Allow" means Switchboard adds no approval of its own; the host's permission prompts and sandbox still apply. Switchboard never loosens a harness's permissions.
- **Ask** uses the host's own approval prompt, which names the sending harness and session. Codex hooks cannot prompt, so in Codex a call that needs approval is refused instead, and the model asks you to start that step yourself.
- When a call is refused or you decline it, the model does not retry it another way and does not hand it to another session. The one exception is a refusal reason that itself names a safer alternative. The model then tells the sender what happened.
- When the receiving session cannot prompt at all, act letters are handled as `direct`: Claude Code in dontAsk or bypassPermissions mode, DSH with the Full access or ptc preset, Codex with `approval_policy = "never"`, or Codex before the hooks are trusted.
- **No-reply receipts.** If the receiving turn of an act letter ends without a reply, msd sends the sender a short receipt that starts with "Switchboard 回执" and gives the likely reason. A real reply can still follow.

Known limits of act:

- The tiers are rules on the command text. They are not a security boundary; the harness's sandbox and permissions remain the boundary.
- Codex: when an ms hook fails, the call is allowed, and while the ms MCP process is disconnected act letters get only Codex's own approval and sandbox. Codex's hosted web search does not pass through the hooks.
- Claude Code: after you press Esc in a letter's turn, your own next turn is still gated as a letter turn until a turn ends normally. This only errs on the strict side.
- The full list, per harness, is in the user guide.

## Privacy

**Stored on this Mac.** Everything lives under the private root, `~/Library/Application Support/agent-message-switchboard/`, in a directory only your user can read (0700, files 0600):

- `state/directory.json`, the address book and links. For each registered session: harness, session id, surface (CLI or desktop), title, working directory, project root, alias and timestamps. While a Claude Code session is online, also the identity msd verified for it: the process id, the executable's path and SHA-256, its code signature, and the messaging socket's path, inode and permissions.
- `state/messages.jsonl`, one metadata line per letter: message and link ids, sender, recipient, time, delivery state, size, and a SHA-256 of the body. **Message bodies are never written to disk.** These records are kept until you uninstall.
- `config.json`, your settings and the pinned Python interpreter (path and SHA-256).
- `run/`, the sockets, the act letter-turn markers (session ids only) and the DSH plugin's status file.
- `logs/`, msd's output. msd writes there only when something fails, for example a failure code when it cannot start.
- `install/`, the install ledger and byte-exact backups of the harness files that `ms install` changed (Claude Code settings and plugin registries, Codex `config.toml`, the DSH profile's `package.json` and `pnpm-lock.yaml`), used to restore them on uninstall.
- `bundles/`, `claude-marketplace/`, `codex-marketplace/` and `bin/ms`, the installed program files.

Outside the private root, `ms install` writes the LaunchAgent plist and registers the plugins with each harness; `ms install --dry-run` lists every such write.

**What reaches model providers.** Switchboard never calls a model itself, but harness sessions do:

- A letter's header and body become part of the receiving session's model context, so they are sent to whatever model provider that harness uses.
- When a model looks up the address book, the other registered sessions' titles, aliases, session ids and absolute working directories are returned to that model.
- No-reply receipts and act refusal reasons, which name the sending session, also enter the model context.

**No telemetry.** Switchboard reports nothing. `ms`, msd and the plugins make no network requests of their own: they talk over Unix sockets inside the private root, and `ms ui` listens on 127.0.0.1 only. The host tools that `ms install` and `ms uninstall` run to add and remove the plugins (the `claude` and `codex` command-line tools and DSH's bundled `pnpm`) behave as they normally do.

## Status page

```bash
ms ui
```

`ms ui` opens a read-only page in your default browser. It shows whether msd is running, whether each harness is installed and connected, which sessions are online, and the links and the latest 20 messages (without bodies). The page refreshes every 3 seconds.

- The terminal prints the address, `http://127.0.0.1:<port>/ms-ui/?code=<one-time code>`. The port changes on every run. The code works once and becomes a sign-in that lasts until `ms ui` stops; reloading, restoring the tab or opening a new tab in the same browser keeps working.
- The page cannot change anything. Use `ms config set …` or the in-session commands instead.
- Press Ctrl+C in that terminal to stop it.

## Uninstall

```bash
ms uninstall --dry-run
ms uninstall
npm uninstall -g agent-message-switchboard
```

- `ms uninstall` reverts exactly what the install ledger recorded. Harness files that have not changed since the install are restored byte for byte. Files you or the harness changed since then only lose Switchboard's own entries.
- `--keep-data` keeps `state/` (address book, links and message records) and `config.json` (your settings). The next `ms install` reuses those settings when the kept `config.json` has the same schema version and passes the new version's checks; otherwise they return to their defaults and the result lists each one.
- `ms uninstall --harness <name>` removes a single harness plugin and keeps the rest.
- Restart DSH afterwards so it unloads the plugin.
- If you removed the npm package first, uninstall with the fallback launcher. The path contains a space, so keep the quotes:

  ```bash
  "$HOME/Library/Application Support/agent-message-switchboard/bin/ms" uninstall
  ```

- If neither works, the [user guide](docs/user-guide.md#manual-cleanup) lists every place to clean up by hand, each with a command to look before you delete.

## Upgrade

```bash
npm i -g agent-message-switchboard@latest   # puts the new ms on PATH
ms upgrade --dry-run                        # preflight and plan; stops nothing, writes nothing
ms upgrade
```

`ms upgrade` stages the new version like `ms install`, then in one command:

1. checks the new version the way `ms install` does, and that the installed version can run its own `ms` (any failure stops with `MS_UPGRADE_PRECONDITION_FAILED` and leaves the installed version untouched);
2. stops msd;
3. has the installed version uninstall itself with `--keep-data`, keeping `state/` and `config.json`;
4. installs the new version, reusing the address book, records and settings;
5. starts msd;
6. lists what each harness needs next.

- Settings carry over when the kept `config.json` has the same schema version and passes the new version's checks. Otherwise they return to their defaults, and the result says why and lists each default.
- Upgrading to the same version reinstalls it; an older version is a downgrade. Without an installed version, `ms upgrade` stops with `NOT_INSTALLED`; use `ms install`.
- When a step fails, the error code says where: `MS_UPGRADE_UNINSTALL_FAILED`, `MS_UPGRADE_INSTALL_FAILED` or `MS_UPGRADE_START_FAILED`. The user guide says how to finish by hand in each case.

Afterwards, as listed under `next:`: restart DSH; run `/reload-plugins` in open Claude Code sessions; and in a new Codex session trust all six ms hooks again in `/hooks`, because their content changes with every version.

## Known limitations

- Codex in the ChatGPT desktop app is experimental.
- Claude Code agent view: ← and `/bg` copy the conversation into a new background session with a new session id. Run `/ms:register` again in the background session. After ←, the original `claude` keeps running and the old id stays online until it exits; letters sent to the old id are written but never show up anywhere, so ask senders to use the new id.
- The macOS user name must be at most 19 bytes (see [Requirements](#requirements)). There is no workaround except a user account with a shorter name.
- Letters to an offline session are not queued for later delivery.
- In Claude Code, the `/ms:` commands are recognised from any submitted prompt that is exactly the command, including prompts written by other programs running as your user. This affects only registration and auto-registration on your own Mac.

## Documentation

- [User guide](docs/user-guide.md) (Chinese): manual installation per harness, every command, the full act rules and limitations, error codes.
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)

## Acknowledgements

Thanks to [GengDaPeng/dsh-agent-message](https://github.com/GengDaPeng/dsh-agent-message), the earlier DSH messaging work this project built on.

## License

[MIT](LICENSE)
