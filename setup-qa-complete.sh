#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

INSTALL_DEPS=1

usage() {
  cat <<'EOF'
Usage: ./setup-qa-complete.sh [--skip-install] [--help]

Safe bootstrap for the sparfuchs-qa repo.

What it does:
  - Verifies you are running from the repo root
  - Checks that required project files and directories exist
  - Makes .claude hook scripts executable
  - Ensures CLAUDE.local.md is ignored
  - Installs npm dependencies unless --skip-install is passed

What it does not do:
  - Pull, commit, or push git changes
  - Clone external repositories
  - Overwrite tracked source files

To remove local install/runtime artifacts later, run:
  ./uninstall-qa-complete.sh
EOF
}

while (($# > 0)); do
  case "$1" in
    --skip-install)
      INSTALL_DEPS=0
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

echo "=== Sparfuchs QA setup ==="
echo "Repo root: $SCRIPT_DIR"

# Required: core project files + directories. Missing any of these means the
# repo is incomplete and setup cannot proceed.
required_files=(
  "package.json"
  "package-lock.json"
  "Makefile"
  "tsconfig.json"
  "CLAUDE.md"
  "CLAUDE.local.md.example"
)

required_dirs=(
  "lib"
  "scripts"
  "docs"
  "canaries"
)

# Optional: Claude Code integration assets. Not shipped in every checkout
# (public distributions exclude the `.claude/` surface). Missing optional
# paths print a warning but do not block setup.
optional_files=(
  ".claude/settings.json"
)

optional_dirs=(
  ".claude/agents"
  ".claude/hooks"
  ".claude/rules"
  ".claude/skills"
)

missing_required=()
missing_optional=()

for path in "${required_files[@]}"; do
  [[ -f "$path" ]] || missing_required+=("$path")
done

for path in "${required_dirs[@]}"; do
  [[ -d "$path" ]] || missing_required+=("$path")
done

for path in "${optional_files[@]}"; do
  [[ -f "$path" ]] || missing_optional+=("$path")
done

for path in "${optional_dirs[@]}"; do
  [[ -d "$path" ]] || missing_optional+=("$path")
done

if ((${#missing_required[@]} > 0)); then
  echo "Missing required repo paths:" >&2
  for path in "${missing_required[@]}"; do
    echo "  - $path" >&2
  done
  exit 1
fi

if ((${#missing_optional[@]} > 0)); then
  echo "Optional Claude Code assets not present (setup will continue without them):"
  for path in "${missing_optional[@]}"; do
    echo "  - $path"
  done
fi

if compgen -G ".claude/hooks/*.sh" >/dev/null; then
  chmod +x .claude/hooks/*.sh
  echo "Made .claude hook scripts executable."
else
  echo "No .claude hook scripts found."
fi

if [[ -f .gitignore ]]; then
  if ! grep -qxF "CLAUDE.local.md" .gitignore; then
    printf '\nCLAUDE.local.md\n' >> .gitignore
    echo "Added CLAUDE.local.md to .gitignore."
  else
    echo "CLAUDE.local.md already ignored."
  fi
fi

if ((INSTALL_DEPS == 1)); then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required but was not found in PATH." >&2
    exit 1
  fi
  echo "Installing npm dependencies..."
  npm ci
else
  echo "Skipping dependency install."
fi

echo ""
echo "Setup complete."
echo "Next steps:"
echo "  make qa-quick"
echo "  make qa-review REPO=/path/to/your/project"
