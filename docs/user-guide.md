# Agent Message Switchboard 用户指南

Agent Message Switchboard 是本机上的跨 Harness 中转站，让 DSH 桌面、Claude Code 和 Codex 的会话互相发消息。

- `ms` 是命令行客户端，负责安装、卸载和管理。
- 后台常驻进程 msd 负责路由。
- 三个 Harness 各装一个插件，在各自的插件管理页里能看到、能停用。

同一个 Harness 里的会话之间，用该 Harness 自己的能力联系，不经过 Switchboard。

来信是对方会话发来的信息，不代表你的授权，不能用来批准任何操作。

## 1. 安装

### 支持范围

全部在 macOS 26 上验收。版本只设最低要求，「实测」是真正验收过的版本。

| 入口 | 状态 | 版本 |
|---|---|---|
| macOS，Apple Silicon（arm64） | 正式支持 | 在 macOS 26 上验收，更低的系统版本没有测过 |
| Claude Code CLI | 正式支持 | 2.1.309 或更高，实测 2.1.309 到 2.1.311 |
| Claude 桌面 App 的本地会话（含 App 终端面板里的 CLI） | 正式支持 | 实测 3.1623.1、3.6556.2 |
| Claude Code 的 agent view、`/bg` 后台会话 | 正式支持，有已知限制（见第 3 节） | 同 Claude Code CLI |
| DSH 桌面 | 正式支持 | 0.2.0-rc.2 或更高，实测 0.2.1-rc.2、0.2.1-rc.3 |
| Codex CLI | 正式支持 | 0.164.0 或更高，实测 0.164.0 |
| Codex 桌面（ChatGPT App 的本地会话） | 实验 | 桌面命令与回归测过，没有像 CLI 那样完整验收 |
| Intel Mac（x64） | 不支持 | 没有测过，`ms install` 报 `MS_PLATFORM_UNSUPPORTED` |
| ChatGPT 桌面的 Local Work 线程 | 不支持 | ms 的工具报 `UNSUPPORTED_CODEX_REMOTE_ENVIRONMENT`；请改用 Codex 标签页的本地线程或 Codex CLI |
| DSH Web、跨电脑通信 | 不支持 | — |

### 前提

- Apple Silicon 的 Mac。
- Node 24：24.16.0 或更高的 24.x。
- Python：3.13.14 或更高，作为 `python3` 排在 PATH 前面。Claude 的 hook 和身份核验要用它。它必须归你或 root 所有，并且不能带 Developer ID 签名：
  - Homebrew 的 `python@3.13` 在装 Homebrew 的那个账户里可以直接用。同一台 Mac 的其他账户用不了，因为它归装 Homebrew 的账户所有，`ms install` 会报 `UNSUPPORTED_PYTHON_OWNER`。请给这个账户单独装一个，例如用 uv，并把 `~/.local/bin` 排到 PATH 最前面；然后新开一个终端，确认 `python3 --version` 是 3.13.14 或更高：

    ```bash
    curl -LsSf https://astral.sh/uv/install.sh | sh
    ~/.local/bin/uv python install 3.13 --default --preview
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
    ```

  - python.org 安装器装的 Python 带 Developer ID 签名，会被拒绝，报 `UNSUPPORTED_PYTHON_SIGNATURE`。
- macOS 用户名不超过 19 个字节（见本节末尾的已知限制）。
- 要接入的 Harness 已经装好、至少运行过一次：Claude Code 要 PATH 上有 `claude`，Codex 要已有 `~/.codex/config.toml`，DSH 桌面装在「应用程序」里。

### 安装步骤

```bash
npm i -g agent-message-switchboard   # 只把 ms 命令放上 PATH，不写任何宿主配置，也不运行安装脚本
ms install --dry-run                 # 先看计划，不写任何东西
ms install
ms daemon start
```

- `ms install` 和 `ms install --dry-run` 会先把 npm 包里的运行文件复制到系统临时目录下一个只有你能读写的目录，从那里运行安装，结束后删掉。这是因为 Node 不能直接运行 node_modules 里的 TypeScript；这个临时目录不在你的主目录下，dry-run 不会在主目录里写任何东西。
- 这一版只支持 Apple Silicon 的 macOS。在其他平台上，`ms install` 和 `ms upgrade` 报 `MS_PLATFORM_UNSUPPORTED`。
- `ms install` 和 `ms upgrade` 只接受 Node 24（24.16 或之后的 24.x），其他版本报 `MS_NODE_UNSUPPORTED`，换成 Node 24 LTS 后重跑。装好后 msd 用的是安装时这份 Node 的副本，之后用 nvm 等切换 Node 版本，不影响 msd。
- 装好之后，`ms` 的其他命令都交给已安装的那一版执行。npm 包的版本与已安装的不同时，会先提示一行，提醒用 `ms upgrade` 换成 npm 包的版本（见下文「升级」）。

`ms install` 先装核心（私有根、pin 过的 bundle、msd 的 LaunchAgent，以及私有根里不在 PATH 上的兜底入口 `bin/ms`），再依次装 DSH、Claude Code、Codex 三家插件，每家一行结果：

```text
ms installed: ~/Library/Application Support/agent-message-switchboard/bundles/<16 位摘要>
records: 9
dsh: installed (restart DSH once so it loads agent-message-switchboard-dsh)
claude-code: installed (new Claude sessions load it; open sessions need /reload-plugins)
codex: installed (start a new Codex session and trust all six ms hooks in /hooks; until UserPromptSubmit, PreToolUse and PermissionRequest are trusted, act letters are handled as direct, and an untrusted Stop or Interrupt only means no no-reply receipts)
next: ms daemon start
```

- 某一家前置条件不满足时，只跳过这一家，其他照装，退出码仍为 0。跳过的那一行写明原因和手动安装的小节，DSH 还附上插件目录：

  ```text
  dsh: skipped (~/.dsh/profiles/desktop/cordis.patch.yml still names ms-dsh-client (for example the plugin page's on/off switch row); remove that entry, then install); manual install: docs/user-guide.md#manual-dsh, plugin directory ~/Library/Application Support/agent-message-switchboard/bundles/<16 位摘要>/plugins/ms-dsh
  codex: skipped (~/.codex/config.toml not found); manual install: docs/user-guide.md#manual-codex
  ```

  按原因处理后，用 `ms install --harness <h>` 补装这一家；也可以按第 2 节手动安装。
- 核心装不上（例如 msd 的 LaunchAgent plist 已存在），或某一家前置都满足、写入时出错：整体回滚，退出码 5，什么都不留。
- 装完运行 `ms daemon start` 启动 msd。
- DSH：首次安装和每次升级后，都要**重启一次 DSH**，插件才会加载（DSH 检测不到只改 `package.json` 的变化）。
- Claude Code：ms 在私有根生成本地 marketplace `claude-marketplace`，再用官方命令 `claude plugin marketplace add` 和 `claude plugin install ms@ms-local` 装成用户范围的插件 `ms@ms-local`。新开的会话自动加载，已经开着的会话输入 `/reload-plugins`；桌面 App 的本地会话也会加载，不用重启 App。需要 PATH 上有 `claude`。
- Codex：ms 在私有根生成本地 marketplace `codex-marketplace`，用 `codex plugin marketplace add` 和 `codex plugin add ms@ms-local` 装成插件（PATH 上没有 codex 时用 ChatGPT 桌面内置的那个），再追加 send/reply 两张免审批子表。装好后新开一个 Codex 会话，在 `/hooks` 里信任 ms 的全部六个 hook（SessionStart、UserPromptSubmit，act 档用的 PreToolUse、PermissionRequest，以及只用于未回信回执的 Stop、Interrupt）。升级后 hook 的内容会变，要重新信任一次；UserPromptSubmit、PreToolUse、PermissionRequest 没全部信任之前，act 档的来信会自动按 direct 处理。

### 只装或重装某一家

```bash
ms install --harness dsh            # 或 claude-code、codex
ms install --harness dsh --dry-run
```

- 前提是 `ms install` 已经装好核心，否则报 `NOT_INSTALLED`（退出码 5）。
- 这一家已经装过时就是重装：先按账本撤销这一家，再装。
- 前置条件不满足时报 `INSTALL_PRECONDITION_FAILED`（退出码 5），并给出手动安装的小节；写入时出错只回滚这一家，核心和其他两家不受影响。

```text
$ ms install --harness dsh
ms installed dsh
dsh: installed (restart DSH once so it loads agent-message-switchboard-dsh)

$ ms install --harness dsh --dry-run      # 已经装过时
ms install plan for dsh (dry run, nothing written):
  reinstall: first revert
    remove agent-message-switchboard-dsh from DSH profile ~/.dsh/profiles/desktop (exact restore, else DSH pnpm remove) and its plugin-page switch row
  then install dsh again (planned after the revert)
```

