/**
 * Buildfunctions SDK Type Definitions
 */

// Client Configuration
export interface BuildfunctionsConfig {
  apiToken: string;
  baseUrl?: string;
  gpuBuildUrl?: string; // URL for GPU build server (storage server)
}

// Runtime controls event stream
export type RuntimeControlEventType =
  | 'retry'
  | 'loop_warning'
  | 'loop_quarantine'
  | 'loop_stop'
  | 'circuit_open'
  | 'budget_stop'
  | 'policy_denied'
  | 'policy_approval_required'
  | 'policy_approved'
  | 'policy_dry_run'
  | 'verifier_rejected'
  | 'idempotency_replay'
  | 'concurrency_wait'
  | 'concurrency_rejected';

export interface RuntimeControlEvent {
  type: RuntimeControlEventType;
  message: string;
  timestamp: number;
  request?: {
    method?: string;
    url: string;
    path: string;
  };
  details?: Record<string, unknown>;
}

// Retry controls
export interface RetryBackoffConfig {
  maxAttempts?: number; // Default 4
  initialDelayMs?: number; // Default 250
  maxDelayMs?: number; // Default 10000
  backoffFactor?: number; // Default 2
  jitterRatio?: number; // 0..1, default 0.2
}

export interface ToolRetryClassifierContext {
  error: {
    message: string;
    code: string;
    statusCode?: number;
  };
  rawError: unknown;
  statusCode?: number;
  cancelledByCaller: boolean;
  attempt: number;
  maxAttempts: number;
  toolName: string;
  destination?: string;
  action?: string;
}

export interface ToolRetryClassifierDecision {
  retryable: boolean;
  reason?: string;
  delayMs?: number;
}

export type ToolRetryClassifier = (
  context: ToolRetryClassifierContext
) =>
  | boolean
  | ToolRetryClassifierDecision
  | Promise<boolean | ToolRetryClassifierDecision>;

// Loop breaker controls
export interface LoopBreakerConfig {
  enabled?: boolean; // Default true
  warningThreshold?: number; // Default 5
  quarantineThreshold?: number; // Default 8
  stopThreshold?: number; // Default 12
  quarantineMs?: number; // Default 15000
  stopCooldownMs?: number; // Default 120000
  maxFingerprints?: number; // Default 200
}

// Policy controls
export type RuntimePolicyMode = 'enforce' | 'dryRun';
export type RuntimePolicyAction = 'allow' | 'deny' | 'require_approval';

// Generic tool-call runtime controls (wrapper mode)
export interface ToolCircuitBreakerConfig {
  enabled?: boolean; // Default true
  windowMs?: number; // Default 30000
  minRequests?: number; // Default 20
  failureRateThreshold?: number; // Default 0.6
  cooldownMs?: number; // Default 60000
}

export interface ToolPolicyRule {
  id?: string;
  action: RuntimePolicyAction;
  tools?: Array<string | '*'>; // Tool names, supports '*' wildcard
  destinations?: string[]; // Supports exact, '*' and '*.suffix'
  actionPrefixes?: string[];
  reason?: string;
}

export interface ToolPolicyApprovalContext {
  ruleId?: string;
  reason?: string;
  toolName: string;
  destination?: string;
  action?: string;
  args?: unknown;
}

export type ToolPolicyApprovalHandler = (
  context: ToolPolicyApprovalContext
) => boolean | Promise<boolean>;

export interface ToolPolicyGateConfig {
  enabled?: boolean; // Default true
  mode?: RuntimePolicyMode; // Default "enforce"
  rules?: ToolPolicyRule[];
  approvalHandler?: ToolPolicyApprovalHandler;
}

