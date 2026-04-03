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
qa-setup:
	npm install
