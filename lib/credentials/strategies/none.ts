import type { AuthStrategy, CredentialFile, ValidationResult, AuthHeader } from './base.js';

export const strategy: AuthStrategy = {
  name: 'none',

  validate(_creds: CredentialFile): ValidationResult {
    return { valid: true, errors: [] };
  },

  async getAuthHeader(_creds: CredentialFile): Promise<AuthHeader> {
    return { header: '', value: '' };
  },
};
