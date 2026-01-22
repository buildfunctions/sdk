/**
 * CPU Function - Deploy serverless functions to Buildfunctions
 */

import type { CPUFunctionOptions, DeployedFunction } from '../types/index.js';
import { ValidationError } from '../utils/errors.js';
import { parseMemory } from '../utils/memory.js';

const DEFAULT_BASE_URL = 'https://www.buildfunctions.com';

interface DeployResponse {
  success: boolean;
  site?: DeployedFunction;
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
    requirements: dependencies ?? '',
    cronExpression: cronSchedule ?? '',
    totalVariables: envVariables ? Object.keys(envVariables).length : 0,
  };
}

/**
 * Create a CPU Function builder
 */
function createCPUFunctionBuilder(options: CPUFunctionOptions, apiKey: string, baseUrl?: string): CPUFunctionBuilder {
  validateOptions(options);
  const resolvedBaseUrl = baseUrl ?? DEFAULT_BASE_URL;

  const deploy = async (): Promise<DeployedFunction | null> => {
    const body = buildRequestBody(options);

    const response = await fetch(`${resolvedBaseUrl}/api/functions/build`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as DeployResponse;

    if (!response.ok || !data.success) {
      return null;
    }

    return data.site ?? null;
  };

  return { deploy };
}

// Store API key globally for the factory function pattern
let globalApiKey: string | null = null;
let globalBaseUrl: string | undefined;

/**
 * Set the API key for function deployment
 */
export function setApiKey(apiKey: string, baseUrl?: string): void {
  globalApiKey = apiKey;
  globalBaseUrl = baseUrl;
}

/**
 * Factory function to create a CPU Function builder
 */
export function CPUFunction(options: CPUFunctionOptions): CPUFunctionBuilder {
  if (!globalApiKey) {
    throw new ValidationError('API key not set. Initialize Buildfunctions client first or call setApiKey()');
  }
  return createCPUFunctionBuilder(options, globalApiKey, globalBaseUrl);
}
