<!-- Nyala PRs target nyala/main. See docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md and docs/nyala-governance/INDEX.md. -->

## Change

- Branch type: `feat/*` / `fix/*` / `sync/code-oss-*` / `security/backport-*` / `release/*`
- Issue / Backlog ID:
- Summary:

## Validation

- Commands run:
- Platform and Node/npm version:
- Desktop/Web smoke result:
- Checks not run and reason: (use PASS / FAIL / BLOCKED / NOT RUN)
- Evidence link (run, log, screenshot):

## Upstream sync fields

<!-- Complete this section for sync/* or security/backport/* branches. -->

- Old upstream Tag/SHA:
- New upstream Tag/SHA or commit:
- Conflict files and resolution:
- Product service / license audit:
- Updated `nyala/upstream-base.json`, Patch Ledger, and compatibility report:

## Review checklist

- [ ] This PR targets `nyala/main` and does not rewrite its history.
- [ ] No `codex/*` branch or direct `upstream/main` merge is involved.
- [ ] Tests and unrun checks are recorded.
- [ ] User-visible behavior, docs, ADR, or Backlog entries are updated as needed.

## Reviewer focus (Nyala)

- [ ] Upstream mergeability / Patch Ledger updated when upstream-tracked files change.
- [ ] Runtime or SQL surface: connection identity, cancellation, and ResultHandle release are covered.
- [ ] Database privilege and connection isolation reviewed; no secret or row data in logs.

## Rollback

- Procedure and state migration impact:
