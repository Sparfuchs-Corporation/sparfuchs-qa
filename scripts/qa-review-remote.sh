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
REPORTS_DIR=""  # set after mode detection

# Map shell CLI binary names to orchestrator ProviderName values
cli_to_provider() {
  case "$1" in
    claude)   echo "claude-cli" ;;
    gemini)   echo "gemini-cli" ;;
    codex)    echo "codex-cli" ;;
    openclaw) echo "openclaw" ;;
    *)        echo "$1" ;;
  esac
}

# CLIs that have orchestrator adapters (used to filter selection menu)
SUPPORTED_CLIS="claude gemini codex openclaw"

# Agent filenames we deploy (and clean up by name — never wildcard)
AGENT_FILES=(
  # Stage 0: Build & Semantic Safety
  build-verifier.md
  semantic-diff-reviewer.md
  # Stage 1: Risk & Static Quality
  code-reviewer.md
  security-reviewer.md
  observability-auditor.md
  workflow-extractor.md
  performance-reviewer.md
  risk-analyzer.md
  regression-risk-scorer.md
  deploy-readiness-reviewer.md
  contract-reviewer.md
  rbac-reviewer.md
  access-query-validator.md
  permission-chain-checker.md
  collection-reference-validator.md
  role-visibility-matrix.md
  a11y-reviewer.md
  compliance-reviewer.md
  dead-code-reviewer.md
  spec-verifier.md
  ui-intent-verifier.md
  # Stage 2: Integrity & Prep
  schema-migration-reviewer.md
  mock-integrity-checker.md
  environment-parity-checker.md
  iac-reviewer.md
  dependency-auditor.md
  sca-reviewer.md
  api-spec-reviewer.md
  doc-reviewer.md
  crud-tester.md
  e2e-tester.md
  fixture-generator.md
  boundary-fuzzer.md
  # Stage 3: Execution & Live Validation
  test-runner.md
  smoke-test-runner.md
  api-contract-prober.md
  failure-analyzer.md
  # Stage 1: Stub Detection
  stub-detector.md
  # Stage 4: Synthesis & Gate
  qa-gap-analyzer.md
  release-gate-synthesizer.md
)

# Documentation agents — only deployed when explicitly requested via --agents or --training/--docs
DOC_AGENT_FILES=(
  training-system-builder.md
  architecture-doc-builder.md
)

# --- Parse arguments ---
REPO=""
FULL=""
PROJECT=""
PERSON=""
URL=""
AUTH=""
AGENTS=""
MODE=""
MODULE=""
JOURNEY=""
TRAINING=""
DOCS=""
REF_DOCS=""
CRED_PROFILE=""
NO_INTERACTIVE=""
COMPOSE_RULES=""
AUTO_COMPLETE=""
BASELINE=""
COVERAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)      REPO="$2"; shift 2 ;;
    --full)      FULL="--full"; shift ;;
    --project)   PROJECT="$2"; shift 2 ;;
    --person)    PERSON="$2"; shift 2 ;;
    --url)       URL="$2"; shift 2 ;;
    --auth)      AUTH="1"; shift ;;
    --agents)    AGENTS="$2"; shift 2 ;;
    --training)  TRAINING="1"; shift ;;
    --docs)      DOCS="1"; shift ;;
    --module)    MODULE="$2"; shift 2 ;;
    --journey)   JOURNEY="$2"; shift 2 ;;
    --engine)    ENGINE="$2"; shift 2 ;;
    --provider)  PROVIDER="$2"; shift 2 ;;
    --ref-docs)  REF_DOCS="$2"; shift 2 ;;
    --profile)   CRED_PROFILE="$2"; shift 2 ;;
    --no-interactive) NO_INTERACTIVE="1"; shift ;;
    --compose-rules) COMPOSE_RULES="1"; shift ;;
    --auto-complete) AUTO_COMPLETE="1"; shift ;;
    --baseline)      BASELINE="1"; shift ;;
    --coverage)      COVERAGE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Determine mode: standalone training/docs vs. qa-review with add-ons
# --training alone (no --full/--tier) = standalone training mode
# --training + --full = qa-review with training as add-on (integrated)
# --docs alone = standalone docs mode
# --docs + --full = qa-review with docs as add-on
if [[ -n "$AGENTS" ]]; then
  MODE="selective"
elif [[ -n "$TRAINING" && -z "$FULL" ]]; then
  MODE="training"
elif [[ -n "$DOCS" && -z "$FULL" && -z "$TRAINING" ]]; then
  MODE="docs"