export interface ToolCallContext {
  toolName: string;
  runKey?: string;
  destination?: string;
  action?: string;
  args?: unknown;
  idempotencyKey?: string;
  resourceKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ToolRuntimeExecuteContext {
  signal: AbortSignal;
}

export interface ToolWrapParams<TArgs extends unknown[], TResult> {
  toolName: string;
  runKey?: string;
  destination?: string;
  idempotencyKey?: string;
  resourceKey?: string;
  resolveRunKey?: (...args: TArgs) => string | undefined;
  resolveDestination?: (...args: TArgs) => string | undefined;
  resolveAction?: (...args: TArgs) => string | undefined;
  resolveIdempotencyKey?: (...args: TArgs) => string | undefined;
  resolveResourceKey?: (...args: TArgs) => string | undefined;
  run?: (args: TArgs, runtime: ToolRuntimeExecuteContext) => Promise<TResult>;
  fn?: (args: TArgs, runtime: ToolRuntimeExecuteContext) => Promise<TResult>;
  function?: (args: TArgs, runtime: ToolRuntimeExecuteContext) => Promise<TResult>;
}

export interface ToolRuntimeOverrideConfig {
  timeoutMs?: number;
  retry?: RetryBackoffConfig;
  loopBreaker?: LoopBreakerConfig;
  circuitBreaker?: ToolCircuitBreakerConfig;
}

export interface ToolRuntimeOverridesConfig {
  tools?: Record<string, ToolRuntimeOverrideConfig>;
  destinations?: Record<string, ToolRuntimeOverrideConfig>;
}

export interface ToolRuntimeStateAdapter {
  get: <T = unknown>(key: string) => T | undefined | Promise<T | undefined>;
  set: <T = unknown>(key: string, value: T) => void | Promise<void>;
  delete?: (key: string) => void | Promise<void>;
  keys?: () => Iterable<string> | Promise<Iterable<string>>;
}

export interface ToolRuntimeStateAdaptersConfig {
  loop?: ToolRuntimeStateAdapter;
  circuit?: ToolRuntimeStateAdapter;
  budget?: ToolRuntimeStateAdapter;
  lock?: ToolRuntimeStateAdapter;
  idempotency?: ToolRuntimeStateAdapter;
}

export interface ToolVerifierDecision {
  allow: boolean;
  reason?: string;
}

export interface ToolCallVerifierContext {
  toolName: string;
  runKey?: string;
  destination?: string;
  action?: string;
  args?: unknown;
  idempotencyKey?: string;
  resourceKey?: string;
}

export interface ToolSuccessVerifierContext extends ToolCallVerifierContext {
  result: unknown;
}

export interface ToolErrorVerifierContext extends ToolCallVerifierContext {
  error: {
    message: string;
    code: string;
    statusCode?: number;
  };
  rawError: unknown;
}

export type ToolCallVerifier = (
  context: ToolCallVerifierContext
) => boolean | ToolVerifierDecision | Promise<boolean | ToolVerifierDecision>;

export type ToolSuccessVerifier = (
  context: ToolSuccessVerifierContext
) => boolean | ToolVerifierDecision | Promise<boolean | ToolVerifierDecision>;

export type ToolErrorVerifier = (
  context: ToolErrorVerifierContext
) => boolean | ToolVerifierDecision | Promise<boolean | ToolVerifierDecision>;

export interface ToolRuntimeVerifiersConfig {
  beforeCall?: ToolCallVerifier;
  afterSuccess?: ToolSuccessVerifier;
  afterError?: ToolErrorVerifier;
}

export interface ToolIdempotencyConfig {
  enabled?: boolean; // Default true
  ttlMs?: number; // Default unlimited
  includeErrors?: boolean; // Default false
  namespaceByRunKey?: boolean; // Default true
}

export type ToolConcurrencyWaitMode = 'reject' | 'wait';

export interface ToolConcurrencyConfig {
  enabled?: boolean; // Default false
  leaseMs?: number; // Default 30000
  waitMode?: ToolConcurrencyWaitMode; // Default "reject"
  waitTimeoutMs?: number; // Default 5000 (used when waitMode="wait")
  pollIntervalMs?: number; // Default 50 (used when waitMode="wait")
}

export interface ToolRuntimeControlsConfig {
  tenantKey?: string;
  timeoutMs?: number; // Default 60000
  maxToolCalls?: number;
  retry?: RetryBackoffConfig;
  retryClassifier?: ToolRetryClassifier;
  loopBreaker?: LoopBreakerConfig;
  circuitBreaker?: ToolCircuitBreakerConfig;
  policy?: ToolPolicyGateConfig;
  verifiers?: ToolRuntimeVerifiersConfig;
  idempotency?: ToolIdempotencyConfig;
  concurrency?: ToolConcurrencyConfig;
  overrides?: ToolRuntimeOverridesConfig;
  state?: ToolRuntimeStateAdaptersConfig;
  onEvent?: (event: RuntimeControlEvent) => void;
  eventSinks?: Array<(event: RuntimeControlEvent) => void | Promise<void>>;
  onEventSinkFailure?: (params: {
    failure: unknown;
    event: RuntimeControlEvent;
    sinkIndex: number;
  }) => void;
}

export interface ToolRuntimeControls {
  run: <TResult>(
    context: ToolCallContext,
    fn: (runtime: ToolRuntimeExecuteContext) => Promise<TResult>
  ) => Promise<TResult>;
  wrap: <TArgs extends unknown[], TResult>(
    params: ToolWrapParams<TArgs, TResult>
  ) => (...args: TArgs) => Promise<TResult>;
  reset: (runKey?: string) => Promise<void>;
}

// Agent logic safety layer (used with RuntimeControls)
export interface AgentLogicInjectionGuardConfig {
  enabled?: boolean;
  patterns?: Array<string | RegExp>;
  reason?: string;
}

export interface AgentLogicTerminalAction {
  toolNamePattern?: string; // Default "*"
  actionPrefix: string;
}

export interface AgentLogicExitConditionConfig {
  enabled?: boolean;
  maxStepsPerRun?: number; // Default 30
  terminalActions?: AgentLogicTerminalAction[];
  blockAfterTerminal?: boolean; // Default true
  stateAdapter?: ToolRuntimeStateAdapter;
}

export interface AgentLogicIntentAllowlistRule {
  id?: string;
  toolNamePattern: string; // Supports exact, "*" and prefix ("name*")
  actionPrefixes?: string[];
  destinations?: string[];
  reason?: string;
}

export interface AgentLogicIntentAllowlistConfig {
  enabled?: boolean;
  rules: AgentLogicIntentAllowlistRule[];
  denyReason?: string;
}

export interface AgentLogicSafetyConfig {
  injectionGuard?: AgentLogicInjectionGuardConfig;
  exitCondition?: AgentLogicExitConditionConfig;
  intentAllowlist?: AgentLogicIntentAllowlistConfig;
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
  memory?: string | number;  // Top-level shorthand for config.memory
  timeout?: number;          // Top-level shorthand for config.timeout
  requirements?: string | string[];  // Top-level shorthand for dependencies
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
