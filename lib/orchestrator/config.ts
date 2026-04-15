import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ModelsYaml, ModelTier, ProviderName, ApiProviderName } from './types.js';
import { isApiProvider, isCliProvider } from './types.js';
import { resolveApiKey } from './credential-store.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(MODULE_DIR, '../../config/models.yaml');

// --- Zod schema ---

const ProviderNameEnum = z.enum(['xai', 'google', 'anthropic', 'openai', 'claude-cli', 'gemini-cli', 'codex-cli', 'openclaw']);
const TierEnum = z.enum(['heavy', 'mid', 'light']);

const ApiProviderSchema = z.object({
  type: z.literal('api'),
  enabled: z.boolean(),
  apiKeyEnvVar: z.string(),
});

const CliProviderSchema = z.object({
  type: z.literal('cli'),
  enabled: z.union([z.boolean(), z.literal('auto')]),
  binary: z.string(),
});

const ProviderConfigSchema = z.discriminatedUnion('type', [ApiProviderSchema, CliProviderSchema]);

const TokenBudgetSchema = z.object({
  presets: z.object({
    full: z.union([z.literal('all'), z.array(z.string())]),
    standard: z.array(z.string()),
    lite: z.array(z.string()),
  }),
  pricing: z.object({
    xai: z.number(),
    google: z.number(),
    anthropic: z.number(),
    openai: z.number(),
  }),
  defaultCap: z.number().default(0),
}).optional();

const ModelsYamlSchema = z.object({
  defaultProvider: ProviderNameEnum,
  dataClassification: z.enum(['public', 'internal', 'restricted']).default('public'),
  redactSecrets: z.boolean().default(true),
  approvedProviders: z.array(ProviderNameEnum).optional(),
  providers: z.record(z.string(), ProviderConfigSchema),
  fallbackChain: z.array(ProviderNameEnum),
  tiers: z.record(TierEnum, z.object({
    xai: z.string(),
    google: z.string(),
    anthropic: z.string(),
    openai: z.string(),
  })),
  agentOverrides: z.record(z.string(), z.object({
    provider: ProviderNameEnum.optional(),
    tier: TierEnum.optional(),
    disableBash: z.boolean().optional(),
    maxSteps: z.number().optional(),
  })).default({}),
  tokenBudget: TokenBudgetSchema,
});

// --- Public API ---

export function loadModelsConfig(configPath: string = DEFAULT_CONFIG_PATH): ModelsYaml {
  if (!existsSync(configPath)) {
    throw new Error(
      `Models config not found: ${configPath}\n` +
      `Copy the example: cp config/models.yaml.example config/models.yaml`
    );
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = parseYaml(raw);
  return ModelsYamlSchema.parse(parsed) as ModelsYaml;
}

export function enforceDataClassification(config: ModelsYaml): void {
  if (config.dataClassification === 'restricted') {
    // In restricted mode: disable API providers (data would leave the machine)
    // but CLI providers are allowed (data stays local)
    let hasCliProvider = false;
    for (const [, provider] of Object.entries(config.providers)) {
      if (isApiProvider(provider)) {
        provider.enabled = false;
      } else if (isCliProvider(provider) && provider.enabled) {
        hasCliProvider = true;
      }
    }
    if (!hasCliProvider) {
      throw new Error(
        'dataClassification is "restricted" — all API providers disabled.\n' +
        'No CLI providers detected. Install a CLI tool (claude, gemini, codex, openclaw)\n' +
        'or change dataClassification in config/models.yaml.'
      );
    }
  }

  if (config.dataClassification === 'internal') {
    const approved = config.approvedProviders ?? [];
    if (approved.length === 0) {
      throw new Error(
        'dataClassification is "internal" but approvedProviders is empty.\n' +
        'Add providers to approvedProviders or change to "public".'
      );
    }
    for (const [name, provider] of Object.entries(config.providers)) {
      if (isApiProvider(provider) && !approved.includes(name as ProviderName)) {
        provider.enabled = false;
      }
    }
  }
}

export function resolveProviderKeys(
  config: ModelsYaml,
): { available: ProviderName[]; disabled: string[] } {
  const available: ProviderName[] = [];
  const disabled: string[] = [];

  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.enabled) continue;

    if (isApiProvider(provider)) {
      // API providers need an API key
      const key = resolveApiKey(provider.apiKeyEnvVar, provider.apiKeyEnvVar);
      if (key) {
        available.push(name as ProviderName);
        const sourceLabel = key.source === 'keychain' ? 'OS keychain' : 'env var';
        process.stderr.write(`  ${name}: API key valid (${sourceLabel})\n`);
      } else {
        provider.enabled = false;
        disabled.push(`${name}: no key (checked OS keychain + ${provider.apiKeyEnvVar} env var)`);
      }
    } else if (isCliProvider(provider)) {
      // CLI providers are already resolved by resolveCliProviders() — just check enabled
      if (provider.enabled === true) {
        available.push(name as ProviderName);
      } else {
        disabled.push(`${name}: CLI binary "${provider.binary}" not found in PATH`);
      }
    }
  }

  const chainAvailable = config.fallbackChain.filter(p => {
    const prov = config.providers[p];
    return prov && prov.enabled;
  });

  if (chainAvailable.length === 0) {
    throw new Error(
      'No providers available. Either:\n' +
      '  1. Store an API key:\n' +
      '     macOS:   security add-generic-password -s sparfuchs-qa -a XAI_API_KEY -w "your-key"\n' +
      '     Linux:   secret-tool store --label=sparfuchs-qa service sparfuchs-qa key XAI_API_KEY\n' +
      '     Any OS:  export XAI_API_KEY=your-key\n' +
      '  2. Install a CLI tool: claude, gemini, codex, or openclaw'
    );
  }

  return { available, disabled };
}

