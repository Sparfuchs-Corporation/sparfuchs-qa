import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { KeychainPlatform, CredentialResult } from './types.js';
import type { CredentialFile } from '../credentials/strategies/base.js';

const SERVICE_NAME = 'sparfuchs-qa';
const TEST_PROFILE_PREFIX = 'TEST_PROFILE_';

export function detectPlatform(): KeychainPlatform {
  switch (platform()) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    case 'linux': return 'linux';
    default: return 'unknown';
  }
}

// --- Low-level keychain operations ---

function readFromKeychain(keyName: string): string | null {
  const plat = detectPlatform();
  try {
    switch (plat) {
      case 'macos':
        return execFileSync('security', [
          'find-generic-password', '-s', SERVICE_NAME, '-a', keyName, '-w',
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      case 'windows':
        return execFileSync('powershell', ['-Command',
          `(Get-StoredCredential -Target '${SERVICE_NAME}-${keyName}').GetNetworkCredential().Password`,
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      case 'linux':
        return execFileSync('secret-tool', [
          'lookup', 'service', SERVICE_NAME, 'key', keyName,
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      default:
        return null;
    }
  } catch {
    return null;
  }
}

function writeToKeychain(keyName: string, value: string): void {
  const plat = detectPlatform();
  switch (plat) {
    case 'macos':
      try {
        execFileSync('security', [
          'delete-generic-password', '-s', SERVICE_NAME, '-a', keyName,
        ], { stdio: 'pipe' });
      } catch { /* entry may not exist */ }
      execFileSync('security', [
        'add-generic-password', '-s', SERVICE_NAME, '-a', keyName, '-w', value,
      ], { stdio: 'pipe' });
      break;

    case 'windows':
      execFileSync('powershell', ['-Command',
        `$ss = ConvertTo-SecureString '${value}' -AsPlainText -Force; ` +
        `New-StoredCredential -Target '${SERVICE_NAME}-${keyName}' -Password $ss -Type Generic -Persist LocalMachine`,
      ], { stdio: 'pipe' });
      break;

    case 'linux':
      execFileSync('secret-tool', [
        'store', '--label', SERVICE_NAME, 'service', SERVICE_NAME, 'key', keyName,
      ], { input: value, stdio: ['pipe', 'pipe', 'pipe'] });
      break;

    default:
      throw new Error(`OS keychain not supported on ${platform()}. Use environment variables instead.`);
  }
}

function deleteFromKeychain(keyName: string): boolean {
  const plat = detectPlatform();
  try {
    switch (plat) {
      case 'macos':
        execFileSync('security', [
          'delete-generic-password', '-s', SERVICE_NAME, '-a', keyName,
        ], { stdio: 'pipe' });
        return true;

      case 'windows':
        execFileSync('powershell', ['-Command',
          `Remove-StoredCredential -Target '${SERVICE_NAME}-${keyName}'`,
        ], { stdio: 'pipe' });
        return true;

      case 'linux':
        execFileSync('secret-tool', [
          'clear', 'service', SERVICE_NAME, 'key', keyName,
        ], { stdio: 'pipe' });
        return true;

      default:
        return false;
    }
  } catch {
    return false;
  }
}

// --- API Key Operations (existing interface) ---

export function resolveApiKey(keyName: string, envVar: string): CredentialResult | null {
  const keychainValue = readFromKeychain(keyName);
  if (keychainValue) return { value: keychainValue, source: 'keychain' };

  const envValue = process.env[envVar];
  if (envValue) return { value: envValue, source: 'env' };

  return null;
}

export function storeApiKey(keyName: string, value: string): void {
  writeToKeychain(keyName, value);
}

export function listStoredKeys(): string[] {
  const TARGET_KEYS = [
    'XAI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    // CLI adapters that benefit from keychain-sourced auth
    'GEMINI_API_KEY',
  ];
  const found: string[] = [];
  for (const key of TARGET_KEYS) {
    if (readFromKeychain(key)) found.push(key);
  }
  return found;
}

// --- Test Credential Profile Operations ---

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". ` +
      `Must be 1-63 characters, alphanumeric with hyphens/underscores, starting with alphanumeric.`
    );
  }
}

export function storeTestProfile(name: string, credFile: CredentialFile): void {
  validateProfileName(name);
  const json = JSON.stringify(credFile);
  writeToKeychain(`${TEST_PROFILE_PREFIX}${name}`, json);
}

export function loadTestProfile(name: string): CredentialFile | null {
  validateProfileName(name);
  const json = readFromKeychain(`${TEST_PROFILE_PREFIX}${name}`);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as CredentialFile;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteTestProfile(name: string): boolean {
  validateProfileName(name);
  return deleteFromKeychain(`${TEST_PROFILE_PREFIX}${name}`);
}

export function listTestProfiles(): string[] {
  const plat = detectPlatform();
  try {
    switch (plat) {
      case 'macos': {
        // Dump keychain and extract account names for our service
        const dump = execFileSync('security', [
          'dump-keychain',
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 });

        const profiles: string[] = [];
        const lines = dump.split('\n');
        let inEntry = false;
        let isOurService = false;

        for (const line of lines) {
          if (line.includes('keychain:')) {
            inEntry = true;
            isOurService = false;
          }
          if (inEntry && line.includes(`"svce"<blob>="${SERVICE_NAME}"`)) {
            isOurService = true;
          }
          if (inEntry && isOurService && line.includes('"acct"<blob>=')) {
            const match = line.match(/"acct"<blob>="([^"]+)"/);
            if (match?.[1]?.startsWith(TEST_PROFILE_PREFIX)) {
              profiles.push(match[1].slice(TEST_PROFILE_PREFIX.length));
            }
          }
        }
        return profiles;
      }

      case 'linux': {
        const output = execFileSync('secret-tool', [
          'search', 'service', SERVICE_NAME,
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 });

        const profiles: string[] = [];
        const keyMatches = output.matchAll(/attribute\.key\s*=\s*(\S+)/g);
        for (const m of keyMatches) {
          if (m[1].startsWith(TEST_PROFILE_PREFIX)) {
            profiles.push(m[1].slice(TEST_PROFILE_PREFIX.length));
          }
        }
        return profiles;
      }

      case 'windows': {
        const output = execFileSync('powershell', ['-Command',
          `Get-StoredCredential | Where-Object {$_.TargetName -like '${SERVICE_NAME}-${TEST_PROFILE_PREFIX}*'} | ForEach-Object {$_.TargetName}`,
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 });

        const prefix = `${SERVICE_NAME}-${TEST_PROFILE_PREFIX}`;
        return output.split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith(prefix))
          .map(l => l.slice(prefix.length));
      }

      default:
        return [];
    }
  } catch {
    return [];
  }
}
