import type { AuthStrategy, CredentialFile, ValidationResult, AuthHeader } from './base.js';

export const strategy: AuthStrategy = {
  name: 'api-token',

  validate(creds: CredentialFile): ValidationResult {
    const errors: string[] = [];
    if (!creds.credentials.token) {
      errors.push('credentials.token is required for api-token strategy');
    }
    return { valid: errors.length === 0, errors };
  },

  async getAuthHeader(creds: CredentialFile): Promise<AuthHeader> {
    const header = creds.metadata?.authHeader ?? 'Authorization';
    const prefix = creds.metadata?.tokenPrefix ?? 'Bearer';
    const token = creds.credentials.token;
    return { header, value: prefix ? `${prefix} ${token}` : token };
  },
};
