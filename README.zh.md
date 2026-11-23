# dsh-plugins

[English](README.md) | **简体中文**

[DeepSeek Harness](https://www.deepseek.com/zh/harness/) 插件集合，使用 pnpm
monorepo 管理。每个插件位于 `packages/` 下独立的包中，可以单独安装。

## 插件

| 包名 | 目录 | 说明 |
| --- | --- | --- |
| `dsh-session-recovery` | `packages/session-recovery` | 系统维护：DSH 重启后，自动恢复上一轮失败或未完成的会话。 |
| `dsh-sidebar-session-status` | `packages/sidebar-session-status` | 界面：将运行中会话所属项目固定在侧边栏顶部，并按状态（进行中、已完成、待复核、中断、失败）为会话行着色。 |
| `dsh-cli-bridge` | `packages/cli-bridge` | CLI 桥接：在 DSH 中运行 Claude Code、Codex、Antigravity CLI、CodeBuddy 会话，提供委派工具和各 Agent 设置页。 |

## 目录结构

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

## 环境要求

- Node.js 22 或更高版本
- pnpm 12 或更高版本
- 支持 bundle 的 DeepSeek Harness 安装

## 开发

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

## 插件约定

`packages/` 下的每个包都是一个可安装的 **bundle**：

- `package.json` 声明 `dsh.bundle.patch`，并将 `main` 指向随包发布的 JavaScript 文件。
- `cordis.patch.yml` 插入该 bundle 提供的插件行。
- `lib/index.js` 导出 Cordis 插件（`name`、`apply`，可选 `Config`）。请提交构建后的 JavaScript，确保 `link:` 和 `git:` 安装无需构建步骤即可使用。
- 除非采用已发布的 npm scope，包名使用 `dsh-<plugin-name>`。
- 新增或重命名插件后，请同步更新本 README 中的插件表。

## 发布

移除插件 `package.json` 中的 `"private": true`，设置最终的 npm scope，然后在包目录中发布：

```sh
pnpm --filter dsh-my-plugin publish
```

## 许可证

[MIT](LICENSE)
