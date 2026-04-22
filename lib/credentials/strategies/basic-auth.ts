import type { AuthStrategy, CredentialFile, ValidationResult, AuthHeader } from './base.js';

export const strategy: AuthStrategy = {
  name: 'basic-auth',

  validate(creds: CredentialFile): ValidationResult {
    const errors: string[] = [];
    if (!creds.credentials.username) errors.push('credentials.username is required');
    if (!creds.credentials.password) errors.push('credentials.password is required');
    return { valid: errors.length === 0, errors };
  },

  async getAuthHeader(creds: CredentialFile): Promise<AuthHeader> {
    const encoded = Buffer.from(
      `${creds.credentials.username}:${creds.credentials.password}`,
    ).toString('base64');
    return { header: 'Authorization', value: `Basic ${encoded}` };
  },
};
