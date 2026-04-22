/**
 * Flaky Test Tracker
 *
 * Detects flaky tests by comparing current results against historical runs.
 * Maintains a qa_flaky_tests Firestore collection tracking flip patterns.
 *
 * Usage:
 *   npx tsx scripts/flaky-test-tracker.ts [results-json-path]
 *   npx tsx scripts/flaky-test-tracker.ts --report
 *   npx tsx scripts/flaky-test-tracker.ts --dry-run
 *
 * Input: JSON file with test results in shape:
 *   { tests: [{ name: string, file: string, passed: boolean }] }
 */

import { db, COLLECTIONS, FieldValue } from '../lib/firestore';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface TestResult {
  name: string;
  file: string;
  passed: boolean;
}

interface TestInput {
  tests: TestResult[];
  commitSha?: string;
  branch?: string;
}

interface FlakyRecord {
  testFile: string;
  testName: string;
  status: 'candidate' | 'confirmed' | 'fixed';
  flipCount: number;
  lastFlipAt: any;
  lastPassAt: any;
  lastFailAt: any;
  quarantined: boolean;
  createdAt: any;
}

const FLAKY_COLLECTION = COLLECTIONS.FLAKY_TESTS || 'qa_flaky_tests';
const CANDIDATE_THRESHOLD = 2;
const CONFIRMED_THRESHOLD = 5;

async function getExistingRecord(testName: string, testFile: string): Promise<{ id: string; data: FlakyRecord } | null> {
  const snapshot = await db.collection(FLAKY_COLLECTION)
    .where('testName', '==', testName)
    .where('testFile', '==', testFile)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, data: doc.data() as FlakyRecord };
}

async function trackResults(input: TestInput, dryRun: boolean): Promise<{ candidates: number; confirmed: number; fixed: number }> {
  const stats = { candidates: 0, confirmed: 0, fixed: 0 };

  for (const test of input.tests) {
    const existing = await getExistingRecord(test.name, test.file);

    if (!existing) {
      // No flaky record exists. Only create one if the test failed
      // (we need a subsequent pass to detect a flip).
      // We don't track passing tests that have never failed.
      continue;
    }

    const record = existing.data;
    const wasLastPassing = record.lastPassAt && (!record.lastFailAt || record.lastPassAt > record.lastFailAt);
    const wasLastFailing = record.lastFailAt && (!record.lastPassAt || record.lastFailAt > record.lastPassAt);

    const isFlip = (test.passed && wasLastFailing) || (!test.passed && wasLastPassing);

    if (isFlip) {
      const newFlipCount = record.flipCount + 1;
      let newStatus = record.status;

      if (newFlipCount >= CONFIRMED_THRESHOLD) {
        newStatus = 'confirmed';
        stats.confirmed++;
      } else if (newFlipCount >= CANDIDATE_THRESHOLD) {
        newStatus = 'candidate';
        stats.candidates++;
      }

      const update: Partial<FlakyRecord> = {
        flipCount: newFlipCount,
        lastFlipAt: FieldValue.serverTimestamp(),
        status: newStatus,
        quarantined: newStatus === 'confirmed',
      };

      if (test.passed) {
        update.lastPassAt = FieldValue.serverTimestamp();
      } else {
        update.lastFailAt = FieldValue.serverTimestamp();
      }

      if (!dryRun) {
        await db.collection(FLAKY_COLLECTION).doc(existing.id).update(update);
      }
      console.log(`  FLIP: ${test.name} (${test.file}) — flips: ${newFlipCount}, status: ${newStatus}`);
    } else {
      // No flip — just update last pass/fail timestamp
      const update: Partial<FlakyRecord> = {};
      if (test.passed) {
        update.lastPassAt = FieldValue.serverTimestamp();
      } else {
        update.lastFailAt = FieldValue.serverTimestamp();
      }

      if (!dryRun) {
        await db.collection(FLAKY_COLLECTION).doc(existing.id).update(update);
      }
    }
  }

  // Check for failed tests that aren't yet tracked
  for (const test of input.tests.filter(t => !t.passed)) {
    const existing = await getExistingRecord(test.name, test.file);
    if (!existing) {
      const newRecord: FlakyRecord = {
        testFile: test.file,
        testName: test.name,
        status: 'candidate',
        flipCount: 0,
        lastFlipAt: null,
        lastPassAt: null,
        lastFailAt: FieldValue.serverTimestamp(),
        quarantined: false,
        createdAt: FieldValue.serverTimestamp(),
      };

      if (!dryRun) {
        await db.collection(FLAKY_COLLECTION).add(newRecord);
      }
      console.log(`  NEW: ${test.name} (${test.file}) — tracking started`);
    }
  }

  return stats;
}

async function generateReport(): Promise<void> {
  const snapshot = await db.collection(FLAKY_COLLECTION)
    .orderBy('flipCount', 'desc')
    .limit(50)
    .get();

  const records = snapshot.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => ({ id: d.id, ...d.data() as FlakyRecord }));

  const confirmed = records.filter((r: FlakyRecord & { id: string }) => r.status === 'confirmed');
  const candidates = records.filter((r: FlakyRecord & { id: string }) => r.status === 'candidate');

  console.log(JSON.stringify({
    total: records.length,
    confirmed: confirmed.length,
    candidates: candidates.length,
    quarantined: records.filter((r: FlakyRecord & { id: string }) => r.quarantined).length,
    tests: records.map((r: FlakyRecord & { id: string }) => ({
      name: r.testName,
      file: r.testFile,
      status: r.status,
      flips: r.flipCount,
      quarantined: r.quarantined,
    })),
  }, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const reportOnly = args.includes('--report');

  if (reportOnly) {
    await generateReport();
    return;
  }

  const inputPath = args.find(a => !a.startsWith('--'));
  if (!inputPath) {
    console.error('Usage: npx tsx scripts/flaky-test-tracker.ts [results.json]');
    console.error('       npx tsx scripts/flaky-test-tracker.ts --report');
    process.exit(1);
  }

  const raw = readFileSync(resolve(inputPath), 'utf-8');
  const input: TestInput = JSON.parse(raw);

  console.log(`Flaky Test Tracker: ${input.tests.length} test results`);
  if (dryRun) console.log('  (dry run — no Firestore writes)');

  const stats = await trackResults(input, dryRun);

  console.log(`\nResults:`);
  console.log(`  New candidates: ${stats.candidates}`);
  console.log(`  Confirmed flaky: ${stats.confirmed}`);
  console.log(`  Fixed: ${stats.fixed}`);
}

main().catch(console.error);