elif [[ -n "$FULL" ]]; then
  MODE="full"
  # TRAINING and DOCS become additive flags passed in the prompt
else
  MODE="review"
fi

# --- Interactive prompts for missing values ---
if [[ -z "$REPO" ]]; then
  read -rp "Path to local repo to evaluate: " REPO
  if [[ -z "$REPO" ]]; then
    echo "Error: repo path is required" >&2
    exit 1
  fi
fi
if [[ -z "$PROJECT" ]]; then
  read -rp "Project name: " PROJECT
fi
if [[ -z "$PERSON" ]]; then
  read -rp "Your name (tester): " PERSON
fi

REPO="$(cd "$REPO" && pwd)"  # resolve to absolute path

if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Error: $REPO is not a git repository" >&2
  exit 1
fi

# --- Detect installed AI CLIs ---
DETECTED_CLIS=""
DETECTED_CLI_NAMES=()
DETECTED_CLI_LABELS=()

for cli_name in claude gemini codex openclaw aider; do
  if command -v "$cli_name" >/dev/null 2>&1; then
    cli_version=$("$cli_name" --version 2>/dev/null | head -1 || echo "installed")
    DETECTED_CLIS="${DETECTED_CLIS:+$DETECTED_CLIS, }$cli_name ($cli_version)"
    DETECTED_CLI_NAMES+=("$cli_name")
    DETECTED_CLI_LABELS+=("$cli_name ($cli_version)")
  fi
done

# --- Interactive engine selection ---
if [[ -z "${ENGINE:-}" && -z "$NO_INTERACTIVE" && ${#DETECTED_CLI_NAMES[@]} -gt 0 ]]; then
  echo ""
  echo "Select engine:"

  ENGINE_OPTIONS=()
  ENGINE_OPTION_LABELS=()

  # Orchestrated is always option 1 (default)
  opt_idx=1
  ENGINE_OPTIONS+=("orchestrated")
  ENGINE_OPTION_LABELS+=("Orchestrated — multi-provider engine")
  DEFAULT_ENGINE_IDX=1

  for i in "${!DETECTED_CLI_NAMES[@]}"; do
    cli="${DETECTED_CLI_NAMES[$i]}"
    label="${DETECTED_CLI_LABELS[$i]}"
    # Only show CLIs that have orchestrator adapters
    if [[ " $SUPPORTED_CLIS " != *" $cli "* ]]; then
      continue
    fi
    ((opt_idx++))
    if [[ "$cli" == "claude" ]]; then
      ENGINE_OPTIONS+=("claude-direct")
      ENGINE_OPTION_LABELS+=("Claude CLI — direct mode $label")
    else
      ENGINE_OPTIONS+=("$cli")
      ENGINE_OPTION_LABELS+=("$label — orchestrated mode")
    fi
  done

  for i in "${!ENGINE_OPTIONS[@]}"; do
    idx=$((i + 1))
    default_tag=""
    if [[ $idx -eq $DEFAULT_ENGINE_IDX ]]; then
      default_tag=" (default)"
    fi
    echo "  $idx. ${ENGINE_OPTION_LABELS[$i]}$default_tag"
  done

  read -rp "Choice [1-$opt_idx, default=$DEFAULT_ENGINE_IDX]: " engine_choice
  engine_choice="${engine_choice:-$DEFAULT_ENGINE_IDX}"

  selected_idx=$((engine_choice - 1))
  if [[ $selected_idx -ge 0 && $selected_idx -lt ${#ENGINE_OPTIONS[@]} ]]; then
    selected="${ENGINE_OPTIONS[$selected_idx]}"
    if [[ "$selected" == "claude-direct" ]]; then
      ENGINE="claude"
    elif [[ "$selected" == "orchestrated" ]]; then
      ENGINE="orchestrated"
    else
      ENGINE="orchestrated"
      PROVIDER="$(cli_to_provider "$selected")"
    fi
  else
    echo "Invalid selection, using default (orchestrated)."
    ENGINE="orchestrated"
  fi
elif [[ -z "${ENGINE:-}" && -z "$NO_INTERACTIVE" && ${#DETECTED_CLI_NAMES[@]} -eq 0 ]]; then
  # No CLIs detected — default to orchestrated
  echo ""
  echo "No AI CLIs detected in PATH."
  echo "Defaulting to orchestrated engine (requires API keys)."
  ENGINE="orchestrated"
fi
ENGINE="${ENGINE:-orchestrated}"

# --- Interactive scan-type confirmation ---
EXPLICIT_MODE_FLAG=""
[[ -n "$FULL" ]] && EXPLICIT_MODE_FLAG="1"
[[ -n "$TRAINING" ]] && EXPLICIT_MODE_FLAG="1"
[[ -n "$DOCS" ]] && EXPLICIT_MODE_FLAG="1"
[[ -n "$AGENTS" ]] && EXPLICIT_MODE_FLAG="1"

if [[ -z "$EXPLICIT_MODE_FLAG" && -z "$NO_INTERACTIVE" ]]; then
  echo ""
  echo "Select scan type:"
  echo "  1. Diff review — changes since last commit (default)"
  echo "  2. Full audit — entire codebase"
  echo "  3. Training — generate training documentation"
  echo "  4. Architecture docs — generate architecture documentation"

  read -rp "Choice [1-4, default=1]: " scan_choice
  scan_choice="${scan_choice:-1}"

  case "$scan_choice" in
    1)
      MODE="review"
      FULL=""
      ;;
    2)
      MODE="full"
      FULL="--full"
      ;;
    3)
      MODE="training"
      TRAINING="1"
      FULL=""
      ;;
    4)
      MODE="docs"
      DOCS="1"
      FULL=""
      ;;
    *)
      echo "Invalid selection, using default (diff review)."
      MODE="review"
      FULL=""
      ;;
  esac
fi

# --- Select skill and output dir based on mode ---
case "$MODE" in
  selective)
    SKILL_SRC="$SPARFUCHS_ROOT/.claude/skills/qa-selective/SKILL.md"
    REPORTS_DIR="$SPARFUCHS_ROOT/qa-reports"
    ;;
  training)
    SKILL_SRC="$SPARFUCHS_ROOT/.claude/skills/qa-training/SKILL.md"
    REPORTS_DIR="$SPARFUCHS_ROOT/training-reports"
    ;;
  docs)
    SKILL_SRC="$SPARFUCHS_ROOT/.claude/skills/qa-docs/SKILL.md"
    REPORTS_DIR="$SPARFUCHS_ROOT/architecture-reports"
    ;;
  review|full)
    # Main qa-review skill (unchanged) — training/docs are add-ons via prompt flags
    REPORTS_DIR="$SPARFUCHS_ROOT/qa-reports"
    ;;
