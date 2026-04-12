---
name: pre-push-check
description: Multi-platform pre-push validation — catches CI/CD build failure patterns across GCP, AWS, Azure, and GitHub Actions before pushing
argument-hint: "[path to target repo — defaults to TARGET_REPO env or cwd]"
disable-model-invocation: true
allowed-tools:
  - Bash(npx tsc *)
  - Bash(git *)
  - Bash(ls *)
  - Read
  - Glob
  - Grep
---

Run a fast pre-push validation gate that catches the most common CI/CD build failure patterns before code is pushed. Works across GCP Cloud Build, AWS CodeBuild, Azure DevOps Pipelines, and GitHub Actions.

## Step 0: Determine Target Repo

- If `$ARGUMENTS` is provided, use it as the repo path
- Otherwise use `$TARGET_REPO` environment variable
- Otherwise use the current working directory
- Validate it is a git repo: run `git -C <repo> rev-parse --is-inside-work-tree`
- Show the current branch and unpushed commits:
  ```
  git -C <repo> log origin/$(git -C <repo> branch --show-current)..HEAD --oneline 2>/dev/null
  ```
- If no unpushed commits, tell the user and ask if they still want to run checks

## Step 1: Detect CI/CD Platforms

Scan the repo for CI/CD config files and report what was found:

| Platform | Look for |
|----------|----------|
| GCP Cloud Build | `cloudbuild*.yaml`, `cloudbuild*.yml` |
| AWS CodeBuild | `buildspec*.yaml`, `buildspec*.yml` |
| Azure DevOps | `azure-pipelines*.yml`, `.azure-pipelines/*.yml` |
| GitHub Actions | `.github/workflows/*.yml`, `.github/workflows/*.yaml` |

Also detect serverless frameworks:
| Framework | Look for |
|-----------|----------|
| Firebase Functions | `firebase.json` + `functions/` directory |
| AWS SAM/Lambda | `template.yaml` with `AWSTemplateFormatVersion` or `Transform.*Serverless` |
| Azure Functions | `host.json` |

Report: "Detected: [platforms], [frameworks]" — only run checks for what's present.

## Step 2: TypeScript Compilation (Platform-Agnostic)

This is the #1 cause of CI/CD build failures (43% of failures in analyzed data).

- Check for `tsconfig.json` at repo root. If missing, skip with a note.
- Check for `node_modules/`. If missing, report: "node_modules not found — run npm install first. Skipping TypeScript checks." and skip.
- Run `npx tsc --noEmit 2>&1 || true` from the repo root (timeout: 90 seconds)
- If a serverless function directory has its own tsconfig (e.g., `functions/tsconfig.json`), also run: `npx tsc --noEmit -p functions/tsconfig.json 2>&1 || true`
- Parse output lines matching `error TS(\d+):` — count errors by TS error code
- If errors > 0: report as **FAIL** with a grouped breakdown:
  ```
  FAIL: 42 TypeScript errors
    18x TS6133 — declared but never read
    12x TS2322 — type not assignable
     5x TS2339 — property does not exist on type
     ...
  ```
- If clean: report **PASS**

**This check is BLOCKING** — any TypeScript errors mean the build will fail.

## Step 3: CI/CD Config Validation (Vendor-Specific)

For each detected platform, read and validate the config files:

### GCP Cloud Build
- Check `$_VARIABLE` references exist in `substitutions:` block
- Check `secretEnv:` values have matching `availableSecrets.secretManager` entries
- Check `waitFor:` step ID references resolve to actual step IDs
- Flag `$SHORT_SHA` in Docker image tags (empty when manually triggered)

### AWS CodeBuild
- Check `version: 0.2` is present
- Check `aws ecr get-login-password` appears before any `docker push`
- Validate `env.secrets-manager` format: `secret-id:json-key:version-stage:version-id`
- Check `env.parameter-store` values start with `/`
- Flag `on-failure: CONTINUE` on build phase

