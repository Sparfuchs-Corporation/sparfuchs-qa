# Known Limitations & Caveats

This document covers the current known limitations of the framework. We're releasing early and openly because we believe the community is the engine that makes this better — please read this before filing issues or drawing conclusions about expected behaviour.

---

## Framework Maturity

- **This is pre-alpha software.** We wanted to get it into the community's hands so we can build and improve on the framework together. Treat it accordingly.
- This framework is designed to address significant gaps in code quality across a broad range of codebases. It has not been tested against all code types, and gaps in coverage and results should be expected.
- Intent vs. outcome will differ. Community contribution and feedback are the bedrock for improving quality, security, intent alignment, documentation, and training projects.

---

## Agent Behaviour

- **Agent definitions are still under development.** They are functional, but have meaningful room to improve.
- **Agents are largely non-idempotent.** Future versions will deterministically hand agents artifacts to review, which will significantly improve consistency and reproducibility.
- **False positive rates still need improvement.** Results should be treated as guidance, not ground truth.
- **ETA estimates are currently inaccurate.** We know. Improvements are in progress.
- **Token estimates are insufficiently dynamic** and frequently under-estimate actual consumption — often by significant amounts.

---

## Performance & Cost

- **The tool is not yet optimised for token usage or execution time.** Full runs can be expensive and time-consuming — plan accordingly.
- **Concurrency limits vary by model provider.** Running this from within a model shell (Claude Code and OpenAI Codex in particular) will further constrain the number of agents that can run concurrently.
- **API rate limits are real.** Many model providers enforce rate limits, and depending on the service you use, your base account tier may include no API credits at all. Check your provider's limits before running.

---

## CI/CD Integration

- **The CI/CD harness is experimental pre-alpha at best.** It is currently only functional under very specific conditions and should not be relied upon for production pipelines.

---

## Testing & Compatibility

- This has been validated against a limited set of tool versions. Broader compatibility testing is needed — **your help here is vital.**

---

## Security — Please Read

- **Do not store usernames, passwords, or API keys in `.env` files.** Use your OS credential store instead — Keychain on macOS, or BitLocker-protected storage on Windows. The tool is built to check these stores; use this method wherever possible.
- **API inspection mode sends your code to the model provider over the API.** Local CLI mode processes everything in memory on your machine. Understand the distinction and **use API inspection mode at your own risk.**

---

*Have a fix, a finding, or a failure to report? Open an issue or start a discussion — that's exactly why we shipped this early.*
