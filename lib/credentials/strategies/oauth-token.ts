import type { AuthStrategy, CredentialFile, ValidationResult, AuthHeader } from './base.js';

export const strategy: AuthStrategy = {
  name: 'oauth-token',

  validate(creds: CredentialFile): ValidationResult {
    const errors: string[] = [];
    if (!creds.credentials.accessToken) {
      errors.push('credentials.accessToken is required');
    }
    if (creds.credentials.expiresAt) {
      const expiry = new Date(creds.credentials.expiresAt).getTime();
      if (expiry < Date.now()) {
        errors.push(`OAuth token expired at ${creds.credentials.expiresAt}`);
      }
    }
    return { valid: errors.length === 0, errors };
  },

  async getAuthHeader(creds: CredentialFile): Promise<AuthHeader> {
    const header = creds.metadata?.authHeader ?? 'Authorization';
    const prefix = creds.metadata?.tokenPrefix ?? 'Bearer';
    const token = creds.credentials.accessToken;
    return { header, value: prefix ? `${prefix} ${token}` : token };
  },
};
