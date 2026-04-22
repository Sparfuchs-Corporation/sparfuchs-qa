# Caveat Emptor — Sparfuchs QA Gaps Analysis

An honest assessment of what the Sparfuchs QA platform can catch, cannot catch, might miss, and where real risks exist.

---

## Executive Summary

| Category | Status | Confidence |
|---|---|---|
| Static code pattern detection | GREEN | HIGH |
| LLM-powered deep analysis | YELLOW | MODERATE-HIGH |
| Quality auditing of LLM outputs | YELLOW | MODERATE |
| Supply chain security | GREEN | MODERATE |
| Platform self-security | GREEN | HIGH |
| Runtime/dynamic behavior | RED | NOT COVERED (by design) |
| Business logic correctness | RED | NOT COVERED (by design) |
| Test account protection | RED | NOT COVERED |
| PII masking | RED | NOT COVERED |

---

## Section 1: What the System Catches Well

### 1.1 Static Code Patterns (HIGH confidence)

16 canaries provide deterministic, fast, repeatable checks:
- Hardcoded credentials (API_KEY, SECRET, PASSWORD, TOKEN patterns)
- RBAC bypass via unguarded routes
- Mock data leaking into production paths
- Empty catch blocks / silent error swallowing
- Zero-coverage source files
- Bundle size regression (threshold 2.5MB)
- Stale React hook closures
- TODO/FIXME density monitoring
- Console.error leak counting
- i18n hardcoded string detection
- Observability coverage (structured logging ratio)

### 1.2 Deep LLM Analysis (MODERATE-HIGH confidence)

9+ Phase 1 agents with quality gates:
- SQL injection, XSS, command injection, path traversal detection
- Authentication weakness detection
- RBAC bypass via request body, open redirect, OAuth state issues
- Workflow integrity validation (Intent-to-Flow)
- Observability gap detection (6-dimension audit)
- Reference document accuracy verification
- Code quality: null dereferences, race conditions, logic errors
- Cross-language contract alignment
- Release gate synthesis with quantified risk scoring

### 1.3 Quality Auditing of LLM Outputs (MODERATE confidence)

- Hallucinated file paths verified against filesystem
- Give-up detection (agent claims inability with zero tool calls)
- Output concatenation detection
- Batched findings detection ("+ N more" patterns)
- Cross-provider semantic audit (different LLM reviews for lazy/incomplete work)
- Output size validation (flags outputs under 500 chars)

### 1.4 Supply Chain Security (MODERATE confidence)

- CycloneDX-lite SBOM generation
- npm audit integration for known CVEs
- Lockfile integrity checking
- npm signature/provenance attestation verification

### 1.5 Platform Self-Security (HIGH confidence)

