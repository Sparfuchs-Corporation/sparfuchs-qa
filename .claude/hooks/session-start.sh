#!/bin/bash
# Injects dynamic project context at session start.
# Used as a SessionStart hook.

CONTEXT=""

# Current branch (or detached HEAD)
BRANCH=$(git branch --show-current 2>/dev/null)
if [ -n "$BRANCH" ]; then
  CONTEXT="Branch: $BRANCH"
elif git rev-parse --git-dir >/dev/null 2>&1; then
  SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null)
  CONTEXT="HEAD: detached at $SHORT_SHA"
fi

# Last commit
LAST_COMMIT=$(git log --oneline -1 2>/dev/null)
if [ -n "$LAST_COMMIT" ]; then
  CONTEXT="$CONTEXT | Last commit: $LAST_COMMIT"
fi

# Uncommitted changes count
CHANGES=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "$CHANGES" -gt 0 ] 2>/dev/null; then
  CONTEXT="$CONTEXT | Uncommitted changes: $CHANGES files"
fi

# Staged changes indicator
if ! git diff --cached --quiet 2>/dev/null; then
  CONTEXT="$CONTEXT | Staged: yes"
fi

# Stash count
STASH_COUNT=$(git stash list 2>/dev/null | wc -l | tr -d ' ')
if [ "$STASH_COUNT" -gt 0 ] 2>/dev/null; then
  CONTEXT="$CONTEXT | Stashes: $STASH_COUNT"
fi

# Active PR on current branch (if gh CLI is available)
if command -v gh >/dev/null 2>&1; then
  PR_INFO=$(gh pr view --json number,title,state --jq '"PR #\(.number): \(.title) (\(.state))"' 2>/dev/null)
  if [ -n "$PR_INFO" ]; then
    CONTEXT="$CONTEXT | $PR_INFO"
  fi
fi

if [ -n "$CONTEXT" ]; then
  echo "$CONTEXT"
fi

exit 0
