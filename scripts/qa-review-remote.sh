#!/usr/bin/env bash
# qa-review-remote.sh — Deploy QA agents into a target repo and run a full review
#
# Usage:
#   bash scripts/qa-review-remote.sh --repo /path/to/target [--full] \
#       [--project NAME] [--person NAME] [--url URL]
#
# Or via Make:
#   make qa-review REPO=/path/to/target FULL=1

set -euo pipefail

SPARFUCHS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_SRC="$SPARFUCHS_ROOT/.claude/agents"
SKILL_SRC="$SPARFUCHS_ROOT/.claude/skills/qa-review/SKILL.md"
REPORTS_DIR="$SPARFUCHS_ROOT/qa-reports"

# Agent filenames we deploy (and clean up by name — never wildcard)
AGENT_FILES=(
  code-reviewer.md
  security-reviewer.md
  performance-reviewer.md
  doc-reviewer.md
  risk-analyzer.md
  crud-tester.md
  sca-reviewer.md
  a11y-reviewer.md
  contract-reviewer.md
  dependency-auditor.md
  e2e-tester.md
  failure-analyzer.md
  compliance-reviewer.md
  iac-reviewer.md
  fixture-generator.md
  rbac-reviewer.md
  api-spec-reviewer.md
  dead-code-reviewer.md
  deploy-readiness-reviewer.md
  ui-intent-verifier.md
  spec-verifier.md
  qa-gap-analyzer.md
)

# --- Parse arguments ---
REPO=""
FULL=""
PROJECT=""
PERSON=""
URL=""
AUTH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)    REPO="$2"; shift 2 ;;
    --full)    FULL="--full"; shift ;;
    --project) PROJECT="$2"; shift 2 ;;
    --person)  PERSON="$2"; shift 2 ;;
    --url)     URL="$2"; shift 2 ;;
    --auth)    AUTH="1"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "Error: --repo is required" >&2
  echo "Usage: bash scripts/qa-review-remote.sh --repo /path/to/target [--full]" >&2
  exit 1
fi

REPO="$(cd "$REPO" && pwd)"  # resolve to absolute path

if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Error: $REPO is not a git repository" >&2
  exit 1
fi

# --- Generate run ID ---
RUN_ID="qa-$(date +%Y%m%d-%H%M)-$(openssl rand -hex 2)"

# --- Credential setup ---
CRED_FILE=""
if [[ -n "$AUTH" ]]; then
  echo "Running credential setup wizard..."
  CRED_FILE=$(npx tsx "$SPARFUCHS_ROOT/lib/credentials/setup-wizard.ts" --run-id="$RUN_ID")
  if [[ -z "$CRED_FILE" || ! -f "$CRED_FILE" ]]; then
    echo "Error: credential setup failed" >&2
    exit 1
  fi
  echo "Credentials written to: $CRED_FILE"
fi

# --- Backup and deploy ---
BACKUP_DIR="$(mktemp -d "/tmp/sparfuchs-qa-backup-XXXXXX")"
PROMPT_FILE="$(mktemp "/tmp/sparfuchs-qa-prompt-XXXXXX.md")"
HAD_AGENTS_DIR=false

cleanup() {
  echo ""
  echo "Cleaning up..."

  # Delete temporary credential file
  if [[ -n "$CRED_FILE" && -f "$CRED_FILE" ]]; then
    npx tsx "$SPARFUCHS_ROOT/lib/credentials/teardown.ts" "$CRED_FILE" 2>/dev/null \
      || rm -f "$CRED_FILE"
  fi

  # Remove deployed agents by name
  for f in "${AGENT_FILES[@]}"; do
    rm -f "$REPO/.claude/agents/$f"
  done

  # Restore backed-up agents
  if [[ -d "$BACKUP_DIR/agents" ]]; then
    cp "$BACKUP_DIR/agents/"* "$REPO/.claude/agents/" 2>/dev/null || true
  fi

  # If .claude/agents/ didn't exist before and is now empty, remove it
  if [[ "$HAD_AGENTS_DIR" == false ]]; then
    rmdir "$REPO/.claude/agents" 2>/dev/null || true
    # Also remove .claude/ if it was created and is now empty
    rmdir "$REPO/.claude" 2>/dev/null || true
  fi

  rm -rf "$BACKUP_DIR"
  rm -f "$PROMPT_FILE"
  echo "Cleanup complete."
}
trap cleanup EXIT

# Back up existing agents if they exist
if [[ -d "$REPO/.claude/agents" ]]; then
  HAD_AGENTS_DIR=true
  cp -r "$REPO/.claude/agents" "$BACKUP_DIR/agents"
  # Warn about overrides
  for f in "${AGENT_FILES[@]}"; do
    if [[ -f "$REPO/.claude/agents/$f" ]]; then
      echo "Note: overriding target repo's $f during review"
    fi
  done
fi

# Deploy agents
mkdir -p "$REPO/.claude/agents"
for f in "${AGENT_FILES[@]}"; do
  cp "$AGENTS_SRC/$f" "$REPO/.claude/agents/$f"
done
echo "Deployed ${#AGENT_FILES[@]} QA agents to $REPO/.claude/agents/"

# --- Prepare prompt ---
# Strip YAML frontmatter from SKILL.md (compatible with macOS BSD sed)
awk 'BEGIN{skip=0} /^---$/{skip++; next} skip>=2{print}' "$SKILL_SRC" > "$PROMPT_FILE"

# Ensure reports directory exists
mkdir -p "$REPORTS_DIR"

# Build the user prompt with pre-filled context
USER_PROMPT="Run a QA review for this repository."
if [[ -n "$FULL" ]]; then
  USER_PROMPT="Run /qa-review --full for this repository."
fi
if [[ -n "$PROJECT" ]]; then
  USER_PROMPT="$USER_PROMPT Project name: $PROJECT."
fi
if [[ -n "$PERSON" ]]; then
  USER_PROMPT="$USER_PROMPT Initiated by: $PERSON."
fi
if [[ -n "$URL" ]]; then
  USER_PROMPT="$USER_PROMPT Web URL: $URL."
fi
if [[ -n "$CRED_FILE" ]]; then
  USER_PROMPT="$USER_PROMPT Credentials file: $CRED_FILE"
fi
USER_PROMPT="$USER_PROMPT Write reports to: $REPORTS_DIR/"

echo ""
echo "=== Sparfuchs QA Review ==="
echo "Target repo:  $REPO"
echo "Reports dir:  $REPORTS_DIR"
echo "Mode:         ${FULL:-diff review}"
echo "Auth:         ${CRED_FILE:-none}"
echo "==========================="
echo ""

# --- Launch Claude from within target repo ---
cd "$REPO"
SPARFUCHS_CRED_FILE="${CRED_FILE:-}" \
claude \
  --append-system-prompt-file "$PROMPT_FILE" \
  --add-dir "$REPORTS_DIR" \
  --add-dir "$SPARFUCHS_ROOT/qa-data" \
  --permission-mode default \
  "$USER_PROMPT"
