# dsh-plugins

[English](#dsh-plugins) · [简体中文](#简体中文)

A collection of [DeepSeek Harness](https://www.deepseek.com/en/harness/) plugins,
managed as a pnpm monorepo. Each plugin lives in its own package under
`packages/` and can be installed independently.

## Plugins

| Package | Directory | Description |
| --- | --- | --- |
| `dsh-session-recovery` | `packages/session-recovery` | System maintenance: after a restart, resumes sessions whose last turn failed or never finished. |
| `dsh-sidebar-session-status` | `packages/sidebar-session-status` | UI: pins the active project to the top of the sidebar and tints Session rows by state (active, completed, needs review, failed). |
| `dsh-cli-bridge` | `packages/cli-bridge` | CLI bridge: runs Claude Code, Codex, Antigravity CLI, and CodeBuddy sessions in DSH, with delegation tools and per-agent settings. |

## Layout

```text
dsh-plugins/
├── packages/                 # one installable DSH bundle per directory
│   └── <plugin-name>/
│       ├── package.json      # declares dsh.bundle.patch
│       ├── cordis.patch.yml  # plugin rows added to a profile
│       ├── lib/index.js      # plugin entry point
│       └── README.md
├── scripts/
│   ├── new-plugin.mjs        # scaffold a plugin package
│   └── check-workspace.mjs   # validate package manifests and entry points
├── .github/workflows/ci.yml
├── pnpm-workspace.yaml
└── package.json
```

## Requirements

- Node.js 22 or newer
- pnpm 12 or newer
- A DeepSeek Harness installation with bundle support

## Develop

```sh
pnpm install
pnpm new my-plugin
pnpm check
```

Install a plugin from this checkout as a link:

```sh
dsh plugin --profile web add link:./packages/my-plugin
```

Restart the profile after changing plugin code. Do not commit `node_modules/`,
`.env` files, or profile credentials.

## Plugin conventions

Each package under `packages/` is an installable **bundle**:

- `package.json` declares `dsh.bundle.patch` and points `main` at the shipped
  JavaScript file.
- `cordis.patch.yml` inserts the plugin rows the bundle contributes.
- `lib/index.js` exports the Cordis plugin (`name`, `apply`, and optionally
  `Config`). Commit the built JavaScript so `link:` and `git:` installs work
  without a build step.
- The package name is `dsh-<plugin-name>` unless a published npm scope is
  adopted.
- Keep the plugin table in this README up to date.

## Publishing

Remove `"private": true` from the plugin's `package.json`, set the final npm
scope, then publish from the package directory:

```sh
pnpm --filter dsh-my-plugin publish
```

## 简体中文

[DeepSeek Harness](https://www.deepseek.com/zh/harness/) 插件集合，使用 pnpm
monorepo 管理。每个插件位于 `packages/` 下独立的包中，可以单独安装。

### 插件

| 包名 | 目录 | 说明 |
| --- | --- | --- |
| `dsh-session-recovery` | `packages/session-recovery` | 系统维护：DSH 重启后，自动恢复上一轮失败或未完成的会话。 |
| `dsh-sidebar-session-status` | `packages/sidebar-session-status` | 界面：将当前项目固定在侧边栏顶部，并按状态（进行中、已完成、待复核、失败）为会话行着色。 |
| `dsh-cli-bridge` | `packages/cli-bridge` | CLI 桥接：在 DSH 中运行 Claude Code、Codex、Antigravity CLI、CodeBuddy 会话，提供委派工具和各 Agent 设置页。 |

### 目录结构

```text
dsh-plugins/
├── packages/                 # 每个目录一个可安装的 DSH bundle
│   └── <plugin-name>/
│       ├── package.json      # 声明 dsh.bundle.patch
│       ├── cordis.patch.yml  # 向 profile 插入插件行
│       ├── lib/index.js      # 插件入口
│       └── README.md
├── scripts/
│   ├── new-plugin.mjs        # 生成插件包脚手架
│   └── check-workspace.mjs   # 校验包清单和入口
├── .github/workflows/ci.yml
├── pnpm-workspace.yaml
└── package.json
```

### 环境要求

- Node.js 22 或更高版本
- pnpm 12 或更高版本
- 支持 bundle 的 DeepSeek Harness 安装

### 开发

```sh
pnpm install
pnpm new my-plugin
pnpm check
```

以链接方式安装本仓库中的插件：

```sh
dsh plugin --profile web add link:./packages/my-plugin
```

修改插件代码后需重启 profile。不要提交 `node_modules/`、`.env` 文件或 profile 凭据。

### 插件约定

`packages/` 下的每个包都是一个可安装的 **bundle**：

- `package.json` 声明 `dsh.bundle.patch`，并将 `main` 指向随包发布的 JavaScript 文件。
- `cordis.patch.yml` 插入该 bundle 提供的插件行。
- `lib/index.js` 导出 Cordis 插件（`name`、`apply`，可选 `Config`）。请提交构建后的 JavaScript，确保 `link:` 和 `git:` 安装无需构建步骤即可使用。
- 除非采用已发布的 npm scope，包名使用 `dsh-<plugin-name>`。
- 新增或重命名插件后，请同步更新本 README 中的插件表。

### 发布

移除插件 `package.json` 中的 `"private": true`，设置最终的 npm scope，然后在包目录中发布：

```sh
pnpm --filter dsh-my-plugin publish
```

## License

[MIT](LICENSE)
