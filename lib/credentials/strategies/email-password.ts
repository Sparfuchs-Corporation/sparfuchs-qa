import type {
  AuthStrategy,
  CredentialFile,
  ValidationResult,
  AuthHeader,
  PlaywrightAuth,
} from './base.js';

let cachedToken: { value: string; expiresAt: number } | null = null;

async function firebaseSignIn(email: string, password: string, apiKey: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as { error?: { message?: string } }).error?.message ?? res.statusText;
    throw new Error(`Firebase sign-in failed: ${message}`);
  }

  const data = await res.json() as { idToken: string; expiresIn: string };
  const expiresInMs = parseInt(data.expiresIn, 10) * 1000;

  cachedToken = { value: data.idToken, expiresAt: Date.now() + expiresInMs - 60_000 };
  return data.idToken;
}

export const strategy: AuthStrategy = {
  name: 'email-password',

  validate(creds: CredentialFile): ValidationResult {
    const errors: string[] = [];
    if (!creds.credentials.email) errors.push('credentials.email is required');
    if (!creds.credentials.password) errors.push('credentials.password is required');
    if (creds.metadata?.provider === 'firebase' && !creds.credentials.apiKey) {
      errors.push('credentials.apiKey is required for firebase provider');
    }
    return { valid: errors.length === 0, errors };
  },

  async getAuthHeader(creds: CredentialFile): Promise<AuthHeader> {
    if (creds.metadata?.provider === 'firebase') {
      const token = await firebaseSignIn(
        creds.credentials.email,
        creds.credentials.password,
        creds.credentials.apiKey,
      );
      return { header: 'Authorization', value: `Bearer ${token}` };
    }

    // Generic email/password — return raw credentials for form-based auth
    return { header: '', value: '' };
  },

  async getPlaywrightAuth(creds: CredentialFile): Promise<PlaywrightAuth> {
    const loginPath = creds.target.loginPath ?? '/login';
    return {
      loginSteps: [
        `await page.goto('${creds.target.baseUrl}${loginPath}');`,
        `await page.fill('[type="email"], [name="email"]', '${creds.credentials.email}');`,
        `await page.fill('[type="password"], [name="password"]', '${creds.credentials.password}');`,
        `await page.click('[type="submit"]');`,
        `await page.waitForURL('**/dashboard**');`,
      ],
    };
  },
};
