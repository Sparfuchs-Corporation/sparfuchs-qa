/**
 * Sparfuchs QA — Secure Auth Proxy
 *
 * Spawned as a child process by the orchestrator. Reads API keys from the OS
 * keychain, holds them in this process only, and forwards API requests with
 * injected auth headers. The main orchestrator process never sees raw keys.
 *
 * Security model:
 *   - Unix domain socket (0o600) — no TCP exposure
 *   - Session token via IPC — not CLI args (visible in ps)
 *   - Constant-time token comparison — no timing attacks
 *   - Keys as Buffers — zeroed on shutdown
 *   - Anti-debug checks — refuses --inspect, traps SIGUSR1
 *   - 3-phase integrity handshake before receiving token
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, chmodSync, unlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Types ---

interface UpstreamConfig {
  host: string;
  port: number;
  authStyle: 'header-xapi' | 'header-bearer' | 'query-key';
  authHeader?: string;
}

interface ProxyTelemetryEvent {
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

// --- Constants ---

const SERVICE_NAME = 'sparfuchs-qa';
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const TOKEN_WAIT_TIMEOUT_MS = 5_000;
const PARENT_CHECK_INTERVAL_MS = 5_000;
const ALLOWED_METHODS = new Set(['POST', 'GET']);

const UPSTREAM: Record<string, UpstreamConfig> = {
  anthropic: { host: 'api.anthropic.com', port: 443, authStyle: 'header-xapi', authHeader: 'x-api-key' },
  xai:       { host: 'api.x.ai',          port: 443, authStyle: 'header-bearer' },
  google:    { host: 'generativelanguage.googleapis.com', port: 443, authStyle: 'query-key' },
  openai:    { host: 'api.openai.com',     port: 443, authStyle: 'header-bearer' },
};

const KEY_ENV_VARS: Record<string, string> = {
  xai: 'XAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

// --- State ---

let sessionTokenBuf: Buffer | null = null;
let socketPath: string | null = null;
const keyBuffers = new Map<string, Buffer>();
let server: ReturnType<typeof createServer> | null = null;
let parentCheckTimer: NodeJS.Timeout | null = null;

// --- Anti-Debug ---

function checkDebugger(): void {
  const debugFlags = ['--inspect', '--inspect-brk', '--inspect-port'];
  for (const arg of process.execArgv) {
    if (debugFlags.some(f => arg.startsWith(f))) {
      process.stderr.write('AUTH PROXY: Refusing to start — debugger flags detected. Keys would be exposed.\n');
      process.exit(1);
    }
  }
}

// Trap SIGUSR1 (Node debugger attach signal)
process.on('SIGUSR1', () => { /* ignore — prevent runtime debugger attach */ });

// --- Keychain Access ---

