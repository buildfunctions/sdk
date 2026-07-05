/**
 * GPU Sandbox - Hardware-isolated execution environment for untrusted AI actions with GPU-acceleration
 */

import https from 'https';
import type { GPUSandboxConfig, GPUSandboxInstance, RunResult, UploadOptions, GPUType, ListOptions, FindUniqueOptions } from '../types/index.js';
import { ValidationError, BuildfunctionsError } from '../lib/errors.js';
import { assertBuildAllowed } from '../lib/compliance-preflight.js';
import { parseMemory } from '../lib/memory.js';
import { detectFramework } from '../lib/framework.js';
import { DEFAULT_GPU_BUILD_URL } from '../lib/internal-endpoints.js';
import { resolveCode, getCallerFile } from '../lib/resolve-code.js';
import { dirname } from 'path';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { basename } from 'path';
import { getFilesInDirectory, uploadModelFiles } from '../lib/uploader.js';
const DEFAULT_BASE_URL = 'https://www.buildfunctions.com';

// Global configuration
let globalApiToken: string | null = null;
let globalGpuBuildUrl: string | undefined;
let globalBaseUrl: string | undefined;
let globalUserId: string | undefined;
let globalUsername: string | undefined;
let globalComputeTier: string | undefined;

/**
 * Set the API token for GPU Sandbox operations
 */
export function setGpuSandboxApiToken(
  apiToken: string,
  gpuBuildUrl?: string,
  userId?: string,
  username?: string,
  computeTier?: string,
  baseUrl?: string
): void {
  globalApiToken = apiToken;
  globalGpuBuildUrl = gpuBuildUrl;
  globalUserId = userId;
  globalUsername = username;
  globalComputeTier = computeTier;
  globalBaseUrl = baseUrl;
}

interface BuildResponse {
  success?: boolean;
  data?: {
    siteId?: string;
    sslCertificateEndpoint?: string;
  };
  siteId?: string;
  id?: string;
  endpoint?: string;
  error?: string;
  modelAndFunctionPresignedUrls?: {
    modelPresignedUrls?: Record<string, {
      signedUrl: string[];
      uploadId: string | null;
      numberOfParts?: number;
      s3FilePath?: string;
    }>;
  };
  bucketName?: string;
}

function validateConfig(config: GPUSandboxConfig): void {
  if (!config.name || typeof config.name !== 'string') {
    throw new ValidationError('Sandbox name is required');
  }
  if (!config.language || typeof config.language !== 'string') {
    throw new ValidationError('Language is required');
  }
  if (config.language !== 'python') {
    throw new ValidationError('GPU Sandboxes currently only support Python. Additional languages coming soon.');
  }
  if (config.gpuCount !== undefined) {
    if (!Number.isInteger(config.gpuCount) || config.gpuCount < 1 || config.gpuCount > 10) {
      throw new ValidationError('gpuCount must be an integer between 1 and 10');
    }
  }
}

function getFileExtension(language: string): string {
  const extensions: Record<string, string> = {
    javascript: '.js',
    typescript: '.ts',
    python: '.py',
    go: '.go',
    shell: '.sh',
  };
  return extensions[language] ?? '.py';
}

function getDefaultRuntime(language: string): string {
  if (language === 'javascript') {
    throw new ValidationError('JavaScript requires explicit runtime: "nodejs" or "deno"');
  }
  return language;
}

function isLocalPath(path: string): boolean {
  if (!path) return false;
  return (path.startsWith('/') || path.startsWith('./') || path.startsWith('../')) && existsSync(path);
}

function sanitizeModelName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

import type { FileMetadata } from '../lib/uploader.js';

interface LocalModelInfo {
  files: FileMetadata[];
  filesWithinModelFolder: Array<{ name: string; size: number; type: string; webkitRelativePath: string }>;
  fileNamesWithinModelFolder: string[];
  localUploadFileName: string;
  sanitizedModelName: string;
}