esac

# --- Generate run ID ---
RUN_ID="qa-$(date +%Y%m%d-%H%M)-$(openssl rand -hex 2)"

# --- Credential setup ---
CRED_FILE=""
if [[ -n "$CRED_PROFILE" ]]; then
  # Direct profile loading from keychain — skip wizard
  echo "Loading credentials from keychain profile: $CRED_PROFILE"
elif [[ -n "$AUTH" ]]; then
  echo "Running credential setup wizard..."
  CRED_RESULT=$(npx tsx "$SPARFUCHS_ROOT/lib/credentials/setup-wizard.ts" --run-id="$RUN_ID")

  if [[ "$CRED_RESULT" == keychain:* ]]; then
    # Credentials loaded from OS keychain profile
    CRED_PROFILE="${CRED_RESULT#keychain:}"
    echo "Credentials loaded from keychain profile: $CRED_PROFILE"
  elif [[ -n "$CRED_RESULT" && -f "$CRED_RESULT" ]]; then
    CRED_FILE="$CRED_RESULT"
    echo "Credentials written to: $CRED_FILE"
  else
    echo "Error: credential setup failed" >&2
    exit 1
  fi
fi

# --- Backup and deploy ---
BACKUP_DIR="$(mktemp -d "/tmp/sparfuchs-qa-backup-XXXXXX")"
PROMPT_FILE="$(mktemp "/tmp/sparfuchs-qa-prompt-XXXXXX.md")"
HAD_AGENTS_DIR=false

cleanup() {
  echo ""
  echo "Cleaning up..."

  # Delete temporary credential file (skip if credentials came from keychain)
  if [[ -n "$CRED_FILE" && -f "$CRED_FILE" && -z "$CRED_PROFILE" ]]; then
    npx tsx "$SPARFUCHS_ROOT/lib/credentials/teardown.ts" "$CRED_FILE" 2>/dev/null \
      || rm -f "$CRED_FILE"
  fi

  # Remove deployed agents by name
  case "$MODE" in
    selective)
      IFS=',' read -ra SELECTED <<< "$AGENTS"
      for agent in "${SELECTED[@]}"; do
        agent="$(echo "$agent" | xargs)"
        rm -f "$REPO/.claude/agents/${agent}.md"
      done
      ;;
    training)
      rm -f "$REPO/.claude/agents/training-system-builder.md"
      ;;
    docs)
      rm -f "$REPO/.claude/agents/architecture-doc-builder.md"
      ;;
    review|full)
      for f in "${AGENT_FILES[@]}"; do
        rm -f "$REPO/.claude/agents/$f"
      done
      # Clean up doc agents if they were deployed as add-ons
      rm -f "$REPO/.claude/agents/training-system-builder.md"
      rm -f "$REPO/.claude/agents/architecture-doc-builder.md"
      ;;
  esac

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

