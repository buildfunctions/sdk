/**
 * Buildfunctions SDK Client
 */

import { HttpClient, createHttpClient } from './utils/http.js';
import { NotFoundError } from './utils/errors.js';
import { parseMemory } from './utils/memory.js';
import { detectFramework } from './utils/framework.js';
import { setCpuSandboxApiKey } from './sandbox/cpu-sandbox.js';
import { setGpuSandboxApiKey } from './sandbox/gpu-sandbox.js';
import { setGpuApiKey, GPUFunction } from './function/gpu-function.js';
import type {
  BuildfunctionsConfig,
  DeployedFunction,
  FindUniqueOptions,
  ListOptions,
  FunctionListResponse,
  AuthenticatedUser,
  AuthResponse,
  CreateFunctionOptions,
} from './types/index.js';

const DEFAULT_BASE_URL = 'https://www.buildfunctions.com';
const DEFAULT_GPU_BUILD_URL = 'https://prod-gpu-build.buildfunctions.link';

/**
 * Functions management interface
 */
export interface FunctionsManager {
  list: (options?: ListOptions) => Promise<DeployedFunction[]>;
  findUnique: (options: FindUniqueOptions) => Promise<DeployedFunction | null>;
  get: (siteId: string) => Promise<DeployedFunction>;
  create: (options: CreateFunctionOptions) => Promise<DeployedFunction>;
  delete: (siteId: string) => Promise<void>;
}

function getDefaultRuntime(language: string): string {
  // JavaScript requires explicit runtime (node.js or deno)
  if (language === 'javascript') {
    throw new Error('JavaScript requires explicit runtime: "nodejs" or "deno"');
  }
  // All other languages have single runtime = language name
  return language;
}

function getFileExtension(language: string): string {
  switch (language) {
    case 'javascript':
      return '.js';
    case 'typescript':
      return '.ts';
    case 'python':
      return '.py';
    case 'go':
      return '.go';
    case 'shell':
      return '.sh';
    default:
      return '.js';
  }
}

