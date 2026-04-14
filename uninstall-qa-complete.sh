#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./uninstall-qa-complete.sh [--dry-run] [--help]

Safe uninstall for the sparfuchs-qa repo.

What it removes:
  - node_modules/
  - qa-reports/
  - qa-data/
  - training-reports/
  - architecture-reports/
  - CLAUDE.local.md

What it does not do:
  - Delete tracked repo files
  - Rewrite .gitignore
  - Remove git history, branches, or remotes
EOF
}

while (($# > 0)); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

echo "=== Sparfuchs QA uninstall ==="
echo "Repo root: $SCRIPT_DIR"

required_files=(
  "package.json"
  "Makefile"
  "tsconfig.json"
  "setup-qa-complete.sh"
)

missing_paths=()

for path in "${required_files[@]}"; do
  if [[ ! -f "$path" ]]; then
    missing_paths+=("$path")
  fi
done

if ((${#missing_paths[@]} > 0)); then
  echo "Refusing to run outside the expected repo root. Missing:" >&2
  for path in "${missing_paths[@]}"; do
    echo "  - $path" >&2
  done
  exit 1
fi

targets=(
  "node_modules"
  "qa-reports"
  "qa-data"
  "training-reports"
  "architecture-reports"
  "CLAUDE.local.md"
)

removed_any=0

for target in "${targets[@]}"; do
  if [[ -e "$target" ]]; then
    removed_any=1
    if ((DRY_RUN == 1)); then
      echo "Would remove: $target"
    else
      rm -rf -- "$target"
      echo "Removed: $target"
    fi
  else
    echo "Not present: $target"
  fi
done

echo ""
if ((DRY_RUN == 1)); then
  echo "Dry run complete."
elif ((removed_any == 1)); then
  echo "Uninstall complete."
else
  echo "Nothing to remove."
fi