私有根在 `~/Library/Application Support/agent-message-switchboard/`，下文简称“私有根”。

- 已知限制：用户名太长时装不上。macOS 规定 Unix socket 的路径最多 103 个字节，私有根里最长的一个是 `~/Library/Application Support/agent-message-switchboard/run/broker/broker.sock`，展开 `~` 后是 84 个字节加用户名的长度，所以用户名超过 19 个字节（按 UTF-8 计，一个汉字算 3 个字节）就会超限。`ms install` 和 `ms install --dry-run` 会先检查，超限时报 `MS_SOCKET_PATH_TOO_LONG` 并写明是哪个路径、多长；msd 启动时也会同样检查。目前没有绕过的办法，只能换一个用户名短一些的 macOS 账户。

### 升级

```bash
npm i -g agent-message-switchboard@latest   # 先把新版本的 ms 装上 PATH
ms upgrade --dry-run                        # 先看计划：预检结果、设置能否沿用、每一步做什么；不停 msd，不写任何东西
ms upgrade
```

`ms upgrade` 和 `ms install` 一样，先把新版本复制到系统临时目录里运行，用完删掉。然后在一条命令里依次：

1. 预检：按 `ms install` 的规则检查新版本（平台、Node、socket 路径、Python、包是否完整），再确认已安装的那一版能运行它自己的 `ms`、`私有根/config.json` 是普通文件。任何一项不过，都报 `MS_UPGRADE_PRECONDITION_FAILED`，已安装的版本一点不动。
2. 停 msd。
3. 由已安装的那一版自己卸载：`ms uninstall --keep-data`，保留 `私有根/state` 和 `私有根/config.json`。
4. 装新版本，沿用保留下来的通讯录、记录和设置。
5. 启动 msd。
6. 列出各家要做的事。

输出示例（节选）：

```text
ms upgrade: 1.0.0 → 1.0.1
stop msd: msd stopped
uninstall 1.0.0 with its own CLI (ms uninstall --keep-data):
  ms uninstalled
  ok agent-message-switchboard-dsh: removed with DSH pnpm; ...
  removed ~/Library/Application Support/agent-message-switchboard except state/ and config.json
  restart DSH so it unloads agent-message-switchboard-dsh
install 1.0.1:
  ms installed: ~/Library/Application Support/agent-message-switchboard/bundles/<16 位摘要>
  records: 9
  settings kept from the previous config.json: autoRegister, autoRegisterProjects, replyMode, actPreset, linkBudget (Python pin re-detected)
  dsh: installed (restart DSH once so it loads agent-message-switchboard-dsh)
  ...
start msd:
  msd 1.0.1 started
  launchd: loaded, state running, pid 12345
ms upgraded 1.0.0 → 1.0.1
next:
  DSH: restart DSH once so it loads the new plugin
  Claude Code: in Claude sessions that are already open, run /reload-plugins
  Codex: start a new Codex session and trust all six ms hooks again in /hooks; until UserPromptSubmit, PreToolUse and PermissionRequest are trusted, act letters are handled as direct
```

- `next:` 下面只列新版本实际装上的那几家。
- `ms upgrade --dry-run` 只做预检，然后打印计划，不停 msd、不卸载、不写任何东西。三家插件要等旧版本卸掉之后才能规划，所以计划里只写一句，不逐家列出。设置是按现在的 `config.json` 判断的：

  ```text
  ms upgrade plan (dry run, nothing written): 1.0.0 → 1.0.1
    preflight passed: socket paths, install ledger, installed bundle and its CLI, Python pin, new package, config.json
    stop msd
    run 1.0.0's own ms uninstall --keep-data, which keeps state/ and config.json (its own plan: "~/Library/Application Support/agent-message-switchboard/bin/ms" uninstall --dry-run --keep-data)
    install 1.0.1:
      copy bundle ~/Library/Application Support/agent-message-switchboard/bundles/<16 位摘要> (...)
      write ~/Library/Application Support/agent-message-switchboard/config.json (0600: pins below)
      pin python /opt/homebrew/Cellar/python@3.13/.../Python (...)
      settings kept from the previous config.json: autoRegister, autoRegisterProjects, replyMode, actPreset, linkBudget (Python pin re-detected)
      (as long as 1.0.0's uninstall --keep-data keeps config.json; an older one that drops it leaves every setting at its default)
      then the LaunchAgent, the fallback launcher and the DSH, Claude Code and Codex plugins, each planned once 1.0.0 is gone; a harness whose preconditions fail then is skipped with a manual-install pointer
    start msd
    then list the follow-up steps for each harness installed
  ```

- 设置怎么沿用：保留下来的 `config.json` 与新版本的格式（schemaVersion）一致、并且通过新版本的检查时，自动登记、回复档位、act 预设、推送预算都沿用，Python 的 pin 重新探测。否则这些设置全部回到默认，结果里写明原因，并逐项列出默认值：

  ```text
  settings back to defaults (the kept config.json has schemaVersion 3, this version uses 4):
    autoRegister: off for every harness
    autoRegisterProjects: empty (every project)
    replyMode: direct for every harness
    actPreset: workspace-write for every harness
    linkBudget: 30 pushes per 600 s
  ```

- 同一个版本也可以 `ms upgrade`，就是重装，第一行写 `(reinstall of the same version)`；换成更低的版本也可以，第一行写 `(downgrade)`。
- 还没装过时报 `NOT_INSTALLED`，改用 `ms install`。
- 中途失败时：
  - 旧版本卸载失败，报 `MS_UPGRADE_UNINSTALL_FAILED`。msd 已经停了，旧版本可能只卸了一部分，数据都还在。按提示处理后，用私有根里的兜底入口再卸一次：`"$HOME/Library/Application Support/agent-message-switchboard/bin/ms" uninstall --keep-data`，然后 `ms install`。
  - 新版本安装失败，报 `MS_UPGRADE_INSTALL_FAILED`。新版本自己回滚，现在没有已安装的版本，但保留下来的 `state/` 和 `config.json` 都还在。处理好原因后再跑一次 `ms install`；或者装回旧版本的 npm 包（`npm i -g agent-message-switchboard@<旧版本>`）再 `ms install`。ms 不会自动装回旧版本。
  - msd 起不来，报 `MS_UPGRADE_START_FAILED`。新版本已经装好，处理好原因后运行 `ms daemon start`。

## 2. 手动安装（ms 装不上某一家时）

手动安装的插件不在 ms 的安装账本里，所以 `ms uninstall` 不会替你卸载它，要到该 Harness 的插件管理页里卸载。

<a id="manual-dsh"></a>
### 2.1 DSH 桌面

1. 先看跳过原因。最常见的是 profile 的 `cordis.patch.yml` 里还有提到 `ms-dsh-client` 的条目，例如插件页条目开关留下的覆盖行：删掉这一条。处理完运行 `ms install --harness dsh` 即可，不必手动安装。
2. 确实要手动安装时：打开 DSH 的插件页，选择从本地路径安装，安装源填结果行里打印的插件目录，形如 `私有根/bundles/<16 位摘要>/plugins/ms-dsh`。
3. 插件页出现 “Agent Message Switchboard” 卡片就是装好了。这条路径由 DSH 自己的插件管理器完成安装和加载，不需要重启。
4. 确认：在任一 DSH 会话的输入框输入 `/ms-auto status`，会看到一张命令卡片。
5. 停用：卡片上的开关。卸载：在插件页里卸载。

<a id="manual-claude-code"></a>
### 2.2 Claude Code

ms 装 Claude 这一家时会做三件事：在私有根生成本地 marketplace 目录 `私有根/claude-marketplace`，运行 `claude plugin marketplace add <该目录>`，再运行 `claude plugin install ms@ms-local -s user`。被跳过时，先按原因处理：

- `claude CLI not found on PATH`：先装好 Claude Code 命令行，或让它出现在 PATH 上，再运行 `ms install --harness claude-code`。
- `ms-local is already known to Claude`：之前装过还没卸干净，运行 `ms uninstall`，或 `claude plugin marketplace remove ms-local` 后再装。

ms 跳过 Claude 时不会生成 marketplace 目录，所以通常是处理完原因后用 `ms install --harness claude-code` 补装。下面的手动步骤适用于目录已经在、只是插件被你在 `/plugin` 里卸掉又想装回来的情况。

1. 添加 marketplace：

   ```bash
   claude plugin marketplace add "$HOME/Library/Application Support/agent-message-switchboard/claude-marketplace"
   ```

   ```text
   Adding marketplace…✔ Successfully added marketplace: ms-local (declared in user settings)
   ```

2. 安装插件（用户范围，终端和桌面 App 的本地会话都能用）：

   ```bash
   claude plugin install ms@ms-local -s user
   ```

   ```text
   Installing plugin "ms@ms-local"...✔ Successfully installed plugin: ms@ms-local (scope: user)
   ```

