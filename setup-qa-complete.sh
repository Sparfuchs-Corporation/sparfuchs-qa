#!/bin/bash
set -e

echo "=== Sparfuchs-Pro/sparfuchs-qa FULL CLEAN SETUP ==="

cd ~/Development-Local/sparfuchs-qa

# 1. Pull latest just in case
git pull origin main

# 2. Remove any leftover broken .claude files
rm -rf .claude

# 3. Re-clone dotclaude fresh and integrate it
git clone https://github.com/poshan0126/dotclaude.git /tmp/dotclaude
mkdir -p .claude
cp /tmp/dotclaude/settings.json .claude/
cp -r /tmp/dotclaude/{rules,skills,agents,hooks} .claude/
cp /tmp/dotclaude/.gitignore .claude/
cp /tmp/dotclaude/CLAUDE.md ./
cp /tmp/dotclaude/CLAUDE.local.md.example ./
chmod +x .claude/hooks/*.sh
rm -rf /tmp/dotclaude

# 4. Add our three QA skills
mkdir -p .claude/skills/{run-canaries,qa-evolve,persona-test}

cat > .claude/skills/run-canaries/SKILL.md << 'EOF'
# /run-canaries
Run all QA canaries. Use --push to save history to Firestore for forecasting.
EOF

cat > .claude/skills/qa-evolve/SKILL.md << 'EOF'
# /qa-evolve
Make agents learn from canary history and evolve. Use --dry-run to preview the prompt.
EOF

cat > .claude/skills/persona-test/SKILL.md << 'EOF'
# /persona-test
Run multi-user E2E tests using safe staging personas (auto-disables after run).
EOF

# 5. Add the core QA files from the updated plan
mkdir -p lib scripts docs canaries

# (lib/firestore.ts, lib/types.ts, canaries/index.ts, scripts/qa-evolve.ts, Makefile already exist from previous cleanup — we keep them)

# 6. Commit everything cleanly
git add .
git commit -m "feat(qa): full clean rebuild + dotclaude integration + three QA skills"
git push origin main

echo "✅ FULL SETUP COMPLETE!"
echo ""
echo "Now tell your team:"
echo "1. cd ~/Development-Local/sparfuchs-qa"
echo "2. git pull origin main"
echo "3. Open Claude in that folder"
echo "4. Type: /setupdotclaude"
