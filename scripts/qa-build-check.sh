#!/usr/bin/env bash
# qa-build-check.sh — Run build verification against a target repo (standalone)
#
# Deploys only the build-verifier agent, runs it, and cleans up.
# Faster than a full QA review — answers "will CI pass?" in one command.
#
# Usage:
#   bash scripts/qa-build-check.sh --repo /path/to/target
#
# Or via Make:
#   make qa-build-check REPO=/path/to/target

set -euo pipefail

SPARFUCHS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_SRC="$SPARFUCHS_ROOT/.claude/agents/build-verifier.md"
AGENT_FILE="build-verifier.md"

# --- Parse arguments ---
REPO=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    *)      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "Error: --repo is required" >&2
  echo "Usage: bash scripts/qa-build-check.sh --repo /path/to/target" >&2
  exit 1
fi

REPO="$(cd "$REPO" && pwd)"

if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Error: $REPO is not a git repository" >&2
  exit 1
fi

# --- Backup and deploy ---
BACKUP_FILE=""
HAD_AGENTS_DIR=false

cleanup() {
  echo ""
  echo "Cleaning up..."

  rm -f "$REPO/.claude/agents/$AGENT_FILE"

  # Restore backup if we overwrote an existing file
  if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    cp "$BACKUP_FILE" "$REPO/.claude/agents/$AGENT_FILE"
    rm -f "$BACKUP_FILE"
  fi

  # Remove directories if they didn't exist before
  if [[ "$HAD_AGENTS_DIR" == false ]]; then
    rmdir "$REPO/.claude/agents" 2>/dev/null || true
    rmdir "$REPO/.claude" 2>/dev/null || true
  fi

  echo "Cleanup complete."
}
trap cleanup EXIT

# Back up existing agent if it exists
if [[ -d "$REPO/.claude/agents" ]]; then
  HAD_AGENTS_DIR=true
  if [[ -f "$REPO/.claude/agents/$AGENT_FILE" ]]; then
    BACKUP_FILE="$(mktemp "/tmp/sparfuchs-qa-bv-backup-XXXXXX.md")"
    cp "$REPO/.claude/agents/$AGENT_FILE" "$BACKUP_FILE"
    echo "Note: overriding target repo's $AGENT_FILE during check"
  fi
fi

# Deploy
mkdir -p "$REPO/.claude/agents"
cp "$AGENT_SRC" "$REPO/.claude/agents/$AGENT_FILE"

echo ""
echo "=== Sparfuchs QA — Build Check ==="
echo "Target repo: $REPO"
echo "==================================="
echo ""

# --- Launch Claude from within target repo ---
cd "$REPO"
claude \
  --permission-mode default \
  "Run @build-verifier against this repository. Report all build errors grouped by root cause. Output everything to the conversation — no report files needed."
