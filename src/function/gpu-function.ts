/**
 * GPU Function - Deploy GPU-accelerated serverless functions to Buildfunctions
 */

import https from 'https';
import type { GPUFunctionOptions, DeployedFunction } from '../types/index.js';
import { ValidationError } from '../lib/errors.js';
import { parseMemory } from '../lib/memory.js';
import { detectFramework } from '../lib/framework.js';
import { resolveCode, getCallerFile } from '../lib/resolve-code.js';
import { dirname } from 'path';

const DEFAULT_GPU_BUILD_URL = 'https://prod-gpu-build.buildfunctions.link';

interface DeployResponse {
  success?: boolean;
  data?: {
    siteId?: string;
    sslCertificateEndpoint?: string;
  };
  siteId?: string;
  site?: DeployedFunction;
  id?: string;
  name?: string;
  subdomain?: string;
  endpoint?: string;
  lambdaUrl?: string;
  error?: string;
  code?: string;
}

/**
 * GPU Function builder interface
 */
export interface GPUFunctionBuilder {
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

function validateOptions(options: GPUFunctionOptions): void {
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

  // GPU Functions only support Python currently
  if (options.language !== 'python') {
    throw new ValidationError('GPU Functions currently only support Python. Additional languages coming soon.');
  }
}

function buildRequestBody(options: GPUFunctionOptions): Record<string, unknown> {
  const {
    name,
    language,
    code,
    config,
    envVariables,
    dependencies,
    cronSchedule,
    framework,
  } = options;

  // Auto-infer runtime from language (server handles runtimeVersion)
  const runtime = options.runtime ?? getDefaultRuntime(language);
  // Default GPU to T4
  const gpu = options.gpu ?? 'T4';

  const fileExt = getFileExtension(language);
  const functionName = name.toLowerCase();

  return {
    name: functionName,
    language,
    runtime,
    sourceWith: code, // source with env vars
    sourceWithout: code,
    fileExt,
    processorType: 'GPU',
    gpu,
    memoryAllocated: config?.memory ? parseMemory(config.memory) : 4096,
    timeout: config?.timeout ?? 180,
    cpuCores: options.cpuCores ?? 10,  // vCPUs for the GPU function VM (hotplugged at runtime)
    envVariables: envVariables ? JSON.stringify(Object.entries(envVariables).map(([key, value]) => ({ key, value }))) : '[]',
    requirements: formatRequirements(dependencies),
    cronExpression: cronSchedule ?? '',
    totalVariables: envVariables ? Object.keys(envVariables).length : 0,
    selectedFramework: framework ?? detectFramework(formatRequirements(dependencies)),
    // GPU Function requires these fields
    useEmptyFolder: true,
    selectedFunction: {
      name: functionName,
      sourceWith: code,
      runtime,
      language,
      sizeInBytes: new TextEncoder().encode(code).length,
    },
    selectedModel: {
      currentModelName: null,
      isCreatingNewModel: true,
      gpufProjectTitleState: 'test',
      useEmptyFolder: true,
    },
  };
}

function createGPUFunctionBuilder(
  options: GPUFunctionOptions,
  apiToken: string,
  gpuBuildUrl?: string,
  userId?: string,
  username?: string,
  computeTier?: string,
  callerDir?: string,
  baseUrl?: string
): GPUFunctionBuilder {
  const resolvedGpuBuildUrl = gpuBuildUrl ?? DEFAULT_GPU_BUILD_URL;
  const resolvedBaseUrl = baseUrl ?? 'https://www.buildfunctions.com';

  const deploy = async (): Promise<DeployedFunction | null> => {
    // Resolve code (inline string or file path)
    const resolvedCode = await resolveCode(options.code, callerDir);
    const resolvedOptions = { ...options, code: resolvedCode };
    validateOptions(resolvedOptions);

    // Compute runtime for use in resolved function
    const resolvedRuntime = resolvedOptions.runtime ?? getDefaultRuntime(resolvedOptions.language);

    const body = {
      ...buildRequestBody(resolvedOptions),
      userId,
      username,
      computeTier,
      runCommand: null,
    };

    const buildUrl = `${resolvedGpuBuildUrl}/build`;
    const postData = JSON.stringify(body);
    const url = new URL(buildUrl);

    return new Promise((resolve, reject) => {

      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'Connection': 'keep-alive',
          },
          timeout: 30 * 60 * 1000, // 30 minutes total timeout
        },
        (res) => {
          let responseText = '';

          res.on('data', (chunk) => {
            responseText += chunk.toString();
          });

          res.on('end', () => {
            // Parse the response
            let data: DeployResponse;
            try {
              data = JSON.parse(responseText) as DeployResponse;
            } catch {
              data = { success: res.statusCode === 201 };
            }

            // Storage server returns 201 on success
            if (res.statusCode !== 201 && res.statusCode !== 200) {
              resolve(null);
              return;
            }

            const siteId = data.data?.siteId || data.siteId || data.id;
            const funcName = options.name.toLowerCase();
            const endpoint = data.endpoint || `https://${funcName}.buildfunctions.app`;

            resolve({
              id: siteId!,
              name: funcName,
              subdomain: funcName,
              endpoint,
              lambdaUrl: data.data?.sslCertificateEndpoint || '',
              language: options.language,
              runtime: resolvedRuntime,
              lambdaMemoryAllocated: options.config?.memory ? parseMemory(options.config.memory) : 4096,
              timeoutSeconds: options.config?.timeout ?? 180,
              isGPUF: true,
              framework: options.framework,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              delete: async () => {
                await fetch(`${resolvedBaseUrl}/api/sdk/function/delete`, {
                  method: 'DELETE',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiToken}`,
                  },
                  body: JSON.stringify({ siteId }),
                });
              },
            });
          });

          res.on('error', (error) => {
            reject(error);
          });
        }
      );

      // Set socket timeout separately (for connection establishment)
      req.on('socket', (socket) => {
        socket.setTimeout(30 * 60 * 1000); // 30 minutes
        socket.on('timeout', () => {
          req.destroy(new Error('Socket timeout'));
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });

      req.on('error', (error) => {
        reject(error);
      });

      // Send the request body
      req.write(postData);
      req.end();
    });
  };

  return { deploy };
}

let globalApiToken: string | null = null;
let globalGpuBuildUrl: string | undefined;
let globalUserId: string | undefined;
let globalUsername: string | undefined;
let globalComputeTier: string | undefined;
let globalBaseUrl: string | undefined;

export function setGpuApiToken(apiToken: string, gpuBuildUrl?: string, userId?: string, username?: string, computeTier?: string, baseUrl?: string): void {
  globalApiToken = apiToken;
  globalGpuBuildUrl = gpuBuildUrl;
  globalUserId = userId;
  globalUsername = username;
  globalComputeTier = computeTier;
  globalBaseUrl = baseUrl;
}

export function GPUFunction(options: GPUFunctionOptions): GPUFunctionBuilder {
  // Capture caller file FIRST before any async operations change the call stack
  const callerFile = getCallerFile();
  const callerDir = callerFile ? dirname(callerFile) : undefined;

  if (!globalApiToken) {
    throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
  }
  return createGPUFunctionBuilder(options, globalApiToken, globalGpuBuildUrl, globalUserId, globalUsername, globalComputeTier, callerDir, globalBaseUrl);
}
