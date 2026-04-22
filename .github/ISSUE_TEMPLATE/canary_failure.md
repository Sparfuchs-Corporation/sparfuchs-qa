---
name: Canary failure
about: A QA canary check is producing false positives or incorrect results
title: "[Canary] "
labels: canary, quality
assignees: ''
---

## Canary
Which check is misfiring (e.g., `security`, `code-quality`, `rbac`)?

## Finding tag
The `[TAG]` from the finding output:

## Failure mode
- [ ] False positive — flags a valid pattern
- [ ] False negative — misses a real issue
- [ ] Crashes / throws
- [ ] Wrong severity

## Reproduction
Paste the minimal input that triggers the issue.

## Expected output
What the canary should have reported.

## Actual output
What it actually reported.