3. 新开一个会话，或在已开的会话里输入 `/reload-plugins`，插件才会加载。
4. 确认：`claude plugin list` 里 ms 显示已启用；在会话里输入 `/ms:auto status`，能看到回执。
5. 停用或卸载：在会话里输入 `/plugin`，到 Installed 页选中 ms，可以停用或卸载；也可以在终端运行：

   ```text
   $ claude plugin uninstall ms@ms-local -s user
   ✔ Successfully uninstalled plugin: ms (scope: user)
   $ claude plugin marketplace remove ms-local
   ✔ Successfully removed marketplace: ms-local
   ```

6. 插件是从 marketplace 目录原地加载的（Claude 的安装记录指向一份 cache 副本，但运行时用的是这个目录），所以不要删除或移动这个目录。

这几条命令不一定只由你亲手输入触发，见第 3 节的“已知限制”。

<a id="manual-codex"></a>
### 2.3 Codex

ms 装 Codex 这一家时会做四件事：
1. 在私有根生成本地 marketplace 目录 `私有根/codex-marketplace`；
2. 运行 `codex plugin marketplace add <该目录>`；
3. 运行 `codex plugin add ms@ms-local`；
4. 往 `~/.codex/config.toml` 追加 send/reply 两张免审批子表。

codex 先用 PATH 上的；没有时，用 ChatGPT 桌面内置的 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`。两者写的是同一个 `~/.codex`。

被跳过时，先按原因处理：

- `codex CLI not found on PATH or at …`：装好 Codex 命令行或 ChatGPT 桌面 App，再运行 `ms install --harness codex`。
- `~/.codex/config.toml not found`：Codex 还没在这台电脑上运行过。先启动一次 Codex，再运行 `ms install --harness codex`。
- `this build has no src/adapters/codex/mcp-main.ts`：当前 ms 构建里没有 Codex 适配器，需要换用含 Codex 适配器的构建。
- `already exists: …/codex-marketplace`：上次没卸干净。运行 `ms uninstall --harness codex` 后再装。
- `ms-local is already known to Codex`：之前装过还没卸干净。运行 `ms uninstall`，或 `codex plugin marketplace remove ms-local` 后再装。
- `… already has [mcp_servers.ms]; remove or rename it, then install`：config.toml 里已经有同名的 `[mcp_servers.ms]`，它会顶替插件里的 ms（见本节末尾的已知限制）。删掉或改名后，运行 `ms install --harness codex`。

ms 跳过 Codex 时不会生成 marketplace 目录，所以通常是处理完原因后用 `ms install --harness codex` 补装。下面的手动步骤适用于目录已经在、只是插件被你用 codex 命令卸掉又想装回来的情况。PATH 上没有 codex 时，把命令里的 `codex` 换成上面那个桌面内置的完整路径。

1. 添加 marketplace：

   ```bash
   codex plugin marketplace add "$HOME/Library/Application Support/agent-message-switchboard/codex-marketplace"
   ```

2. 安装插件：

   ```bash
   codex plugin add ms@ms-local
   ```

3. 免审批：手动安装时 ms 不会替你写两张免审批子表，所以 router_send、router_reply 会照常弹审批。需要免审批时，在 `~/.codex/config.toml` 末尾加上下面两张表；它们不进 ms 的安装账本，卸载时要自己删：

   ```toml
   [plugins."ms@ms-local".mcp_servers.ms.tools.router_send]
   approval_mode = "approve"

   [plugins."ms@ms-local".mcp_servers.ms.tools.router_reply]
   approval_mode = "approve"
   ```

4. 新开一个 Codex 会话，在 `/hooks` 里信任 ms 的六个 hook，键都是 `ms@ms-local:hooks/hooks.json:<事件>:0:0`，事件依次为 session_start、user_prompt_submit、pre_tool_use、permission_request、stop、interrupt。没信任的 hook 不运行：
   - SessionStart 或 UserPromptSubmit 没信任时，`$ms-*` 命令会交给模型处理；
   - act 依赖的三个 hook（UserPromptSubmit、PreToolUse、PermissionRequest）没有全部按当前内容信任时，act 档的来信会自动按 direct 处理（见第 4 节）；
   - stop、interrupt 只用于未回信回执。不信任它们时 act 照常，只是来信那一轮结束时不会给发信方发回执。
5. 确认：在会话里输入 `$ms-auto status`，界面显示 “Blocked by hook” 和自动登记的回执，表示命令已由 hook 执行、没有发给模型。
6. 停用或卸载：

   ```bash
   codex plugin remove ms@ms-local
   codex plugin marketplace remove ms-local
   ```

   - 手动安装的插件不进 ms 的安装账本，`ms uninstall` 不会替你卸。
   - Codex 自己改写 config.toml 时会补末尾换行、加空行，卸载后文件可能和安装前差这些空白。
7. 插件会被复制到 `~/.codex/plugins/cache/ms-local/ms/<版本>/`，但其中的 MCP 指向私有根里的 bundle，所以不要删除私有根。
8. Codex 桌面 App 和终端用的是同一个 `~/.codex`，装一次两边都能用。桌面上也可以从 `/` 菜单选 ms-register、ms-unregister、ms-auto 或 ms-reply，和输入 `$ms-*` 一样由 hook 直接执行、不经模型（第 3 节、第 4 节）。
- 已知限制：不要在 `~/.codex/config.toml` 里手动加 `[mcp_servers.ms]`。Codex 会让 config.toml 里的同名 MCP server 静默顶替插件里的 ms，启动命令和 send/reply 的免审批设置都会失效，而且不会有任何提示。ms install 发现已有这张表时会跳过 Codex。

## 3. 登记当前会话

只有已登记的会话才能被其他 Harness 找到、收到消息。默认是手动登记。

| Harness | 登记 | 撤销 | 自动登记开关 |
|---|---|---|---|
| Claude Code | `/ms:register` | `/ms:unregister` | `/ms:auto on\|off\|status` |
| DSH | `/ms-register` | `/ms-unregister` | `/ms-auto on\|off\|status` |
| Codex | `$ms-register`（补全出的 `$ms:ms-register` 也认） | `$ms-unregister`（也认 `$ms:ms-unregister`） | `$ms-auto on\|off\|status`（也认 `$ms:ms-auto`） |

Claude Code 里请带冒号输入：不带冒号的 `/ms-register`、`/ms-auto` 等不是 Claude 的命令，Claude 会直接提示 Unknown command。不带冒号的写法只用于 DSH。

- 这些命令都在本机直接处理，不发给模型，结果直接显示给你。Codex 没有插件斜杠命令，所以用 `$` 开头的技能名，由 ms 插件的 UserPromptSubmit hook 识别；整条输入必须恰好是命令（`$ms-auto` 后面可以跟 `on`、`off`、`status`），否则当普通提示交给模型。Codex 界面会显示 “Blocked by hook” 和结果，这是 Codex 的固定写法，表示命令已执行、没有发给模型。
- Codex 桌面上也可以从 `/` 菜单选 ms-register、ms-unregister 或 ms-auto（auto 选中后接着输入 `on`、`off` 或 `status`），由 hook 直接执行。菜单提交的是一个指向 ms 插件缓存里该技能的链接；前后再加别的文字，就当普通提示交给模型。
- Codex 也可以用自然语言请模型登记或撤销（模型调用 router_register、router_unregister）。
- Codex 的 hook 需要先在 `/hooks` 里信任一次，ms 的 MCP 也要已经连上；否则命令原文会交给模型，由模型按技能说明调用 router 工具。
- 已知限制：Claude Code 侧的这几条命令（含不带冒号的写法），不一定是你亲手输入才会触发。同一系统用户下的其他程序直接写会话的消息通道、子代理回报或定时任务，只要提交的原文恰好是命令，也会触发。经 Switchboard 投递的来信带消息头，不会被当成命令。影响只限于你自己这台电脑、同一系统用户下 Claude Code 的登记和自动登记开关。DSH 的命令不受影响。
- 撤销后会话变为离线，已有的线路保留，重新登记后可以接着用。
- Claude Code 的 agent view：交给后台托管的会话（←、`/bg`、`claude --bg`、`claude agents` 里新建等）也能用 `/ms:register` 登记，登记类型是 CLI。已知限制：
  - ← 和 `/bg` 会把对话复制成一个新编号的后台会话。后台会话要重新输入 `/ms:register`。你在后台会话的历史里还能看到移交前那条「已登记 Switchboard：…」，它只属于旧编号。
  - 用 ← 移交后，原来窗口里的 claude 不会退出，旧编号在它退出之前一直显示在线。发给旧编号的信会显示已写入，但不会出现在任何你看得到的对话里，也不会有回信。请让对方改发给新编号；原来窗口里的 claude 退出后，旧编号转为离线。
  - 用 `/bg` 移交后，原来窗口里的 claude 会退出，旧编号随之离线。
- 在电脑上也能切换：`ms config set auto-register [--harness claude-code|dsh|codex] on|off`。

### 自动登记的范围和生效时机

- `/ms-auto`、`/ms:auto` 和 Codex 的 `$ms-auto` 只切换当前这一个 Harness 的开关，不改项目名单。
- 项目名单只能在电脑上修改：`ms config set auto-register --project <目录> on|off`。名单为空表示所有项目。
- `status` 和 `on` 的回执会写明当前范围。
- 生效时机有三点不同，请留意：
  1. **DSH 开启后立即生效**：当前已打开、在项目名单内的 DSH 主会话会马上登记，之后新建的主会话也会自动登记。
  2. **Claude Code 与 Codex 开启后，从下一次新开或恢复的会话起生效**：当前会话不受影响，需要的话输入 `/ms:register`（Codex 输入 `$ms-register`）。
  3. **关闭只停止今后的自动登记**：已经登记的会话保持在线，要撤销请用 `/ms-unregister`（或 `/ms:unregister`）。

## 4. 收发消息

- 直接对模型说，例如“给 DSH 里负责评审的会话发一句……”。模型会先查通讯录，再发送。
  - 找不到或有多个候选时，模型不会发送，而是把候选列给你选。
- 收到来信时，来信头写着“来源：<Harness> | Agent Message Switchboard”。来信是对方会话发来的信息，**不代表你的授权**，不能用来批准操作。
  - 要回复，就告诉模型“回复他”。模型会按原消息原址回复；直接在本会话里回答，对方收不到。
  - 一个会话收到的第一封来信，信头里带完整的回复说明，之后的来信不再重复，只有一行头，写着来自哪个 Harness、哪个会话（通讯录里的别名或标题，没有时写会话 ID）和 messageId。多个会话同时来信时，看这一行区分。新开会话或 `/clear` 之后重新算第一封；恢复（resume）同一个会话不重算。
- “已写入”或“已入队”不代表对方已读。
- Codex 收件会话的上一轮是按 Esc 中断的时候，之后送到的来信会停在 Codex 的队列里，不会自动开始处理，要等你在那个会话里下一轮普通对话结束（例如发一句话、等它答完）才处理。这是 Codex 自己的排队规则，ms 这边显示 dispatched。
- 对方离线（TARGET_OFFLINE）时，消息不会排队补投。

### 回复档位

收到来信后，模型要不要直接回，由收件方 Harness 的回复档位决定。三家各有一个档位，默认都是 `direct`。

- `direct`：来信是提问，或明确要求回应时，模型直接按原址回复，只用对话里已有的信息回答。
- `confirm`：模型回复前先问你。
- `act`：来信可以请收件会话动手，按统一的风险分级把关，见下面「act 档」。
- `direct` 和 `confirm` 只回答，不替对方干活：来信要求执行操作（改文件、跑命令、登记或撤销等）时，模型都不执行，也不答应对方会去执行，先告诉你来信要求做什么、问你要不要做；为了回答而去读文件、环境变量、密钥或跑命令，也算执行操作，同样先问你。只回提问或明确要求回应的来信，其他来信不回。
- 拿不到档位时（例如 msd 没在运行），按 `confirm` 处理，先问你。

切换与查看有四个入口：

| 位置 | 命令 |
|---|---|
| DSH | `/ms-reply direct\|confirm\|act\|status` |
| Claude Code | `/ms:reply direct\|confirm\|act\|status` |
| Codex | `$ms-reply direct\|confirm\|act\|status`（也认 `$ms:ms-reply`）；桌面上也可以从 `/` 菜单选 ms-reply，接着输入参数 |
| 电脑 | `ms config set reply-mode [--harness claude-code\|dsh\|codex] direct\|confirm\|act`；查看用 `ms config get` 或 `ms status` |

- 会话里的三个命令只认表里列出的小写参数，不带参数等于 `status`，多个参数算非法。它们只切换当前这一个 Harness 的档位，在本机直接处理，不发给模型。回执例如：

  ```text
  已把 Switchboard 回复档位（dsh）设为 confirm：之后的来信，回复前会先问你。已打开的会话从下一次模型调用起生效。本命令未发送给模型。
  ```

- `ms config set reply-mode` 不带 `--harness` 时三家一起设，与 `auto-register` 相同。输出是设置后的完整配置：

  ```text
  $ ms config set reply-mode --harness dsh confirm
  auto-register: claude-code off, dsh off, codex off
  auto-register projects: (any)
  reply-mode: claude-code direct, dsh confirm, codex direct
  act-preset: claude-code workspace-write, dsh workspace-write, codex workspace-write
  link-budget: 30 pushes per 600 s
  ```

- 生效时机：
  - DSH：从下一次模型调用起生效，已打开的会话也一样。
  - Claude Code 与 Codex：从下一封来信起生效，已打开的会话也一样。
- `ms upgrade`（或者 `ms uninstall --keep-data` 之后再 `ms install`）沿用档位和 act 预设，条件是保留下来的 `config.json` 与新版本格式一致并且通过检查；否则三家的档位回到 `direct`，act 预设回到 `workspace-write`，结果里逐项写明（见第 1 节「升级」）。不带 `--keep-data` 卸载后重装，一律回到默认。

#### act 档：请收件会话动手

`act` 是第三档：来信可以请收件会话执行操作，由收件会话在自己的权限内去做，ms 按统一的风险分级把关。有的操作直接执行，有的弹审批由你决定，危险的一律拒绝。

- 被拒绝或你没批准时，模型不会换一个命令、工具或写法去做被拒绝的那一步，也不转托别的会话。唯一的例外是 ms 的拒绝理由里明确写了可以怎样改做（例如下面递归搜索的提示），模型可以照那样做。之后模型如实回复对方：是你没批准还是 ms 拒绝、是哪一步，原因照拒绝理由写。
- 模型按来信写的原样运行要求的命令，不在后面拼接别的命令（例如 `; echo "exit=$?"`）。拼接的部分常常让 ms 判为无法解析而直接拒绝，连审批都到不了；这时拒绝理由会提示去掉附加部分、按原样再运行一次。
- 来信那一轮里只能原址回复：不向第三方发信，不派生子代理。
- 来信那一轮里，也不能启动会在这一轮之后继续运行的后台工作：
  - 后台命令（`run_in_background`）、结尾带 `&` 或用 nohup、setsid、disown 脱离的 shell 命令、在 screen 或 tmux 里常驻运行的命令、at 与 batch 作业、`launchctl load`/`submit`/`bootstrap`/`start`/`kickstart`、Claude 的 Monitor、DSH 与 Codex 的 goal 一律拒绝；`screen -ls`、`tmux ls`、`atq` 这类查询不受影响；
  - 模型会如实告诉对方，需要长时间运行的由你自己发起；
  - 宿主自己把超时的长命令转到后台时，这些命令完成后开的那一轮仍按来信把关（见下）。
- 打开 act：
  - Claude Code：电脑上用 `ms config set reply-mode --harness claude-code act`，或在 Claude 会话里输入 `/ms:reply act`，`/ms:reply` 查看时会同时显示当前的 act 预设。
  - DSH：电脑上用 `ms config set reply-mode --harness dsh act`，或在 DSH 会话里输入 `/ms-reply act`，`/ms-reply` 查看时会同时显示当前的 act 预设。
  - Codex：电脑上用 `ms config set reply-mode --harness codex act`，或在 Codex 会话里输入 `$ms-reply act`，`$ms-reply` 查看时会同时显示当前的 act 预设。不带 `--harness` 的 `ms config set reply-mode act` 三家一起设。
- Claude Code 下的表现：
  - 需要审批时，Claude 弹出的权限提示里写着「Switchboard 同伴请求（发信方）：要做什么，按某预设需要你审批」，末尾带 `[plugin:ms]`。被拒绝时，模型会看到理由并如实回复对方。
  - Claude 处在 dontAsk 或 bypassPermissions 模式时没法逐次审批，来信按 direct 处理；来信那一轮中途切进这两种模式，需要审批的操作直接拒绝。
  - 来信那一轮从来信开始，到这一轮结束为止。这一轮里你自己插的话也算在这一轮里，按来信把关。
  - 按 Esc 打断来信那一轮时，Claude 不会通知 ms 这一轮结束了，所以你自己的下一轮也按来信把关，直到那一轮结束，偏严。提示里会写「本轮含同伴来信，按来信把关；如果是你自己的要求，请在本轮结束后再发一次」。
  - 来信那一轮结束时，如果会话里还有后台工作在跑（例如 Claude 把超时的长命令转到了后台），ms 会继续按来信把关，直到某一轮结束时已经没有后台工作为止。这段时间里你自己的轮也按来信把关，偏严。
  - 未回信回执（总说明见下面的「未回信回执」）：Claude 正常结束、API 出错结束、会话结束都会发。
    - Claude 的未回信回执需要 hook 输入带 prompt_id。Claude Code 2.1.309 或更高都带（实测 2.1.309 到 2.1.311）；更早的版本没有测过。
    - 在确认框选 No（不附文字）、按 Esc 或在桌面点停止时，Claude 不触发任何 hook，ms 当时不知道这一轮已经结束。回执要等这个会话的下一轮结束或会话关闭才发，发信方看到的是「中断或拒绝」那一句；会话一直闲着就一直没有。
    - 选 No 时按 Tab 附一句话，这一轮不会中止，模型会接着做；之后正常结束、仍没有回信时，原因是「正常结束」。
    - 来信那一轮结束时还有后台工作在跑，回执要等之后某一轮结束、已经没有后台工作时才发，原因仍是「正常结束」。
    - msd 重启时，还没结算的来信会丢失，这些来信不再发回执。
- DSH 下的表现：
  - 需要审批时，输入框处弹出审批卡，标题写着「Switchboard 同伴请求（发信方）：要做什么，按某预设需要你审批」，下面显示要执行的命令，按钮是「拒绝」「允许一次」。DSH 的审批卡本身不标来源，所以发信方写在标题里。被拒绝时，模型会看到理由并如实回复对方。
  - 会话的权限预设是 Full access（`/permission danger-full-access`，审批策略 never）时没法逐次审批，来信按 direct 处理，运行时上下文里的档位一行写 direct；来信那一轮中途切到 Full access，需要审批的操作直接拒绝。
  - Auto review 预设下，ms 要求的审批仍然交给你，不交给自动审查；自动审查自己也不把来信当作你的授权。
  - 来信那一轮从来信开始，到这一轮结束（正常结束或点停止）为止。回车排队的话会在这一轮结束后另开一轮，那一轮按你自己的要求处理；用 Cmd+回车插进这一轮的话，按来信把关。
  - 来信那一轮里，委派子 agent、给其他 agent 发消息或派任务一律拒绝：子 agent 的操作不经过 ms 的把关。
  - DSH 插件在宿主进程里把关，不经过 msd；msd 暂时断开时，来信那一轮按「仅可查看」预设处理。
  - 用 ptc 预设（工具都经 run_code 程序调用）的会话，来信按 direct 处理，档位一行写 direct。原因是 run_code 程序可以直接读文件、联网，不经过逐个工具的把关，而 DSH 的沙箱只限制写文件，不管读和网络。
  - 来信那一轮里的命令跑满超时被 DSH 转到后台的，命令完成后开的那一轮也按来信把关，发信方不变；你在来信之前自己启动的后台命令不受影响。
  - 未回信回执（总说明见下面的「未回信回执」）：DSH 正常结束、点停止、出错结束、会话被关闭都会发。
    - 点停止时，发信方看到的是「中断或拒绝」那一句。审批卡里点「拒绝」不会中止这一轮，模型会接着做；这一轮之后正常结束、仍没有回信时，原因是「正常结束」。
    - 来信那一轮留下了被转到后台的命令时，回执要等这些命令都完成、它们的完成通知那一轮结束才发，因为来信的事还在接着做。
    - DSH 插件或 DSH 本身重启时，正在进行的来信回合会丢失，这些来信不再发回执。
- Codex 下的表现：
  - Codex 的 hook 不能弹审批，所以按预设需要审批的操作在 Codex 上改为拒绝。拒绝理由写着「Switchboard 同伴请求（发信方）：要做什么，按某预设需要审批，Codex 不为同伴请求弹审批，已拒绝」，模型会把来信要做的事告诉你，由你在本会话里亲自发起；你亲自发起的那一轮是你自己的回合，按 Codex 自己的审批与沙箱走。
  - 来信那一轮里，Codex 要为某个操作申请提权或审批时一律拒绝，自动审批（auto_review）也看不到同伴的请求。
  - 审批策略为 never（`approval_policy = "never"`）时，来信按 direct 处理，档位一行写 direct。完全权限（danger-full-access）但审批策略不是 never 时照常 act：ms 本来就不靠 Codex 弹审批，L3 与转托、派生、后台工作照样拒绝。
  - 来信那一轮从来信开始。回车插的话并进这一轮，按来信把关；按 Tab 排队的话在这一轮结束后另开一轮，按你自己的要求处理。
  - 这一轮结束或按 Esc 中断之后，ms 仍记着它，不会因为这一轮结束而清掉。原因是 Codex 的代码模式（GPT-6 系列默认就用）：模型在这一轮里启动的程序可以让出后继续运行，之后调用工具时带的仍是这一轮的标识。所以这些后来的调用照样按来信把关。你自己的回合不受影响。
  - 未回信回执（总说明见下面的「未回信回执」）：Codex 正常结束、按 Esc 中断、在审批里选 Abort 时会发。
    - 按 Esc 或选 Abort 时，发信方看到的是「中断或拒绝」那一句。
    - 出错结束的那一轮不会触发 stop、interrupt，回执要等这个会话下一次结束或中断时才发，原因是「结束原因不明」。
    - 这只用到 stop、interrupt 两个 hook，没信任它们就没有回执，act 照常。之后再信任的话，这个会话里之前没报过的来信，会在下一次结束或中断时一起补发回执，原因是「结束原因不明」。
  - 来信那一轮里，派子代理、给其他 agent 发消息、等待或关闭 agent、设定或更新 goal 一律拒绝：子代理的操作关联不回来信那一轮，ms 管不到。
  - ms 在 Codex 拉起的 ms MCP 进程里判档，不经过 msd；msd 暂时断开时，来信那一轮按「仅可查看」预设处理，msd 回来后几秒内自动重连，恢复原来的预设。
  - Codex 只运行你在 `/hooks` 里信任过的 hook，hook 内容变了（例如升级 ms 之后）要重新信任。ms 每次收到 act 档的来信，都先只读核对 act 用到的三个 hook 是否按当前内容被信任；有任何一个没信任，这封来信就按 direct 处理，档位一行写 direct。到 `/hooks` 把 ms 的 hook 全部信任后，下一封来信起就是 act。ms 只读 Codex 的配置，不会替你信任。

风险分四档，按“这次工具调用会做什么”由固定规则判定，不交给模型自己评估：

| 档 | 含义 | 例如 |
|---|---|---|
| L0 只读 | 只读、不出本机 | 读工作区内的普通文件、列目录、只列文件名或计数的搜索；只读命令（ls、cat、`grep -rl`、`git status` 等） |
| L1 工作区内写 | 在工作区内建、改文件，不碰受保护路径；也包括把命令输出重定向写进工作区内的文件 | 改代码、`printf 'hello' > note.txt` |
| L2 执行或联网 | 其余命令；联网读取；读工作区外的非密钥文件；技能；MCP 工具；不认识的工具 | 跑测试、抓网页 |
| L3 危险 | 改权限、配置或 CLAUDE.md；读密钥或凭据；删除工作区外的东西；把数据发到外部网络；解析不了的命令；会输出匹配内容的递归搜索 | `git push`、读 `~/.ssh`、`sudo`、`grep -r token .` |

- 工作区是收件会话所在的项目根（ms 通讯录里的 project）。一次调用含多个动作时，按最高的那一档算。
- 用 heredoc 写文件只认一种写法：`cat > 文件 <<'EOF'` 加正文，再以单独一行 `EOF` 结束，分隔符要整个加引号。这样写进工作区内的文件按 L1 算，和直接改文件一样。其他 heredoc 写法（分隔符不加引号、交给 python 或 bash 执行、用 tee 写）都当作解析不了的命令，一律拒绝。
- 同伴请求里，会输出匹配内容的递归搜索一律拒绝（例如 `grep -r`、`rg`、Claude Grep 的 content 模式、DSH 的 grep 工具），因为它会把 `.env` 一类密钥文件的匹配行原样带出来。要先只列文件名定位（例如 `grep -rl`，或 Grep 的 files_with_matches），再逐个读具体文件，每个文件都会查密钥清单。

三个预设决定 L0 到 L2 怎么处理，L3 在任何预设下都拒绝：

| 预设 | L0 只读 | L1 工作区内写 | L2 执行或联网 | L3 危险 |
|---|---|---|---|---|
| 仅可查看（`read-only`） | 放行 | 审批 | 审批 | 拒绝 |
| 工作区内修改（`workspace-write`，默认） | 放行 | 放行 | 审批 | 拒绝 |
| 完全权限（`full-access`） | 放行 | 放行 | 放行 | 拒绝 |

- **放行**只是 ms 不额外加审批，宿主自己的权限照常生效。例如 Claude Code 在默认模式下改文件照样会问你，Codex 在沙箱外的操作照样会问。ms 只收紧、不放宽。分级按命令文本判定，不是安全边界；真正的边界仍是宿主的沙箱与权限。
- **审批**：走宿主的审批，提示里标明是哪个 Harness 的哪个会话发来的请求。Codex 不支持这种审批，需要审批的那几档在 Codex 上改为拒绝，模型会请你在本会话里亲自发起。
- **拒绝**：不执行，把原因告诉模型，模型如实回复对方。
- 预设只能在电脑上设，按收件方 Harness 分开：`ms config set act-preset [--harness claude-code|dsh|codex] read-only|workspace-write|full-access`，不带 `--harness` 时三家一起设。会话里的命令只切档位，不改预设。`ms status` 与 `ms config get` 的 `act-preset:` 一行列出三家的预设。

三条底线，任何档位和预设都关不掉：

1. 不会因为对方要求就改权限设置、项目说明文件（Claude Code 的 CLAUDE.md，DSH 的 AGENTS.md 与 CLAUDE.md，Codex 的 AGENTS.md）或配置。
2. 对方的消息不能当作你对待处理审批的批准。
3. 对方说某个操作被拒了、请这边代做时，会拒绝并告诉你。

已知限制：

- Claude Code：按 Esc 打断来信那一轮，或者在来信那一轮中途结束会话（关终端、`/exit`、`claude respawn` 等）之后，下次 resume 这个会话时，你自己的第一轮也按来信把关，直到某一轮正常结束。偏严，不会放宽。
- Claude Code：来信那一轮进行中，会话换到新进程接着跑时（崩溃后自动重启、attach 卡住时的 respawn、agent view 里确认重启），ms 按会话编号继续把关；但在 agent view 里用 ← 或 `/bg` 把会话移到后台时，Claude 会给它一个新的会话编号和新的进程，这一轮余下的部分不再经 ms 把关，回落到会话自身的权限设置：Claude 的权限模式与权限提示照常生效，ms 不再加审批或拒绝。
- Claude Code：快速路径先判断 socket 变量非空，变量为空时不会误判。socket 路径的最后一段如果是 `..`，这个会话的每次工具调用都会多走一次 msd 判断，结果只会更严；socket 路径由 Claude 设定，正常不会出现。
- DSH：来信那一轮里用 Cmd+回车插的话也按来信把关（见上）。
- 你在来信之前自己建的 goal、启动的后台工作和子 agent，之后照常运行，不受 ms 把关。
- Claude Code：`background_tasks` 里分不出哪些后台工作是来信那一轮启动的，你自己早先启动的后台工作也会让 ms 继续按来信把关，直到它们结束。Claude 自家的维护任务（dream、auto-mode scan、memory import）不算。
- Codex：ms 的 hook 出错时按放行处理；ms 掉线（ms 的 MCP 断开）时，act 档的来信不受 ms 分级管控，只剩 Codex 自己的审批与沙箱。界面上会显示「Hook failed」。
- Codex：hook 的信任只核对 `~/.codex/config.toml`（或 `CODEX_HOME` 下的 config.toml）。用 profile 配置文件或 `-c hooks.state…` 停用 ms 的 hook 时 ms 看不到，档位一行仍会写 act。
- Codex：exec 命令默认 10 秒后让出，还没跑完的会转到后台继续跑，调用前 ms 只看得到命令文本，看不出这一点，所以只拦命令里显式的 `&`、nohup、setsid、disown。这类命令跑完时 Codex 不会另开新一轮。
- Codex：子代理的调用带的是它自己的轮次，关联不回来信那一轮，所以只能在来信那一轮里拒绝派生子代理；你在来信之前派出的子代理照常运行。
- Codex：ms 的 Codex MCP 进程最多记 1024 个来信回合，满了淘汰最旧的，被淘汰的那一轮之后的工具调用不再按来信把关。ms 的 MCP 单独重启而 Codex 仍在运行时，这些记录会丢失，之前来信那一轮里启动、仍在运行的程序之后的工具调用不再按来信把关。msd 重启不影响这些记录。
- Codex：代码模式外层的 `exec`、`wait` 调用本身不经过 ms 的把关，ms 看不到程序原文；程序里每一次调用工具都会经过。
- Codex：未回信回执可能先到、真回信后到。代码模式里让出后继续运行的程序，在这一轮结束之后才调用回信时，要等这个会话下一轮开始才真正发出。
- Codex：以下情况没有未回信回执，或回执晚到：
  - 这一轮出错结束、被新的一轮替换或被挂起时，回执要等这个会话下一次结束或中断；
  - ms 的 Codex MCP 单独重启，或来信回合超过 1024 个被淘汰时，这些来信不再发回执；
  - 没有在 `/hooks` 信任 stop、interrupt 时不发回执；之后再信任，同一会话里之前没报过的来信会补发「结束原因不明」；
  - 收件会话上一轮按 Esc 中断后，之后到的来信要等你在那个会话里下一轮普通对话结束才开始处理（见第 4 节），回执也随之推迟。
- DSH：后台 job 的完成通知正文认不出、会话里又还有没结束的来信 job 时，那一轮按来信把关，但不算用掉那个 job；在正规通知到来之前，之后的每条通知都会让那一轮按来信把关。这依赖 DSH 的通知格式保持稳定，只会多拒。
- Claude Code：Claude 自家维护任务的名字（dream、auto-mode scan、memory import）取自 2.1.310。Claude 以后改名时，来信把关会多持续一阵，只会更严。
- Claude Code：ms 固定的 Python 损坏时，Stop 删不掉来信标记，act hook 每次都拒绝，这个会话在结束或重启之前用不了工具。这是从严失败，属于安装异常。
- Claude Code 的未回信回执：
  - attach 卡住时被 respawn，或在 agent view 里确认重启时，Claude 先报会话结束，发信方会先收到「对方会话已经结束或退出」的回执；新进程接着跑原来那一轮，之后仍可能回信。
  - 一轮开始时 Claude 一次读入几条排队的消息（例如上一轮快结束时先后到了来信和你的输入），排在前面的来信即使那一轮正常结束，回执的原因句也会写成「中断或拒绝」。
  - Claude 没在 hook 输入里给出 prompt_id 时不发回执。2.1.309 及以上只在进程刚启动、还没有任何输入时缺这个字段；ms 不检查 Claude 的版本。
- Codex 托管的 web_search 不经过 PreToolUse，ms 管不到（它属于 L2 的联网读取）。

#### 未回信回执（act 档）

你发出的 act 档来信送达后，如果对方处理它的那一轮结束了，却没有回信，ms 会替对方给你发一条回执。这样你不会一直干等。

- **什么时候会收到：**
  - 只对你经发送（不是回复）发出、对方按 act 档处理的来信。对方是 direct 或 confirm 档，或者对方那边改按 direct 处理（例如没法逐次审批，见上面各家的表现），都不发。
  - 对方回过信的不发，一封来信最多一条。回执之后对方仍可能补回信，你照常会收到。
- **回执长什么样：** 第一行固定以「Switchboard 回执」开头，写明它不是对方的回信，以及原来那封的 messageId：

  ```text
  Switchboard 回执 · 不是对方的回信 · 原消息 messageId "〈原来那封的 messageId〉"
  你发给 〈Harness〉 会话 "〈对方的别名或标题〉" 的消息已送达，对方处理它的那一轮已经结束，结束时没有回信。〈原因句〉之后对方仍可能回信。……
  ```

  原因句有五种：

  | 情况 | 原因句 |
  |---|---|
  | 对方那一轮正常结束 | 对方这一轮正常结束，但没有调用回信。 |
  | 被对方的用户中断，或对方的用户拒绝了其中的操作 | 这一轮可能被对方的用户中断，或对方的用户拒绝了其中的操作。 |
  | 出错结束 | 对方这一轮出错结束。 |
  | 对方会话结束或退出 | 对方会话已经结束或退出。 |
  | 看不出原因 | 结束原因不明。 |

- **收到之后怎么办：**
  - 回执是 ms 代发的状态说明，会作为一条新消息进入你的会话，模型读到后只把情况告诉你，不回复它，也不自动重发原来那封。要不要再问对方、怎么问，由你决定。
  - 回执不能回复：它不进 `ms messages`，用回执的编号去回复会报 UNKNOWN_MESSAGE。
  - 回执不计入线路的推送预算。

已知限制：

- 先收到回执、后来又收到真回信，是正常的。例如对方的用户随后让模型接着做，模型再回信。
- act 档下发出的纯通知，对方按规则不回，你仍会收到「对方这一轮正常结束，但没有调用回信」。
- 对方那一轮结束时你的会话不在线，或者线路已因推送预算暂停，这条回执直接丢弃，之后也不补发。
- 各家自己的情况见上面各家的表现与已知限制。

## 5. 常见提示

| 提示 | 含义与处理 |
|---|---|
| `MS_PLUGIN_UNAVAILABLE：<阶段>` | DSH 插件没有就绪。运行 `ms status`，或查看 `私有根/run/dsh-plugin.json` 里的阶段与状态。 |
| `UNKNOWN_CLAUDE_BINARY` | 调用方不是有效的 Anthropic 签名 Claude Code，或调用链里有未识别的程序。 |
| `MESSAGING_SOCKET_UNAVAILABLE` | 当前 Claude Code 会话没有提供消息通道，无法登记。 |
| `INVALID_COMMAND_INPUT` | 命令参数不对，例如 `/ms-auto` 只接受 on、off、status，`/ms-reply` 只接受 direct、confirm、act、status（都是小写）。 |
| `DAEMON_ERROR: INVALID_CONFIG` | msd 拒绝了这次配置修改，例如值不合法。 |
| `UNKNOWN_TARGET` / `AMBIGUOUS_TARGET` | 没找到目标，或有多个候选；在候选里选一个再发。 |
| `BODY_HAS_REPLY_MODE` | 发出去的正文里有一行「Switchboard 回复档位：…」这样的写法，ms 没有发送。档位只由收件方的宿主附加在来信之外，正文里写的不算数，也不允许写，以免冒充；删掉这一行再发。只是提到档位的普通句子不受影响。 |
| `TARGET_OFFLINE` | 对方离线，没有投递。 |
| `LINK_PAUSED` | 线路因推送预算暂停，用 `ms links resume <linkId>` 恢复。 |
| `UNSUPPORTED_PYTHON_OWNER` | PATH 上的 `python3` 或它上面的某一级目录归别的账户所有，或者别人能改。msd 只运行归你或 root 所有的 Python，所以 `ms install`、`ms repin` 和 `ms upgrade` 都会先拒绝。按第 1 节的前提给这个账户装一个 Python。 |
| `MS_SOCKET_PATH_TOO_LONG` | 用户名太长，私有根里的 socket 路径超过 macOS 的 103 字节上限，装不上也起不来（见第 1 节的已知限制）。 |
| `MS_UPGRADE_PRECONDITION_FAILED` | `ms upgrade` 的预检没过（原因写在冒号后面），已安装的版本一点没动。 |
| `MS_UPGRADE_UNINSTALL_FAILED` | `ms upgrade` 时旧版本卸载失败，msd 已停；按第 1 节「升级」用兜底入口再卸一次，然后 `ms install`。 |
| `MS_UPGRADE_INSTALL_FAILED` | `ms upgrade` 时新版本没装上，现在没有已安装的版本，数据还在；再跑 `ms install`，或装回旧版本的 npm 包后 `ms install`。 |
| `MS_UPGRADE_START_FAILED` | 新版本已装好，但 msd 没起来；处理好原因后 `ms daemon start`。 |
| `MS_BUNDLE_OUTSIDE_ROOT` | 安装账本记的 bundle 不在私有根的 `bundles/` 下，或者已经不存在，`ms` 不执行它。正常安装不会出现；遇到时用私有根里的兜底入口卸载（见第 7 节），再重新 `ms install`。 |

## 6. 查看与管理

- `ms ui`：在浏览器里打开只读状态页，见下面「状态页」。
- `ms status`：msd 概况，包括三家的自动登记开关、回复档位、act 预设，以及此刻连上 msd 的 DSH 插件实例与 Codex MCP 进程数（`adapters:` 一行）。
- `ms sessions [--harness <h>] [--project <目录>]`：通讯录。
- `ms links`、`ms links resume <linkId>`：线路及恢复。
- `ms config get`：当前配置，包括自动登记开关、项目名单、回复档位、act 预设与推送预算。

### 状态页

运行 `ms ui`，会用默认浏览器打开一个只读网页：

- 内容：msd 在不在；三家装没装、连没连上；哪些会话在线；线路和最近 20 封消息（不含正文）。每 3 秒自动刷新。
- 只读：页面上不能改任何东西。改设置还是用 `ms config set …`，或在会话里用 `/ms:reply`、`/ms-reply`、`$ms-reply`。
- 关闭：在运行 `ms ui` 的终端按 Ctrl+C。关闭后页面会提示服务已停止；想再看，重新运行 `ms ui`，会打开新的地址。
- 只能在这台电脑上打开：地址是 `http://127.0.0.1:<端口>/ms-ui/?code=<一次性代码>`。端口每次运行都不同。代码用一次就作废，浏览器打开后会换成只在本次运行有效的登录状态。
  - 浏览器没自动打开时，复制终端里的地址手动打开。
  - 已经打开过的浏览器里，刷新、恢复标签页或新开标签页都可以直接用。
  - 换一个浏览器打开同一个地址，会显示「本页的登录已失效」，重新运行 `ms ui` 即可。
