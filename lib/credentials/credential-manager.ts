import { readFileSync, existsSync } from 'node:fs';
import { resolveStrategy } from './strategies/base.js';
import type { CredentialFile, AuthHeader } from './strategies/base.js';

const CRED_ENV_VAR = 'SPARFUCHS_CRED_FILE';
const CURRENT_VERSION = 1;

export function getCredentialPath(): string | null {
  return process.env[CRED_ENV_VAR] ?? null;
}

export function hasCredentials(): boolean {
  const path = getCredentialPath();
  return path !== null && existsSync(path);
}

export function loadCredentials(): CredentialFile | null {
  const path = getCredentialPath();
  if (!path || !existsSync(path)) return null;

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as CredentialFile;

  if (parsed.version !== CURRENT_VERSION) {
    throw new Error(
      `Credential file version ${parsed.version} is not supported (expected ${CURRENT_VERSION})`,
    );
  }

  return parsed;
}

export async function getAuthHeader(): Promise<AuthHeader | null> {
  const creds = loadCredentials();
  if (!creds) return null;

  const strat = await resolveStrategy(creds.strategy);
  const validation = strat.validate(creds);
  if (!validation.valid) {
    throw new Error(`Credential validation failed: ${validation.errors.join(', ')}`);
  }

  return strat.getAuthHeader(creds);
}

export { resolveStrategy } from './strategies/base.js';
export type { CredentialFile, AuthHeader, AuthStrategy, StrategyName } from './strategies/base.js';
