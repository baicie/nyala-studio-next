---
description: 'Nyala-specific PR, upstream-sync, docs and CI governance, without replacing Code OSS development rules.'
applyTo: 'docs/nyala-governance/**,docs/nyala-kickoff/**,nyala/upstream-*.json,nyala/patch-ledger.md,.github/workflows/nyala-*.yml,.github/pull_request_template.md'
---

# Nyala Process Instructions

- Read `docs/nyala-governance/INDEX.md` and the existing authority `docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md`.
- Preserve upstream tag ancestry: `sync/code-oss-*` requires true git merge + PR merge commit, never squash; regular Nyala PRs generally squash.
- Do not overwrite `.github/copilot-instructions.md`, existing `.github/instructions/*`, Code OSS workflows, base/editor source or npm/toolchain configuration.
- Only report checks as PASS if actually executed; a CI job blocked by billing/runner is BLOCKED, not code FAIL nor PASS.
- Do not update upstream-base/tag or patch counts for a docs-only governance installation.