- msd 没在运行时，页面会提示运行 `ms daemon start`；msd 起来后几秒内自动恢复。
- 三张卡片右上角的标签，三家一个口径，都看此刻的在线会话数：
  - 有会话在线：「N 个会话在线」；
  - 没有会话在线、但装了：「已安装 · 没有在线会话」。「装了」指 ms 的安装账本里有，或者虽然是按第 2 节手动安装的、但这家此刻有连接或有会话在线；
  - 否则是「未安装」，读不到安装账本时是「安装情况未知」。
- 顶部的「有会话在线的 Harness」：三家里此刻有几家有会话在线。
- 卡片里「连接」一行写这一家怎么连着 msd：
  - Claude Code：没有常驻连接，按会话登记；
  - DSH：DSH 插件连着 msd 时写「DSH 插件已连上」，多于一个实例时带个数；DSH 没打开时写没连上；
  - Codex：每个打开的 Codex 会话都有一个 ms 的 MCP 进程，会话打开后几秒内连上 msd，不用先输入任何命令，这里写连上的进程数。Codex 桌面只开着 App、没有打开任何会话时，没有这个进程，显示「没有打开的 Codex 会话」。
  - 「连接」一行只是说明，有连接不等于有会话在线：会话还要按第 3 节登记，才算在线。