- OS keychain credential storage (macOS/Windows/Linux)
- Secret redaction in all tool outputs (10+ regex patterns)
- Filesystem jail with symlink resolution (3-root boundary)
- Bash command allowlist (read-only, no destructive ops)
- Environment variable sanitization (whitelist-only: PATH, HOME, NODE_ENV, GIT_*)
- Data classification enforcement (public/internal/restricted)
- Pre-write secret scanning hook
- Protected file list (.env, .pem, .key, lockfiles, .git/*)
- Agent integrity validation via SHA-256 content hashes

### 1.6 Large Codebase Handling (NEW)

- Testability pre-flight scanner (language profiling, uncheckable code detection)
- Automatic chunking for repos >50 files (directory-based grouping, ~25 files/chunk)
- Module scoping (`--module` flag for monorepo subdirectories)
- Agent effectiveness predictions (skip agents that won't produce value)
- Configurable per-agent step budgets
- Coverage tracking per agent per chunk
- Context overflow detection (finishReason checking)

---

## Section 2: Architectural Limitations (BY DESIGN)

### 2.1 No Runtime/Dynamic Analysis — SEVERITY: HIGH

The system is fundamentally static analysis. It reads files, runs grep, relies on LLM comprehension of code structure. It does NOT execute the target application.

**Cannot detect**: runtime crashes, memory leaks under load, race conditions that only manifest under concurrency, database query performance, network timeout handling, connection pool exhaustion, timing-dependent bugs.

**Recommendation**: ACCEPT. Sparfuchs QA is complementary to integration/e2e testing, not a replacement.

### 2.2 No Business Logic Verification — SEVERITY: HIGH

LLMs can identify code patterns but cannot validate that business rules are correctly implemented. A function that applies a 10% discount instead of the correct 15% will not be flagged.

**Cannot verify**: calculation correctness, state machine transitions, workflow ordering, domain-specific invariants, regulatory compliance logic.

**Recommendation**: ACCEPT. Business logic requires human-written test cases with known expected values.

### 2.3 No UI/UX Rendering — SEVERITY: MEDIUM

The `ui-intent-verifier` reads JSX/TSX source code but cannot render it.

**Cannot detect**: visual regressions, layout breaks, z-index issues, CSS specificity conflicts, responsive breakpoint failures, animation bugs, actual screen reader behavior, touch target sizes.

**Recommendation**: MITIGATE with visual regression testing (Percy, Chromatic) as a separate pipeline.

### 2.4 No Concurrency/Distributed System Testing — SEVERITY: MEDIUM

**Cannot detect**: distributed deadlocks, split-brain scenarios, eventual consistency violations, message ordering bugs, idempotency failures, retry storm amplification.

**Recommendation**: ACCEPT. These require chaos engineering and distributed tracing tools.

---

## Section 3: What It Might Miss (Edge Cases)

### 3.1 LLM Non-Determinism — SEVERITY: HIGH

All agents use LLM inference (temperature 0.1, not 0). Two runs on the same codebase may produce different findings. Step limits cap each agent's analysis — large codebases may not get full coverage even with chunking.

**Mitigations in place**: Automatic chunking, configurable step budgets, coverage tracking, quality auditing.

### 3.2 Canary Pattern Limitations — SEVERITY: MEDIUM

- `hardcoded-credential` canary checks 5 specific patterns — misses credentials in YAML/JSON, base64-encoded values, or non-standard naming
- `rbac-bypass` canary checks a single router file — backend route protection not verified
- `mock-data-leak` canary only checks `apps/shell/src/` — backend leaks invisible
- Several canaries silently pass when prerequisite files are missing

### 3.3 Context Window Truncation — SEVERITY: MEDIUM

- Read tool caps at 2000 lines per call — code on line 2001+ is invisible
- Grep results cap at 250 matches — finding 251+ is lost

**Mitigations in place**: Testability scanner detects large files, warns in pre-flight report, excludes from default chunk plan.

### 3.4 Cross-Agent Blind Spots — SEVERITY: MEDIUM

Agents operate independently within their domains. Data flows spanning security, code quality, and contract boundaries may fall between agents. Example: an IDOR vulnerability requires understanding both the route handler (security-reviewer) and the database query (code-reviewer).

**Mitigations in place**: Workflow-extractor traces end-to-end flows, release-gate-synthesizer reads all agent outputs.

### 3.5 Novel Vulnerability Classes — SEVERITY: LOW-MEDIUM

LLM training data has a cutoff. Novel vulnerability classes discovered after training won't be detected unless agent prompts are updated.

---

## Section 4: Risk Scenarios

### 4.1 Plaintext Credentials in /tmp — SEVERITY: CRITICAL — STATUS: MISSING

Credentials collected by the setup wizard are written as plaintext JSON to `/tmp/sparfuchs-qa-creds-{runId}.json`. File mode is 0600 (owner-only) but:
- Any process running as the same user can read the file
- If the process crashes, credentials remain in /tmp indefinitely
- No encryption at rest
- `/tmp` may be shared in containerized environments

**Recommendation**: FIX — encrypt credential files with a session-derived key, implement auto-cleanup watchdog.

### 4.2 No PII Masking in Agent Outputs — SEVERITY: HIGH — STATUS: MISSING

Secret redaction covers API keys, tokens, private keys, and connection strings — but NOT PII patterns (email addresses, phone numbers, SSNs). Agent session logs may contain verbatim PII from the target repository.

**Recommendation**: FIX — add PII regex patterns to the redactSecrets function, implement session log retention policy.

### 4.3 No Production Environment Detection — SEVERITY: HIGH — STATUS: MISSING

No mechanism to detect or block execution against a production environment. If a user provides production credentials via the setup wizard, agents could read production code and send it to external LLM providers.

**Recommendation**: FIX — add environment detection (check for production config, `.env.production`, deployment markers), add confirmation interlock.

### 4.4 No Test Account Isolation — SEVERITY: MEDIUM — STATUS: MISSING

No mechanism to distinguish test accounts from real user accounts:
- No naming convention enforced (e.g., `test-*` prefix)
- No environment-aware credential routing (staging vs. production)
- No warning if a production credential is used in a test context
- No test data lifecycle management (cleanup, TTL, rotation)
- No credential audit trail

**Recommendation**: FIX — add test account tagging, implement post-run cleanup.

### 4.5 Agent Integrity Check is Advisory — SEVERITY: MEDIUM — STATUS: WEAK

Agent hash validation produces a WARNING on mismatch but continues execution. If the hashes file doesn't exist, validation passes silently. An attacker who can modify both the agent file and hashes file bypasses integrity checking.

**Recommendation**: FIX — make integrity validation a hard block, sign the hashes file.

### 4.6 LLM False Confidence — SEVERITY: MEDIUM — STATUS: PARTIAL

Despite quality auditor checks, an agent could report "No issues found" after shallow analysis. The give-up detector only flags agents with *zero* tool calls. An agent making 2 tool calls and reporting clean passes all quality checks.

**Recommendation**: MITIGATE — track finding validation rates (human confirmation percentage), calibrate confidence per agent.

### 4.7 No Session Log Retention Policy — SEVERITY: LOW — STATUS: MISSING

Session logs persist indefinitely with no automatic cleanup. Historical logs could leak credentials or PII if accessed later.

**Recommendation**: FIX — implement configurable retention with automatic deletion.

---

## Section 5: Summary Matrix

| # | Gap | Category | Severity | Status | Action |
|---|---|---|---|---|---|
| 4.1 | Plaintext credentials in /tmp | Data Protection | CRITICAL | MISSING | FIX |
| 4.2 | No PII masking in outputs | Data Protection | HIGH | MISSING | FIX |
| 4.3 | No production detection | Safety | HIGH | MISSING | FIX |
| 2.1 | No runtime analysis | Architecture | HIGH | BY DESIGN | ACCEPT |
| 2.2 | No business logic verification | Architecture | HIGH | BY DESIGN | ACCEPT |
| 3.1 | LLM non-determinism | LLM Limitation | HIGH | MITIGATED | MONITOR |
| 4.4 | No test account isolation | Data Protection | MEDIUM | MISSING | FIX |
| 4.5 | Advisory integrity check | Security | MEDIUM | WEAK | FIX |
| 4.6 | LLM false confidence | LLM Limitation | MEDIUM | PARTIAL | MITIGATE |
| 3.2 | Canary pattern limits | Static Analysis | MEDIUM | PARTIAL | EXPAND |
| 3.3 | Context window truncation | LLM Limitation | MEDIUM | MITIGATED | MONITOR |
| 3.4 | Cross-agent blind spots | Architecture | MEDIUM | MITIGATED | MONITOR |
| 2.3 | No visual rendering | Architecture | MEDIUM | BY DESIGN | COMPLEMENT |
| 2.4 | No concurrency testing | Architecture | MEDIUM | BY DESIGN | ACCEPT |
| 4.7 | No session log retention | Operations | LOW | MISSING | FIX |
| 3.5 | Novel vulnerability classes | LLM Limitation | LOW-MED | INHERENT | UPDATE |

---

## Section 6: Hardening Roadmap

### Phase 1 — Immediate (1-2 weeks)
1. Encrypt credential files at rest with session-derived key
2. Add PII pattern detection to secret redaction
3. Make agent integrity check a hard block
4. Add session log retention policy with auto-cleanup

### Phase 2 — Near-term (2-4 weeks)
1. Production environment detection and interlock
2. Per-agent filesystem jail scoping (restrict analysis agents from session logs)
3. Test account tagging and post-run cleanup
4. Large file chunked reading heuristic

### Phase 3 — Medium-term (1-2 months)
1. Finding validation rate tracking (human confirmation metrics)
2. Data-flow-tracer agent for cross-domain vulnerability tracing
3. Expanded canary patterns and file type coverage
4. Coverage tracking across LLM agent runs with retry on low coverage

---

## Section 7: What Sparfuchs QA Should Never Be Used For

- **Sole security gate** for production deployments — always pair with human security review
- **Replacement for penetration testing** — static analysis cannot find runtime exploits
- **Processing classified/regulated repos** without the `restricted` data classification
- **Runtime application security scanning** — the system does not execute code
- **Compliance certification** (SOC2, HIPAA, PCI-DSS) — the system is a tool, not a certification body
- **Verifying business logic correctness** — requires human-authored test cases with known expected values

---

*This document was generated from a systematic audit of every source file in the sparfuchs-qa repository, tracing execution paths through the orchestrator, examining all canary implementations, reading all agent definitions, and reviewing all security hooks.*