function getLocalModelInfo(modelPath: string, sandboxName: string): LocalModelInfo {
  const stats = statSync(modelPath);
  if (!stats.isDirectory()) {
    throw new ValidationError('Model path must be a directory');
  }

  const localUploadFileName = basename(modelPath);
  const sanitizedModelName = sanitizeModelName(sandboxName);
  const files = getFilesInDirectory(modelPath);

  if (files.length === 0) {
    throw new ValidationError('No files found in model directory');
  }

  const filesWithinModelFolder = files.map(f => ({
    name: f.name,
    size: f.size,
    type: f.type,
    webkitRelativePath: f.webkitRelativePath,
  }));

  const fileNamesWithinModelFolder = files.map(f => f.name);

  return {
    files,
    filesWithinModelFolder,
    fileNamesWithinModelFolder,
    localUploadFileName,
    sanitizedModelName,
  };
}

function formatRequirements(requirements: string | string[] | undefined): string {
  if (!requirements) return '';
  if (Array.isArray(requirements)) return requirements.join('\n');
  return requirements;
}

function buildRequestBody(config: GPUSandboxConfig, localModelInfo: LocalModelInfo | null, modelByName: string | null = null): Record<string, unknown> {
  const name = config.name.toLowerCase();
  const language = config.language;
  const runtime = config.runtime ?? getDefaultRuntime(language);
  const code = config.code ?? '';
  const fileExt = getFileExtension(language);
  const gpu = config.gpu === 'T4' ? 'T4G' : (config.gpu ?? 'T4G');
  const requirements = formatRequirements(config.requirements);

  const hasLocalModel = localModelInfo !== null;
  const hasModelByName = modelByName !== null;
  const modelName = hasLocalModel ? localModelInfo.sanitizedModelName : (hasModelByName ? modelByName : null);

  // When gpuCount >= 2, user specifies totals — divide per VM
  const gpuCount = config.gpuCount ?? 1;
  const perVmDivisor = gpuCount >= 2 ? gpuCount : 1;
  const memoryTotal = config.memory ? parseMemory(config.memory) : 10000;
  const vcpusTotal = config.vcpus ?? 10;

  // Build selectedModel based on model source
  let selectedModel: Record<string, unknown>;
  let useEmptyFolder: boolean;
  let filesWithinModelFolder: Array<{ name: string; size: number; type: string; webkitRelativePath: string }>;
  let fileNamesWithinModelFolder: string[];

  if (hasLocalModel) {
    selectedModel = {
      name: localModelInfo.sanitizedModelName,
      modelName: localModelInfo.sanitizedModelName,
      currentModelName: localModelInfo.localUploadFileName,
      isCreatingNewModel: true,
      gpufProjectTitleState: localModelInfo.sanitizedModelName,
      useEmptyFolder: false,
      files: localModelInfo.filesWithinModelFolder,
    };
    useEmptyFolder = false;
    filesWithinModelFolder = localModelInfo.filesWithinModelFolder;
    fileNamesWithinModelFolder = localModelInfo.fileNamesWithinModelFolder;
  } else if (hasModelByName) {
    // Pre-uploaded model referenced by name — build server uses existing model
    selectedModel = {
      currentModelName: modelByName,
      isCreatingNewModel: false,
      gpufProjectTitleState: modelByName,
      useEmptyFolder: false,
    };
    useEmptyFolder = false;
    filesWithinModelFolder = [];
    fileNamesWithinModelFolder = [];
  } else {
    selectedModel = {
      currentModelName: null,
      isCreatingNewModel: true,
      gpufProjectTitleState: 'test',
      useEmptyFolder: true,
    };
    useEmptyFolder = true;
    filesWithinModelFolder = [];
    fileNamesWithinModelFolder = [];
  }

  return {
    name,
    language,
    runtime,
    sourceWith: code,
    sourceWithout: code,
    fileExt,
    processorType: 'GPU',
    sandboxType: 'gpu',
    gpu,
    memoryAllocated: Math.floor(memoryTotal / perVmDivisor),
    timeout: config.timeout ?? 300,
    cpuCores: Math.floor(vcpusTotal / perVmDivisor),
    envVariables: JSON.stringify(config.envVariables ?? []),
    requirements,
    cronExpression: '',
    totalVariables: (config.envVariables ?? []).length,
    selectedFramework: detectFramework(requirements),
    useEmptyFolder,
    modelPath: hasLocalModel ? `${localModelInfo.sanitizedModelName}/mnt/storage/${localModelInfo.localUploadFileName}` : null,
    selectedFunction: {
      name,
      sourceWith: code,
      runtime,
      language,
      sizeInBytes: code ? new TextEncoder().encode(code).length : 0,
    },
    selectedModel,
    // File metadata for build server
    filesWithinModelFolder,
    fileNamesWithinModelFolder,
    modelName: modelName,
    gpuCount: config.gpuCount ?? 1,
  };
}