- 「安装」一行：看的是 ms 的安装账本。按第 2 节手动安装的 Harness 显示「没有用 ms 安装」，但只要有连接或有会话在线，右上角照样按实际情况显示。
- 同一个 Harness 里的会话互发，走各家自己的能力，不经过 ms，页面上看不到。

## 7. 卸载

```bash
ms uninstall --dry-run
ms uninstall
```

卸完再运行 `npm uninstall -g agent-message-switchboard` 删掉 ms 命令。如果先删了 npm 包，可以用私有根里不在 PATH 上的兜底入口卸载：`"$HOME/Library/Application Support/agent-message-switchboard/bin/ms" uninstall`（路径里有空格，要加引号）。

`ms uninstall` 按安装账本精确撤销三家插件和核心；加 `--keep-data` 会保留 `私有根/state`（通讯录、线路与消息记录）和 `私有根/config.json`（自动登记、回复档位、act 预设、推送预算等设置）。之后再 `ms install` 时，格式一致的设置会沿用，格式不一致就回到默认并逐项写明（见第 1 节「升级」）。输出节选：

```text
ms uninstalled
ok agent-message-switchboard-dsh: removed with DSH pnpm; ~/.dsh/profiles/desktop/package.json, ~/.dsh/profiles/desktop/pnpm-lock.yaml: restored exactly; ~/.dsh/profiles/desktop/node_modules/agent-message-switchboard-dsh: removed
ok ms@ms-local: removed with the codex CLI; ~/.codex/config.toml: restored exactly
ok ~/Library/Application Support/agent-message-switchboard/codex-marketplace: removed
ok ms@ms-local: removed with the claude CLI; ~/.claude settings.json, plugins/known_marketplaces.json, plugins/installed_plugins.json: restored exactly
ok ~/Library/Application Support/agent-message-switchboard/claude-marketplace: removed
ok ~/Library/LaunchAgents/local.agent-message-switchboard.msd.plist: removed
removed ~/Library/Application Support/agent-message-switchboard
restart DSH so it unloads agent-message-switchboard-dsh
```

