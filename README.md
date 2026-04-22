# Sparfuchs QA

Sparfuchs QA is a TypeScript-based multi-agent QA toolkit for running canaries, orchestrated repository reviews, documentation generation, and credential-aware authenticated testing.

## Status

Early public release. The installer and bootstrap flow are safe and repo-relative; the QA review, canary, and orchestration toolchain are under active development.

## Prerequisites

- **Node.js ≥ 22** (see `engines` in `package.json`)
- **Git** for git-backed targets; non-git targets are supported via the `--accept-no-git` flag (or `ACCEPT_NO_GIT=1` when invoked through `make`)
- **AI access** — at least one of the following, configured before a QA review can run:
  - An API key for any of the supported API providers (xAI, Google Generative AI, Anthropic, OpenAI) — store it in your OS keychain with `make qa-keys-setup`, OR
  - A supported AI CLI on your `PATH`: `claude`, `gemini`, `codex`, or `openclaw` (the CLI handles its own authentication)

## Usage

```bash
make qa-setup
make qa-quick
make qa-review REPO=/path/to/target/repo
```

For direct CLI use, `qa-review` supports Claude in direct mode and Codex through the orchestrated engine path with `ENGINE=orchestrated PROVIDER=codex-cli`. In orchestrated mode, the selected `PROVIDER` drives the live status provider label consistently, including agents that are skipped before execution.

## Data handling and provider egress

This toolkit analyzes source code by passing it to AI providers. What leaves the local machine depends on which provider is selected:

| Provider type | Examples | Network egress | Notes |
|---|---|---|---|
| **CLI providers** | `claude`, `gemini`, `codex`, `openclaw` | Controlled by the CLI itself | This toolkit does not intercept or log the payload. The vendor CLI sends data to its own service. |
| **API providers** | `xai`, `google`, `anthropic`, `openai` | Yes — via the in-process auth proxy in `lib/orchestrator/auth-proxy.ts` | Source-file contents, grep / find results, and agent delegation prompts are sent to the provider API over HTTPS. API keys are pulled from the OS keychain at runtime and never written to disk. |
| **Local-only components** | canaries, finding deduplication, markdown report generators | None | Run entirely in-process on the local machine. |

All QA run artifacts — `findings-final.json`, `delta.json`, `meta.json`, and the markdown reports — are written locally under `qa-data/<project>/runs/<runId>/`. This toolkit does not push them to any external service.

## Key Paths

- `canaries/` — QA canary checks
- `scripts/` — QA orchestration and reporting scripts
- `lib/` — Shared orchestration, credential, and Firestore-client logic
- `rules/` — Rule sets used by QA agents
- `config/` — Configuration (`models.yaml`, agent-hash manifest)
- `docs/` — Onboarding, architecture, quickstart, and testing guides

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Please report security issues privately per [SECURITY.md](./SECURITY.md).

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
