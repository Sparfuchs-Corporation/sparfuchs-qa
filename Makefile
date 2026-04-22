qa-quick:
	npx tsx canaries/index.ts
qa-sca:
	npx tsx scripts/package-verify.ts
qa-verify:
	npx tsx scripts/package-verify.ts --dry-run
qa-watch:
	npx tsx canaries/index.ts --watch
qa-review:
	@bash scripts/qa-review-remote.sh \
		--repo "$(REPO)" \
		$(if $(FULL),--full) \
		$(if $(AUTH),--auth) \
		$(if $(AGENTS),--agents "$(AGENTS)") \
		$(if $(TRAINING),--training) \
		$(if $(DOCS),--docs) \
		$(if $(MODULE),--module "$(MODULE)") \
		$(if $(JOURNEY),--journey "$(JOURNEY)") \
		$(if $(PROJECT),--project "$(PROJECT)") \
		$(if $(PERSON),--person "$(PERSON)") \
		$(if $(URL),--url "$(URL)") \
		$(if $(ENGINE),--engine "$(ENGINE)") \
		$(if $(PROVIDER),--provider "$(PROVIDER)") \
		$(if $(REF_DOCS),--ref-docs "$(REF_DOCS)") \
		$(if $(COMPOSE_RULES),--compose-rules) \
		$(if $(AUTO_COMPLETE),--auto-complete) \
		$(if $(BASELINE),--baseline) \
		$(if $(CONCURRENCY),--concurrency "$(CONCURRENCY)") \
		$(if $(ACCEPT_NO_GIT),--accept-no-git)
qa-ref-verify:
	@bash scripts/qa-review-remote.sh \
		--repo "$(REPO)" --full \
		--ref-docs "$(REF_DOCS)" \
		$(if $(PROJECT),--project "$(PROJECT)") \
		$(if $(PERSON),--person "$(PERSON)")
qa-delta:
	npx tsx scripts/qa-delta-report.ts --project "$(PROJECT)"
qa-evolve-v2:
	npx tsx scripts/qa-evolve-v2.ts --project "$(PROJECT)"
qa-cleanup:
	npx tsx scripts/qa-cleanup.ts --project "$(PROJECT)" --keep 10
qa-build-check:
	@bash scripts/qa-build-check.sh --repo "$(REPO)" $(if $(ACCEPT_NO_GIT),--accept-no-git)
qa-schema-check:
	@bash scripts/qa-schema-check.sh --repo "$(REPO)" $(if $(ACCEPT_NO_GIT),--accept-no-git)
qa-training:
	@bash scripts/qa-review-remote.sh \
		--repo "$(REPO)" --training \
		$(if $(MODULE),--module "$(MODULE)") \
		$(if $(JOURNEY),--journey "$(JOURNEY)") \
		$(if $(PROJECT),--project "$(PROJECT)") \
		$(if $(PERSON),--person "$(PERSON)")
qa-docs:
	@bash scripts/qa-review-remote.sh \
		--repo "$(REPO)" --docs \
		$(if $(PROJECT),--project "$(PROJECT)") \
		$(if $(PERSON),--person "$(PERSON)")
qa-docs-all:
	@bash scripts/qa-review-remote.sh \
		--repo "$(REPO)" --full \
		--agents "training-system-builder,architecture-doc-builder" \
		$(if $(PROJECT),--project "$(PROJECT)") \
		$(if $(PERSON),--person "$(PERSON)")
qa-stubs:
	@bash scripts/qa-review-remote.sh \
		--repo "$(REPO)" --full \
		--agents "stub-detector" \
		$(if $(PROJECT),--project "$(PROJECT)") \
		$(if $(PERSON),--person "$(PERSON)")
qa-cache-status:
	npx tsx scripts/file-audit-cache.ts --project "$(PROJECT)" status
qa-cache-reset:
	npx tsx scripts/file-audit-cache.ts --project "$(PROJECT)" reset
qa-setup:
	npm install
qa-keys-check:
	@npx tsx -e "import{listStoredKeys}from'./lib/orchestrator/credential-store.ts';const k=listStoredKeys();console.log(k.length?'Stored keys: '+k.join(', '):'No keys in OS keychain. Use: make qa-keys-setup')"
