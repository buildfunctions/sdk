/**
 * CPU Function - Deploy serverless functions to Buildfunctions
 */

import type { CPUFunctionOptions, DeployedFunction } from '../types/index.js';
import { ValidationError } from '../lib/errors.js';
import { parseMemory } from '../lib/memory.js';
import { resolveCode, getCallerFile } from '../lib/resolve-code.js';
import { dirname } from 'path';

const DEFAULT_BASE_URL = 'https://www.buildfunctions.com';

interface DeployResponse {
  siteId?: string;
  endpoint?: string;
  sslCertificateEndpoint?: string;
  error?: string;
  code?: string;
}

/**
 * CPU Function builder interface
 */
export interface CPUFunctionBuilder {
  deploy: () => Promise<DeployedFunction | null>;
}

function getFileExtension(language: string): string {
  const extensions: Record<string, string> = {
    javascript: '.js',
    typescript: '.ts',
    python: '.py',
    go: '.go',
    shell: '.sh',
  };
  return extensions[language] ?? '.js';
}

function getDefaultRuntime(language: string): string {
  // JavaScript requires explicit runtime (node.js or deno)
  if (language === 'javascript') {
    throw new ValidationError('JavaScript requires explicit runtime: "nodejs" or "deno"');
  }
  // All other languages have single runtime = language name
  return language;
}

function formatRequirements(requirements: string | string[] | undefined): string {
  if (!requirements) return '';
  if (Array.isArray(requirements)) return requirements.join('\n');
  return requirements;
}

function validateOptions(options: CPUFunctionOptions): void {
  if (!options.name || typeof options.name !== 'string') {
    throw new ValidationError('Function name is required');
  }

  if (!/^[a-z0-9-]+$/.test(options.name.toLowerCase())) {
    throw new ValidationError('Function name can only contain lowercase letters, numbers, and hyphens');
  }

  if (!options.code || typeof options.code !== 'string') {
    throw new ValidationError('Function code is required');
  }

  if (!options.language) {
    throw new ValidationError('Language is required');
  }

  // Runtime defaults to language (except JavaScript which requires explicit runtime)
}

function buildRequestBody(options: CPUFunctionOptions): Record<string, unknown> {
  const { name, language, code, config, envVariables, dependencies, cronSchedule } = options;

  // Auto-infer runtime from language (server handles runtimeVersion)
  const runtime = options.runtime ?? getDefaultRuntime(language);
  const fileExt = getFileExtension(language);

  return {
    name: name.toLowerCase(),
    language,
    runtime,
    sourceWith: code, // source with env vars
    fileExt,
    processorType: 'CPU only',
    memoryAllocated: config?.memory ? parseMemory(config.memory) : 1024,
    timeout: config?.timeout ?? 10,
    envVariables: envVariables ? JSON.stringify(Object.entries(envVariables).map(([key, value]) => ({ key, value }))) : '[]',
    requirements: formatRequirements(dependencies),
    cronExpression: cronSchedule ?? '',
    totalVariables: envVariables ? Object.keys(envVariables).length : 0,
  };
}

/**
 * Create a CPU Function builder
 */
function createCPUFunctionBuilder(options: CPUFunctionOptions, apiToken: string, baseUrl?: string, callerDir?: string): CPUFunctionBuilder {
  const resolvedBaseUrl = baseUrl ?? DEFAULT_BASE_URL;

  const deploy = async (): Promise<DeployedFunction | null> => {
    const resolvedCode = await resolveCode(options.code, callerDir);
    const resolvedOptions = { ...options, code: resolvedCode };
    validateOptions(resolvedOptions);
    const body = buildRequestBody(resolvedOptions);
    const runtime = options.runtime ?? getDefaultRuntime(options.language);
    const name = options.name.toLowerCase();

    const response = await fetch(`${resolvedBaseUrl}/api/sdk/function/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as DeployResponse;

    const deleteFn = async () => {
      await fetch(`${resolvedBaseUrl}/api/sdk/function/build`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ siteId: data.siteId }),
      });
    };

    return {
      id: data.siteId || '',
      name,
      subdomain: name,
      endpoint: data.endpoint || '',
      url: data.sslCertificateEndpoint || '',
      language: options.language,
      runtime,
      memoryAllocated: options.config?.memory ? parseMemory(options.config.memory) : 1024,
      timeoutSeconds: options.config?.timeout ?? 10,
      isGPUF: false,
      framework: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      delete: deleteFn,
    };
  };

  return { deploy };
}

// Store API key globally for the factory function pattern
let globalApiToken: string | null = null;
let globalBaseUrl: string | undefined;

/**
 * Set the API token for function deployment
 */
export function setApiToken(apiToken: string, baseUrl?: string): void {
  globalApiToken = apiToken;
  globalBaseUrl = baseUrl;
}

/**
 * CPU Function factory
 */
export const CPUFunction = {
  create: async (options: CPUFunctionOptions): Promise<DeployedFunction | null> => {
    const callerFile = getCallerFile();
    const callerDir = callerFile ? dirname(callerFile) : undefined;

    if (!globalApiToken) {
      throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
    }
    const builder = createCPUFunctionBuilder(options, globalApiToken, globalBaseUrl, callerDir);
    return builder.deploy();
  },
};