### Azure DevOps
- Check `$(variable)` references resolve to `variables:` block or known predefined variables
- Check `pool:` exists with valid `vmImage:` or `name:`
- Check `template:` file references point to existing files
- Flag deprecated task versions (Docker@0, AzureKeyVault@1, etc.)

### GitHub Actions
- Flag `${{ secrets.NAME }}` inside `run:` blocks (secret leak risk)
- Check for top-level `permissions:` block
- Flag unpinned action versions (not SHA-pinned)
- Validate `needs:` job dependency references

Report findings per platform or **PASS** if no issues.

## Step 4: Secret Reference Consistency (Vendor-Specific)

Cross-reference secrets used in application code against CI config declarations:

| Platform | Code Pattern | CI Config Pattern |
|----------|-------------|-------------------|
| GCP | `defineSecret('NAME')` in `functions/src/` | `availableSecrets.secretManager` in cloudbuild YAML |
| AWS | `resolve:secretsmanager:NAME` in SAM template, `SecretId: 'NAME'` in code | `env.secrets-manager` in buildspec |
| Azure | `@Microsoft.KeyVault(SecretName=NAME)` | Variable groups / AzureKeyVault task |
| GitHub | `${{ secrets.NAME }}` | Cross-check consistency across workflow files |

Flag:
- **Orphaned secrets** (in code but not in CI config) — these will fail at deploy time
- **Partial coverage** (in some environment configs but not all) — may work in dev but fail in staging/prod

## Step 5: Docker Build Prerequisites (Vendor-Specific)

If Docker is used (Dockerfiles exist or CI configs reference Docker):

- Check that referenced Dockerfiles actually exist
- Check `.dockerignore` is present
- Validate registry auth ordering:
  - GCP: automatic (service account), but check `$SHORT_SHA` tag fallbacks
  - AWS: `ecr get-login-password` must precede `docker push`
  - Azure: `Docker@2` needs `containerRegistry` for push
  - GitHub: `docker/login-action` must precede `docker/build-push-action`

## Step 6: Serverless Deployment Hygiene (Framework-Specific)

### Firebase Functions
- Check `functions/src/index.ts` exists and has exports
- Check for duplicate function export names
- Check for mixed v1/v2 `firebase-functions` imports
- Check for functions defined in source files but not exported from index

### AWS SAM
- Check SAM `Handler:` paths resolve to actual files
- Check for duplicate `FunctionName` values
- Check for mixed Node.js/Python runtime versions

### Azure Functions
- Check `host.json` has version field
- Check `function.json` bindings have required `type` field
- Check `scriptFile` references resolve to actual files

## Step 7: Summary Verdict

Display a summary table showing only the platforms/frameworks that were detected:

```
Pre-Push Check Results
======================

| Platform         | Check              | Status | Issues |
|------------------|--------------------|--------|--------|
| (all)            | TypeScript         | FAIL   | 42     |
| GCP Cloud Build  | Config validation  | PASS   | 0      |
| GCP Cloud Build  | Secret references  | WARN   | 2      |
| Firebase         | Function hygiene   | PASS   | 0      |
| (all)            | Docker prereqs     | PASS   | 0      |

Verdict: BLOCKING — fix 42 TypeScript errors before pushing.
```

Verdict logic:
- If any **FAIL**: "BLOCKING — fix the above before pushing. These would fail the CI/CD build."
- If only **WARN**: "WARNINGS present — push is OK but review the warnings above."
- If all **PASS**: "All clear — safe to push."

## Rules

- **Never modify** any files in the target repo
- **Never run** `npm install`, `npm ci`, or any install command
- If `node_modules` is missing, skip TypeScript checks (report as SKIP, not FAIL)
- **90 second timeout** per `tsc` invocation — if it times out, report what was captured
- Only show rows for detected platforms — don't show "N/A" rows
- Keep total execution under 2 minutes
- Be specific about which files have issues and what the fix is
