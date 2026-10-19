# Nyala Studio

Nyala Studio is a Code OSS based, SQL first desktop IDE. This repository starts from the upstream Code OSS `1.142.0` tag and uses product version `0.0.1-dev.0` for the current development build.

The project design, architecture boundaries, ADRs, and P0 acceptance criteria are in [`docs/nyala-kickoff/`](docs/nyala-kickoff/). The upstream baseline, Node.js version, and package manager are recorded in [`nyala/upstream-base.json`](nyala/upstream-base.json).

Branching and Code OSS synchronization follow [`docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md`](docs/nyala-kickoff/docs/26-branching-and-upstream-sync.md). The stable product branch is `nyala/main`; use `feat/*`, `fix/*`, `sync/code-oss-*`, `security/backport-*`, and `release/*` for short-lived work. The repository does not use `codex/*` branches.

Development uses Node.js `24.18.0` and npm:

```bash
npm install
npm run watch
./scripts/code.sh
```

Nyala retains the upstream MIT license and attribution. External services and distribution settings require the product audit described in [`docs/nyala-kickoff/docs/17-release-compliance.md`](docs/nyala-kickoff/docs/17-release-compliance.md).

## Upstream Code OSS

Nyala Studio is developed from the open-source [Code OSS](https://github.com/microsoft/vscode) `1.142.0` baseline. Upstream source, issue, and contribution guidance remain useful when working on shared Workbench code; Nyala-specific scope and acceptance criteria are maintained in [`docs/nyala-kickoff/`](docs/nyala-kickoff/).

The upstream Code OSS source and the Nyala changes in this repository are available under the MIT license. Microsoft copyright and third-party notices are retained where required by the upstream license.

## Contributing

Please open issues and pull requests in the Nyala Studio repository. Before changing Workbench code, read the project rules in [`AGENTS.md`](AGENTS.md) and the P0 checklist in [`docs/nyala-kickoff/checklists/P0-FIRST-14-DAYS.md`](docs/nyala-kickoff/checklists/P0-FIRST-14-DAYS.md).

## Feedback

Use the repository issue tracker for Nyala Studio bugs, feature requests, and implementation questions. Changes to the upstream Workbench should include the compatibility and regression evidence described in [`nyala/patch-ledger.md`](nyala/patch-ledger.md).

## Bundled Extensions

Nyala Studio includes the built-in extensions under [`extensions/`](extensions), including language grammars, snippets, and debugging support. The three platform debugging extensions pinned in `product.json` are open-source upstream dependencies; they do not enable a Marketplace or Copilot service.

## Development Container

The repository includes the upstream development container configuration as an optional local build aid. It does not enable a hosted Marketplace, synchronization service, or Copilot account.

## Code of Conduct

Nyala Studio follows the project conduct rules in [`AGENTS.md`](AGENTS.md) and the engineering requirements in [`docs/nyala-kickoff/docs/25-engineering-rules.md`](docs/nyala-kickoff/docs/25-engineering-rules.md).

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the [MIT](LICENSE.txt) license.
