<!--
Thanks for contributing. Keep the description focused on what changed and how
it was verified; reviewers should not need to reconstruct the motivation.
-->

## Summary

<!-- What does this PR change, and why? Keep it to a few sentences. -->

## Related issue

<!-- Fixes #123, closes #456, or "N/A". -->

## Changes

<!-- Bullet the user-visible and internal changes. Mention affected packages. -->

- Package(s):
- Change:

## Type of change

- [ ] `feat` — new capability or behavior
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `refactor` — behavior-preserving code change
- [ ] `test` — tests only
- [ ] `chore` — build, CI, tooling, or dependencies

## Verification

<!-- List the exact commands and manual checks. Include the DSH version and any
external CLI version that matters for a plugin. -->

- DSH version:
- External CLI / runtime versions:

```sh
pnpm check
pnpm test
```

- [ ] `pnpm check`
- [ ] Package tests (if the package defines them)
- [ ] Installed or linked the plugin and exercised the changed flow
- [ ] Checked the Web GUI flow (or explained why it cannot be checked)

## Screenshots / recordings

<!-- Required for visible UI changes; otherwise write "N/A". -->

## Checklist

- [ ] The change follows the branch workflow in `AGENTS.md` and targets `develop`
- [ ] The affected package's `README.md` is updated when behavior or setup changed
- [ ] The root plugin table is updated for new or renamed packages
- [ ] Built JavaScript under `lib/` is committed for bundle packages
- [ ] No secrets, `.env` files, generated profiles, or `node_modules/` are included
- [ ] New behavior has tests, or the PR explains why a test is not practical

## Breaking changes

<!-- Describe migration steps, or write "None". -->

## Notes for reviewers

<!-- Optional: areas that need extra attention, follow-ups, or known limitations. -->
