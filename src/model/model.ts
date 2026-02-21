/**
 * Model - Upload and manage models independently from GPU Sandboxes
 */

import { existsSync, statSync } from 'fs';
import { basename } from 'path';
import type { ModelConfig, ModelFindOptions, ModelInstance } from '../types/index.js';
import { ValidationError, BuildfunctionsError } from '../lib/errors.js';
import { getFilesInDirectory, uploadModelFiles, type UploadProgress } from '../lib/uploader.js';

const DEFAULT_BASE_URL = 'https://www.buildfunctions.com';

// Module-level state
let globalApiToken: string | null = null;
let globalBaseUrl: string | undefined;
export function setModelApiToken(
  apiToken: string,
  baseUrl?: string,
  _userId?: string,
  _username?: string
): void {
  globalApiToken = apiToken;
  globalBaseUrl = baseUrl;
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

export const Model = {
  create: async (config: ModelConfig): Promise<ModelInstance> => {
    if (!globalApiToken) {
      throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
    }

    const baseUrl = globalBaseUrl ?? DEFAULT_BASE_URL;
    const modelPath = config.path;

    if (!modelPath) {
      throw new ValidationError('Model path is required');
    }

    if (!existsSync(modelPath)) {
      throw new ValidationError(`Model path does not exist: ${modelPath}`);
    }

    const stats = statSync(modelPath);
    if (!stats.isDirectory()) {
      throw new ValidationError('Model path must be a directory');
    }

    const localUploadFileName = basename(modelPath);
    const modelName = config.name ?? sanitizeModelName(localUploadFileName);

    // Validate model name
    if (!/^[a-z0-9-]+$/.test(modelName)) {
      throw new ValidationError('Model name must contain only lowercase letters, numbers, and hyphens');
    }

    console.log(`   Creating model "${modelName}" from ${modelPath}...`);

    // Collect files
    const files = getFilesInDirectory(modelPath);
    if (files.length === 0) {
      throw new ValidationError('No files found in model directory');
    }

    console.log(`   Found ${files.length} files to upload`);

    // Remap webkitRelativePath to use modelName instead of folder name
    // e.g. "gpt-oss-120b/subdir/file.bin" → "my-llm/subdir/file.bin"
    for (const f of files) {
      f.webkitRelativePath = modelName + f.webkitRelativePath.substring(localUploadFileName.length);
    }

    const filesWithinModelFolder = files.map(f => ({
      name: f.name,
      size: f.size,
      type: f.type,
      webkitRelativePath: f.webkitRelativePath,
    }));

    // POST to model/create endpoint
    const response = await fetch(`${baseUrl}/api/sdk/model/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${globalApiToken}`,
      },
      body: JSON.stringify({
        modelName,
        localUploadFileName,
        filesWithinModelFolder,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new BuildfunctionsError(`Failed to create model: ${errorText}`, 'UNKNOWN_ERROR', response.status);
    }

    const data = await response.json() as {
      modelId: string;
      modelName: string;
      modelPresignedUrls: Record<string, any>;
      bucketName: string;
      totalFiles?: number;
      skippedFiles?: number;
    };

    const skippedByServer = data.skippedFiles ?? 0;
    const totalFileCount = data.totalFiles ?? files.length;

    if (skippedByServer > 0) {
      console.log(`   Resuming upload: ${skippedByServer}/${totalFileCount} files already uploaded`);
    }

    // Upload model files
    if (data.modelPresignedUrls && Object.keys(data.modelPresignedUrls).length > 0) {
      const filesToUploadCount = Object.keys(data.modelPresignedUrls).length;
      console.log(`   Uploading ${filesToUploadCount} file${filesToUploadCount === 1 ? '' : 's'}...`);

      let lastLogTime = 0;
      await uploadModelFiles(files, data.modelPresignedUrls, data.bucketName, baseUrl, (progress: UploadProgress) => {
        const now = Date.now();
        if (now - lastLogTime < 2000 && progress.completedFiles < progress.totalFiles) return;
        lastLogTime = now;

        const pct = progress.totalBytes > 0
          ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100)
          : 0;
        const elapsed = (now - progress.startTime) / 1000;
        let eta = '';
        if (elapsed > 0 && pct > 0 && pct < 100) {
          const remaining = (elapsed / pct) * (100 - pct);
          if (remaining >= 60) {
            eta = ` | ETA: ${Math.ceil(remaining / 60)}m`;
          } else {
            eta = ` | ETA: ${Math.ceil(remaining)}s`;
          }
        }

        const totalMB = (progress.totalBytes / (1024 * 1024)).toFixed(0);
        const uploadedMB = (progress.uploadedBytes / (1024 * 1024)).toFixed(0);
        process.stdout.write(`\r   [${modelName}] ${pct}% (${uploadedMB}/${totalMB} MB) ${progress.completedFiles}/${progress.totalFiles} files${eta}   `);
      });
      process.stdout.write('\n');
      console.log('   Upload complete');
    } else {
      console.log('   All files already uploaded');
    }

    // Mark upload as complete
    await fetch(`${baseUrl}/api/sdk/model/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${globalApiToken}`,
      },
      body: JSON.stringify({ modelName }),
    });

    const modelId = data.modelId;
    const finalModelName = data.modelName;

    // Return ModelInstance
    return {
      id: modelId,
      name: finalModelName,
      delete: async () => {
        await Model.delete({ where: { name: finalModelName } });
      },
    };
  },

  findUnique: async (options: ModelFindOptions): Promise<ModelInstance | null> => {
    if (!globalApiToken) {
      throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
    }

    const baseUrl = globalBaseUrl ?? DEFAULT_BASE_URL;
    const { where } = options;
    const params = new URLSearchParams();
    if (where.name) params.set('name', where.name);
    if (where.id) params.set('id', where.id);

    const response = await fetch(`${baseUrl}/api/sdk/model/find?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${globalApiToken}`,
      },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new BuildfunctionsError(`Failed to find model: ${errorText}`, 'UNKNOWN_ERROR', response.status);
    }

    const data = await response.json() as { modelId: string; modelName: string };

    return {
      id: data.modelId,
      name: data.modelName,
      delete: async () => {
        await Model.delete({ where: { name: data.modelName } });
      },
    };
  },

  delete: async (options: { where: { name?: string; id?: string } }): Promise<void> => {
    if (!globalApiToken) {
      throw new ValidationError('API key not set. Initialize Buildfunctions client first.');
    }

    const baseUrl = globalBaseUrl ?? DEFAULT_BASE_URL;
    const modelName = options.where.name || options.where.id;

    if (!modelName) {
      throw new ValidationError('Model name or id is required');
    }

    const response = await fetch(`${baseUrl}/api/sdk/model/delete`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${globalApiToken}`,
      },
      body: JSON.stringify({
        modelName,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new BuildfunctionsError(`Failed to delete model: ${errorText}`, 'UNKNOWN_ERROR', response.status);
    }
  },
};
