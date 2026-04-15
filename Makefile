qa-quick:
	npx tsx canaries/index.ts
qa-push:
	QA_PUSH_FIRESTORE=1 npx tsx canaries/index.ts
qa-evolve:
	npx tsx scripts/qa-evolve.ts
qa-evolve-dry:
	QA_EVOLVE_DRY=1 npx tsx scripts/qa-evolve.ts
qa-sca:
	npx tsx scripts/package-verify.ts
qa-sca-push:
	npx tsx scripts/package-verify.ts --push
qa-verify:
	npx tsx scripts/package-verify.ts --dry-run
qa-flaky:
	npx tsx scripts/flaky-test-tracker.ts --report
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
		$(if $(BASELINE),--baseline)
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
qa-sync:
	npx tsx scripts/qa-firestore-sync.ts --project "$(PROJECT)" --latest
qa-build-check:
	@bash scripts/qa-build-check.sh --repo "$(REPO)"
qa-schema-check:
	@bash scripts/qa-schema-check.sh --repo "$(REPO)"
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
	@echo "Store API keys in your OS keychain (encrypted at rest):"
	@echo ""
	@echo "macOS:"
	@echo "  security add-generic-password -s sparfuchs-qa -a XAI_API_KEY -w 'your-key'"
	@echo "  security add-generic-password -s sparfuchs-qa -a GOOGLE_GENERATIVE_AI_API_KEY -w 'your-key'"
	@echo "  security add-generic-password -s sparfuchs-qa -a ANTHROPIC_API_KEY -w 'your-key'"
	@echo ""
	@echo "Linux:"
	@echo "  echo 'your-key' | secret-tool store --label=sparfuchs-qa service sparfuchs-qa key XAI_API_KEY"
	@echo ""
	@echo "Or set environment variables: export XAI_API_KEY=your-key"
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
