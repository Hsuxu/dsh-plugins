# Repository guide for agents

This repository is a pnpm monorepo that collects installable DeepSeek Harness
(DSH) plugins. Each plugin is one package under `packages/`.

## Rules

- Add a plugin with `pnpm new <plugin-name>`; do not hand-create a package
  directory unless the scaffold cannot express the plugin.
- Every package must be an installable DSH bundle:
  - `package.json` declares `dsh.bundle.patch` and a `main` entry under `lib/`.
  - `cordis.patch.yml` inserts the plugin rows.
  - `lib/index.js` exports `name` and `apply`.
  - `README.md` documents install, configuration, and permissions.
- Commit the built JavaScript in each package's `lib/` directory. Consumers
  install through `link:` or `git:`, so a missing build step must not break
  installation.
- Keep package names unique. Use `dsh-<plugin-name>` unless the repository
  adopts a published scope.
- Update the plugin table in the root `README.md` when adding or renaming a
  package.
- Never commit credentials, `.env` files, generated profiles, or `node_modules/`.
- Run `pnpm check` before committing. Run `pnpm build` and `pnpm test` for
  packages that define those scripts.

## Layout

- `packages/<plugin-name>/` — one installable bundle.
- `scripts/new-plugin.mjs` — scaffold.
- `scripts/check-workspace.mjs` — manifest and entry-point validation.
- `.github/workflows/ci.yml` — install and check on every push and pull request.

## Commit style

Use short conventional subjects such as `feat(<plugin>): ...`,
`fix(<plugin>): ...`, `docs: ...`, or `chore: ...`.
