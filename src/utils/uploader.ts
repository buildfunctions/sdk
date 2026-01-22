/**
 * File upload utilities for GPU Sandbox
 */

import { statSync, readdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { basename, join, relative } from 'path';

const CHUNK_SIZE = 9 * 1024 * 1024;

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  webkitRelativePath: string;
  localPath: string;
}

export interface PresignedUrlInfo {
  signedUrl: string[];
  uploadId: string | null;
  numberOfParts?: number;
  s3FilePath?: string;
}

interface TransferDetailsResponse {
  transferDetails: Array<{ fileName: string; [key: string]: unknown }>;
  storageApiUrl: string;
  storageApiPath: string;
}

interface PresignedUrlsResponse {
  modelAndFunctionPresignedUrls: {
    modelPresignedUrls: Record<string, PresignedUrlInfo>;
  };
  bucketName: string;
  modelRecord?: {
    modelName: string;
    modelFolderContainingFilesPath: string;
  };
}

export async function uploadFile(content: Buffer, presignedUrl: string): Promise<void> {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: content,
    headers: {
      'Content-Type': 'application/octet-stream',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to upload file: ${response.statusText}`);
  }
}

async function uploadPart(
  content: Buffer,
  presignedUrl: string,
  partNumber: number
): Promise<{ PartNumber: number; ETag: string }> {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: content,
    headers: {
      'Content-Type': 'application/octet-stream',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to upload part ${partNumber}: ${response.statusText}`);
  }

  const etag = response.headers.get('ETag');
  if (!etag) {
    throw new Error(`Failed to retrieve ETag for part ${partNumber}`);
  }

  const cleanEtag = etag.replace(/^"|"$/g, '');
  return { PartNumber: partNumber, ETag: cleanEtag };
}

export async function uploadMultipartFile(
  content: Buffer,
  signedUrls: string[],
  uploadId: string,
  numberOfParts: number,
  bucketName: string,
  s3FilePath: string,
  baseUrl: string
): Promise<void> {
  const parts: { PartNumber: number; ETag: string }[] = [];
  const maxParallelUploads = 5;

  for (let i = 0; i < numberOfParts; i += maxParallelUploads) {
    const batch = [];
    for (let j = i; j < Math.min(i + maxParallelUploads, numberOfParts); j++) {
      const partNumber = j + 1;
      const start = j * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, content.length);
      const chunk = content.slice(start, end);
      const signedUrl = signedUrls[j];
      if (!signedUrl) {
        throw new Error(`Missing upload URL for part ${partNumber}`);
      }

      batch.push(
        uploadPart(chunk, signedUrl, partNumber).then((part) => {
          parts.push(part);
        })
      );
    }
    await Promise.all(batch);
  }

  const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

  const response = await fetch(`${baseUrl}/api/functions/gpu/transfer-and-mount/complete-multipart-upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketName,
      uploadId,
      parts: sortedParts,
      s3FilePath,
      fileName: s3FilePath.split('/').pop(),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to complete upload: ${response.statusText} - ${errorText}`);
  }
}

export function getFilesInDirectory(dirPath: string): FileMetadata[] {
  const files: FileMetadata[] = [];
  const rootDirName = basename(dirPath);

  function walkDir(currentPath: string) {
    const entries = readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile()) {
        const stats = statSync(fullPath);
        const relativePath = relative(dirPath, fullPath);

        files.push({
          name: entry.name,
          size: stats.size,
          type: 'application/octet-stream',
          webkitRelativePath: `${rootDirName}/${relativePath}`,
          localPath: fullPath,
        });
      }
    }
  }

  walkDir(dirPath);
  return files;
}

export async function uploadModelFiles(
  files: FileMetadata[],
  presignedUrls: Record<string, PresignedUrlInfo>,
  bucketName: string,
  baseUrl: string
): Promise<void> {
  const uploadPromises: Promise<void>[] = [];

  for (const file of files) {
    const urlInfo = presignedUrls[file.webkitRelativePath];
    if (!urlInfo) {
      console.error(`No upload URL found for ${file.webkitRelativePath}`);
      continue;
    }

    const content = await readFile(file.localPath);
    const signedUrls = urlInfo.signedUrl;

    if (signedUrls.length > 1 && urlInfo.uploadId) {
      uploadPromises.push(
        uploadMultipartFile(
          content,
          signedUrls,
          urlInfo.uploadId,
          urlInfo.numberOfParts || signedUrls.length,
          bucketName,
          urlInfo.s3FilePath || '',
          baseUrl
        )
      );
    } else if (signedUrls.length === 1 && signedUrls[0]) {
      uploadPromises.push(uploadFile(content, signedUrls[0]));
    }
  }

  await Promise.all(uploadPromises);
}

export async function transferFilesToEFS(
  files: FileMetadata[],
  sanitizedModelName: string,
  baseUrl: string,
  sessionToken: string
): Promise<void> {
  const detailsResponse = await fetch(`${baseUrl}/api/sdk/sandbox/gpu/get-transfer-details`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      shouldVerifyContents: false,
      filesToTransfer: files.map(f => f.webkitRelativePath),
      sanitizedModelName,
      fileNamesWithinModelFolder: files.map(f => f.name),
    }),
  });

  if (!detailsResponse.ok) {
    const errorData = await detailsResponse.json() as { error?: string };
    throw new Error(errorData.error || 'Failed to prepare file transfer');
  }

  const transferData = await detailsResponse.json() as TransferDetailsResponse;
  const { transferDetails, storageApiUrl, storageApiPath } = transferData;

  const validTransferDetails = transferDetails.filter(d => d.fileName && d.fileName.length > 0);

  for (const fileDetail of validTransferDetails) {
    const transferResponse = await fetch(`${storageApiUrl}${storageApiPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fileDetail),
    });

    if (!transferResponse.ok) {
      const errorText = await transferResponse.text();
      throw new Error(`Failed to transfer ${fileDetail.fileName}: ${errorText}`);
    }
  }
}

export type { PresignedUrlsResponse, TransferDetailsResponse };