- DSH：卸载后重启一次 DSH，插件才会卸下。在此之前，插件的工具会返回 `MS_PLUGIN_UNAVAILABLE`，不会误投。
- 用户在 DSH 插件页拨过“条目开关”时，DSH 会留下覆盖行，ms uninstall 会一并清掉；其他提到 `ms-dsh-client` 的行会保留并提示你，退出码 6，处理后重跑。
- 期间你用 DSH 插件页装过别的插件时，ms 只用 DSH 自带的 pnpm 移除自己的包，保留你的改动。
- DSH 的 pnpm 移除后，profile 的 `node_modules/agent-message-switchboard-dsh` 链接还在，ms 最后确认并删掉这条指向自己 bundle 的链接。那里换成了别的东西或删不掉时，保留并报冲突（退出码 6），处理后重跑。
- Claude：ms 先用官方的 `claude plugin uninstall` 和 `marketplace remove` 移除 ms@ms-local。三份 Claude 文件（`settings.json`、两个插件注册表）自安装后没被改过，就逐字节还原；改过（Claude 自己也会更新注册表）就只确认 ms 的键已删除，其余保留。cache 副本一并清理。

### 只卸某一家

```bash
ms uninstall --harness dsh --dry-run
ms uninstall --harness dsh          # 或 claude-code、codex
```