qa-keys-setup:
	@echo "Store credentials in your OS keychain (encrypted at rest)."
	@echo "Service name is always 'sparfuchs-qa'. The account name is the credential identifier."
	@echo ""
	@echo "Recognized accounts:"
	@echo "  ANTHROPIC_API_KEY               — Anthropic API provider"
	@echo "  OPENAI_API_KEY                  — OpenAI API provider"
	@echo "  XAI_API_KEY                     — xAI API provider"
	@echo "  GOOGLE_GENERATIVE_AI_API_KEY    — Google Generative AI (Gemini API provider)"
	@echo "  GEMINI_API_KEY                  — Gemini CLI auth (adapter injects into child env)"
	@echo ""
	@echo "=== macOS ==="
	@echo "  security add-generic-password -s sparfuchs-qa -a ANTHROPIC_API_KEY -w 'sk-ant-...'"
	@echo "  security add-generic-password -s sparfuchs-qa -a OPENAI_API_KEY -w 'sk-...'"
	@echo "  security add-generic-password -s sparfuchs-qa -a XAI_API_KEY -w 'xai-...'"
	@echo "  security add-generic-password -s sparfuchs-qa -a GOOGLE_GENERATIVE_AI_API_KEY -w 'AIza...'"
	@echo "  security add-generic-password -s sparfuchs-qa -a GEMINI_API_KEY -w 'AIza...'"
	@echo ""
	@echo "  # Update an existing entry (delete, then re-add):"
	@echo "  security delete-generic-password -s sparfuchs-qa -a GEMINI_API_KEY"
	@echo "  security add-generic-password -s sparfuchs-qa -a GEMINI_API_KEY -w 'new-value'"
	@echo ""
	@echo "  # Verify a stored value:"
	@echo "  security find-generic-password -s sparfuchs-qa -a GEMINI_API_KEY -w"
	@echo ""
	@echo "=== Linux (libsecret / secret-tool) ==="
	@echo "  echo 'sk-ant-...' | secret-tool store --label=sparfuchs-qa service sparfuchs-qa key ANTHROPIC_API_KEY"
	@echo "  echo 'sk-...'     | secret-tool store --label=sparfuchs-qa service sparfuchs-qa key OPENAI_API_KEY"
	@echo "  echo 'xai-...'    | secret-tool store --label=sparfuchs-qa service sparfuchs-qa key XAI_API_KEY"
	@echo "  echo 'AIza...'    | secret-tool store --label=sparfuchs-qa service sparfuchs-qa key GOOGLE_GENERATIVE_AI_API_KEY"
	@echo "  echo 'AIza...'    | secret-tool store --label=sparfuchs-qa service sparfuchs-qa key GEMINI_API_KEY"
	@echo ""
	@echo "  # Verify / delete:"
	@echo "  secret-tool lookup service sparfuchs-qa key GEMINI_API_KEY"
	@echo "  secret-tool clear  service sparfuchs-qa key GEMINI_API_KEY"
	@echo ""
	@echo "=== Windows (PowerShell, CredentialManager module) ==="
	@echo "  \$$s = ConvertTo-SecureString 'sk-ant-...' -AsPlainText -Force"
	@echo "  New-StoredCredential -Target 'sparfuchs-qa-ANTHROPIC_API_KEY' -Password \$$s -Type Generic -Persist LocalMachine"
	@echo ""
	@echo "=== Fallback: shell env vars (not persisted) ==="
	@echo "  export ANTHROPIC_API_KEY=sk-ant-..."
	@echo "  export GEMINI_API_KEY=AIza..."
	@echo ""
	@echo "After storing, verify with: make qa-keys-check"
	@echo ""
	@echo "=== Gemini CLI alternative: cached OAuth (interactive one-time) ==="
	@echo "  gemini     # complete browser login; creds saved at ~/.gemini/oauth_creds.json"
	@echo ""
qa-creds-list:
	@npx tsx scripts/qa-creds-manage.ts list
qa-creds-store:
	@npx tsx scripts/qa-creds-manage.ts store --name "$(NAME)"
qa-creds-show:
	@npx tsx scripts/qa-creds-manage.ts show --name "$(NAME)"
qa-creds-delete:
	@npx tsx scripts/qa-creds-manage.ts delete --name "$(NAME)"
qa-hashes-update:
	@npx tsx -e "import{parsePhase1Agents,generateAgentHashes}from'./lib/orchestrator/agent-parser.ts';import{writeFileSync}from'fs';const a=parsePhase1Agents('.claude/agents',{});writeFileSync('config/agent-hashes.json',JSON.stringify(generateAgentHashes(a),null,2));console.log('Updated config/agent-hashes.json')"
