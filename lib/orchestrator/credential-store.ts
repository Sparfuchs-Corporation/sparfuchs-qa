import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { KeychainPlatform, CredentialResult } from './types.js';

const SERVICE_NAME = 'sparfuchs-qa';

export function detectPlatform(): KeychainPlatform {
  switch (platform()) {
    case 'darwin': return 'macos';
    case 'win32': return 'windows';
    case 'linux': return 'linux';
    default: return 'unknown';
  }
}

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

export function resolveApiKey(keyName: string, envVar: string): CredentialResult | null {
  // 1. OS keychain first (strongest local store)
  const keychainValue = readFromKeychain(keyName);
  if (keychainValue) return { value: keychainValue, source: 'keychain' };

  // 2. Environment variable fallback (for CI/CD)
  const envValue = process.env[envVar];
  if (envValue) return { value: envValue, source: 'env' };

  return null;
}

export function storeApiKey(keyName: string, value: string): void {
  const plat = detectPlatform();
  switch (plat) {
    case 'macos':
      try {
        execFileSync('security', [
          'delete-generic-password', '-s', SERVICE_NAME, '-a', keyName,
        ], { stdio: 'pipe' });
      } catch { /* ignore — entry may not exist */ }
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

export function listStoredKeys(): string[] {
  const TARGET_KEYS = ['XAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'ANTHROPIC_API_KEY'];
  const found: string[] = [];
  for (const key of TARGET_KEYS) {
    if (readFromKeychain(key)) found.push(key);
  }
  return found;
}