```text
ms uninstalled dsh
ok agent-message-switchboard-dsh: removed with DSH pnpm; ~/.dsh/profiles/desktop/package.json, ~/.dsh/profiles/desktop/pnpm-lock.yaml: restored exactly; ~/.dsh/profiles/desktop/node_modules/agent-message-switchboard-dsh: removed
restart DSH so it unloads agent-message-switchboard-dsh
```

- 只撤销这一家，核心和其他两家不动，msd 也不停。之后可以用 `ms install --harness <h>` 装回来。
- 这一家没被 ms 装过时报 `NOT_INSTALLED`（退出码 5）；遇到冲突退出码 6，这一家的记录留在账本里，处理后重跑。
- `--harness` 不能和 `--keep-data` 一起用。

<a id="manual-cleanup"></a>
### 手动清理（旧版本彻底坏掉、自己卸载不了时）

先试 `ms uninstall`，再试私有根里的兜底入口 `"$HOME/Library/Application Support/agent-message-switchboard/bin/ms" uninstall`。两个都跑不起来（例如私有根被删了一半、账本坏了），才按下面逐项手动清理。

- 这些步骤由你自己执行，ms 不替你删任何东西。
- 每一步都**先看、再删**：先用列出来的命令确认那里确实是 ms 的东西，再执行删除；不是 ms 的就留着。
- 顺序：先停 msd，再用三家各自的官方命令移除插件，最后删 LaunchAgent 和私有根。

