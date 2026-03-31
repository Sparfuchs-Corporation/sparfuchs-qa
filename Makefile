qa-quick:
	npx tsx canaries/index.ts

qa-push:
	QA_PUSH_FIRESTORE=1 npx tsx canaries/index.ts

qa-evolve:
	npx tsx scripts/qa-evolve.ts

qa-evolve-dry:
	QA_EVOLVE_DRY=1 npx tsx scripts/qa-evolve.ts

qa-report:
	npx tsx scripts/qa-report-query.ts

qa-setup:
	npm ci
