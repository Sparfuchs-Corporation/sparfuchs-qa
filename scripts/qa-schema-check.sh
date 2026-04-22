#!/usr/bin/env bash
# qa-schema-check.sh — Run schema/migration verification against a target repo (standalone)
#
# Deploys only the schema-migration-reviewer agent, runs it, and cleans up.
# Answers "are all my schema tables migrated?" in one command.
#
# Usage:
#   bash scripts/qa-schema-check.sh --repo /path/to/target
#
# Or via Make:
#   make qa-schema-check REPO=/path/to/target

set -euo pipefail

SPARFUCHS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_SRC="$SPARFUCHS_ROOT/.claude/agents/schema-migration-reviewer.md"
AGENT_FILE="schema-migration-reviewer.md"

# --- Parse arguments ---
REPO=""
ACCEPT_NO_GIT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --accept-no-git) ACCEPT_NO_GIT="1"; shift ;;
    *)      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REPO" ]]; then
  read -rp "Path to local repo to evaluate: " REPO
  if [[ -z "$REPO" ]]; then
    echo "Error: repo path is required" >&2
    exit 1
  fi
fi

REPO="$(cd "$REPO" && pwd)"

if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "" >&2
  echo "WARNING: $REPO is not a git repository." >&2
  echo "  There is no VCS backup for this run. The agent may modify files." >&2
  echo "" >&2
  if [[ -n "$ACCEPT_NO_GIT" ]]; then
    echo "  --accept-no-git was passed; continuing without a repo backup." >&2
    echo "" >&2
  elif [[ -t 0 ]]; then
    read -rp "Continue anyway? [y/N] " git_ack
    case "$git_ack" in
      y|Y|yes|YES) echo "Acknowledged. Continuing." >&2 ;;
      *) echo "Aborted. Run from a git-backed target, or pass --accept-no-git." >&2; exit 1 ;;
    esac
  else
    echo "Error: non-interactive session and --accept-no-git was not passed." >&2
    exit 1
  fi
fi

# --- Backup and deploy ---
BACKUP_FILE=""
HAD_AGENTS_DIR=false

cleanup() {
  echo ""
  echo "Cleaning up..."

  rm -f "$REPO/.claude/agents/$AGENT_FILE"

  if [[ -n "$BACKUP_FILE" && -f "$BACKUP_FILE" ]]; then
    cp "$BACKUP_FILE" "$REPO/.claude/agents/$AGENT_FILE"
    rm -f "$BACKUP_FILE"
  fi

  if [[ "$HAD_AGENTS_DIR" == false ]]; then
    rmdir "$REPO/.claude/agents" 2>/dev/null || true
    rmdir "$REPO/.claude" 2>/dev/null || true
  fi

  echo "Cleanup complete."
}
trap cleanup EXIT

if [[ -d "$REPO/.claude/agents" ]]; then
  HAD_AGENTS_DIR=true
  if [[ -f "$REPO/.claude/agents/$AGENT_FILE" ]]; then
    BACKUP_FILE="$(mktemp "/tmp/sparfuchs-qa-sm-backup-XXXXXX.md")"
    cp "$REPO/.claude/agents/$AGENT_FILE" "$BACKUP_FILE"
    echo "Note: overriding target repo's $AGENT_FILE during check"
  fi
fi

mkdir -p "$REPO/.claude/agents"
cp "$AGENT_SRC" "$REPO/.claude/agents/$AGENT_FILE"

echo ""
echo "=== Sparfuchs QA — Schema/Migration Check ==="
echo "Target repo: $REPO"
echo "==============================================="
echo ""

# --- Launch Claude from within target repo ---
cd "$REPO"
claude \
  --permission-mode default \
  "Run @schema-migration-reviewer against this repository. Compare all schema definitions against migration files. Report every table that exists in schema but has no migration. Output everything to the conversation — no report files needed."
