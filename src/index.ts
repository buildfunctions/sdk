/**
 * Buildfunctions SDK
 *
 * A TypeScript SDK for Buildfunctions - the serverless platform for AI agents.
 *
 * @example
 * ```typescript
 * import { Buildfunctions, CPUSandbox, GPUSandbox, GPUFunction } from 'buildfunctions';
 *
 * // Initialize the client (authenticates with the API)
 * const buildfunctions = await Buildfunctions({
 *   apiToken: process.env.BUILDFUNCTIONS_API_KEY
 * });
 *
 * // Access authenticated user info
 * console.log(buildfunctions.user);
 * console.log(buildfunctions.authenticatedAt);
 *
 * // Create a CPU sandbox
 * const sandbox = await CPUSandbox.create({
 *   name: 'my-sandbox',
 *   language: 'python',
 *   memory: '512MB'
 * });
 *
 * // Run code
 * const result = await sandbox.run('print("Hello from Buildfunctions!")');
 * console.log(result.stdout);
 *
 * // Clean up
 * await sandbox.delete();
 * ```
 */

// Re-export functions
export { CPUFunction } from './function/cpu-function.js';
export type { CPUFunctionBuilder } from './function/cpu-function.js';
export { GPUFunction } from './function/gpu-function.js';
export type { GPUFunctionBuilder } from './function/gpu-function.js';

// Re-export sandboxes
export { CPUSandbox } from './sandbox/cpu-sandbox.js';
export { GPUSandbox } from './sandbox/gpu-sandbox.js';

// Re-export types
export type {
  BuildfunctionsConfig,
  AuthenticatedUser,
  AuthResponse,
  Language,
  Runtime,
  GPUType,
  Framework,
  Memory,
  FunctionConfig,
  CPUFunctionOptions,
  GPUFunctionOptions,
  CreateFunctionOptions,
  DeployedFunction,
  CPUSandboxConfig,
  GPUSandboxConfig,
  RunResult,
  UploadOptions,
  SandboxInstance,
  CPUSandboxInstance,
  GPUSandboxInstance,
  FindUniqueOptions,
  ListOptions,
  ErrorCode,
} from './types/index.js';

// Re-export errors
export {
  BuildfunctionsError,
  AuthenticationError,
  NotFoundError,
  ValidationError,
  CapacityError,
} from './utils/errors.js';

// Re-export client
export { Buildfunctions, createClient } from './client.js';
export type { BuildfunctionsClient, FunctionsManager } from './client.js';

// Import internal setters for initialization
import { setApiToken } from './function/cpu-function.js';
import { setGpuApiToken } from './function/gpu-function.js';
import { setCpuSandboxApiToken } from './sandbox/cpu-sandbox.js';
import { setGpuSandboxApiToken } from './sandbox/gpu-sandbox.js';

export function init(
  apiToken: string,
  baseUrl?: string,
  gpuBuildUrl?: string,
  userId?: string,
  username?: string,
  computeTier?: string
): void {
  setApiToken(apiToken, baseUrl);
  setGpuApiToken(apiToken, gpuBuildUrl, userId, username, computeTier);
  setCpuSandboxApiToken(apiToken, baseUrl);
  setGpuSandboxApiToken(apiToken, gpuBuildUrl, userId, username, computeTier, baseUrl);
}
