import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ModelsYaml, ModelTier, ProviderName } from './types.js';
import { resolveApiKey } from './credential-store.js';

const DEFAULT_CONFIG_PATH = join(import.meta.dirname, '../../config/models.yaml');

// --- Zod schema ---

const ProviderNameEnum = z.enum(['xai', 'google', 'anthropic']);
const TierEnum = z.enum(['heavy', 'mid', 'light']);

const ModelsYamlSchema = z.object({
  defaultProvider: ProviderNameEnum,
  dataClassification: z.enum(['public', 'internal', 'restricted']).default('public'),
  redactSecrets: z.boolean().default(true),
  approvedProviders: z.array(ProviderNameEnum).optional(),
  providers: z.record(ProviderNameEnum, z.object({
    enabled: z.boolean(),
    apiKeyEnvVar: z.string(),
  })),
  fallbackChain: z.array(ProviderNameEnum),
  tiers: z.record(TierEnum, z.object({
    xai: z.string(),
    google: z.string(),
    anthropic: z.string(),
  })),
  agentOverrides: z.record(z.string(), z.object({
    provider: ProviderNameEnum.optional(),
    tier: TierEnum.optional(),
    disableBash: z.boolean().optional(),
  })).default({}),
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
    throw new Error(
      'dataClassification is "restricted" — orchestrated engine disabled.\n' +
      'Use ENGINE=claude (default) for Claude CLI, or change dataClassification in config/models.yaml.'
    );
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
      if (!approved.includes(name as ProviderName)) {
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
    const key = resolveApiKey(provider.apiKeyEnvVar, provider.apiKeyEnvVar);
    if (key) {
      available.push(name as ProviderName);
    } else {
      provider.enabled = false;
      disabled.push(`${name}: no key (checked OS keychain + ${provider.apiKeyEnvVar} env var)`);
    }
  }

  const chainAvailable = config.fallbackChain.filter(p => config.providers[p]?.enabled);
  if (chainAvailable.length === 0) {
    throw new Error(
      'No providers available. Store at least one API key:\n' +
      '  macOS:   security add-generic-password -s sparfuchs-qa -a XAI_API_KEY -w "your-key"\n' +
      '  Linux:   secret-tool store --label=sparfuchs-qa service sparfuchs-qa key XAI_API_KEY\n' +
      '  Any OS:  export XAI_API_KEY=your-key'
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

export function resolveModelForAgent(
  agentName: string,
  tier: ModelTier,
  config: ModelsYaml,
  providerOverride?: ProviderName,
): { provider: ProviderName; model: string } {
  const override = config.agentOverrides[agentName];
  const preferred = providerOverride ?? override?.provider ?? config.defaultProvider;

  if (config.providers[preferred]?.enabled) {
    return { provider: preferred, model: config.tiers[tier][preferred] };
  }

  // Fall through to first enabled provider in chain
  const fallback = config.fallbackChain.find(p => config.providers[p]?.enabled);
  if (!fallback) {
    throw new Error(`No enabled provider for agent ${agentName}`);
  }
  return { provider: fallback, model: config.tiers[tier][fallback] };
}