1. **停 msd**。先查看服务在不在：

   ```bash
   launchctl print "gui/$(id -u)/local.agent-message-switchboard.msd"
   ```

   查得到就停掉它；查不到说明已经停了，跳过：

   ```bash
   launchctl bootout "gui/$(id -u)/local.agent-message-switchboard.msd"
   ```

2. **Claude Code**：用官方命令移除插件和 marketplace。

   ```bash
   claude plugin list
   claude plugin uninstall ms@ms-local -s user
   claude plugin marketplace remove ms-local
   ```

   - 第一条用来确认 `ms@ms-local` 在列表里；不在就跳过后两条。
   - 移除之后，`~/.claude/plugins/cache/ms-local/` 和 `~/.claude/plugins/data/ms-ms-local/` 可能还留着。先用 `ls -la` 看一眼，确认是 ms 的目录再删。
   - `~/.claude/settings.json` 和两个插件注册表里留下的空对象不影响使用，可以不管。

3. **Codex**：用官方命令移除插件和 marketplace。PATH 上没有 `codex` 时，换成 ChatGPT 桌面内置的 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`。

   ```bash
   codex plugin remove ms@ms-local
   codex plugin marketplace remove ms-local
   ```

   - 然后查看 `~/.codex/config.toml` 里还剩下哪些 ms 的表：

     ```bash
     grep -n 'ms@ms-local\|ms-local' ~/.codex/config.toml
     ```

   - 用编辑器删掉剩下的 ms 自己的表，每张表从表头删到下一个表头之前：
     - 两张免审批子表，`[plugins."ms@ms-local".mcp_servers.ms.tools.router_send]` 和 `[plugins."ms@ms-local".mcp_servers.ms.tools.router_reply]`；
     - 你在 `/hooks` 里信任 hook 时 Codex 写下的 `[hooks.state."ms@ms-local:hooks/hooks.json:…"]`。

     别的表都不要动。
   - `~/.codex/plugins/cache/ms-local/` 可能还留着，先看再删。

4. **DSH**：在 DSH 的插件页卸载「Agent Message Switchboard」，然后重启一次 DSH。之后看 desktop profile 里还有没有残留：

   ```bash
   grep -n 'agent-message-switchboard-dsh' ~/.dsh/profiles/desktop/package.json
   ls -la ~/.dsh/profiles/desktop/node_modules/agent-message-switchboard-dsh
   grep -n 'ms-dsh-client' ~/.dsh/profiles/desktop/cordis.patch.yml
   ```

   - `package.json` 里还有 `agent-message-switchboard-dsh`（`dependencies` 里一条，`dsh.profile.bundles` 里一项）时，先退出 DSH，再删掉这两处。
   - `node_modules/agent-message-switchboard-dsh` 是一个指向私有根的符号链接。确认是链接后，用 `rm`（不带 `-r`）删掉它。
   - `cordis.patch.yml` 里只含 `id: ms-dsh-client` 和 `disabled` 的那一项，是插件页的开关留下的，可以删；提到 `ms-dsh-client` 的其他内容，先确认是不是你自己加的。
   - 改完重启一次 DSH。

5. **LaunchAgent**：确认文件在，再删除。

   ```bash
   ls -l ~/Library/LaunchAgents/local.agent-message-switchboard.msd.plist
   rm ~/Library/LaunchAgents/local.agent-message-switchboard.msd.plist
   ```

6. **私有根**：先看里面有什么。

   ```bash
   ls -la "$HOME/Library/Application Support/agent-message-switchboard"
   ```

   - `install/backups/` 里是安装前三家配置文件的逐字节副本。上面几步之后，哪个宿主文件看起来不对，先拿它和备份比一比，需要的话自己拷回去，再删私有根。
   - 想留着通讯录和消息记录的话，先把 `state/` 挪到别处。
   - 确认之后整个删掉。路径里有空格，要加引号：

     ```bash
     rm -rf "$HOME/Library/Application Support/agent-message-switchboard"
     ```

7. **ms 命令**：`npm uninstall -g agent-message-switchboard`。

清理完可以重新 `npm i -g agent-message-switchboard`，再从 `ms install --dry-run` 开始。第 2 节手动装过的插件不在 ms 的账本里，也按上面对应的那一步移除。

## 8. 隐私

**存在这台电脑上的东西。** 都在私有根 `~/Library/Application Support/agent-message-switchboard/` 下，目录只有你自己能读写（0700，文件 0600）：

- `state/directory.json`：通讯录与线路。每个登记过的会话存：Harness、会话 ID、入口（CLI 或桌面）、标题、工作目录、项目根、别名和时间。Claude Code 会话在线期间，还存 msd 为它核验的身份：进程号、可执行文件的路径与 SHA-256、代码签名，以及消息 socket 的路径、inode 与权限；会话下线时清掉。
- `state/messages.jsonl`：每封信一行元数据，包括消息与线路编号、发信方、收信方、时间、投递状态、大小和正文的 SHA-256。**正文从不写盘。** 这些记录一直保留，直到你卸载（带 `--keep-data` 时继续保留）。
- `config.json`：你的设置，以及固定下来的 Python 解释器（路径与 SHA-256）。
- `run/`：socket、act 来信回合的标记（只有会话 ID）、DSH 插件的状态文件。
- `logs/`：msd 的输出。msd 只在出错时往里写，例如起不来时写一行错误码。
- `install/`：安装账本，以及 `ms install` 改动过的宿主文件的逐字节备份（Claude Code 的设置与两个插件注册表、Codex 的 `config.toml`、DSH profile 的 `package.json` 与 `pnpm-lock.yaml`），卸载时用来还原。
- `bundles/`、`claude-marketplace/`、`codex-marketplace/`、`bin/ms`：装好的程序文件。

私有根之外，`ms install` 写 LaunchAgent 的 plist，并在三家登记插件；`ms install --dry-run` 会把每一处都列出来。

**会进入模型服务商的东西。** Switchboard 自己从不调用模型，但各家的会话会：

- 来信的信头和正文会进入收件会话的模型上下文，也就会发给那个 Harness 用的模型服务商。
- 模型查通讯录时，其他已登记会话的标题、别名、会话 ID 和工作目录的绝对路径会返回给这个模型。
- 未回信回执和 act 的拒绝理由里写着发信会话，也会进入模型上下文。

**不上报。** Switchboard 不上报任何东西。`ms`、msd 和插件自己不发任何网络请求：它们之间走私有根里的 Unix socket，`ms ui` 只监听 127.0.0.1。安装和卸载时调用的宿主工具（`claude`、`codex` 命令行和 DSH 自带的 `pnpm`）照它们平常的方式运行。
