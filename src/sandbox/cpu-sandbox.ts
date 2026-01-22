/**
 * CPU Sandbox - Hardware-isolated execution environment for untrusted AI actions
 */

import type { CPUSandboxConfig, CPUSandboxInstance, RunResult, UploadOptions } from '../types/index.js';
import { ValidationError, BuildfunctionsError } from '../utils/errors.js';
import { parseMemory } from '../utils/memory.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import dns from 'dns';
import https from 'https';

const DEFAULT_BASE_URL = 'https://www.buildfunctions.com';

// AWS Route53 authoritative nameservers for buildfunctions.app
// These have the DNS records IMMEDIATELY - no propagation delay
const awsNameservers = [
  '205.251.193.143', // ns-399.awsdns-49.com
  '205.251.198.254', // ns-1278.awsdns-31.org
  '205.251.195.249', // ns-1017.awsdns-63.net
  '205.251.198.95',  // ns-1631.awsdns-11.co.uk
];

// DNS resolver using AWS Route53 authoritative nameservers
const awsResolver = new dns.Resolver();
awsResolver.setServers(awsNameservers);

/**
 * Resolve hostname using AWS Route53 authoritative nameservers
 */
function resolveWithAWS(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    awsResolver.resolve4(hostname, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        reject(err || new Error('No addresses'));
      } else {
        resolve(addresses[0]!);
      }
    });
  });
}

/**
 * HTTPS GET using resolved IP (bypasses system DNS entirely)
 */
