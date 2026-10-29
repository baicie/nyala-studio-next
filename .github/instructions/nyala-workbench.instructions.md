---
description: 'Nyala SQL-specific Workbench UI contributions and lifecycle rules; supplements Code OSS guidance.'
applyTo: 'src/vs/workbench/contrib/nyala/**,src/vs/workbench/services/nyala/**,extensions/nyala-*/**'
---

# Nyala Workbench Instructions

- Read `docs/nyala-governance/03-architecture-ownership.md`, `04-engineering-style.md` and `09-ui-ux-performance.md`.
- Respect `.github/copilot-instructions.md`, VS Code contribution/DI/Disposable/localization/theme/API conventions; do not fork or replace generic Workbench UX for SQL features.
- Create SQL Editor/Result/Plan as native first-class IDE objects; the active SQL Tab owns an explicit connection context, never global `currentConnection`.
- Use Service APIs and DTOs, not renderer-side DB drivers or secrets. Release Event/Worker/Editor/Result resources on close and reload.
- For inherited upstream paths, add only the minimum possible import/service shim and document the change in `nyala/patch-ledger.md`.
- Report targeted validation and Electron smoke separately from mere compile success.