const TIER_MAP: Record<string, ModelTier> = {
  opus: 'heavy',
  sonnet: 'mid',
  haiku: 'light',
};

export function mapLegacyTier(frontmatterModel: string): ModelTier {
  const tier = TIER_MAP[frontmatterModel];
  if (!tier) {
    throw new Error(
      `Unknown model in agent frontmatter: "${frontmatterModel}". Expected: opus, sonnet, or haiku.`
    );
  }
  return tier;
}

const API_PROVIDER_NAMES = new Set(['xai', 'google', 'anthropic', 'openai']);

/**
 * Resolve "API" / "CLI" meta-values to the first matching enabled provider.
 * Passes through valid ProviderName values unchanged.
 */
function resolveProviderMeta(
  raw: string | undefined,
  config: ModelsYaml,
): ProviderName | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();

  if (lower === 'api') {
    for (const [name, cfg] of Object.entries(config.providers)) {
      if (cfg.enabled && isApiProvider(cfg)) return name as ProviderName;
    }
    return undefined;
  }
  if (lower === 'cli') {
    for (const [name, cfg] of Object.entries(config.providers)) {
      if (cfg.enabled && isCliProvider(cfg)) return name as ProviderName;
    }
    return undefined;
  }
  return raw as ProviderName;
}

export function resolveModelForAgent(
  agentName: string,
  tier: ModelTier,
  config: ModelsYaml,
  providerOverride?: ProviderName,
): { provider: ProviderName; model: string } {
  const override = config.agentOverrides[agentName];
  const resolved = resolveProviderMeta(providerOverride as string | undefined, config);
  const preferred = resolved ?? override?.provider ?? config.defaultProvider;

  const preferredConfig = config.providers[preferred];
  if (preferredConfig?.enabled) {
    if (isCliProvider(preferredConfig)) {
      return { provider: preferred, model: preferredConfig.binary };
    }
    if (API_PROVIDER_NAMES.has(preferred)) {
      return { provider: preferred, model: config.tiers[tier][preferred as ApiProviderName] };
    }
  }

  // Fall through to first enabled provider in chain
  for (const p of config.fallbackChain) {
    const pConfig = config.providers[p];
    if (!pConfig?.enabled) continue;

    if (isCliProvider(pConfig)) {
      return { provider: p, model: pConfig.binary };
    }
    if (API_PROVIDER_NAMES.has(p)) {
      return { provider: p, model: config.tiers[tier][p as ApiProviderName] };
    }
  }

  throw new Error(`No enabled provider for agent ${agentName}`);
}
