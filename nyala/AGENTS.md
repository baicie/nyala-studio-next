# Nyala Product/Runtime Scope

This file applies only under `nyala/` and supplements root `AGENTS.md`.

- Read `docs/nyala-governance/INDEX.md` and `docs/nyala-governance/02-upstream-compatibility.md`.
- `nyala/rpc/v1/` contract is authoritative; any change to methods/errors/types needs compatibility assessment and conformance updates.
- Record real Code OSS upstream changes in `nyala/upstream-base.json`, `nyala/patch-ledger.md`, `nyala/upstream-compatibility.md`; do not update these for governance-document-only changes.
- Never disclose secrets or dump database rows to logs. Keep immutable evidence of schema compatibility tests.
- For Agent gateway tools, enforce connection scope and authorization independently of the harness.
