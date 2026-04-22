import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { CredentialFile, StrategyName } from './strategies/base.js';
import {
  createPromptHelpers, STRATEGIES,
  collectCredentials, collectTarget, collectMetadata, buildCredFile,
} from './collectors.js';
import {
  listTestProfiles, loadTestProfile, storeTestProfile,
} from '../orchestrator/credential-store.js';

const rl = createInterface({ input: process.stdin, output: process.stderr });
const { ask, askChoice } = createPromptHelpers(rl);

async function main(): Promise<void> {
  const runIdArg = process.argv.find((a: string) => a.startsWith('--run-id='));
  const runId = runIdArg
    ? runIdArg.split('=')[1]
    : `qa-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;

  console.error('\n=== Sparfuchs QA \u2014 Credential Setup ===\n');

  const needsAuth = await ask('Does the target project require authentication for testing? (y/n): ');

  if (needsAuth.toLowerCase() !== 'y') {
    const credFile = buildCredFile(runId, 'none', {}, { baseUrl: '', loginPath: '', apiBasePath: '' });
    const path = writeCredFile(runId, credFile);
    console.log(path);
    rl.close();
    return;
  }

  // Offer credential source options
  const existingProfiles = listTestProfiles();
  const sourceOptions = [
    'Enter fresh credentials',
    ...(existingProfiles.length > 0 ? ['Load from saved keychain profile'] : []),
    'Enter fresh credentials and save as profile',
  ];

  const sourceIdx = await askChoice('How would you like to provide credentials?', sourceOptions);
  const sourceChoice = sourceOptions[sourceIdx];

  // Load from saved profile
  if (sourceChoice === 'Load from saved keychain profile') {
    const profileIdx = await askChoice(
      'Select a saved profile:',
      existingProfiles.map(p => p),
    );
    const profileName = existingProfiles[profileIdx];
    const profile = loadTestProfile(profileName);

    if (!profile) {
      console.error(`Error: profile "${profileName}" not found or corrupted.`);
      rl.close();
      process.exit(1);
    }

    console.error(`\nLoaded profile: ${profileName}`);
    console.error(`  Strategy: ${profile.strategy}`);
    console.error(`  Target: ${profile.target.baseUrl}`);
    console.error(`  Created: ${profile.createdAt}`);

    // Output keychain protocol — shell script parses this
    console.log(`keychain:${profileName}`);
    rl.close();
    return;
  }

  // Collect fresh credentials
  const stratIdx = await askChoice(
    'Select authentication strategy:',
    STRATEGIES.map(s => `${s.label} \u2014 ${s.description}`),
  );
  const selectedStrategy = STRATEGIES[stratIdx];

  const credentials = await collectCredentials(selectedStrategy.name, ask, askChoice);
  const target = await collectTarget(ask);
  const metadata = await collectMetadata(ask, selectedStrategy.name);

  const credFile = buildCredFile(runId, selectedStrategy.name, credentials, target, metadata);

  // Save as profile if requested
  if (sourceChoice === 'Enter fresh credentials and save as profile') {
    const profileName = await ask('\nProfile name (alphanumeric + hyphens, e.g., staging-admin): ');
    try {
      storeTestProfile(profileName, credFile);
      console.error(`\nProfile "${profileName}" saved to OS keychain.`);
      console.error('You can load it in future runs with: --profile ' + profileName);
    } catch (err: unknown) {
      console.error(`Warning: failed to save profile: ${err instanceof Error ? err.message : String(err)}`);
      console.error('Credentials will still be available for this run via temp file.');
    }
  }

  // Write temp file for this run
  const path = writeCredFile(runId, credFile);
  console.error(`\nCredentials written to: ${path}`);
  console.error('This file will be automatically deleted after the QA review.\n');
  console.log(path);
  rl.close();
}

function writeCredFile(runId: string, credFile: CredentialFile): string {
  const filePath = `/tmp/sparfuchs-qa-creds-${runId}.json`;
  writeFileSync(filePath, JSON.stringify(credFile, null, 2), { mode: 0o600 });
  return filePath;
}

main().catch(err => {
  console.error(`Setup wizard failed: ${err}`);
  process.exit(1);
});