# Deploy agents — selective or full
mkdir -p "$REPO/.claude/agents"
DEPLOYED_COUNT=0

if [[ -n "$AGENTS" ]]; then
  # Selective: deploy only named agents
  IFS=',' read -ra SELECTED <<< "$AGENTS"
  for agent in "${SELECTED[@]}"; do
    agent="$(echo "$agent" | xargs)"  # trim whitespace
    if [[ -f "$AGENTS_SRC/${agent}.md" ]]; then
      cp "$AGENTS_SRC/${agent}.md" "$REPO/.claude/agents/${agent}.md"
      ((DEPLOYED_COUNT++))
    else
      echo "Warning: agent '$agent' not found at $AGENTS_SRC/${agent}.md" >&2
    fi
  done
elif [[ "$MODE" == "training" ]]; then
  cp "$AGENTS_SRC/training-system-builder.md" "$REPO/.claude/agents/training-system-builder.md"
  DEPLOYED_COUNT=1
elif [[ "$MODE" == "docs" ]]; then
  cp "$AGENTS_SRC/architecture-doc-builder.md" "$REPO/.claude/agents/architecture-doc-builder.md"
  DEPLOYED_COUNT=1
else
  # Full: deploy all standard QA agents
  for f in "${AGENT_FILES[@]}"; do
    cp "$AGENTS_SRC/$f" "$REPO/.claude/agents/$f"
    ((DEPLOYED_COUNT++))
  done
  # Deploy doc agents if training/docs add-ons requested
  if [[ -n "$TRAINING" ]]; then
    cp "$AGENTS_SRC/training-system-builder.md" "$REPO/.claude/agents/training-system-builder.md"
    ((DEPLOYED_COUNT++))
  fi
  if [[ -n "$DOCS" ]]; then
    cp "$AGENTS_SRC/architecture-doc-builder.md" "$REPO/.claude/agents/architecture-doc-builder.md"
    ((DEPLOYED_COUNT++))
  fi
fi
echo "Deployed $DEPLOYED_COUNT QA agents to $REPO/.claude/agents/"

# --- Prepare prompt ---
# Strip YAML frontmatter from SKILL.md (compatible with macOS BSD sed)
awk 'BEGIN{skip=0} /^---$/{skip++; next} skip>=2{print}' "$SKILL_SRC" > "$PROMPT_FILE"

# Ensure reports directory exists
mkdir -p "$REPORTS_DIR"

# Build the user prompt with pre-filled context
case "$MODE" in
  selective)
    USER_PROMPT="Run ONLY these agents: $AGENTS."
    ;;
  training)
    if [[ -n "$MODULE" ]]; then
      USER_PROMPT="Generate training deep-dive for this repository. Module: $MODULE."
    elif [[ -n "$JOURNEY" ]]; then
      USER_PROMPT="Generate training journey for this repository. Journey: $JOURNEY."
    else
      USER_PROMPT="Generate a training system specification for this repository."
    fi
    ;;
  docs)
    USER_PROMPT="Generate architecture documentation for this repository."
    ;;
  review|full)
    if [[ -n "$FULL" ]]; then
      USER_PROMPT="Run /qa-review --full for this repository."
    else
      USER_PROMPT="Run a QA review for this repository."
    fi
    # Append additive flags for integrated training/docs
    if [[ -n "$TRAINING" ]]; then
      USER_PROMPT="$USER_PROMPT --training"
      if [[ -n "$MODULE" ]]; then
        USER_PROMPT="$USER_PROMPT Module: $MODULE."
      elif [[ -n "$JOURNEY" ]]; then
        USER_PROMPT="$USER_PROMPT Journey: $JOURNEY."
      fi
    fi
    if [[ -n "$DOCS" ]]; then
      USER_PROMPT="$USER_PROMPT --docs"
    fi
    ;;
