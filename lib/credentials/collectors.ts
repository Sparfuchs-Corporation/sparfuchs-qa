import { createInterface } from 'node:readline';
import type { CredentialFile, StrategyName } from './strategies/base.js';

// Shared readline interface — must be created by the caller and passed in
export type AskFn = (question: string) => Promise<string>;
export type AskChoiceFn = (prompt: string, options: string[]) => Promise<number>;

export function createPromptHelpers(rl: ReturnType<typeof createInterface>): {
  ask: AskFn;
  askChoice: AskChoiceFn;
} {
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

  return { ask, askChoice };
}

export async function collectEmailPassword(ask: AskFn, askChoice: AskChoiceFn): Promise<Record<string, string>> {
  const email = await ask('Email: ');
  const password = await ask('Password: ');
  const providerIdx = await askChoice('Auth provider?', ['Firebase', 'Generic (form-based)', 'Other']);
  const creds: Record<string, string> = { email, password };

  if (providerIdx === 0) {
    creds.apiKey = await ask('Firebase Web API Key: ');
  }

  return creds;
}

export async function collectApiToken(ask: AskFn): Promise<Record<string, string>> {
  const token = await ask('API Token: ');
  return { token };
}

export async function collectOAuthToken(ask: AskFn): Promise<Record<string, string>> {
  const accessToken = await ask('Access Token: ');
  const refreshToken = await ask('Refresh Token (optional, press Enter to skip): ');
  const expiresAt = await ask('Expires At (ISO 8601, optional): ');
  const creds: Record<string, string> = { accessToken };
  if (refreshToken) creds.refreshToken = refreshToken;
  if (expiresAt) creds.expiresAt = expiresAt;
  return creds;
}

export async function collectBasicAuth(ask: AskFn): Promise<Record<string, string>> {
  const username = await ask('Username: ');
  const password = await ask('Password: ');
  return { username, password };
}

export async function collectTarget(ask: AskFn): Promise<CredentialFile['target']> {
  console.error('\n--- Target Environment ---');
  const baseUrl = await ask('Base URL (e.g., http://localhost:3000): ');
  const loginPath = await ask('Login path (default: /login): ') || '/login';
  const apiBasePath = await ask('API base path (default: /api): ') || '/api';
  return { baseUrl, loginPath, apiBasePath };
}

export async function collectMetadata(ask: AskFn, strategyName: StrategyName): Promise<CredentialFile['metadata']> {
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

export const STRATEGIES: { name: StrategyName; label: string; description: string }[] = [
  { name: 'email-password', label: 'Email + Password', description: 'Login form or Firebase auth' },
  { name: 'api-token', label: 'API Token', description: 'Bearer token or API key' },
  { name: 'oauth-token', label: 'OAuth Token', description: 'Pre-obtained OAuth access token' },
  { name: 'basic-auth', label: 'Basic Auth', description: 'HTTP Basic (username:password)' },
  { name: 'none', label: 'No Auth', description: 'Public endpoints, no authentication needed' },
];

export async function collectCredentials(
  strategyName: StrategyName,
  ask: AskFn,
  askChoice: AskChoiceFn,
): Promise<Record<string, string>> {
  switch (strategyName) {
    case 'email-password': return collectEmailPassword(ask, askChoice);
    case 'api-token': return collectApiToken(ask);
    case 'oauth-token': return collectOAuthToken(ask);
    case 'basic-auth': return collectBasicAuth(ask);
    default: return {};
  }
}

export function buildCredFile(
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
