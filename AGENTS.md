# Nyala Studio Agent Instructions

These instructions apply to the entire Nyala Studio repository. The repository is a Code OSS product fork, so retain the upstream engineering conventions in [`.github/copilot-instructions.md`](.github/copilot-instructions.md) and apply the Nyala constraints below.

## Project sources of truth

- Read [`docs/nyala-kickoff/START-HERE.md`](docs/nyala-kickoff/START-HERE.md) before making cross-cutting changes.
- Treat [`docs/nyala-kickoff/docs/25-engineering-rules.md`](docs/nyala-kickoff/docs/25-engineering-rules.md) as the engineering and architecture red-line list.
- Treat [`docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md`](docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md) as the authoritative branch and Code OSS synchronization process.
- Update the relevant design/ADR, test matrix, and roadmap/backlog entry when a change introduces a new domain capability or changes an existing contract.

## Branch and upstream rules

- `nyala/main` is the only stable product mainline and the default PR target.
- Use `feat/<topic>`, `fix/<topic>`, `security/backport-<id>`, `sync/code-oss-<tag>`, `release/<version>`, or `experiment/<topic>` for short-lived work. Do not create or recommend `codex/*` branches.
- Do not force-push, rebase, reset, or rewrite the history of `nyala/main`. Merge changes through a reviewed PR.
- The `upstream` remote is read-only. Synchronize from explicit Code OSS release tags; never merge `upstream/main` directly into Nyala.
- A Code OSS sync must record the old/new tag and SHA and update `nyala/upstream-base.json`, `nyala/patch-ledger.md`, and `nyala/upstream-compatibility.md`.

## Nyala architecture boundaries

- Preserve Code OSS layering and solve Nyala behavior in Nyala contributions, services, extensions, or Rust runtime before modifying upstream core.
- All Nyala database execution goes through the Rust SQL runtime. Renderer code and extensions must not hold long-lived secrets, connect directly to databases, or bypass query authority.
- Cross-process contracts must be versioned, framed, schema-validated, and use structured errors with explicit cancellation and resource release. Do not serialize unbounded result sets through IPC.
- Keep Electron/Node/Tauri details behind adapters; Rust domain code must remain runtime-neutral.
- Manage every Contribution, listener, model, view, webview, worker, and sidecar lifecycle with a clear owner and disposal/shutdown path.
- Do not assume a Microsoft-hosted service, Marketplace, Copilot/Agent integration, telemetry, authentication, or update endpoint is valid for Nyala. Audit product configuration and actual call paths before enabling or retaining one.

## Implementation and validation

- Follow the Code OSS TypeScript, DI, localization, layering, and disposable rules in `.github/copilot-instructions.md`; use existing APIs and patterns before adding abstractions.
- Keep changes scoped. Do not combine upstream synchronization, SQL features, and unrelated refactors in one PR.
- Choose validation proportional to risk. For Workbench or product-entry changes, run the smallest relevant compile/typecheck/tests plus an Electron smoke check when available. For upstream sync, run the full documented sync checks.
- Record skipped checks and their reason. Before committing, run `git diff --check` and verify no generated or temporary files are included.

## Nyala governance supplement

- Nyala-specific governance index: [`docs/nyala-governance/INDEX.md`](docs/nyala-governance/INDEX.md); it supplements the sources of truth above and never replaces them.
- Code OSS upstream syncs must preserve tagged Git ancestry through a merge commit; ordinary Nyala feature PRs may squash.
- Report evidence as PASS / FAIL / BLOCKED / NOT RUN; a CI job blocked by billing or a missing runner is neither a code failure nor a passing gate.
