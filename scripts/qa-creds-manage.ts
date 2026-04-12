import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import {
  listTestProfiles, loadTestProfile, storeTestProfile, deleteTestProfile,
} from '../lib/orchestrator/credential-store.js';
import {
  createPromptHelpers, STRATEGIES,
  collectCredentials, collectTarget, collectMetadata, buildCredFile,
} from '../lib/credentials/collectors.js';

const COMMANDS = ['list', 'store', 'delete', 'show'] as const;
type Command = typeof COMMANDS[number];

function parseArgs(): { command: Command; name?: string } {
  const args = process.argv.slice(2);
  const command = args[0] as Command;

  if (!command || !COMMANDS.includes(command)) {
    console.error('Usage:');
    console.error('  npx tsx scripts/qa-creds-manage.ts list');
    console.error('  npx tsx scripts/qa-creds-manage.ts store --name <profile-name>');
    console.error('  npx tsx scripts/qa-creds-manage.ts show --name <profile-name>');
    console.error('  npx tsx scripts/qa-creds-manage.ts delete --name <profile-name>');
    process.exit(1);
  }

  const nameIdx = args.indexOf('--name');
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;

  if (['store', 'delete', 'show'].includes(command) && !name) {
    console.error(`Error: --name is required for "${command}" command`);
    process.exit(1);
  }

  return { command, name };
}

async function cmdList(): Promise<void> {
  const profiles = listTestProfiles();
  if (profiles.length === 0) {
    console.log('No test credential profiles found in OS keychain.');
    console.log('Store one with: npx tsx scripts/qa-creds-manage.ts store --name <name>');
    return;
  }

  console.log(`\nStored test credential profiles (${profiles.length}):\n`);
  for (const name of profiles) {
    const profile = loadTestProfile(name);
    if (profile) {
      console.log(`  ${name}`);
      console.log(`    Strategy: ${profile.strategy}`);
      console.log(`    Target:   ${profile.target.baseUrl || '(not set)'}`);
      console.log(`    Created:  ${profile.createdAt}`);
      console.log('');
    } else {
      console.log(`  ${name} (corrupted — could not parse)`);
    }
  }
}

async function cmdShow(name: string): Promise<void> {
  const profile = loadTestProfile(name);
  if (!profile) {
    console.error(`Profile "${name}" not found in OS keychain.`);
    process.exit(1);
  }

  console.log(`\nProfile: ${name}\n`);
  console.log(`  Strategy:  ${profile.strategy}`);
  console.log(`  Target:    ${profile.target.baseUrl || '(not set)'}`);
  console.log(`  Login:     ${profile.target.loginPath || '(not set)'}`);
  console.log(`  API Base:  ${profile.target.apiBasePath || '(not set)'}`);
  console.log(`  Created:   ${profile.createdAt}`);

  if (profile.metadata) {
    console.log(`  Provider:  ${profile.metadata.provider || '-'}`);
    console.log(`  Header:    ${profile.metadata.authHeader || '-'}`);
    console.log(`  Prefix:    ${profile.metadata.tokenPrefix || '-'}`);
  }

  // Show credential keys (not values!) for verification
  const credKeys = Object.keys(profile.credentials);
  console.log(`  Cred keys: ${credKeys.length > 0 ? credKeys.join(', ') : '(none)'}`);
  console.log('');
}

async function cmdStore(name: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const { ask, askChoice } = createPromptHelpers(rl);

  console.error(`\n=== Store Credential Profile: ${name} ===\n`);

  const stratIdx = await askChoice(
    'Select authentication strategy:',
    STRATEGIES.map(s => `${s.label} \u2014 ${s.description}`),
  );
  const selectedStrategy = STRATEGIES[stratIdx];

  const credentials = await collectCredentials(selectedStrategy.name, ask, askChoice);
  const target = await collectTarget(ask);
  const metadata = await collectMetadata(ask, selectedStrategy.name);

  const runId = `profile-${name}-${randomBytes(2).toString('hex')}`;
  const credFile = buildCredFile(runId, selectedStrategy.name, credentials, target, metadata);

  storeTestProfile(name, credFile);
  console.error(`\nProfile "${name}" saved to OS keychain.`);
  console.error(`Use with: --profile ${name}`);

  rl.close();
}

async function cmdDelete(name: string): Promise<void> {
  const deleted = deleteTestProfile(name);
  if (deleted) {
    console.log(`Profile "${name}" deleted from OS keychain.`);
  } else {
    console.error(`Profile "${name}" not found or could not be deleted.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { command, name } = parseArgs();

  switch (command) {
    case 'list': return cmdList();
    case 'show': return cmdShow(name!);
    case 'store': return cmdStore(name!);
    case 'delete': return cmdDelete(name!);
  }
}

main().catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
