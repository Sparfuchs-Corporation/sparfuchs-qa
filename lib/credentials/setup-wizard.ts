import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { CredentialFile, StrategyName } from './strategies/base.js';

const STRATEGIES: { name: StrategyName; label: string; description: string }[] = [
  { name: 'email-password', label: 'Email + Password', description: 'Login form or Firebase auth' },
  { name: 'api-token', label: 'API Token', description: 'Bearer token or API key' },
  { name: 'oauth-token', label: 'OAuth Token', description: 'Pre-obtained OAuth access token' },
  { name: 'basic-auth', label: 'Basic Auth', description: 'HTTP Basic (username:password)' },
  { name: 'none', label: 'No Auth', description: 'Public endpoints, no authentication needed' },
];

const rl = createInterface({ input: process.stdin, output: process.stderr });

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, (answer: string) => resolve(answer.trim()));
  });
}

async function askChoice(prompt: string, options: string[]): Promise<number> {
  console.error(`\n${prompt}`);
  options.forEach((opt, i) => console.error(`  ${i + 1}. ${opt}`));
  const answer = await ask(`Choose [1-${options.length}]: `);
  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= options.length) {
    console.error('Invalid choice, try again.');
    return askChoice(prompt, options);
  }
  return idx;
}

async function collectEmailPassword(): Promise<Record<string, string>> {
  const email = await ask('Email: ');
  const password = await ask('Password: ');
  const providerIdx = await askChoice('Auth provider?', ['Firebase', 'Generic (form-based)', 'Other']);
  const creds: Record<string, string> = { email, password };

  if (providerIdx === 0) {
    creds.apiKey = await ask('Firebase Web API Key: ');
  }

  return creds;
}

async function collectApiToken(): Promise<Record<string, string>> {
  const token = await ask('API Token: ');
  return { token };
}

async function collectOAuthToken(): Promise<Record<string, string>> {
  const accessToken = await ask('Access Token: ');
  const refreshToken = await ask('Refresh Token (optional, press Enter to skip): ');
  const expiresAt = await ask('Expires At (ISO 8601, optional): ');
  const creds: Record<string, string> = { accessToken };
  if (refreshToken) creds.refreshToken = refreshToken;
  if (expiresAt) creds.expiresAt = expiresAt;
  return creds;
}

async function collectBasicAuth(): Promise<Record<string, string>> {
  const username = await ask('Username: ');
  const password = await ask('Password: ');
  return { username, password };
}

async function collectTarget(): Promise<CredentialFile['target']> {
  console.error('\n--- Target Environment ---');
  const baseUrl = await ask('Base URL (e.g., http://localhost:3000): ');
  const loginPath = await ask('Login path (default: /login): ') || '/login';
  const apiBasePath = await ask('API base path (default: /api): ') || '/api';
  return { baseUrl, loginPath, apiBasePath };
}

async function collectMetadata(strategyName: StrategyName): Promise<CredentialFile['metadata']> {
  const meta: CredentialFile['metadata'] = {};

  if (strategyName === 'email-password') {
    const providerAnswer = await ask('Auth provider name (e.g., firebase, supabase, or press Enter): ');
    if (providerAnswer) meta.provider = providerAnswer;
  }

  if (['api-token', 'oauth-token'].includes(strategyName)) {
    const headerName = await ask('Auth header name (default: Authorization): ');
    if (headerName) meta.authHeader = headerName;
    const prefix = await ask('Token prefix (default: Bearer): ');
    if (prefix) meta.tokenPrefix = prefix;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

async function main(): Promise<void> {
  const runIdArg = process.argv.find((a: string) => a.startsWith('--run-id='));
  const runId = runIdArg
    ? runIdArg.split('=')[1]
    : `qa-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex')}`;

  console.error('\n=== Sparfuchs QA — Credential Setup ===\n');

  const needsAuth = await ask('Does the target project require authentication for testing? (y/n): ');

  if (needsAuth.toLowerCase() !== 'y') {
    const credFile = buildCredFile(runId, 'none', {}, { baseUrl: '', loginPath: '', apiBasePath: '' });
    const path = writeCredFile(runId, credFile);
    console.log(path); // stdout — captured by shell script
    rl.close();
    return;
  }

  const stratIdx = await askChoice(
    'Select authentication strategy:',
    STRATEGIES.map(s => `${s.label} — ${s.description}`),
  );
  const selectedStrategy = STRATEGIES[stratIdx];

  let credentials: Record<string, string>;
  switch (selectedStrategy.name) {
    case 'email-password':
      credentials = await collectEmailPassword();
      break;
    case 'api-token':
      credentials = await collectApiToken();
      break;
    case 'oauth-token':
      credentials = await collectOAuthToken();
      break;
    case 'basic-auth':
      credentials = await collectBasicAuth();
      break;
    default:
      credentials = {};
  }

  const target = await collectTarget();
  const metadata = await collectMetadata(selectedStrategy.name);

  const credFile = buildCredFile(runId, selectedStrategy.name, credentials, target, metadata);
  const path = writeCredFile(runId, credFile);

  console.error(`\nCredentials written to: ${path}`);
  console.error('This file will be automatically deleted after the QA review.\n');
  console.log(path); // stdout — captured by shell script
  rl.close();
}

function buildCredFile(
  runId: string,
  strategy: StrategyName,
  credentials: Record<string, string>,
  target: CredentialFile['target'],
  metadata?: CredentialFile['metadata'],
): CredentialFile {
  return {
    version: 1,
    runId,
    createdAt: new Date().toISOString(),
    strategy,
    credentials,
    target,
    metadata,
  };
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
