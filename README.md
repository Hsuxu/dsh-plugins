# dsh-plugins

A collection of [DeepSeek Harness](https://www.deepseek.com/en/harness/) plugins,
managed as a pnpm monorepo. Each plugin lives in its own package under
`packages/` and can be installed independently.

## Plugins

| Package | Directory | Description |
| --- | --- | --- |
| `dsh-session-recovery` | `packages/session-recovery` | System maintenance: after a restart, resumes sessions whose last turn failed or never finished. |
| `dsh-sidebar-session-status` | `packages/sidebar-session-status` | UI: pins the project of the running Session to the top of the sidebar and tints Session rows by state (active, completed, needs review, interrupted, failed). |

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

## License

[MIT](LICENSE)