function httpsGetWithIP(ip: string, hostname: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ip,
      port: 443,
      path: path,
      method: 'GET',
      headers: { 'Host': hostname },
      servername: hostname, // SNI for TLS
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Wait for endpoint using AWS Route53 authoritative DNS
 */
async function waitForEndpoint(endpoint: string, maxAttempts = 60, delayMs = 500): Promise<void> {
  const url = new URL(endpoint);
  const hostname = url.hostname;
  const path = url.pathname + url.search || '/';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Step 1: Resolve via AWS Route53 authoritative nameservers (immediate, no propagation)
      const ip = await resolveWithAWS(hostname);

      // Step 2: Connect directly to IP with proper Host/SNI headers
      const res = await httpsGetWithIP(ip, hostname, path);
      if (res.status >= 200 && res.status < 500) return;
    } catch (err) {
      const error = err as Error & { code?: string };
      if (attempt === 1 || attempt % 10 === 0) {
        console.log(`   Waiting for endpoint... (attempt ${attempt}/${maxAttempts}) ${error.code || error.message}`);
      }
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new BuildfunctionsError(`Endpoint not ready after ${maxAttempts} attempts`, 'NETWORK_ERROR');
}

/**
 * Fetch endpoint using AWS Route53 authoritative DNS
 */
async function fetchWithAuthDNS(endpoint: string): Promise<{ status: number; body: string }> {
  const url = new URL(endpoint);
  const hostname = url.hostname;
  const path = url.pathname + url.search || '/';

  const ip = await resolveWithAWS(hostname);
  return httpsGetWithIP(ip, hostname, path);
}


// Global configuration
let globalApiKey: string | null = null;
let globalBaseUrl: string | undefined;

/**
 * Set the API key for sandbox operations
 */
export function setCpuSandboxApiKey(apiKey: string, baseUrl?: string): void {
  globalApiKey = apiKey;
  globalBaseUrl = baseUrl;
}

function validateConfig(config: CPUSandboxConfig): void {
  if (!config.name || typeof config.name !== 'string') {
    throw new ValidationError('Sandbox name is required');
  }

  if (!config.language || typeof config.language !== 'string') {
    throw new ValidationError('Language is required');
  }

  // JavaScript requires explicit runtime (node or deno)
  if (config.language === 'javascript' && !config.runtime) {
    throw new ValidationError('JavaScript requires explicit runtime: "node" or "deno"');
  }
}

/**
 * Create a CPU sandbox instance
 */
function createCPUSandboxInstance(
  id: string,
  name: string,
  runtime: string,
  endpoint: string,
  apiKey: string,
  baseUrl: string
): CPUSandboxInstance {
  let deleted = false;

  const run = async (): Promise<RunResult> => {
    if (deleted) {
      throw new BuildfunctionsError('Sandbox has been deleted', 'INVALID_REQUEST');
    }

    // Wait for endpoint to be ready
    await waitForEndpoint(endpoint);

    // Call the sandbox endpoint using authoritative DNS
    const response = await fetchWithAuthDNS(endpoint);
    const responseText = response.body;

    if (!responseText) {
      throw new BuildfunctionsError('Empty response from sandbox', 'UNKNOWN_ERROR', response.status);
    }

    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      // Response is plain text
      return {
        stdout: responseText,
        stderr: '',
        text: responseText,
        results: null,
        exit_code: 0,
      };
    }

    if (response.status < 200 || response.status >= 300) {
      const errorData = data as { error?: string };
      throw new BuildfunctionsError(`Execution failed: ${errorData.error || 'Unknown error'}`, 'UNKNOWN_ERROR', response.status);
    }

    // Response is already the unwrapped result from the handler
    return {
      stdout: responseText,
      stderr: '',
      text: responseText,
      results: data,
      exit_code: 0,
    };
  };

  const upload = async (options: UploadOptions): Promise<void> => {
    if (deleted) {
      throw new BuildfunctionsError('Sandbox has been deleted', 'INVALID_REQUEST');
    }

    // Normalize options to support both snake_case and camelCase
    const localPath = options.local_path ?? options.localPath;
    const filePath = options.file_path ?? options.filePath;

    if (!localPath || !filePath) {
      throw new ValidationError('Both local_path and file_path are required');
    }

    // Read file content
    if (!existsSync(localPath)) {
      throw new ValidationError(`Local file not found: ${localPath}`);
    }

    const content = await readFile(localPath, 'utf-8');

    const response = await fetch(`${baseUrl}/api/sdk/sandbox/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        sandboxId: id,
        filePath,
        content,
        type: 'cpu',
      }),
    });

    if (!response.ok) {
      throw new BuildfunctionsError('Upload failed', 'UNKNOWN_ERROR', response.status);
    }
  };

  const deleteFn = async (): Promise<void> => {
    if (deleted) {
      return;
    }

    const response = await fetch(`${baseUrl}/api/sdk/sandbox/delete`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        sandboxId: id,
        type: 'cpu',
      }),
    });

    if (!response.ok) {
      throw new BuildfunctionsError('Delete failed', 'UNKNOWN_ERROR', response.status);
    }

    deleted = true;
  };

  return {
    id,
    name,
    runtime,
    endpoint,
    type: 'cpu',
    run,
    upload,
    delete: deleteFn,
  };
}

/**
 * CPU Sandbox factory
 */
export const CPUSandbox = {
  /**
   * Create a new CPU sandbox
   */
  create: async (config: CPUSandboxConfig): Promise<CPUSandboxInstance> => {
    if (!globalApiKey) {
      throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
    }

    validateConfig(config);

    const baseUrl = globalBaseUrl ?? DEFAULT_BASE_URL;

    // CPU sandbox endpoint
    const url = `${baseUrl}/api/sdk/sandbox/create`;

    // Match CPU function body exactly (from client.ts create function)
    const name = config.name.toLowerCase();
    const fileExt = config.language === 'python' ? '.py' : config.language === 'javascript' ? '.js' : '.py';

    const requestBody = {
      // Required by sandbox/create endpoint
      type: 'cpu',
      // Same fields as CPU function
      name,
      fileExt,
      code: config.code ?? '',
      sourceWith: config.code ?? '',
      sourceWithout: config.code ?? '',
      language: config.language,
      runtime: config.runtime ?? config.language,
      memoryAllocated: config.memory ? parseMemory(config.memory) : 128,
      timeout: config.timeout ?? 10,
      envVariables: JSON.stringify(config.envVariables ?? []),
      requirements: config.requirements ?? '',
      cronExpression: '',
      subdomain: name,
      totalVariables: (config.envVariables ?? []).length,
      functionCount: 0,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 minute timeout

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${globalApiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const responseText = await response.text();

    if (!response.ok) {
      throw new BuildfunctionsError(`Failed to create sandbox: ${responseText}`, 'UNKNOWN_ERROR', response.status);
    }

    let data: { siteId: string; endpoint: string };
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new BuildfunctionsError(`Invalid JSON response: ${responseText}`, 'UNKNOWN_ERROR', response.status);
    }

    // Response has siteId and endpoint
    const sandboxId = data.siteId;
    const sandboxEndpoint = data.endpoint || `https://${name}.buildfunctions.app`;
    const sandboxRuntime = config.runtime ?? config.language;

    return createCPUSandboxInstance(sandboxId, name, sandboxRuntime, sandboxEndpoint, globalApiKey, baseUrl);
  },
};
