/**
 * Buildfunctions SDK Type Definitions
 */

// Client Configuration
export interface BuildfunctionsConfig {
  apiToken: string;
  baseUrl?: string;
  gpuBuildUrl?: string; // URL for GPU build server (storage server)
}

// Authenticated User
export interface AuthenticatedUser {
  id: string;
  username: string | null;
  email: string | null;
  computeTier?: string | null;
}

// Auth Response
export interface AuthResponse {
  authenticated: boolean;
  user: AuthenticatedUser;
  sessionToken: string;
  expiresAt: string;
  authenticatedAt: string;
}

// Function Types
export type Language = 'javascript' | 'typescript' | 'python' | 'go' | 'shell';
export type Runtime = 'node' | 'deno' | 'python' | 'go' | 'shell';
export type GPUType = 'T4G' | 'T4';
export type Framework = 'pytorch';
export type Memory = '128Mi' | '256Mi' | '512Mi' | '1Gi' | '2Gi' | '4Gi' | '8Gi' | '16Gi' | '32Gi' | '64Gi';

// Function Configuration
export interface FunctionConfig {
  memory?: string | number;  // "2GB", "1024MB", or number in MB
  timeout?: number;
}

export interface CPUFunctionOptions {
  name: string;
  language: Language;
  runtime?: Runtime;  // Defaults to language (except JavaScript which requires explicit)
  code: string;  // Inline code string or path to file (absolute, relative, or ~/path)
  config?: FunctionConfig;
  envVariables?: Record<string, string>;
  dependencies?: string;
  cronSchedule?: string;
}

export interface GPUFunctionOptions extends CPUFunctionOptions {
  gpu?: GPUType;
  vcpus?: number;
  gpuCount?: number;
  memory?: string | number;  // "2GB", "1024MB", or number in MB (top-level shorthand for config.memory)
  timeout?: number;          // Top-level shorthand for config.timeout
  requirements?: string | string[];  // Top-level shorthand for dependencies
  framework?: Framework;
  modelPath?: string;
  modelName?: string;
}

// Create Function Options (for SDK deploy)
export interface CreateFunctionOptions {
  name: string;
  code: string;  // Inline code string or path to file (absolute, relative, or ~/path)
  language: Language;
  runtime?: Runtime;  // Defaults to language (except JavaScript which requires explicit)
  memory?: string | number;  // "2GB", "1024MB", or number in MB
  timeout?: number;
  envVariables?: Array<{ key: string; value: string }>;
  requirements?: string | string[];
  cronSchedule?: string;
  // GPU-specific
  processorType?: 'CPU' | 'GPU';
  framework?: Framework;
  gpu?: GPUType;
  modelName?: string;
  modelPath?: string;
}

// Deployed Function
export interface DeployedFunction {
  id: string;
  name: string;
  subdomain: string;
  endpoint: string;
  url: string;
  language: string;
  runtime: string;
  memoryAllocated: number;
  timeoutSeconds: number;
  cpuCores?: string;
  isGPUF: boolean;
  framework?: string;
  createdAt: string;
  updatedAt: string;
  delete: () => Promise<void>;
}

// Sandbox Configuration (matches CPU function arguments)
export interface CPUSandboxConfig {
  name: string;
  language: Language;
  runtime?: Runtime;
  code?: string;  // Inline code string or path to file (absolute, relative, or ~/path)
  memory?: string | number;  // "2GB", "1024MB", or number in MB
  timeout?: number;
  envVariables?: Array<{ key: string; value: string }>;
  requirements?: string | string[];
}

export interface GPUSandboxConfig extends CPUSandboxConfig {
  gpu?: GPUType;
  vcpus?: number;
  gpuCount?: number;
  code?: string;
  model?: string | {
    name: string;
    path: string;
  };
}

// Sandbox Run Result
export interface RunResult {
  response: unknown;  // The response (parsed JSON object, or raw string if not JSON)
  status: number;     // HTTP status code
}

// Upload Options
export interface UploadOptions {
  local_path?: string;
  file_path?: string;
  localPath?: string;
  filePath?: string;
}

// Sandbox Instance
export interface SandboxInstance {
  id: string;
  name: string;
  runtime: string;
  endpoint: string;
  run: (code?: string) => Promise<RunResult>;
  upload: (options: UploadOptions) => Promise<void>;
  delete: () => Promise<void>;
}

export interface CPUSandboxInstance extends SandboxInstance {
  type: 'cpu';
}

export interface GPUSandboxInstance extends SandboxInstance {
  type: 'gpu';
  gpu: GPUType;
}

// API Response Types
export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface FunctionListResponse {
  stringifiedQueryResults: DeployedFunction[];
}

// Find Options
export interface FindUniqueOptions {
  where: {
    name?: string;
    id?: string;
  };
}

export interface ListOptions {
  page?: number;
}

// Error Types
export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'MAX_CAPACITY'
  | 'SIZE_LIMIT_EXCEEDED'
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

// Model resource types
export interface ModelConfig {
  path: string;
  name?: string;
}

export interface ModelFindOptions {
  where: {
    name?: string;
    id?: string;
  };
}

export interface ModelInstance {
  id: string;
  name: string;
  delete: () => Promise<void>;
}
