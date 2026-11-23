# dsh-cli-bridge

[English](README.md) | **简体中文**

在 DeepSeek Harness 中直接运行 **Claude Code**、**Codex**、**Antigravity CLI**、
**CodeBuddy** 会话。DSH 负责展示、命令、审批与审计，每一轮都由对应 CLI 以自己的
模型、工具和登录状态执行。

这是一个独立的 MIT 插件包，架构参考
[`@cocofhu/dsh-aio-agent`](https://github.com/cocofhu/dsh-aio-agent)（同为
MIT），但不共享其包名、预设 id、HTTP 路由或数据。

## 支持的 Agent

| Agent | 可执行文件 | 登录 | 模型来源 |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude auth login` | 内置 Claude 别名 |
| Codex | `codex` | `codex login` | `~/.codex/models_cache.json` |
| Antigravity | `agy` | `agy acp --login`（或交互运行一次 `agy`） | `agy models` |
| CodeBuddy | `codebuddy` | 运行 `codebuddy` 后输入 `/login` | 内置 CodeBuddy 别名 |

四个 Agent 各自是独立的插件行，可以单独启用。

## 安装

要求：支持 bundle 的 DSH、Node.js 22+、目标 CLI 在 `PATH` 中（或在设置页填写
启动命令）。

在 `dsh-plugins` monorepo 根目录中，打开 **插件 → 添加插件** 并选择
`packages/cli-bridge`，或在终端执行：

```powershell
dsh plugin --profile web add link:./packages/cli-bridge
```

启用 **CLI Bridge** 下的行，然后新建会话。每个 Agent 的设置页（插件 → CLI
Bridge → 对应行）会显示 CLI 是否可运行、模型数量以及安装/登录步骤。

## 使用

1. 打开模型选择器，选择 **Claude Code**、**Codex**、**Antigravity** 或
   **CodeBuddy** 下的模型，会话即切换到该 Agent 预设。
2. 发送消息。每轮都会在会话工作区启动对应 CLI，把输出流式写回 DSH，并记录工具
   调用与结果。
3. 随时可在选择器中切换 Agent 或模型，下一轮即生效。

### 命令

输入框中的命令会转发给当前 CLI：

- `/resume` —— 选择历史 CLI 会话（当前工作区优先）。`/resume <id>` 绑定该会话，
  后续轮次会传 `--resume`、`codex exec resume` 或 `--conversation`。
- `/agent <内容>` —— 把任意一行作为下一轮提示词发给 CLI。插件不认识的命令或技能
  都可以用它。
- `/quota` —— 查询 Claude Code 或 Codex 已登录账号的订阅额度。Codex 通过
  `codex app-server` 的 `account/rateLimits/read` 读取；Claude Code 读取 OAuth
  用量接口。设置页也会显示同一份快照，并提供刷新按钮。
- **已验证的原生命令** —— 只注册在该 CLI 无头/print 模式下确实能执行的命令
  （见下一节）。模型选择仍由 DSH 的模型选择器负责，因此 `/model` 是 DSH 自己的
  命令。
- **自定义命令与技能** —— 从 `.dsh/skills`、`.agents/skills`、`.claude/skills`、
  `.claude/commands`、`.cursor/skills`、`.codex/skills`、`.gemini/skills`、
  `.gemini/antigravity-cli/skills`、`.opencode/skills`、`.codebuddy/skills`、
  `.kimi/skills`（项目与用户目录）发现。`/技能名` 会把技能内容注入发给 CLI 的
  提示词，因此即使 CLI 本身不扫描该目录也能生效。
- **委派工具** —— `delegate_claude_code`、`delegate_codex`、
  `delegate_antigravity`、`delegate_codebuddy` 让 DSH 模型把单个任务交给另一个
  CLI 并取回最终答案。

### 命令支持

只注册在该 CLI 的 print 模式下确实会执行的命令；其余命令仍可通过 `/agent` 转发。

| 命令 | Claude Code | Codex | Antigravity | CodeBuddy |
| --- | --- | --- | --- | --- |
| `/resume` | 插件实现 | 插件实现 | 插件实现 | 插件实现 |
| `/agent <内容>` | 插件实现 | 插件实现 | 插件实现 | 插件实现 |
| `/quota` | 订阅额度 | 订阅额度 | — | — |
| `/cli-compact` | 转发（已实测） | — | 转发（文档说明） | 转发（文档说明） |
| `/config`、`/usage`、`/context`、`/cost` | 转发（已实测） | — | `/config`、`/usage`、`/context` 有文档 | `/config`、`/context`、`/cost` 有文档 |
| `/status`、`/skills`、`/permissions`、`/help` | print 模式下**不可用** | `codex exec` 没有斜杠命令层 | 文档称 print 模式会展开 | 文档称 print 模式会展开 |
| `/compact` | DSH 自身压缩（不影响 CLI 上下文） | 同上 | 同上 | 同上 |
| `/model` | DSH 模型选择器 | DSH 模型选择器 | DSH 模型选择器 | DSH 模型选择器 |

说明：

- **Claude Code**：针对 Claude Code 2.1.329 验证。`/config`、`/usage`、`/context`、
  `/cost`、`/compact` 会作为本地命令执行；`/status`、`/skills`、`/permissions`、
  `/help` 返回“isn't available in this environment”，因此不注册。
- **Codex**：`exec` 没有斜杠命令层，因此不注册原生命令；技能仍通过插件注入内容
  生效。
- **Antigravity**：CLI 文档称 print 模式会展开斜杠命令，但本插件不附带 `agy`，
  这部分只有文档依据，尚未验证。
- **CodeBuddy**：2.185.0 会在 print 模式的 `init` 事件里列出可用的斜杠命令；转发
  名单来自该列表，实际执行尚未验证。print 模式无法完成交互式登录：先运行一次
  `codebuddy` 并输入 `/login`，或在 DSH 进程环境中设置 `CODEBUDDY_API_KEY`
  （中国版另需 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`）。
- **额度**：Codex app-server 返回 ChatGPT 套餐、5 小时/每周窗口以及历史/今日
  token 用量；Claude Code 读取 OAuth 用量接口，并追加本地 `/usage` 的 token 与
  缓存计数。两种查询都不会启动模型回合。Claude Code 若使用自定义
  `ANTHROPIC_BASE_URL`，就没有可读的订阅额度，`/quota` 会说明原因，同时仍显示
  本地 token/缓存行。额度面板位于每个设置页底部。
- `/compact` 压缩的是 DSH 会话日志；CLI 有自己的上下文存储。需要压缩 CLI 上下文时
  用 `/cli-compact`（CLI 支持时），或 `/agent /compact`。

### 设置

每个 Agent 行包含：

- **状态** —— 是否可运行、模型数量、安装/登录步骤与“重新检测”。
- **默认模型** —— 会话未显式选择时使用的模型。
- **启动命令** —— 替换可执行文件，后面的选项会保留；含空格的路径请加引号。
- **批准权限请求** —— `allow` 自动批准 CLI 的权限询问，`deny` 拒绝。CLI 自身
  设置仍会约束其自行执行的操作。

设置保存在 profile 配置中，下一轮生效，无需重载。

## 诊断

会话日志会在 `plugin:dsh-cli-bridge/stream`、`/permission`、`/trace`、`/acp`
下记录每条流、权限与绑定事件。设置页可生成诊断报告（Agent/CLI 版本、argv、退出
码、stderr、最近事件帧）并链接到
<https://github.com/dsh-cli-bridge/dsh-cli-bridge/issues/new>。

## 限制

- **仅 print/JSON-stream 模式**，不维持长驻 ACP 客户端；每轮一个进程。
- 内置斜杠命令会转发给 CLI，但具体某个命令在无头模式下是否展开由该 CLI 决定；
  不确定时使用 `/agent`。
- Codex 与 Antigravity 的图片以临时文件路径传入；Claude Code 通过 stdin 接收
  base64 图片块。
- DSH 的输入框访问模式不会限制外部 CLI 自己的工具；Agent 行的“批准权限请求”
  才会。
- 本插件不安装 Antigravity CLI。设置页会给出安装命令；安装并登录前，其模型不会
  出现在选择器中。插件也会直接解析 `%LOCALAPPDATA%\agy\bin\agy.exe`，安装后
  无需更新 DSH 进程的 PATH。
- `/quota` 需要真实的订阅登录：Codex 使用 `codex login`，Claude Code 使用 OAuth
  的 `claude auth login`。自定义 `ANTHROPIC_BASE_URL`（例如本地网关）会使
  Claude 订阅额度不可用。

## 开发

```powershell
pnpm --filter dsh-cli-bridge test   # 单元测试（进程内 runner）
pnpm --filter dsh-cli-bridge check
```

目录：`lib/backends.js`（argv/env/模型发现）、`lib/*-stream.js`（CLI JSON →
DSH 事件）、`lib/turn-writer.js`（事件写入）、`lib/driver.js`（轮次循环与命令）、
`lib/subagent.js`（委派）、`lib/client.js`（浏览器 UI）、`cordis.patch.yml`
（插件行）。

## 许可证

MIT。详见 [LICENSE](LICENSE)；改编来源见 `NOTICE`。
