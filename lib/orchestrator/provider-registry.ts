/**
 * Sparfuchs QA — Provider Registry
 *
 * Orchestrator-side module that manages the auth proxy lifecycle,
 * creates Vercel AI SDK model instances routed through the proxy,
 * and provides pre-flight validation for each API provider.
 *
 * The main process never sees raw API keys — all requests are
 * routed through the Unix domain socket proxy.
 */

import { fork, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { generateText, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { ApiProviderName } from './types.js';

// --- Types ---

export interface ValidationResult {
  provider: ApiProviderName;
  model: string;
  tier: string;
  status: 'ok' | 'error' | 'skipped';
  latencyMs: number;
  error?: string;
}

export interface ProxyTelemetryEvent {
  type: 'api-request';
  provider: string;
  agentId: string;
  method: string;
  path: string;
  requestBytes: number;
  responseStatus: number;
  responseBytes: number;
  latencyMs: number;
  timestamp: string;
}

interface ProxyReadyMessage {
  type: 'ready';
  socketPath: string | null;
  providers: string[];
}

interface ProxyIntegrityMessage {
  type: 'integrity';
  hash: string;
}

// --- Custom Fetch for Unix Domain Socket ---

/**
 * Creates a fetch function that routes HTTP requests through the auth proxy's
 * Unix domain socket. The proxy handles auth header injection.
 */
function createProxyFetch(
  socketPath: string,
  sessionToken: string,
  agentId: string,
): typeof globalThis.fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input)
      : input instanceof URL ? input
      : new URL(input.url);

    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers: Record<string, string> = {
      'X-Proxy-Token': sessionToken,
      'X-Agent-Id': agentId,
    };

    // Copy headers from init
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) { headers[k] = v; }
      } else {
        for (const [k, v] of Object.entries(h)) {
          if (v !== undefined) headers[k] = v;
        }
      }
    }

    // Get body as Buffer
    let body: Buffer | undefined;
    if (init?.body) {
      if (typeof init.body === 'string') {
        body = Buffer.from(init.body, 'utf8');
      } else if (init.body instanceof ArrayBuffer) {
        body = Buffer.from(init.body);
      } else if (Buffer.isBuffer(init.body)) {
        body = init.body;
      } else if (init.body instanceof Uint8Array) {
        body = Buffer.from(init.body);
      } else {
        // ReadableStream or other — read it
        const reader = (init.body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        let done = false;
        while (!done) {
          const result = await reader.read();
          done = result.done;
          if (result.value) chunks.push(result.value);
        }
        body = Buffer.concat(chunks);
      }
    }

    if (body) {
      headers['content-length'] = String(body.length);
    }

    // The URL path includes the provider prefix that the proxy expects
    // e.g., http://localhost/anthropic/v1/messages → /anthropic/v1/messages
    const path = url.pathname + url.search;

    return new Promise<Response>((resolve, reject) => {
      const req = http.request({
        socketPath,
        path,
        method,
        headers,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [key, val] of Object.entries(res.headers)) {
            if (val) {
              const values = Array.isArray(val) ? val : [val];
              for (const v of values) responseHeaders.append(key, v);
            }
          }
          resolve(new Response(responseBody, {
            status: res.statusCode ?? 500,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }));
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}

// --- Provider Registry ---

export class ProviderRegistry {
  private proxyProcess: ChildProcess | null = null;
  private socketPath: string | null = null;
  private sessionToken: string | null = null;
  private availableProviders: Set<string> = new Set();
  private telemetryHandler: ((event: ProxyTelemetryEvent) => void) | null = null;

  /**
   * Start the auth proxy, perform integrity verification, and complete the
   * 3-phase handshake. Returns the list of providers that have keys available.
   */
  async startProxy(): Promise<string[]> {
    // Compute expected hash of the proxy script
    const proxyScriptPath = this.resolveProxyPath();
    const expectedHash = createHash('sha256')
      .update(readFileSync(proxyScriptPath))
      .digest('hex');

    // Generate session token
    this.sessionToken = randomBytes(64).toString('hex');

    // Spawn proxy with IPC channel.
    // When running via tsx (TypeScript direct execution), we need to use the
    // same tsx loader for the child process. fork() inherits execArgv from
    // the parent process, which includes tsx's loader hooks.
    this.proxyProcess = fork(proxyScriptPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    // Capture stderr for error reporting (but don't write to our stderr — dashboard safety)
    this.proxyProcess.stderr?.on('data', () => { /* silenced during dashboard */ });

    // Phase 1: Wait for integrity hash
    const integrityMsg = await this.waitForIpcMessage<ProxyIntegrityMessage>('integrity', 5_000);
    if (integrityMsg.hash !== expectedHash) {
      this.proxyProcess.kill('SIGTERM');
      this.proxyProcess = null;
      throw new Error(
        'Proxy integrity check failed — auth-proxy has been modified. ' +
        `Expected: ${expectedHash.slice(0, 16)}..., got: ${integrityMsg.hash.slice(0, 16)}...`,
      );
    }

    // Phase 2: Send session token
    this.proxyProcess.send({ type: 'token', token: this.sessionToken });

    // Phase 3: Wait for ready
    const readyMsg = await this.waitForIpcMessage<ProxyReadyMessage>('ready', 10_000);

    if (!readyMsg.socketPath || readyMsg.providers.length === 0) {
      throw new Error('Auth proxy started but no API keys found in keychain');
    }

    this.socketPath = readyMsg.socketPath;
    this.availableProviders = new Set(readyMsg.providers);

    // Listen for telemetry events
    this.proxyProcess.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && 'type' in msg) {
        const typed = msg as { type: string };
        if (typed.type === 'api-request' && this.telemetryHandler) {
          this.telemetryHandler(msg as ProxyTelemetryEvent);
        }
      }
    });

    return readyMsg.providers;
  }

  /**
   * Register a handler for proxy telemetry events (per-request metrics).
   */
  onTelemetry(handler: (event: ProxyTelemetryEvent) => void): void {
    this.telemetryHandler = handler;
  }

  /**
   * Create a Vercel AI SDK LanguageModel instance routed through the proxy.
   * The model's HTTP requests go via the Unix domain socket — never direct.
   */
  createModel(provider: ApiProviderName, modelName: string, agentId = 'unknown'): LanguageModel {
    if (!this.socketPath || !this.sessionToken) {
      throw new Error('Provider registry not initialized — call startProxy() first');
    }
    if (!this.availableProviders.has(provider)) {
      throw new Error(`Provider "${provider}" has no API key available`);
    }

    const fetch = createProxyFetch(this.socketPath, this.sessionToken, agentId);
    // baseURL uses the provider name as path prefix — proxy routes based on this
    const baseOpts = {
      apiKey: 'proxy-managed',
      fetch,
    };

    // NOTE: SDK provider packages return LanguageModelV1, but generateText() accepts
    // LanguageModel (V2/V3 union). The types are functionally compatible at runtime;
    // the cast bridges the version gap between @ai-sdk/* packages and the ai core.
    switch (provider) {
      case 'anthropic': {
        const p = createAnthropic({ ...baseOpts, baseURL: `http://proxy/anthropic/v1` });
        return p(modelName) as unknown as LanguageModel;
      }
      case 'xai': {
        const p = createXai({ ...baseOpts, baseURL: `http://proxy/xai/v1` });
        return p(modelName) as unknown as LanguageModel;
      }
      case 'google': {
        const p = createGoogleGenerativeAI({ ...baseOpts, baseURL: `http://proxy/google/v1beta` });
        return p(modelName) as unknown as LanguageModel;
      }
      case 'openai': {
        const p = createOpenAI({ ...baseOpts, baseURL: `http://proxy/openai/v1` });
        return p(modelName) as unknown as LanguageModel;
      }
      default:
        throw new Error(`Unknown API provider: ${provider}`);
    }
  }

  /**
   * Validate a specific provider + model combination with a minimal API call.
   */
  async validateProvider(provider: ApiProviderName, modelName: string, tier = 'unknown'): Promise<ValidationResult> {
    if (!this.availableProviders.has(provider)) {
      return { provider, model: modelName, tier, status: 'skipped', latencyMs: 0, error: 'No key available' };
    }

    const start = Date.now();
    try {
      const model = this.createModel(provider, modelName, 'validation');
      await generateText({
        model,
        prompt: 'Respond with the single word OK.',
        maxOutputTokens: 5,
      });
      return { provider, model: modelName, tier, status: 'ok', latencyMs: Date.now() - start };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const safeMsg = msg.replace(/key[=:]\s*\S+/gi, 'key=[REDACTED]');
      return { provider, model: modelName, tier, status: 'error', latencyMs: Date.now() - start, error: safeMsg };
    }
  }

  /**
   * Validate all provider + tier combinations that agents will actually use.
   * Accepts a list of { provider, model, tier } entries — one per unique
   * provider/tier combo needed by the agent set.
   */
  async validateAll(
    entries: Array<{ provider: ApiProviderName; model: string; tier: string }>,
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const allProviders: ApiProviderName[] = ['xai', 'google', 'anthropic', 'openai'];
    const entryMap = new Map<string, { provider: ApiProviderName; model: string; tier: string }>();

    for (const e of entries) {
      entryMap.set(`${e.provider}:${e.tier}`, e);
    }

    for (const provider of allProviders) {
      const providerEntries = entries.filter(e => e.provider === provider);
      if (providerEntries.length === 0) {
        results.push({ provider, model: '', tier: '', status: 'skipped', latencyMs: 0, error: 'No key available' });
        continue;
      }
      for (const entry of providerEntries) {
        const result = await this.validateProvider(provider, entry.model, entry.tier);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Get the list of providers that have keys available in the proxy.
   */
  getAvailableProviders(): ApiProviderName[] {
    return [...this.availableProviders] as ApiProviderName[];
  }

  /**
   * Check if the proxy is running and responsive.
   */
  isRunning(): boolean {
    return this.proxyProcess !== null && !this.proxyProcess.killed;
  }

  /**
   * Shut down the proxy process cleanly.
   */
  async shutdown(): Promise<void> {
    if (!this.proxyProcess) return;

    this.proxyProcess.kill('SIGTERM');

    // Wait for exit with timeout
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.proxyProcess && !this.proxyProcess.killed) {
          this.proxyProcess.kill('SIGKILL');
        }
        resolve();
      }, 3_000);

      this.proxyProcess!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.proxyProcess = null;
    this.socketPath = null;
    if (this.sessionToken) {
      // Zero out the token in memory
      const buf = Buffer.from(this.sessionToken, 'utf8');
      buf.fill(0);
      this.sessionToken = null;
    }
  }

  // --- Private ---

  private resolveProxyPath(): string {
    const selfDir = dirname(fileURLToPath(import.meta.url));
    // Support both tsx (TypeScript direct execution) and compiled JS
    const tsPath = join(selfDir, 'auth-proxy.ts');
    const jsPath = join(selfDir, 'auth-proxy.js');
    return existsSync(tsPath) ? tsPath : jsPath;
  }

  private waitForIpcMessage<T extends { type: string }>(
    expectedType: string,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.proxyProcess) {
        reject(new Error('Proxy process not started'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for proxy "${expectedType}" message (${timeoutMs}ms)`));
      }, timeoutMs);

      const handler = (msg: unknown) => {
        if (msg && typeof msg === 'object' && 'type' in msg && (msg as { type: string }).type === expectedType) {
          clearTimeout(timeout);
          this.proxyProcess?.off('message', handler);
          resolve(msg as T);
        }
      };

      this.proxyProcess.on('message', handler);
      this.proxyProcess.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Proxy exited with code ${code} before sending "${expectedType}"`));
      });
    });
  }
}
