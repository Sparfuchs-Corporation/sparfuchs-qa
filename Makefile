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
qa-review:
	@bash scripts/qa-review-remote.sh \
		--repo "$(REPO)" \
		$(if $(FULL),--full) \
		$(if $(AUTH),--auth) \
		$(if $(PROJECT),--project "$(PROJECT)") \
		$(if $(PERSON),--person "$(PERSON)") \
		$(if $(URL),--url "$(URL)")
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
qa-setup:
	npm install
