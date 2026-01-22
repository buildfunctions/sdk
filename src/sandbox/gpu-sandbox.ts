/**
 * GPU Sandbox - Hardware-isolated execution environment for untrusted AI actions with GPU-acceleration
 */

import https from 'https';
import type { GPUSandboxConfig, GPUSandboxInstance, RunResult, UploadOptions, GPUType } from '../types/index.js';
import { ValidationError, BuildfunctionsError } from '../utils/errors.js';
import { parseMemory } from '../utils/memory.js';
import { detectFramework } from '../utils/framework.js';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { basename } from 'path';
import { getFilesInDirectory, uploadModelFiles } from '../utils/uploader.js';

const DEFAULT_GPU_BUILD_URL = 'https://prod-gpu-build.buildfunctions.link';
const DEFAULT_BASE_URL = 'https://www.buildfunctions.com';

// Global configuration
let globalApiKey: string | null = null;
let globalGpuBuildUrl: string | undefined;
let globalBaseUrl: string | undefined;
let globalUserId: string | undefined;
let globalUsername: string | undefined;
let globalComputeTier: string | undefined;

/**
 * Set the API key for GPU Sandbox operations
 */
export function setGpuSandboxApiKey(
  apiKey: string,
  gpuBuildUrl?: string,
  userId?: string,
  username?: string,
  computeTier?: string,
  baseUrl?: string
): void {
  globalApiKey = apiKey;
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

import type { FileMetadata } from '../utils/uploader.js';

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

function buildRequestBody(config: GPUSandboxConfig, localModelInfo: LocalModelInfo | null): Record<string, unknown> {
  const name = config.name.toLowerCase();
  const language = config.language;
  const runtime = config.runtime ?? getDefaultRuntime(language);
  const code = config.code ?? '';
  const fileExt = getFileExtension(language);
  const gpu = config.gpu ?? 'T4';
  const requirements = formatRequirements(config.requirements);

  const hasLocalModel = localModelInfo !== null;
  const modelName = hasLocalModel ? localModelInfo.sanitizedModelName : null;

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
    memoryAllocated: config.memory ? parseMemory(config.memory) : 10000,
    timeout: config.timeout ?? 300,
    cpuCores: 2,
    envVariables: JSON.stringify(config.envVariables ?? []),
    requirements,
    cronExpression: '',
    totalVariables: (config.envVariables ?? []).length,
    selectedFramework: detectFramework(requirements),
    useEmptyFolder: !hasLocalModel,
    modelPath: hasLocalModel ? `${localModelInfo.sanitizedModelName}/mnt/storage/${localModelInfo.localUploadFileName}` : null,
    selectedFunction: {
      name,
      sourceWith: code,
      runtime,
      language,
      sizeInBytes: code ? new TextEncoder().encode(code).length : 0,
    },
    selectedModel: hasLocalModel ? {
      name: localModelInfo.sanitizedModelName,
      modelName: localModelInfo.sanitizedModelName,
      currentModelName: localModelInfo.localUploadFileName,
      isCreatingNewModel: true,
      gpufProjectTitleState: localModelInfo.sanitizedModelName,
      useEmptyFolder: false,
      files: localModelInfo.filesWithinModelFolder,
    } : {
      currentModelName: null,
      isCreatingNewModel: true,
      gpufProjectTitleState: 'test', // todo: need to update
      useEmptyFolder: true,
    },
    // File metadata for build server
    filesWithinModelFolder: hasLocalModel ? localModelInfo.filesWithinModelFolder : [],
    fileNamesWithinModelFolder: hasLocalModel ? localModelInfo.fileNamesWithinModelFolder : [],
    modelName: modelName,
  };
}

function createGPUSandboxInstance(
  id: string,
  name: string,
  runtime: string,
  gpu: GPUType,
  endpoint: string,
  apiKey: string,
  gpuBuildUrl: string,
  baseUrl: string
): GPUSandboxInstance {
  let deleted = false;

  const run = async (): Promise<RunResult> => {
    if (deleted) {
      throw new BuildfunctionsError('Sandbox has been deleted', 'INVALID_REQUEST');
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const responseText = await response.text();
    if (!responseText) {
      throw new BuildfunctionsError('Empty response from sandbox', 'UNKNOWN_ERROR', response.status);
    }

    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch {
      return {
        stdout: responseText,
        stderr: '',
        text: responseText,
        results: null,
        exit_code: 0,
      };
    }

    if (!response.ok) {
      const errorData = data as { error?: string };
      throw new BuildfunctionsError(`Execution failed: ${errorData.error || 'Unknown error'}`, 'UNKNOWN_ERROR', response.status);
    }

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
        Authorization: `Bearer ${apiKey}`,
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

    await fetch(`${gpuBuildUrl}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteId: id,
        sandboxType: 'gpu',
        userId: globalUserId,
        username: globalUsername,
      }),
    });

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
    if (!globalApiKey) {
      throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
    }

    validateConfig(config);

    const gpuBuildUrl = globalGpuBuildUrl ?? DEFAULT_GPU_BUILD_URL;
    const baseUrl = globalBaseUrl ?? DEFAULT_BASE_URL;

    if (!gpuBuildUrl) {
      throw new ValidationError('GPU build URL not configured');
    }

    // Check if model is a local path
    const modelPath = typeof config.model === 'string' ? config.model : config.model?.path;
    let localModelInfo: LocalModelInfo | null = null;

    if (modelPath && isLocalPath(modelPath)) {
      console.log('   Local model detected:', modelPath);
      localModelInfo = getLocalModelInfo(modelPath, config.name);
      console.log('   Found', localModelInfo.files.length, 'files to upload');
    }

    // Build request body (same structure as frontend ModelsList.jsx)
    const requestBody = buildRequestBody(config, localModelInfo);

    const body = {
      ...requestBody,
      userId: globalUserId,
      username: globalUsername,
      computeTier: globalComputeTier,
      runCommand: null,
    };

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
              reject(new BuildfunctionsError(`Failed to create sandbox: ${responseText}`, 'UNKNOWN_ERROR', res.statusCode ?? 500));
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
              } catch (uploadError) {
                reject(new BuildfunctionsError(`Sandbox created but model upload failed: ${(uploadError as Error).message}`, 'UNKNOWN_ERROR'));
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
              config.gpu ?? 'T4',
              sandboxEndpoint,
              globalApiKey!,
              gpuBuildUrl,
              baseUrl
            ));
          });

          res.on('error', (error) => {
            reject(error);
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

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  },
};