esac
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
if [[ -n "$MODULE" && ( "$MODE" == "review" || "$MODE" == "full" ) ]]; then
  USER_PROMPT="$USER_PROMPT SCOPE: Only analyze files under $MODULE/"
fi
if [[ -n "$REF_DOCS" ]]; then
  USER_PROMPT="$USER_PROMPT Reference documents: $REF_DOCS"
fi
USER_PROMPT="$USER_PROMPT Write reports to: $REPORTS_DIR/"

# Determine display mode
case "$MODE" in
  selective) DISPLAY_MODE="selective: $AGENTS" ;;
  training)  DISPLAY_MODE="standalone training" ;;
  docs)      DISPLAY_MODE="standalone architecture docs" ;;
  review|full)
    DISPLAY_MODE="${FULL:-diff review}"
    [[ -n "$FULL" ]] && DISPLAY_MODE="full audit"
    [[ -n "$TRAINING" ]] && DISPLAY_MODE="$DISPLAY_MODE + training"
    [[ -n "$DOCS" ]] && DISPLAY_MODE="$DISPLAY_MODE + docs"
    [[ -n "$MODULE" ]] && DISPLAY_MODE="$DISPLAY_MODE (module: $MODULE)"
    [[ -n "$JOURNEY" ]] && DISPLAY_MODE="$DISPLAY_MODE (journey: $JOURNEY)"
    ;;
esac

echo ""
echo "=== Sparfuchs QA Review ==="
echo "Target repo:  $REPO"
echo "Reports dir:  $REPORTS_DIR"
echo "Mode:         $DISPLAY_MODE"
echo "Engine:       $ENGINE${PROVIDER:+ (provider: $PROVIDER)}"
echo "AI CLIs:      ${DETECTED_CLIS:-(none detected)}"
AUTH_DISPLAY="none"
if [[ -n "$CRED_PROFILE" ]]; then
  AUTH_DISPLAY="keychain:$CRED_PROFILE"
elif [[ -n "$CRED_FILE" ]]; then
  AUTH_DISPLAY="file:$CRED_FILE"
fi
echo "Auth:         $AUTH_DISPLAY"
echo "==========================="
echo ""

# --- Launch engine ---
cd "$REPO"

if [[ "${ENGINE:-claude}" == "claude" ]]; then
  # Claude Code CLI path
  if ! command -v claude >/dev/null 2>&1; then
    echo "Error: Claude CLI not found in PATH." >&2
    echo "Install: https://docs.anthropic.com/en/docs/claude-code" >&2
    echo "Or use: --engine orchestrated (requires API keys or another CLI)" >&2
    exit 1
  fi
  SPARFUCHS_CRED_FILE="${CRED_FILE:-}" \
  SPARFUCHS_CRED_PROFILE="${CRED_PROFILE:-}" \
  claude \
    --append-system-prompt-file "$PROMPT_FILE" \
    --add-dir "$REPORTS_DIR" \
    --add-dir "$SPARFUCHS_ROOT/qa-data" \
    --permission-mode default \
    "$USER_PROMPT"
else
  # Multi-LLM orchestrated engine (supports API + CLI providers)
  echo "Engine: orchestrated (multi-provider)"
  ORCH_ARGS=(
    --repo "$REPO"
    --sparfuchs-root "$SPARFUCHS_ROOT"
    --reports-dir "$REPORTS_DIR"
    --run-id "$RUN_ID"
    --mode "$MODE"
    --user-prompt "$USER_PROMPT"
  )
  [[ -n "$MODULE" ]] && ORCH_ARGS+=(--module "$MODULE")
  [[ -n "$AGENTS" ]] && ORCH_ARGS+=(--selected-agents "$AGENTS")
  [[ -n "$COMPOSE_RULES" ]] && ORCH_ARGS+=(--compose-rules true)
  [[ -n "$AUTO_COMPLETE" ]] && ORCH_ARGS+=(--auto-complete true)
  [[ -n "$BASELINE" ]] && ORCH_ARGS+=(--baseline true)
  [[ -n "$COVERAGE" ]] && ORCH_ARGS+=(--coverage "$COVERAGE")
  [[ -n "$PROVIDER" ]] && ORCH_ARGS+=(--provider "$PROVIDER")
  SPARFUCHS_CRED_FILE="${CRED_FILE:-}" \
  SPARFUCHS_CRED_PROFILE="${CRED_PROFILE:-}" \
  npx tsx "$SPARFUCHS_ROOT/scripts/qa-review-orchestrated.ts" "${ORCH_ARGS[@]}"
fi