function readFromKeychain(keyName: string): Buffer | null {
  const plat = platform();
  try {
    let raw: string;
    switch (plat) {
      case 'darwin':
        raw = execFileSync('security', [
          'find-generic-password', '-s', SERVICE_NAME, '-a', keyName, '-w',
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        break;
      case 'linux':
        raw = execFileSync('secret-tool', [
          'lookup', 'service', SERVICE_NAME, 'key', keyName,
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        break;
      case 'win32':
        raw = execFileSync('powershell', ['-Command',
          `(Get-StoredCredential -Target '${SERVICE_NAME}-${keyName}').GetNetworkCredential().Password`,
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        break;
      default:
        return null;
    }
    if (!raw) return null;
    const buf = Buffer.from(raw, 'utf8');
    // Clear the string from the local scope as best we can
    raw = '';
    return buf;
  } catch {
    return null;
  }
}

function loadAllKeys(): string[] {
  const available: string[] = [];
  for (const [provider, envVar] of Object.entries(KEY_ENV_VARS)) {
    const buf = readFromKeychain(envVar);
    if (buf) {
      keyBuffers.set(provider, buf);
      available.push(provider);
    }
  }
  return available;
}

// --- Cleanup ---

function zeroAllKeys(): void {
  for (const [, buf] of keyBuffers) {
    buf.fill(0);
  }
  keyBuffers.clear();
}

function deleteSocket(): void {
  if (socketPath) {
    try { unlinkSync(socketPath); } catch { /* may already be gone */ }
    socketPath = null;
  }
}

function cleanShutdown(code: number): void {
  if (parentCheckTimer) clearInterval(parentCheckTimer);
  zeroAllKeys();
  if (server) {
    server.close();
    server = null;
  }
  deleteSocket();
  if (sessionTokenBuf) {
    sessionTokenBuf.fill(0);
    sessionTokenBuf = null;
  }
  process.exit(code);
}

process.on('SIGTERM', () => cleanShutdown(0));
process.on('SIGINT', () => cleanShutdown(0));
process.on('uncaughtException', (err) => {
  process.stderr.write(`AUTH PROXY: Uncaught exception: ${err.message}\n`);
  cleanShutdown(1);
});

// --- Integrity ---

function computeOwnHash(): string {
  const selfPath = fileURLToPath(import.meta.url);
  const content = readFileSync(selfPath);
  return createHash('sha256').update(content).digest('hex');
}

// --- Token Validation ---

function validateToken(req: IncomingMessage): boolean {
  if (!sessionTokenBuf) return false;
  const header = req.headers['x-proxy-token'];
  if (!header || typeof header !== 'string') return false;
  const incoming = Buffer.from(header, 'utf8');
  if (incoming.length !== sessionTokenBuf.length) return false;
  return timingSafeEqual(incoming, sessionTokenBuf);
}

// --- Request Forwarding ---

function extractProvider(url: string): { provider: string; upstreamPath: string } | null {
  // URL pattern: /{provider}/rest/of/path
  const match = url.match(/^\/([a-z]+)(\/.*)?$/);
  if (!match) return null;
  const provider = match[1];
  if (!UPSTREAM[provider]) return null;
  return { provider, upstreamPath: match[2] ?? '/' };
}

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forwardRequest(
  provider: string,
  upstreamPath: string,
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
): void {
  const upstream = UPSTREAM[provider];
  const keyBuf = keyBuffers.get(provider);
  if (!keyBuf) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No key available for ${provider}` }));
    return;
  }

  const keyStr = keyBuf.toString('utf8');

  // Build upstream URL
  let path = upstreamPath;
  if (upstream.authStyle === 'query-key') {
    const separator = path.includes('?') ? '&' : '?';
    path = `${path}${separator}key=${keyStr}`;
  }

  // Build headers — forward all except proxy-specific ones
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (key === 'x-proxy-token' || key === 'host' || key === 'connection') continue;
    headers[key] = val;
  }
  headers['host'] = upstream.host;
  headers['content-length'] = String(body.length);

  // Inject auth
  if (upstream.authStyle === 'header-xapi') {
    headers[upstream.authHeader ?? 'x-api-key'] = keyStr;
  } else if (upstream.authStyle === 'header-bearer') {
    headers['authorization'] = `Bearer ${keyStr}`;
  }

  const startTime = Date.now();
  const agentId = (req.headers['x-agent-id'] as string) ?? 'unknown';

  const upstreamReq = httpsRequest({
    hostname: upstream.host,
    port: upstream.port,
    path,
    method: req.method,
    headers,
    timeout: REQUEST_TIMEOUT_MS,
  }, (upstreamRes) => {
    // Scrub sensitive upstream headers
    const safeHeaders: Record<string, string | string[] | undefined> = {};
    for (const [key, val] of Object.entries(upstreamRes.headers)) {
      if (key.startsWith('x-api-key') || key === 'set-cookie') continue;
      safeHeaders[key] = val;
    }
    res.writeHead(upstreamRes.statusCode ?? 502, safeHeaders);

    let responseBytes = 0;
    upstreamRes.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      res.write(chunk);
    });

    upstreamRes.on('end', () => {
      res.end();
      // Emit telemetry
      const event: ProxyTelemetryEvent = {
        type: 'api-request',
        provider,
        agentId,
        method: req.method ?? 'POST',
        path: upstreamPath,
        requestBytes: body.length,
        responseStatus: upstreamRes.statusCode ?? 0,
        responseBytes,
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      if (process.send) process.send(event);
    });
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
    }
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upstream timeout' }));
    }
  });

  upstreamReq.write(body);
  upstreamReq.end();
}

// --- Stats Endpoint ---

const stats = {
  requestCount: 0,
  byProvider: {} as Record<string, { requests: number; errors: number; totalLatencyMs: number }>,
};

function handleStats(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(stats, null, 2));
}

// --- Request Handler ---

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? '';
  const url = req.url ?? '/';

  // Method allowlist
  if (!ALLOWED_METHODS.has(method)) {
    res.writeHead(405);
    res.end();
    return;
  }

  // Token validation
  if (!validateToken(req)) {
    res.writeHead(403);
    res.end();
    // Report auth failure via IPC (no details that could aid enumeration)
    if (process.send) {
      process.send({ type: 'auth-failure', timestamp: new Date().toISOString() });
    }
    return;
  }

  // Stats endpoint
  if (url === '/stats' && method === 'GET') {
    handleStats(res);
    return;
  }

  // Health endpoint
  if (url === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', providers: [...keyBuffers.keys()] }));
    return;
  }

  // Extract provider from path
  const route = extractProvider(url);
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }

  // Collect body and forward
  collectBody(req)
    .then((body) => {
      stats.requestCount++;
      const pStats = stats.byProvider[route.provider] ??= { requests: 0, errors: 0, totalLatencyMs: 0 };
      pStats.requests++;

      forwardRequest(route.provider, route.upstreamPath, req, body, res);
    })
    .catch((err) => {
      if (err instanceof Error && err.message === 'BODY_TOO_LARGE') {
        res.writeHead(413);
        res.end();
      } else {
        res.writeHead(500);
        res.end();
      }
    });
}

// --- Parent PID Monitor ---

function startParentMonitor(): void {
  const parentPid = process.ppid;
  parentCheckTimer = setInterval(() => {
    try {
      process.kill(parentPid, 0); // Signal 0 = check existence
    } catch {
      process.stderr.write('AUTH PROXY: Parent process gone — shutting down.\n');
      cleanShutdown(0);
    }
  }, PARENT_CHECK_INTERVAL_MS);
}

// --- Main Startup ---

async function main(): Promise<void> {
  checkDebugger();

  // Phase 1: Send integrity hash
  const hash = computeOwnHash();
  if (process.send) {
    process.send({ type: 'integrity', hash });
  } else {
    process.stderr.write('AUTH PROXY: No IPC channel — must be spawned by orchestrator.\n');
    process.exit(1);
  }

  // Phase 2: Wait for session token
  const token = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Token not received within timeout'));
    }, TOKEN_WAIT_TIMEOUT_MS);

    process.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && 'type' in msg && (msg as { type: string }).type === 'token') {
        clearTimeout(timeout);
        resolve((msg as { type: string; token: string }).token);
      }
    });
  }).catch((err) => {
    process.stderr.write(`AUTH PROXY: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

  sessionTokenBuf = Buffer.from(token, 'utf8');

  // Phase 3: Load keys and start server
  const available = loadAllKeys();

  if (available.length === 0) {
    process.stderr.write('AUTH PROXY: No API keys found in keychain.\n');
    if (process.send) process.send({ type: 'ready', socketPath: null, providers: [] });
    cleanShutdown(1);
    return;
  }

  // Create Unix domain socket
  const randomSuffix = randomBytes(8).toString('hex');
  socketPath = join(tmpdir(), `sparfuchs-qa-${process.pid}-${randomSuffix}.sock`);

  server = createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    server!.on('error', reject);
    server!.listen(socketPath!, () => {
      // Set socket permissions to owner-only
      try {
        chmodSync(socketPath!, 0o600);
      } catch {
        // Best effort — tmpdir may not support chmod on some systems
      }
      resolve();
    });
  });

  // Report ready
  if (process.send) {
    process.send({ type: 'ready', socketPath, providers: available });
  }

  startParentMonitor();
}

main().catch((err) => {
  process.stderr.write(`AUTH PROXY: Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  cleanShutdown(1);
});
