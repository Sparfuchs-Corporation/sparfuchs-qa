export interface CredentialFile {
  version: number;
  runId: string;
  createdAt: string;
  strategy: StrategyName;
  credentials: Record<string, string>;
  target: {
    baseUrl: string;
    loginPath?: string;
    apiBasePath?: string;
  };
  metadata?: {
    authHeader?: string;
    tokenPrefix?: string;
    provider?: string;
  };
}

export type StrategyName =
  | 'email-password'
  | 'api-token'
  | 'oauth-token'
  | 'basic-auth'
  | 'none';

export interface AuthHeader {
  header: string;
  value: string;
}

export interface PlaywrightAuth {
  storageState?: Record<string, unknown>;
  loginSteps?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AuthStrategy {
  readonly name: StrategyName;
  validate(creds: CredentialFile): ValidationResult;
  getAuthHeader(creds: CredentialFile): Promise<AuthHeader>;
  getPlaywrightAuth?(creds: CredentialFile): Promise<PlaywrightAuth>;
}

const STRATEGY_MAP: Record<StrategyName, () => Promise<AuthStrategy>> = {
  'email-password': () => import('./email-password.js').then(m => m.strategy),
  'api-token': () => import('./api-token.js').then(m => m.strategy),
  'oauth-token': () => import('./oauth-token.js').then(m => m.strategy),
  'basic-auth': () => import('./basic-auth.js').then(m => m.strategy),
  'none': () => import('./none.js').then(m => m.strategy),
};

export async function resolveStrategy(name: string): Promise<AuthStrategy> {
  const loader = STRATEGY_MAP[name as StrategyName];
  if (!loader) {
    throw new Error(`Unknown auth strategy: "${name}". Valid: ${Object.keys(STRATEGY_MAP).join(', ')}`);
  }
  return loader();
}
