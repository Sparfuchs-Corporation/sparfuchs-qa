# Severity Rubric — Authoritative Definition
All agents and skills MUST follow this exact severity scale. Do not invent, escalate, or reinterpret severities.

## Critical
- Will cause production outage, data loss, security breach, or major compliance violation if left unfixed.
- Examples: build failure, unhandled crash in auth/payment/critical path, broken contract that breaks frontend, missing migration for a used table, RBAC bypass, swallowed error in critical path, identity mismatch in access control.

## High
- Significant risk of user impact, data inconsistency, or security vulnerability.
- Examples: major performance regression, missing index on hot query path, incorrect but non-breaking permission logic, flaky test in core path, contract drift on active endpoint, unhandled edge case in user-facing flow.

## Medium
- Noticeable problem that should be fixed in the next sprint, but does not block shipping.
- Examples: inconsistent error formats, missing observability on non-critical endpoint, minor code duplication, deprecated dependency, UX friction that doesn't break functionality, minor naming inconsistency.

## Low
- Minor improvement, cleanup, or nice-to-have. No immediate user or business impact.
- Examples: dead code that is never called, extra whitespace, outdated comment, low-priority test coverage gap.

## Informational / None
- Purely informational. No action required.
- Examples: intentional demo data, properly gated "Coming Soon" feature, documented workaround.

**Strict Rules for All Agents:**
- A finding can only be marked Critical if it meets the Critical definition above.
- Never escalate a Medium to High (or High to Critical) simply because it was not fixed yet.
- Do not re-report fixed items from previous runs unless the fix introduced a new regression.
- When in doubt, default to the lower severity.
