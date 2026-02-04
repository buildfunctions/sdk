/**
 * Resolve code parameter - supports both inline code and file paths.
 *
 * If the code string has no newlines and the path exists on disk, reads the file.
 * If the code string looks like a path but the file doesn't exist, throws an error.
 * Otherwise treats it as inline code.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, isAbsolute, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { ValidationError } from './errors.js';

// Determine the SDK's root directory at module load time
const SDK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Get the file path of the caller (the file that called the SDK).
 * Used to resolve relative paths against the caller's location.
 * Skips frames that are inside the SDK itself.
 */
export function getCallerFile(): string | undefined {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_, stack) => stack;
    const err = new Error();
    const stack = err.stack as unknown as NodeJS.CallSite[];

    for (const frame of stack) {
      const fileName = frame.getFileName();
      if (!fileName) continue;

      // Convert file:// URLs to paths
      const filePath = fileName.startsWith('file://')
        ? fileURLToPath(fileName)
        : fileName;

      // Skip node internals
      if (filePath.startsWith('node:')) continue;

      // Skip files inside the SDK directory
      if (filePath.startsWith(SDK_DIR)) continue;

      return filePath;
    }
    return undefined;
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
  }
}

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',  // JavaScript & TypeScript
  '.py', '.pyw', '.pyi',                          // Python
]);

function looksLikeFilePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~')) {
    return true;
  }
  // Windows drive letter (e.g. C:\...)
  if (/^[a-zA-Z]:[\\\/]/.test(value)) {
    return true;
  }
  // Ends with a known code file extension
  const dotIndex = value.lastIndexOf('.');
  if (dotIndex > 0) {
    const ext = value.slice(dotIndex).toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve code - supports inline code strings and file paths.
 *
 * @param code - Either inline code or a file path
 * @param basePath - Base directory for resolving relative paths (e.g., caller's directory)
 */
export async function resolveCode(code: string, basePath?: string): Promise<string> {
  // Inline code almost always contains newlines; file paths never do
  if (code.includes('\n')) {
    return code;
  }

  // Expand ~ to home directory
  let pathToCheck = code;
  if (pathToCheck.startsWith('~/')) {
    pathToCheck = pathToCheck.replace('~', homedir());
  }

  // Resolve the path:
  // - Absolute paths stay absolute
  // - Relative paths (./foo, ../bar) resolve against basePath if provided
  let resolvedPath: string;
  if (isAbsolute(pathToCheck)) {
    resolvedPath = pathToCheck;
  } else if (basePath) {
    resolvedPath = resolve(basePath, pathToCheck);
  } else {
    resolvedPath = resolve(pathToCheck);
  }

  if (existsSync(resolvedPath)) {
    return await readFile(resolvedPath, 'utf-8');
  }

  // If it looks like a path but doesn't exist, give a helpful error
  if (looksLikeFilePath(code)) {
    throw new ValidationError(
      `Code file not found: "${code}" (resolved to "${resolvedPath}"). ` +
      `If this is meant to be inline code, ensure it is a valid code string.`
    );
  }

  // Single-line inline code (e.g. `print("hello")`)
  return code;
}