function createFunctionsManager(http: HttpClient): FunctionsManager {
  const wrapFunction = (fn: Omit<DeployedFunction, 'delete'>): DeployedFunction => {
    return {
      ...fn,
      delete: async () => {
        await http.delete('/api/sdk/functions/build', { siteId: fn.id });
      },
    };
  };

  const list = async (options: ListOptions = {}): Promise<DeployedFunction[]> => {
    const page = options.page ?? 1;
    const response = await http.get<FunctionListResponse>('/api/sdk/functions', { page });
    return response.stringifiedQueryResults.map((fn) => wrapFunction(fn));
  };

  const findUnique = async (options: FindUniqueOptions): Promise<DeployedFunction | null> => {
    const { where } = options;

    if (where.id) {
      try {
        const fn = await http.get<DeployedFunction>('/api/sdk/functions/build', { siteId: where.id });
        return wrapFunction(fn);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return null;
        }
        throw error;
      }
    }

    if (where.name) {
      const functions = await list();
      const found = functions.find((fn) => fn.name === where.name);
      return found ?? null;
    }

    return null;
  };

  const get = async (siteId: string): Promise<DeployedFunction> => {
    const fn = await http.get<DeployedFunction>('/api/sdk/functions/build', { siteId });
    return wrapFunction(fn);
  };

  const create = async (options: CreateFunctionOptions): Promise<DeployedFunction> => {
    const fileExt = getFileExtension(options.language);
    const name = options.name.toLowerCase();
    // Detect Function by explicit processorType OR by presence of gpu option
    const isGpu = options.processorType === 'GPU' || !!options.gpu;
    const runtime = (options.runtime ?? getDefaultRuntime(options.language)) as typeof options.runtime;

    if (isGpu) {
      const gpuBuilder = GPUFunction({
        name: options.name,
        code: options.code,
        language: options.language,
        runtime,
        gpu: options.gpu ?? 'T4',
        config: {
          memory: options.memory ? parseMemory(options.memory) : 1024,
          timeout: options.timeout ?? 60,
        },
        dependencies: options.requirements,
        envVariables: options.envVariables ? Object.fromEntries(
          options.envVariables.map(v => [v.key, v.value])
        ) : undefined,
        cronSchedule: options.cronSchedule,
        framework: options.framework ?? detectFramework(options.requirements),
        modelName: options.modelName,
        modelPath: options.modelPath,
      });

      const deployed = await gpuBuilder.deploy();
      if (!deployed) {
        throw new Error('GPU Function deployment failed');
      }
      return deployed;
    }

    // CPU builds go to a different API than GPU
    const body: Record<string, unknown> = {
      name,
      fileExt,
      sourceWith: options.code,
      sourceWithout: options.code,
      language: options.language,
      runtime,
      memoryAllocated: options.memory ? parseMemory(options.memory) : 128,
      timeout: options.timeout ?? 10,
      envVariables: JSON.stringify(options.envVariables ?? []),
      requirements: options.requirements ?? '',
      cronExpression: options.cronSchedule ?? '',
      processorType: 'CPU',
      selectedFramework: options.framework ?? detectFramework(options.requirements),
      subdomain: name,
      totalVariables: (options.envVariables ?? []).length,
      functionCount: 0,
    };

    const response = await http.post<{ siteId: string; sslCertificateEndpoint: string; endpoint: string }>('/api/sdk/functions/build', body);

    return wrapFunction({
      id: response.siteId,
      name,
      subdomain: name,
      endpoint: response.endpoint,
      lambdaUrl: response.sslCertificateEndpoint || '',
      language: options.language,
      runtime: runtime!,
      lambdaMemoryAllocated: options.memory ? parseMemory(options.memory) : 128,
      timeoutSeconds: options.timeout ?? 10,
      isGPUF: false,
      framework: options.framework,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  const deleteFn = async (siteId: string): Promise<void> => {
    await http.delete('/api/sdk/functions/build', { siteId });
  };

  return {
    list,
    findUnique,
    get,
    create,
    delete: deleteFn,
  };
}

/**
 * Buildfunctions client interface
 */
export interface BuildfunctionsClient {
  functions: FunctionsManager;
  user: AuthenticatedUser | null;
  sessionExpiresAt: string | null;
  authenticatedAt: string | null;
  getHttpClient: () => HttpClient;
}

/**
 * Create a Buildfunctions SDK client
 */
export async function Buildfunctions(config: BuildfunctionsConfig): Promise<BuildfunctionsClient> {
  if (!config.apiKey) {
    throw new Error('API key is required');
  }

  const http = createHttpClient({
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    apiKey: config.apiKey,
  });

  // Authenticate with the API (uses API key from https://www.buildfunctions.com/settings)
  const authResponse = await http.post<AuthResponse>('/api/sdk/auth');

  if (!authResponse.authenticated) {
    throw new Error('Authentication failed');
  }

  http.setToken(authResponse.sessionToken);

  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const gpuBuildUrl = config.gpuBuildUrl ?? DEFAULT_GPU_BUILD_URL;
  const userId = authResponse.user.id;
  const username = authResponse.user.username || undefined;
  const computeTier = authResponse.user.computeTier || undefined;

  setCpuSandboxApiKey(authResponse.sessionToken, baseUrl);
  setGpuSandboxApiKey(authResponse.sessionToken, gpuBuildUrl, userId, username, computeTier, baseUrl);
  setGpuApiKey(authResponse.sessionToken, gpuBuildUrl, userId, username, computeTier);

  const functions = createFunctionsManager(http);

  return {
    functions,
    user: authResponse.user,
    sessionExpiresAt: authResponse.expiresAt,
    authenticatedAt: authResponse.authenticatedAt,
    getHttpClient: () => http,
  };
}

/**
 * Create a Buildfunctions client instance
 */
export async function createClient(config: BuildfunctionsConfig): Promise<BuildfunctionsClient | null> {
  try {
    return await Buildfunctions(config);
  } catch {
    return null;
  }
}