function createGPUSandboxInstance(
  id: string,
  name: string,
  runtime: string,
  gpu: GPUType,
  endpoint: string,
  apiToken: string,
  baseUrl: string,
  timeout: number
): GPUSandboxInstance {
  let deleted = false;

  const run = async (): Promise<RunResult> => {
    if (deleted) {
      throw new BuildfunctionsError('Sandbox has been deleted', 'INVALID_REQUEST');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const responseText = await response.text();
    if (!responseText) {
      throw new BuildfunctionsError('Empty response from sandbox', 'UNKNOWN_ERROR', response.status);
    }

    if (!response.ok) {
      throw new BuildfunctionsError(`Execution failed (HTTP ${response.status})`, 'UNKNOWN_ERROR', response.status);
    }

    // Try to parse as JSON, otherwise return raw text
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }

    return {
      response: data,
      status: response.status,
    };
  };

  const upload = async (options: UploadOptions): Promise<void> => {
    if (deleted) {
      throw new BuildfunctionsError('Sandbox has been deleted', 'INVALID_REQUEST');
    }

    const localPath = options.local_path ?? options.localPath;
    const filePath = options.file_path ?? options.filePath;

    if (!localPath || !filePath) {
      throw new ValidationError('Both local_path and file_path are required');
    }

    if (!existsSync(localPath)) {
      throw new ValidationError(`Local file not found: ${localPath}`);
    }

    const content = await readFile(localPath, 'utf-8');

    const response = await fetch(`${baseUrl}/api/sdk/sandbox/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        sandboxId: id,
        filePath,
        content,
        type: 'gpu',
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

    // Use the same endpoint as CPU sandbox - buildfunctions web app handles the delete
    // This ensures proper HOST cleanup for occupied VMs
    const response = await fetch(`${baseUrl}/api/sdk/sandbox/delete`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        sandboxId: id,
        type: 'gpu',
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
    type: 'gpu',
    gpu,
    run,
    upload,
    delete: deleteFn,
  };
}

/**
 * GPU Sandbox factory
 */
export const GPUSandbox = {
  create: async (config: GPUSandboxConfig): Promise<GPUSandboxInstance> => {
    // Capture caller file FIRST before any async operations change the call stack
    const callerFile = getCallerFile();
    const callerDir = callerFile ? dirname(callerFile) : undefined;

    if (!globalApiToken) {
      throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
    }

    validateConfig(config);

    const gpuBuildUrl = globalGpuBuildUrl ?? DEFAULT_GPU_BUILD_URL;
    const baseUrl = globalBaseUrl ?? DEFAULT_BASE_URL;

    if (!gpuBuildUrl) {
      throw new ValidationError('GPU build URL not configured');
    }

    // Check if model is a local path or a model-by-name reference
    const modelPath = typeof config.model === 'string' ? config.model : config.model?.path;
    let localModelInfo: LocalModelInfo | null = null;
    let modelByName: string | null = null;

    if (modelPath && isLocalPath(modelPath)) {
      console.log('   Local model detected:', modelPath);
      localModelInfo = getLocalModelInfo(modelPath, config.name);
      console.log('   Found', localModelInfo.files.length, 'files to upload');
    } else if (modelPath) {
      // Model is a name string referencing a pre-uploaded model
      modelByName = sanitizeModelName(modelPath);
      console.log('   Using pre-uploaded model:', modelByName);
    }

    // Resolve code (inline string or file path)
    const resolvedCode = config.code ? await resolveCode(config.code, callerDir) : '';
    const resolvedConfig = { ...config, code: resolvedCode };

    // Build request body (same structure as frontend ModelsList.jsx)
    const requestBody = buildRequestBody(resolvedConfig, localModelInfo, modelByName);

    const body = {
      ...requestBody,
      userId: globalUserId,
      username: globalUsername,
      computeTier: globalComputeTier,
      runCommand: null,
    };

    // Compliance pre-flight: buildfunctions checks the caller's live country and
    // blocks (451/403) before the build request is sent. Throws if not permitted.
    await assertBuildAllowed({ baseUrl, apiToken: globalApiToken || '', body });

    const buildUrl = `${gpuBuildUrl}/build`;
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
          timeout: 30 * 60 * 1000,
        },
        (res) => {
          let responseText = '';

          res.on('data', (chunk) => {
            responseText += chunk.toString();
          });

          res.on('end', async () => {
            let data: BuildResponse;
            try {
              data = JSON.parse(responseText) as BuildResponse;
            } catch {
              data = { success: res.statusCode === 201 };
            }

            if (res.statusCode !== 201 && res.statusCode !== 200) {
              reject(new BuildfunctionsError(`Failed to create sandbox (HTTP ${res.statusCode ?? 500})`, 'UNKNOWN_ERROR', res.statusCode ?? 500));
              return;
            }

            // Upload local model files if present
            if (localModelInfo && data.modelAndFunctionPresignedUrls?.modelPresignedUrls) {
              console.log('   Uploading model files to S3...');
              try {
                await uploadModelFiles(
                  localModelInfo.files,
                  data.modelAndFunctionPresignedUrls.modelPresignedUrls,
                  data.bucketName || '',
                  baseUrl
                );
                console.log('   Model files uploaded successfully');
              } catch {
                reject(new BuildfunctionsError('Sandbox created but model upload failed', 'UNKNOWN_ERROR'));
                return;
              }
            }

            const sandboxId = data.data?.siteId || data.siteId || data.id;
            const name = config.name.toLowerCase();
            const sandboxRuntime = config.runtime ?? config.language;
            const sandboxEndpoint = data.endpoint || data.data?.sslCertificateEndpoint || `https://${name}.buildfunctions.app`;

            resolve(createGPUSandboxInstance(
              sandboxId || name,
              name,
              sandboxRuntime,
              config.gpu === 'T4' ? 'T4G' : (config.gpu ?? 'T4G'),
              sandboxEndpoint,
              globalApiToken!,
              baseUrl,
              config.timeout ?? 300
            ));
          });

          res.on('error', () => {
            reject(new BuildfunctionsError('Network error while creating sandbox', 'NETWORK_ERROR'));
          });
        }
      );

      req.on('socket', (socket) => {
        socket.setTimeout(30 * 60 * 1000);
        socket.on('timeout', () => {
          req.destroy(new Error('Socket timeout'));
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });

      req.on('error', () => {
        reject(new BuildfunctionsError('Network error while creating sandbox', 'NETWORK_ERROR'));
      });

      req.write(postData);
      req.end();
    });
  },

  list: async (options: ListOptions = {}): Promise<GPUSandboxInstance[]> => {
    if (!globalApiToken) {
      throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
    }

    const apiToken = globalApiToken;
    const baseUrl = globalBaseUrl ?? DEFAULT_BASE_URL;
    const page = options.page ?? 1;
    const params = new URLSearchParams();
    params.set('type', 'gpu');
    params.set('page', String(page));

    const response = await fetch(`${baseUrl}/api/sdk/sandbox?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    });

    if (!response.ok) {
      throw new BuildfunctionsError(`Failed to list sandboxes (HTTP ${response.status})`, 'UNKNOWN_ERROR', response.status);
    }

    const data = await response.json() as { gpuSandboxes?: Array<{ id: string; name: string; runtime: string; gpu: GPUType; timeoutSeconds: number }> };

    return (data.gpuSandboxes ?? []).map((sandbox) =>
      createGPUSandboxInstance(
        sandbox.id,
        sandbox.name,
        sandbox.runtime,
        sandbox.gpu,
        `https://${sandbox.name}.buildfunctions.app`,
        apiToken,
        baseUrl,
        sandbox.timeoutSeconds ?? 300
      )
    );
  },

  findUnique: async (options: FindUniqueOptions): Promise<GPUSandboxInstance | null> => {
    const { where } = options;

    if (where.id) {
      const sandboxes = await GPUSandbox.list();
      const found = sandboxes.find((sandbox) => sandbox.id === where.id);
      return found ?? null;
    }

    if (where.name) {
      const sandboxes = await GPUSandbox.list();
      const found = sandboxes.find((sandbox) => sandbox.name === where.name);
      return found ?? null;
    }

    return null;
  },
};
