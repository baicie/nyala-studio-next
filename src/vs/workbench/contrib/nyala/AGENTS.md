# Nyala Workbench Scope

This file applies only under `src/vs/workbench/contrib/nyala/` and supplements the repository root `AGENTS.md` and upstream `.github/copilot-instructions.md`.

- Keep Nyala-specific UI as Workbench contributions; do not rewrite generic Editor/Workbench services for view-level requirements.
- Read `docs/nyala-governance/03-architecture-ownership.md`, `04-engineering-style.md`, `09-ui-ux-performance.md`.
- Bind SQL tabs to explicit connection/session identity, use native DI/Disposable/localize/theme/Codicon conventions.
- No DB passwords, direct DB connection or arbitrary unbounded results in Renderer.
- When changing upstream-tracked entry points, record patch intent and targeted regression evidence.
