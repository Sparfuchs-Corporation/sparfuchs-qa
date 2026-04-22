# Sparfuchs QA

Sparfuchs QA is a TypeScript-based multi-agent QA toolkit for running canaries, orchestrated repository reviews, documentation generation, credential-aware authenticated testing, and Firestore-backed reporting workflows.

## Status

Early public release. The installer and bootstrap flow are safe and repo-relative; the QA review, canary, and orchestration toolchain are under active development.

## Usage

```bash
make qa-setup
make qa-quick
make qa-review REPO=/path/to/target/repo
```

For direct CLI use, `qa-review` supports Claude in direct mode and supports Codex through the orchestrated engine path with `ENGINE=orchestrated PROVIDER=codex-cli`. In orchestrated mode, the selected `PROVIDER` drives the live status provider label consistently, including agents that are skipped before execution.

## Key Paths

- `canaries/` — QA canary checks
- `scripts/` — QA orchestration and reporting scripts
- `lib/` — Shared Firestore, orchestration, and credential logic
- `rules/` — Rule sets used by QA agents
- `config/` — Configuration
- `docs/` — Onboarding, architecture, quickstart, and testing guides

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Please report security issues privately per [SECURITY.md](./SECURITY.md).

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
