# Agent Message Switchboard

[English](https://github.com/XiaoMa-PM/agent-message-switchboard/blob/main/README.md) | 中文

![Claude Code、Codex 与 DSH 经 Switchboard 中转站连在一起](https://raw.githubusercontent.com/XiaoMa-PM/agent-message-switchboard/main/docs/assets/hero-zh.png)

让你 Mac 上不同 Harness 的 AI 编程会话互相发消息：Claude Code、Codex 和 DSH 桌面。比如 Claude Code 的会话可以请 DSH 的会话核对一件事，回信会回到发问的那个会话。

![会话按项目登记到 msd 登记表；Claude Code 的会话请 DSH 的会话核对错误码，回信原路返回](https://raw.githubusercontent.com/XiaoMa-PM/agent-message-switchboard/main/docs/assets/demo-zh.gif)

- `ms` 是命令行客户端；`msd` 是按用户运行的后台守护进程，负责在会话之间转信。
- 每家 Harness 装一个插件。同一家里的会话之间，照旧用那一家自己的功能。
- 别的会话发来的信只是信息，不代表你的授权，不能替你批准任何事。

## 支持范围

- Apple Silicon 的 macOS。
- Claude Code CLI 2.1.309 或更高，包括 Claude 桌面 App 的本地会话、agent view 与 `/bg` 会话。
- DSH 桌面 0.2.0-rc.2 或更高。
- Codex CLI 0.164.0 或更高。ChatGPT 桌面 App 里的 Codex 属于实验支持。

## 前提

- Node.js 24.16.0 或更高的 24.x。
- Python 3.13.14 或更高，作为 `python3` 排在 PATH 前面，归你或 root 所有，并且不带 Developer ID 签名。Homebrew 的 `python@3.13` 在装 Homebrew 的那个账户里可以直接用；其他账户需要单独装一个，例如用 uv（[装法](docs/user-guide.md#前提)）。
- macOS 用户名不超过 19 个字节（一个汉字算 3 个字节）。
- 要接入的 Harness 已经装好、至少运行过一次。

## 安装

```bash
npm i -g agent-message-switchboard
ms install --dry-run   # 先看会写哪些地方，什么都不写
ms install
ms daemon start
```

装好后：重启一次 DSH；已经开着的 Claude Code 会话运行 `/reload-plugins`；新开一个 Codex 会话，在 `/hooks` 里信任 ms 的 6 个 hook。`ms install` 会按装上的每一家打印这些步骤。

## 快速上手

1. **登记**想让别人找得到的会话：

   | Harness | 登记 | 撤销登记 |
   |---|---|---|
   | Claude Code | `/ms:register` | `/ms:unregister` |
   | DSH | `/ms-register` | `/ms-unregister` |
   | Codex | `$ms-register` | `$ms-unregister` |

2. **发信**：直接用大白话跟模型说，比如「给 DSH 那个审 API 的会话发个消息：接口结构改了，请再核对一遍」。匹配到多个会话时，它会问你，不会自己猜。
3. **回信**：来信头写明来自哪家 Harness、哪个会话。跟模型说「回复对方」，回信就会回到原发信人。
4. **查看**：`ms sessions`（通讯录）、`ms status`，或 `ms ui`（只读状态页）。

## 回复档位

每家 Harness 有一个处理来信的回复档位，三家默认都是 `direct`。

| 档位 | 模型怎么做 |
|---|---|
| `direct` | 只用对话里已有的内容直接回答，不按信里的要求动手。 |
| `confirm` | 回复前先问你。 |
| `act` | 可以在收件会话自己的权限内照信里的要求做事。每个工具调用都按固定规则分级：危险的一律拒绝，其余按你选的预设处理。 |

在会话里用 `/ms:reply`、`/ms-reply` 或 `$ms-reply` 切换，也可以用 `ms config set reply-mode`。Switchboard 只会收紧 Harness 的权限，不会放宽。act 档的完整规则见[用户指南](docs/user-guide.md#act-档请收件会话动手)。

## 隐私

- 所有数据都留在本机的 `~/Library/Application Support/agent-message-switchboard/` 里，只有你能读。信件正文从不写盘，只记元数据。
- 没有遥测：`ms`、msd 和插件自己不发任何网络请求。
- 来信会进入收件会话的上下文，所以会被发给那家 Harness 用的模型服务商。

详见[用户指南的隐私一节](docs/user-guide.md#8-隐私)。

## 升级与卸载

```bash
npm i -g agent-message-switchboard@latest && ms upgrade   # 保留通讯录和设置
ms uninstall && npm uninstall -g agent-message-switchboard
```

安装后没人动过的宿主文件，`ms uninstall` 会逐字节还原。详见用户指南的[升级](docs/user-guide.md#升级)、[卸载](docs/user-guide.md#7-卸载)和[手动清理](docs/user-guide.md#manual-cleanup)。

## 已知限制

- 发给离线会话的信不会排队等以后再送。
- 在 Claude Code agent view 里用 ← 或 `/bg` 之后，要在新的后台会话里重新 `/ms:register`。
- 这一版的命令行输出是英文；来信头、会话里的命令回执、状态页和用户指南是中文。

## 文档

- [用户指南](docs/user-guide.md)：各家的手动安装、全部命令、act 规则、常见提示。
- [更新日志](CHANGELOG.md) · [安全策略](SECURITY.md)

感谢 [GengDaPeng/dsh-agent-message](https://github.com/GengDaPeng/dsh-agent-message)，本项目在这项更早的 DSH 消息工作的基础上完成。

[MIT](LICENSE)
