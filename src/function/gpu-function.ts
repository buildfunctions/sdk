/**
 * GPU Function - Deploy GPU-accelerated serverless functions to Buildfunctions
 */

import https from 'https';
import type { GPUFunctionOptions, DeployedFunction } from '../types/index.js';
import { ValidationError } from '../utils/errors.js';
import { parseMemory } from '../utils/memory.js';
import { detectFramework } from '../utils/framework.js';

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
    cpuCores: config?.cpuCores ?? 2,
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
      gpufProjectTitleState: 'test', // todo: need to update
      useEmptyFolder: true,
    },
  };
}

function createGPUFunctionBuilder(
  options: GPUFunctionOptions,
  _apiKey: string,
  gpuBuildUrl?: string,
  userId?: string,
  username?: string,
  computeTier?: string
): GPUFunctionBuilder {
  validateOptions(options);
  const resolvedGpuBuildUrl = gpuBuildUrl ?? DEFAULT_GPU_BUILD_URL;

  const deploy = async (): Promise<DeployedFunction | null> => {
    // Compute runtime for use in resolved function
    const resolvedRuntime = options.runtime ?? getDefaultRuntime(options.language);

    const body = {
      ...buildRequestBody(options),
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
                await fetch(`${resolvedGpuBuildUrl}/delete`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ siteId, userId, username }),
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

let globalApiKey: string | null = null;
let globalGpuBuildUrl: string | undefined;
let globalUserId: string | undefined;
let globalUsername: string | undefined;
let globalComputeTier: string | undefined;

export function setGpuApiKey(apiKey: string, gpuBuildUrl?: string, userId?: string, username?: string, computeTier?: string): void {
  globalApiKey = apiKey;
  globalGpuBuildUrl = gpuBuildUrl;
  globalUserId = userId;
  globalUsername = username;
  globalComputeTier = computeTier;
}

export function GPUFunction(options: GPUFunctionOptions): GPUFunctionBuilder {
  if (!globalApiKey) {
    throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
  }
  return createGPUFunctionBuilder(options, globalApiKey, globalGpuBuildUrl, globalUserId, globalUsername, globalComputeTier);
}
