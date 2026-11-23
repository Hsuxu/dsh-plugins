# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes, merged with this
repository's project-specific rules.

DO NOT send optional commentary.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial
tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes,
simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it
work") require constant clarification.

## 5. Document Complex Tasks

For tasks that appear moderately complex—such as those involving multiple
steps, multiple files, or upfront planning—create a Markdown task document
under `docs/tasks/` before starting implementation. Name the file
`YYYY-MM-DD_{task}.md`, including the task date. This document should serve as
the single source of truth for the task.

The document must include:

* **Background / Context**: The requirement, purpose, root cause, or triggering scenario.
* **Goals / Approach**: The expected deliverables, overall plan, implementation path, list of changes, affected file paths, and pipeline relationships.
* **Verification**: How correctness will be confirmed, such as static checks, single-case or small-sample tests, and regression tests.
* **TODO**: Break the work into checkable steps and update their completion status in real time as the task progresses.

During implementation, especially after completing each major phase, return to
the document and update it:

* Check off completed TODO items.
* Revise the relevant sections whenever the implementation plan changes.
* Ensure the document always remains consistent with the actual state of the code.

## 6. Branch Workflow

**Never commit directly to `main`.** `main` is the integration and release
branch; every change starts on a new branch cut from it.

- Sync `main` before branching:

  ```
  git fetch origin
  git switch main && git pull --ff-only
  ```

- Name the branch by change type, with a short kebab-case slug:

  | Prefix | Use for |
  | --- | --- |
  | `feat/` | New capability or behavior |
  | `fix/` | Bug fix |
  | `docs/` | Documentation only |
  | `chore/` | Build, CI, tooling, dependencies |
  | `refactor/` | Behavior-preserving code change |
  | `test/` | Tests only |

  Example: `git switch -c fix/session-recovery-idle-resume`.

- Merge back into `main` through a pull request. CI
  (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile` and
  `pnpm check` on `main` and on every pull request.

- After the pull request merges successfully, delete the source branch. Remove
  its worktree first if it has one, then delete both the remote and local
  branches:

  ```
  git worktree remove .agents/worktrees/<branch>   # only if a worktree exists
  git push origin --delete <branch>
  git branch -d <branch>
  ```

- For parallel work, use the git worktrees under `.agents/worktrees/`
  (git-ignored).

## 7. Repository Rules

This repository is a pnpm monorepo that collects installable DeepSeek Harness
(DSH) plugins. Each plugin is one package under `packages/`.

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

## 8. Layout

- `packages/<plugin-name>/` — one installable bundle.
- `scripts/new-plugin.mjs` — scaffold.
- `scripts/check-workspace.mjs` — manifest and entry-point validation.
- `.github/workflows/ci.yml` — install and check on every push and pull request.

## 9. Commit Style

Use short conventional subjects such as `feat(<plugin>): ...`,
`fix(<plugin>): ...`, `docs: ...`, or `chore: ...`.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer
rewrites due to overcomplication, and clarifying questions come before
implementation rather than after mistakes.
