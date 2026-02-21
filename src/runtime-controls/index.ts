/**
 * Runtime controls wrapper for arbitrary tool calls.
 *
 * This is wrapper mode: controls can be applied around any async tool call,
 * including tools that run outside Buildfunctions infrastructure.
 */

import { createHash } from 'crypto';
import { BuildfunctionsError } from '../lib/errors.js';

type ToolFailure = Error & {
  code: string;
  statusCode?: number;
};

function createFailure(message: string, code: string = 'UNKNOWN_ERROR', statusCode?: number): ToolFailure {
  const error = new Error(message || 'Tool call failed') as ToolFailure;
  error.name = 'ToolFailure';
  error.code = code;
  if (typeof statusCode === 'number') {
    error.statusCode = statusCode;
  }
  return error;
}

function hasFailureFields(error: unknown): error is ToolFailure {
  return !!(
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

import type {
  ToolCallVerifier,
  ToolConcurrencyConfig,
  ToolConcurrencyWaitMode,
  RetryBackoffConfig,
  ToolErrorVerifier,
  ToolIdempotencyConfig,
  RuntimeControlEvent,
  RuntimePolicyMode,
  RuntimePolicyAction,
  ToolCallContext,
  ToolCircuitBreakerConfig,
  ToolSuccessVerifier,
  ToolVerifierDecision,
  ToolPolicyApprovalHandler,
  ToolPolicyRule,
  ToolRetryClassifier,
  ToolRetryClassifierDecision,
  ToolRuntimeOverrideConfig,
  ToolRuntimeOverridesConfig,
  ToolRuntimeStateAdapter,
  ToolRuntimeStateAdaptersConfig,
  ToolRuntimeControls,
  ToolRuntimeControlsConfig,
} from '../types/index.js';

interface ResolvedRetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterRatio: number;
}

interface ResolvedLoopBreakerConfig {
  enabled: boolean;
  warningThreshold: number;
  quarantineThreshold: number;
  stopThreshold: number;
  quarantineMs: number;
  stopCooldownMs: number;
  maxFingerprints: number;
}

interface ResolvedCircuitBreakerConfig {
  enabled: boolean;
  windowMs: number;
  minRequests: number;
  failureRateThreshold: number;
  cooldownMs: number;
}

interface ResolvedPolicyConfig {
  enabled: boolean;
  mode: RuntimePolicyMode;
  rules: ToolPolicyRule[];
  approvalHandler?: ToolPolicyApprovalHandler;
}

interface ResolvedVerifierConfig {
  beforeCall?: ToolCallVerifier;
  afterSuccess?: ToolSuccessVerifier;
  afterError?: ToolErrorVerifier;
}

interface ResolvedIdempotencyConfig {
  enabled: boolean;
  ttlMs?: number;
  includeErrors: boolean;
  namespaceByRunKey: boolean;
}

interface ResolvedConcurrencyConfig {
  enabled: boolean;
  leaseMs: number;
  waitMode: ToolConcurrencyWaitMode;
  waitTimeoutMs: number;
  pollIntervalMs: number;
}

interface ResolvedRuntimeOverride {
  timeoutMs?: number;
  retry?: RetryBackoffConfig;
  loopBreaker?: {
    enabled?: boolean;
    warningThreshold?: number;
    quarantineThreshold?: number;
    stopThreshold?: number;
    quarantineMs?: number;
    stopCooldownMs?: number;
    maxFingerprints?: number;
  };
  circuitBreaker?: ToolCircuitBreakerConfig;
}

interface ResolvedRuntimeOverrides {
  tools: Array<{ pattern: string; override: ResolvedRuntimeOverride }>;
  destinations: Array<{ pattern: string; override: ResolvedRuntimeOverride }>;
}

interface EffectiveCallConfig {
  timeoutMs: number;
  retry: ResolvedRetryConfig;
  loopBreaker: ResolvedLoopBreakerConfig;
  circuitBreaker: ResolvedCircuitBreakerConfig;
}

interface RuntimeStateStore {
  get: <T>(key: string) => Promise<T | undefined>;
  set: <T>(key: string, value: T) => Promise<void>;
  delete: (key: string) => Promise<void>;
  keys: () => Promise<string[]>;
}

interface ResolvedConfig {
  tenantKey: string;
  timeoutMs: number;
  maxToolCalls?: number;
  retry: ResolvedRetryConfig;
  retryClassifier?: ToolRetryClassifier;
  loopBreaker: ResolvedLoopBreakerConfig;
  circuitBreaker: ResolvedCircuitBreakerConfig;
  policy: ResolvedPolicyConfig;
  verifiers: ResolvedVerifierConfig;
  idempotency: ResolvedIdempotencyConfig;
  concurrency: ResolvedConcurrencyConfig;
  overrides: ResolvedRuntimeOverrides;
  state: ToolRuntimeStateAdaptersConfig;
  onEvent?: (event: RuntimeControlEvent) => void;
  eventSinks: Array<(event: RuntimeControlEvent) => void | Promise<void>>;
  onEventSinkFailure?: (params: {
    failure: unknown;
    event: RuntimeControlEvent;
    sinkIndex: number;
  }) => void;
}

interface LoopState {
  streak: number;
  lastOutcomeHash?: string;
  lastSeenAt: number;
  quarantineUntil?: number;
  stopUntil?: number;
}

interface CircuitSample {
  timestamp: number;
  failed: boolean;
}

interface CircuitState {
  samples: CircuitSample[];
  openUntil?: number;
}

interface RunBudgetState {
  count: number;
}

interface IdempotencyRecord {
  storedAt: number;
  expiresAt?: number;
  ok: boolean;
  result?: unknown;
  error?: {
    message: string;
    code: string;
    statusCode?: number;
  };
}

interface LockState {
  owner: string;
  expiresAt: number;
}

interface NormalizedVerifierDecision {
  allow: boolean;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const DEFAULT_RETRY: ResolvedRetryConfig = {
  maxAttempts: 4,
  initialDelayMs: 250,
  maxDelayMs: 10_000,
  backoffFactor: 2,
  jitterRatio: 0.2,
};

const DEFAULT_LOOP_BREAKER: ResolvedLoopBreakerConfig = {
  enabled: true,
  warningThreshold: 5,
  quarantineThreshold: 8,
  stopThreshold: 12,
  quarantineMs: 15_000,
  stopCooldownMs: 120_000,
  maxFingerprints: 200,
};

const DEFAULT_CIRCUIT_BREAKER: ResolvedCircuitBreakerConfig = {
  enabled: true,
  windowMs: 30_000,
  minRequests: 20,
  failureRateThreshold: 0.6,
  cooldownMs: 60_000,
};

const DEFAULT_POLICY: ResolvedPolicyConfig = {
  enabled: true,
  mode: 'enforce',
  rules: [],
  approvalHandler: undefined,
};

const DEFAULT_IDEMPOTENCY: ResolvedIdempotencyConfig = {
  enabled: true,
  ttlMs: undefined,
  includeErrors: false,
  namespaceByRunKey: true,
};

const DEFAULT_CONCURRENCY: ResolvedConcurrencyConfig = {
  enabled: false,
  leaseMs: 30_000,
  waitMode: 'reject',
  waitTimeoutMs: 5_000,
  pollIntervalMs: 50,
};

function clampNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }

  let next = value;
  if (typeof min === 'number' && next < min) {
    next = min;
  }
  if (typeof max === 'number' && next > max) {
    next = max;
  }
  return next;
}

function resolveRetryConfig(defaults: ResolvedRetryConfig, overrides?: RetryBackoffConfig): ResolvedRetryConfig {
  return {
    maxAttempts: Math.max(1, Math.round(clampNumber(overrides?.maxAttempts, defaults.maxAttempts, 1))),
    initialDelayMs: Math.max(
      0,
      Math.round(clampNumber(overrides?.initialDelayMs, defaults.initialDelayMs, 0))
    ),
    maxDelayMs: Math.max(
      0,
      Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0))
    ),
    backoffFactor: clampNumber(overrides?.backoffFactor, defaults.backoffFactor, 1),
    jitterRatio: clampNumber(overrides?.jitterRatio, defaults.jitterRatio, 0, 1),
  };
}

function resolveLoopBreakerConfig(
  defaults: ResolvedLoopBreakerConfig,
  overrides?: ResolvedRuntimeOverride['loopBreaker']
): ResolvedLoopBreakerConfig {
  return {
    enabled: overrides?.enabled ?? defaults.enabled,
    warningThreshold: Math.max(1, Math.round(clampNumber(overrides?.warningThreshold, defaults.warningThreshold, 1))),
    quarantineThreshold: Math.max(
      1,
      Math.round(clampNumber(overrides?.quarantineThreshold, defaults.quarantineThreshold, 1))
    ),
    stopThreshold: Math.max(1, Math.round(clampNumber(overrides?.stopThreshold, defaults.stopThreshold, 1))),
    quarantineMs: Math.max(0, Math.round(clampNumber(overrides?.quarantineMs, defaults.quarantineMs, 0))),
    stopCooldownMs: Math.max(0, Math.round(clampNumber(overrides?.stopCooldownMs, defaults.stopCooldownMs, 0))),
    maxFingerprints: Math.max(20, Math.round(clampNumber(overrides?.maxFingerprints, defaults.maxFingerprints, 20))),
  };
}

function resolveToolCircuitBreaker(
  defaults: ResolvedCircuitBreakerConfig,
  overrides?: ToolCircuitBreakerConfig
): ResolvedCircuitBreakerConfig {
  return {
    enabled: overrides?.enabled ?? defaults.enabled,
    windowMs: Math.max(1000, Math.round(clampNumber(overrides?.windowMs, defaults.windowMs, 1000))),
    minRequests: Math.max(1, Math.round(clampNumber(overrides?.minRequests, defaults.minRequests, 1))),
    failureRateThreshold: clampNumber(
      overrides?.failureRateThreshold,
      defaults.failureRateThreshold,
      0,
      1
    ),
    cooldownMs: Math.max(1000, Math.round(clampNumber(overrides?.cooldownMs, defaults.cooldownMs, 1000))),
  };
}

function resolveIdempotencyConfig(
  defaults: ResolvedIdempotencyConfig,
  overrides?: ToolIdempotencyConfig
): ResolvedIdempotencyConfig {
  return {
    enabled: overrides?.enabled ?? defaults.enabled,
    ttlMs:
      typeof overrides?.ttlMs === 'number' && Number.isFinite(overrides.ttlMs) && overrides.ttlMs > 0
        ? Math.round(overrides.ttlMs)
        : undefined,
    includeErrors: overrides?.includeErrors ?? defaults.includeErrors,
    namespaceByRunKey: overrides?.namespaceByRunKey ?? defaults.namespaceByRunKey,
  };
}

function resolveConcurrencyConfig(
  defaults: ResolvedConcurrencyConfig,
  overrides?: ToolConcurrencyConfig
): ResolvedConcurrencyConfig {
  const waitMode = overrides?.waitMode ?? defaults.waitMode;

  return {
    enabled: overrides?.enabled ?? defaults.enabled,
    leaseMs: Math.max(1000, Math.round(clampNumber(overrides?.leaseMs, defaults.leaseMs, 1000))),
    waitMode: waitMode === 'wait' ? 'wait' : 'reject',
    waitTimeoutMs: Math.max(
      0,
      Math.round(clampNumber(overrides?.waitTimeoutMs, defaults.waitTimeoutMs, 0))
    ),
    pollIntervalMs: Math.max(
      10,
      Math.round(clampNumber(overrides?.pollIntervalMs, defaults.pollIntervalMs, 10))
    ),
  };
}

function resolveRuntimeOverrides(overrides?: ToolRuntimeOverridesConfig): ResolvedRuntimeOverrides {
  const normalize = (
    map?: Record<string, ToolRuntimeOverrideConfig>
  ): Array<{ pattern: string; override: ResolvedRuntimeOverride }> => {
    return Object.entries(map ?? {})
      .map(([pattern, override]) => ({
        pattern: pattern.trim(),
        override: {
          timeoutMs: override.timeoutMs,
          retry: override.retry,
          loopBreaker: override.loopBreaker,
          circuitBreaker: override.circuitBreaker,
        },
      }))
      .filter((entry) => entry.pattern.length > 0);
  };

  return {
    tools: normalize(overrides?.tools),
    destinations: normalize(overrides?.destinations),
  };
}

function resolveConfig(config?: ToolRuntimeControlsConfig): ResolvedConfig {
  return {
    tenantKey: config?.tenantKey ?? 'default',
    timeoutMs: Math.max(0, Math.round(clampNumber(config?.timeoutMs, DEFAULT_TIMEOUT_MS, 0))),
    maxToolCalls:
      typeof config?.maxToolCalls === 'number'
        ? Math.max(1, Math.round(clampNumber(config.maxToolCalls, config.maxToolCalls, 1)))
        : undefined,
    retry: resolveRetryConfig(DEFAULT_RETRY, config?.retry),
    retryClassifier: config?.retryClassifier,
    loopBreaker: resolveLoopBreakerConfig(DEFAULT_LOOP_BREAKER, config?.loopBreaker),
    circuitBreaker: resolveToolCircuitBreaker(DEFAULT_CIRCUIT_BREAKER, config?.circuitBreaker),
    policy: {
      enabled: config?.policy?.enabled ?? DEFAULT_POLICY.enabled,
      mode: config?.policy?.mode ?? DEFAULT_POLICY.mode,
      rules: config?.policy?.rules ?? DEFAULT_POLICY.rules,
      approvalHandler: config?.policy?.approvalHandler,
    },
    verifiers: {
      beforeCall: config?.verifiers?.beforeCall,
      afterSuccess: config?.verifiers?.afterSuccess,
      afterError: config?.verifiers?.afterError,
    },
    idempotency: resolveIdempotencyConfig(DEFAULT_IDEMPOTENCY, config?.idempotency),
    concurrency: resolveConcurrencyConfig(DEFAULT_CONCURRENCY, config?.concurrency),
    overrides: resolveRuntimeOverrides(config?.overrides),
    state: config?.state ?? {},
    onEvent: config?.onEvent,
    eventSinks: config?.eventSinks ?? [],
    onEventSinkFailure: config?.onEventSinkFailure,
  };
}

function createStateStore(adapter?: ToolRuntimeStateAdapter): RuntimeStateStore {
  if (!adapter) {
    const map = new Map<string, unknown>();
    return {
      get: async function <T>(key: string): Promise<T | undefined> {
        return map.get(key) as T | undefined;
      },
      set: async function <T>(key: string, value: T): Promise<void> {
        map.set(key, value as unknown);
      },
      delete: async (key: string): Promise<void> => {
        map.delete(key);
      },
      keys: async (): Promise<string[]> => Array.from(map.keys()),
    };
  }

  const knownKeys = new Set<string>();
  return {
    get: async function <T>(key: string): Promise<T | undefined> {
      const value = await adapter.get<T>(key);
      if (value !== undefined) {
        knownKeys.add(key);
      }
      return value;
    },
    set: async function <T>(key: string, value: T): Promise<void> {
      knownKeys.add(key);
      await adapter.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      knownKeys.delete(key);
      await adapter.delete?.(key);
    },
    keys: async (): Promise<string[]> => {
      if (!adapter.keys) {
        return Array.from(knownKeys);
      }
      const iter = await adapter.keys();
      return Array.from(iter);
    },
  };
}

function normalizeVerifierDecision(
  decision: boolean | ToolVerifierDecision | undefined
): NormalizedVerifierDecision {
  if (typeof decision === 'boolean') {
    return { allow: decision };
  }

  if (!decision || typeof decision !== 'object') {
    return { allow: true };
  }

  return {
    allow: decision.allow,
    reason: typeof decision.reason === 'string' ? decision.reason : undefined,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function digestStable(value: unknown): string {
  let serialized: string;
  try {
    serialized = stableStringify(value);
  } catch {
    serialized = String(value);
  }
  return createHash('sha256').update(serialized).digest('hex');
}

function buildFingerprint(toolName: string, args: unknown): string {
  return `${toolName}:${digestStable(args ?? null)}`;
}

function buildOutcomeHash(params: {
  ok: boolean;
  statusCode?: number;
  code?: string;
  message?: string;
  data?: unknown;
}): string {
  return digestStable({
    ok: params.ok,
    statusCode: params.statusCode ?? null,
    code: params.code ?? null,
    message: params.message ?? null,
    data: params.data ?? null,
  });
}

function computeBackoffDelay(config: ResolvedRetryConfig, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const baseDelay = config.initialDelayMs * config.backoffFactor ** exponent;
  const bounded = Math.min(config.maxDelayMs, Math.max(0, baseDelay));
  if (config.jitterRatio <= 0) {
    return Math.round(bounded);
  }
  const jitterOffset = (Math.random() * 2 - 1) * config.jitterRatio;
  const jittered = bounded * (1 + jitterOffset);
  return Math.max(0, Math.round(jittered));
}

function createRunSignal(timeoutMs: number, externalSignal?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    externalSignal?.removeEventListener('abort', onExternalAbort);
  };

  return {
    signal: controller.signal,
    cleanup,
    didTimeout: () => timedOut,
  };
}

async function raceWithAbort<TResult>(
  signal: AbortSignal,
  fn: () => Promise<TResult>
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error('aborted'));
    };

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    fn()
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });
  });
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(new Error('aborted'));
    };

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function extractStatusCode(error: unknown): number | undefined {
  if (hasFailureFields(error)) {
    return error.statusCode;
  }
  if (error instanceof BuildfunctionsError) {
    return error.statusCode;
  }
  if (error && typeof error === 'object') {
    const obj = error as {
      statusCode?: unknown;
      status?: unknown;
      response?: { status?: unknown };
    };
    if (typeof obj.statusCode === 'number') {
      return obj.statusCode;
    }
    if (typeof obj.status === 'number') {
      return obj.status;
    }
    if (typeof obj.response?.status === 'number') {
      return obj.response.status;
    }
  }
  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  if (hasFailureFields(error)) {
    return error.code;
  }
  if (error instanceof BuildfunctionsError) {
    return error.code;
  }
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      const trimmed = code.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function extractErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    if (typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
    return undefined;
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      const trimmed = message.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function isRetryableStatus(statusCode: number | undefined): boolean {
  if (typeof statusCode !== 'number') {
    return false;
  }
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function normalizeFailure(
  error: unknown,
  params: { didTimeout: boolean; cancelledByCaller: boolean; statusCode?: number }
): ToolFailure {
  if (hasFailureFields(error)) {
    return error;
  }

  if (error instanceof BuildfunctionsError) {
    return createFailure(error.message, error.code, error.statusCode ?? params.statusCode);
  }

  if (params.cancelledByCaller) {
    return createFailure('Tool call cancelled by caller', 'NETWORK_ERROR', params.statusCode);
  }

  if (params.didTimeout) {
    return createFailure('Tool call timed out', 'NETWORK_ERROR', params.statusCode);
  }

  const explicitCode = extractErrorCode(error);
  const explicitMessage = extractErrorMessage(error);

  if (error instanceof Error) {
    const transient = /timeout|timed out|econnreset|eai_again|enotfound|network|socket|rate limit|temporar/i.test(
      explicitMessage ?? error.message
    );
    return createFailure(
      explicitMessage ?? 'Tool call failed',
      explicitCode ?? (transient ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR'),
      params.statusCode
    );
  }

  if (error && typeof error === 'object') {
    const transient = explicitMessage
      ? /timeout|timed out|econnreset|eai_again|enotfound|network|socket|rate limit|temporar/i.test(explicitMessage)
      : false;
    return createFailure(
      explicitMessage ?? 'Tool call failed',
      explicitCode ?? (transient ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR'),
      params.statusCode
    );
  }

  return createFailure('Tool call failed', 'UNKNOWN_ERROR', params.statusCode);
}

function isFatalBuildfunctionsCode(code: string): boolean {
  return code === 'UNAUTHORIZED' || code === 'INVALID_REQUEST' || code === 'VALIDATION_ERROR' || code === 'NOT_FOUND' || code === 'SIZE_LIMIT_EXCEEDED';
}

function shouldRetryFailure(
  error: ToolFailure,
  statusCode: number | undefined,
  cancelledByCaller: boolean
): boolean {
  if (cancelledByCaller) {
    return false;
  }
  if (isRetryableStatus(statusCode ?? error.statusCode)) {
    return true;
  }
  if (isFatalBuildfunctionsCode(error.code)) {
    return false;
  }
  return error.code === 'NETWORK_ERROR';
}

function matchPattern(value: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === pattern;
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.startsWith('*.')) {
    return host.toLowerCase().endsWith(pattern.slice(1).toLowerCase());
  }
  return host.toLowerCase() === pattern.toLowerCase();
}

function normalizeDestination(destination?: string): string | undefined {
  if (!destination) {
    return undefined;
  }
  try {
    return new URL(destination).host;
  } catch {
    return destination;
  }
}

function getToolPatternSpecificity(pattern: string): number {
  if (pattern === '*') {
    return 0;
  }
  if (pattern.endsWith('*')) {
    return 1;
  }
  return 2;
}

function getDestinationPatternSpecificity(pattern: string): number {
  if (pattern === '*') {
    return 0;
  }
  if (pattern.startsWith('*.')) {
    return 1;
  }
  return 2;
}

function findToolOverride(
  entries: Array<{ pattern: string; override: ResolvedRuntimeOverride }>,
  toolName: string
): ResolvedRuntimeOverride | undefined {
  let best: { score: number; override: ResolvedRuntimeOverride } | undefined;

  for (const entry of entries) {
    if (!matchPattern(toolName, entry.pattern)) {
      continue;
    }
    const score = getToolPatternSpecificity(entry.pattern);
    if (!best || score > best.score) {
      best = { score, override: entry.override };
    }
  }

  return best?.override;
}

function findDestinationOverride(
  entries: Array<{ pattern: string; override: ResolvedRuntimeOverride }>,
  destination?: string
): ResolvedRuntimeOverride | undefined {
  if (!destination) {
    return undefined;
  }

  let best: { score: number; override: ResolvedRuntimeOverride } | undefined;
  for (const entry of entries) {
    if (!hostMatches(entry.pattern, destination)) {
      continue;
    }
    const score = getDestinationPatternSpecificity(entry.pattern);
    if (!best || score > best.score) {
      best = { score, override: entry.override };
    }
  }
  return best?.override;
}

function applyRuntimeOverride(base: EffectiveCallConfig, override?: ResolvedRuntimeOverride): EffectiveCallConfig {
  if (!override) {
    return base;
  }

  return {
    timeoutMs:
      typeof override.timeoutMs === 'number'
        ? Math.max(0, Math.round(clampNumber(override.timeoutMs, base.timeoutMs, 0)))
        : base.timeoutMs,
    retry: override.retry ? resolveRetryConfig(base.retry, override.retry) : base.retry,
    loopBreaker: override.loopBreaker ? resolveLoopBreakerConfig(base.loopBreaker, override.loopBreaker) : base.loopBreaker,
    circuitBreaker: override.circuitBreaker
      ? resolveToolCircuitBreaker(base.circuitBreaker, override.circuitBreaker)
      : base.circuitBreaker,
  };
}

function resolveEffectiveCallConfig(resolved: ResolvedConfig, context: ToolCallContext): EffectiveCallConfig {
  const normalizedDestination = normalizeDestination(context.destination);

  const destinationOverride = findDestinationOverride(resolved.overrides.destinations, normalizedDestination);
  const toolOverride = findToolOverride(resolved.overrides.tools, context.toolName);

  const defaults: EffectiveCallConfig = {
    timeoutMs: context.timeoutMs ?? resolved.timeoutMs,
    retry: resolved.retry,
    loopBreaker: resolved.loopBreaker,
    circuitBreaker: resolved.circuitBreaker,
  };

  return applyRuntimeOverride(applyRuntimeOverride(defaults, destinationOverride), toolOverride);
}

interface ToolRuleMatchRank {
  toolSpecificity: number;
  destinationSpecificity: number;
  actionPrefixSpecificity: number;
  strictness: number;
  index: number;
}

function getPolicyActionStrictness(action: RuntimePolicyAction): number {
  if (action === 'deny') {
    return 2;
  }
  if (action === 'require_approval') {
    return 1;
  }
  return 0;
}

function getToolRuleMatchRank(
  rule: ToolPolicyRule,
  context: ToolCallContext,
  index: number
): ToolRuleMatchRank | undefined {
  let toolSpecificity = -1;
  if (rule.tools && rule.tools.length > 0) {
    const scores = rule.tools
      .filter((pattern) => matchPattern(context.toolName, pattern))
      .map((pattern) => getToolPatternSpecificity(pattern));
    if (scores.length === 0) {
      return undefined;
    }
    toolSpecificity = Math.max(...scores);
  }

  let destinationSpecificity = -1;
  if (rule.destinations && rule.destinations.length > 0) {
    const destination = normalizeDestination(context.destination);
    if (!destination) {
      return undefined;
    }
    const scores = rule.destinations
      .filter((pattern) => hostMatches(pattern, destination))
      .map((pattern) => getDestinationPatternSpecificity(pattern));
    if (scores.length === 0) {
      return undefined;
    }
    destinationSpecificity = Math.max(...scores);
  }

  let actionPrefixSpecificity = -1;
  if (rule.actionPrefixes && rule.actionPrefixes.length > 0) {
    if (!context.action) {
      return undefined;
    }
    const lengths = rule.actionPrefixes
      .filter((prefix) => context.action?.startsWith(prefix))
      .map((prefix) => prefix.length);
    if (lengths.length === 0) {
      return undefined;
    }
    actionPrefixSpecificity = Math.max(...lengths);
  }

  return {
    toolSpecificity,
    destinationSpecificity,
    actionPrefixSpecificity,
    strictness: getPolicyActionStrictness(rule.action),
    index,
  };
}

function compareRuleRanks(a: ToolRuleMatchRank, b: ToolRuleMatchRank): number {
  if (a.toolSpecificity !== b.toolSpecificity) {
    return a.toolSpecificity - b.toolSpecificity;
  }
  if (a.destinationSpecificity !== b.destinationSpecificity) {
    return a.destinationSpecificity - b.destinationSpecificity;
  }
  if (a.actionPrefixSpecificity !== b.actionPrefixSpecificity) {
    return a.actionPrefixSpecificity - b.actionPrefixSpecificity;
  }
  if (a.strictness !== b.strictness) {
    return a.strictness - b.strictness;
  }
  return b.index - a.index;
}

function findMatchingToolRule(rules: ToolPolicyRule[], context: ToolCallContext): ToolPolicyRule | undefined {
  let bestRule: ToolPolicyRule | undefined;
  let bestRank: ToolRuleMatchRank | undefined;

  rules.forEach((rule, index) => {
    const rank = getToolRuleMatchRank(rule, context, index);
    if (!rank) {
      return;
    }

    if (!bestRank || compareRuleRanks(rank, bestRank) > 0) {
      bestRank = rank;
      bestRule = rule;
    }
  });

  return bestRule;
}

function createRuntimeControls(config?: ToolRuntimeControlsConfig): ToolRuntimeControls {
  const resolved = resolveConfig(config);
  const loopStore = createStateStore(resolved.state.loop);
  const circuitStore = createStateStore(resolved.state.circuit);
  const budgetStore = createStateStore(resolved.state.budget);
  const lockStore = createStateStore(resolved.state.lock);
  const idempotencyStore = createStateStore(resolved.state.idempotency);

  const loopPrefix = `${resolved.tenantKey}:loop:`;
  const lockPrefix = `${resolved.tenantKey}:lock:`;
  const idempotencyPrefix = `${resolved.tenantKey}:idempotency:`;

  const emitEvent = (event: Omit<RuntimeControlEvent, 'timestamp'>): void => {
    const emittedEvent: RuntimeControlEvent = {
      ...event,
      timestamp: Date.now(),
    };

    resolved.onEvent?.(emittedEvent);

    if (resolved.eventSinks.length === 0) {
      return;
    }

    resolved.eventSinks.forEach((sink, sinkIndex) => {
      void Promise.resolve()
        .then(() => sink(emittedEvent))
        .catch((error: unknown) => {
          resolved.onEventSinkFailure?.({
            failure: error,
            event: emittedEvent,
            sinkIndex,
          });
        });
    });
  };

  const getLoopStateKey = (fingerprint: string): string => `${loopPrefix}${fingerprint}`;
  const normalizeRunKey = (runKey?: string): string => {
    if (!runKey) {
      return 'default';
    }
    const trimmed = runKey.trim();
    return trimmed.length > 0 ? trimmed : 'default';
  };
  const getRunBudgetKey = (runKey: string): string => `${resolved.tenantKey}:budget:${runKey}`;
  const getLockStateKey = (resourceKey: string): string => `${lockPrefix}${digestStable(resourceKey)}`;

  const getVerifierBaseContext = (context: ToolCallContext) => ({
    toolName: context.toolName,
    runKey: context.runKey,
    destination: context.destination,
    action: context.action,
    args: context.args,
    idempotencyKey: context.idempotencyKey,
    resourceKey: context.resourceKey,
  });

  const enforceBeforeVerifier = async (context: ToolCallContext): Promise<void> => {
    if (!resolved.verifiers.beforeCall) {
      return;
    }

    const decision = normalizeVerifierDecision(await resolved.verifiers.beforeCall(getVerifierBaseContext(context)));
    if (decision.allow) {
      return;
    }

    const reason = decision.reason ?? 'before-call verifier rejected tool call';
    emitEvent({
      type: 'verifier_rejected',
      message: reason,
      details: {
        phase: 'before_call',
        toolName: context.toolName,
        destination: context.destination ?? null,
        action: context.action ?? null,
      },
    });
    throw createFailure(`Verifier rejected tool call: ${reason}`, 'INVALID_REQUEST');
  };

  const enforceSuccessVerifier = async (context: ToolCallContext, result: unknown): Promise<void> => {
    if (!resolved.verifiers.afterSuccess) {
      return;
    }

    const decision = normalizeVerifierDecision(
      await resolved.verifiers.afterSuccess({
        ...getVerifierBaseContext(context),
        result,
      })
    );
    if (decision.allow) {
      return;
    }

    const reason = decision.reason ?? 'success verifier rejected tool result';
    emitEvent({
      type: 'verifier_rejected',
      message: reason,
      details: {
        phase: 'after_success',
        toolName: context.toolName,
        destination: context.destination ?? null,
        action: context.action ?? null,
      },
    });
    throw createFailure(`Verifier rejected tool result: ${reason}`, 'INVALID_REQUEST');
  };

  const applyErrorVerifier = async (
    context: ToolCallContext,
    normalizedError: ToolFailure,
    rawError: unknown
  ): Promise<ToolFailure> => {
    if (!resolved.verifiers.afterError) {
      return normalizedError;
    }

    const decision = normalizeVerifierDecision(
      await resolved.verifiers.afterError({
        ...getVerifierBaseContext(context),
        error: {
          message: normalizedError.message,
          code: normalizedError.code,
          statusCode: normalizedError.statusCode,
        },
        rawError,
      })
    );
    if (decision.allow) {
      return normalizedError;
    }

    const reason = decision.reason ?? 'error verifier rejected tool error';
    emitEvent({
      type: 'verifier_rejected',
      message: reason,
      details: {
        phase: 'after_error',
        toolName: context.toolName,
        destination: context.destination ?? null,
        action: context.action ?? null,
        originalCode: normalizedError.code,
      },
    });
    return createFailure(`Verifier rejected tool error: ${reason}`, 'INVALID_REQUEST');
  };

  const getIdempotencyStateKey = (context: ToolCallContext): string | undefined => {
    if (!resolved.idempotency.enabled || !context.idempotencyKey) {
      return undefined;
    }

    const key = context.idempotencyKey.trim();
    if (key.length === 0) {
      return undefined;
    }

    const scope = resolved.idempotency.namespaceByRunKey ? normalizeRunKey(context.runKey) : 'global';
    const keyHash = digestStable(key);
    return `${idempotencyPrefix}${scope}:${context.toolName}:${keyHash}`;
  };

  const readIdempotencyRecord = async (context: ToolCallContext): Promise<IdempotencyRecord | undefined> => {
    const stateKey = getIdempotencyStateKey(context);
    if (!stateKey) {
      return undefined;
    }

    const record = await idempotencyStore.get<IdempotencyRecord>(stateKey);
    if (!record) {
      return undefined;
    }

    const now = Date.now();
    if (record.expiresAt && record.expiresAt <= now) {
      await idempotencyStore.delete(stateKey);
      return undefined;
    }

    return record;
  };

  const storeIdempotencySuccess = async (context: ToolCallContext, result: unknown): Promise<void> => {
    const stateKey = getIdempotencyStateKey(context);
    if (!stateKey) {
      return;
    }

    const now = Date.now();
    await idempotencyStore.set<IdempotencyRecord>(stateKey, {
      storedAt: now,
      expiresAt: resolved.idempotency.ttlMs ? now + resolved.idempotency.ttlMs : undefined,
      ok: true,
      result,
    });
  };

  const storeIdempotencyError = async (context: ToolCallContext, error: ToolFailure): Promise<void> => {
    if (!resolved.idempotency.includeErrors) {
      return;
    }

    const stateKey = getIdempotencyStateKey(context);
    if (!stateKey) {
      return;
    }

    const now = Date.now();
    await idempotencyStore.set<IdempotencyRecord>(stateKey, {
      storedAt: now,
      expiresAt: resolved.idempotency.ttlMs ? now + resolved.idempotency.ttlMs : undefined,
      ok: false,
      error: {
        message: error.message,
        code: error.code,
        statusCode: error.statusCode,
      },
    });
  };

  const tryReplayIdempotency = async (context: ToolCallContext): Promise<{ hit: false } | { hit: true; value: unknown }> => {
    const stateKey = getIdempotencyStateKey(context);
    if (!stateKey) {
      return { hit: false };
    }

    const record = await readIdempotencyRecord(context);
    if (!record) {
      return { hit: false };
    }

    emitEvent({
      type: 'idempotency_replay',
      message: `Replayed idempotent result for ${context.toolName}`,
      details: {
        toolName: context.toolName,
        runKey: normalizeRunKey(context.runKey),
        hadError: !record.ok,
      },
    });

    if (record.ok) {
      return { hit: true, value: record.result };
    }

    const replayError = record.error
      ? createFailure(record.error.message, record.error.code, record.error.statusCode)
      : createFailure('Replayed idempotent tool error', 'UNKNOWN_ERROR');
    throw replayError;
  };

  const acquireResourceLock = async (
    context: ToolCallContext,
    minimumLeaseMs: number
  ): Promise<{ key: string; owner: string } | undefined> => {
    if (!resolved.concurrency.enabled) {
      return undefined;
    }

    const resourceKey = context.resourceKey?.trim();
    if (!resourceKey) {
      return undefined;
    }

    const key = getLockStateKey(resourceKey);
    const owner = `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const leaseMs = Math.max(resolved.concurrency.leaseMs, minimumLeaseMs);

    const tryAcquire = async (): Promise<boolean> => {
      const now = Date.now();
      const existing = await lockStore.get<LockState>(key);
      if (!existing || existing.expiresAt <= now) {
        await lockStore.set<LockState>(key, {
          owner,
          expiresAt: now + leaseMs,
        });
        return true;
      }
      return false;
    };

    if (await tryAcquire()) {
      return { key, owner };
    }

    if (resolved.concurrency.waitMode === 'reject') {
      emitEvent({
        type: 'concurrency_rejected',
        message: 'Concurrency lock is already held',
        details: {
          toolName: context.toolName,
          resourceKey,
          waitMode: 'reject',
        },
      });
      throw createFailure('Concurrency lock is already held for resource', 'INVALID_REQUEST');
    }

    emitEvent({
      type: 'concurrency_wait',
      message: 'Waiting for concurrency lock',
      details: {
        toolName: context.toolName,
        resourceKey,
        waitTimeoutMs: resolved.concurrency.waitTimeoutMs,
      },
    });

    const startedAt = Date.now();
    while (true) {
      if (await tryAcquire()) {
        return { key, owner };
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= resolved.concurrency.waitTimeoutMs) {
        emitEvent({
          type: 'concurrency_rejected',
          message: 'Concurrency lock wait timeout',
          details: {
            toolName: context.toolName,
            resourceKey,
            waitMode: 'wait',
            waitTimeoutMs: resolved.concurrency.waitTimeoutMs,
            elapsedMs,
          },
        });
        throw createFailure('Concurrency lock wait timeout', 'INVALID_REQUEST');
      }

      try {
        await sleepWithAbort(resolved.concurrency.pollIntervalMs, context.signal);
      } catch {
        throw createFailure('Tool call cancelled by caller', 'NETWORK_ERROR');
      }
    }
  };

  const releaseResourceLock = async (lockRef?: { key: string; owner: string }): Promise<void> => {
    if (!lockRef) {
      return;
    }

    const state = await lockStore.get<LockState>(lockRef.key);
    if (!state || state.owner !== lockRef.owner) {
      return;
    }
    await lockStore.delete(lockRef.key);
  };

  const pruneLoopStates = async (loopConfig: ResolvedLoopBreakerConfig): Promise<void> => {
    const keys = (await loopStore.keys()).filter((key) => key.startsWith(loopPrefix));
    if (keys.length <= loopConfig.maxFingerprints) {
      return;
    }

    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const key of keys) {
      const state = await loopStore.get<LoopState>(key);
      if (!state) {
        continue;
      }
      if (state.lastSeenAt < oldest) {
        oldest = state.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      await loopStore.delete(oldestKey);
    }
  };

  const enforceLoopBeforeCall = async (
    fingerprint: string,
    loopConfig: ResolvedLoopBreakerConfig
  ): Promise<void> => {
    if (!loopConfig.enabled) {
      return;
    }
    const loopStateKey = getLoopStateKey(fingerprint);
    const state = await loopStore.get<LoopState>(loopStateKey);
    if (!state) {
      return;
    }
    const now = Date.now();
    if (state.stopUntil && state.stopUntil > now) {
      throw createFailure('Loop breaker blocked repeated no-progress tool pattern', 'INVALID_REQUEST');
    }
    if (state.quarantineUntil && state.quarantineUntil > now) {
      throw createFailure('Loop breaker quarantined repeated tool pattern', 'INVALID_REQUEST');
    }
    state.lastSeenAt = now;
    await loopStore.set(loopStateKey, state);
  };

  const recordLoopOutcome = async (
    params: {
      fingerprint: string;
      outcomeHash: string;
      toolName: string;
      statusCode?: number;
    },
    loopConfig: ResolvedLoopBreakerConfig
  ): Promise<void> => {
    if (!loopConfig.enabled) {
      return;
    }

    const now = Date.now();
    const loopStateKey = getLoopStateKey(params.fingerprint);
    const state = (await loopStore.get<LoopState>(loopStateKey)) ?? {
      streak: 0,
      lastSeenAt: now,
    };

    if (state.lastOutcomeHash === params.outcomeHash) {
      state.streak += 1;
    } else {
      state.streak = 1;
      state.lastOutcomeHash = params.outcomeHash;
      state.quarantineUntil = undefined;
      state.stopUntil = undefined;
    }

    state.lastSeenAt = now;

    if (state.streak >= loopConfig.stopThreshold) {
      const previous = state.stopUntil ?? 0;
      state.stopUntil = now + loopConfig.stopCooldownMs;
      if (previous <= now) {
        emitEvent({
          type: 'loop_stop',
          message: `Loop breaker stop threshold reached for ${params.toolName}`,
          details: {
            toolName: params.toolName,
            streak: state.streak,
            stopUntil: state.stopUntil,
            statusCode: params.statusCode ?? null,
          },
        });
      }
    } else if (state.streak >= loopConfig.quarantineThreshold) {
      const previous = state.quarantineUntil ?? 0;
      state.quarantineUntil = now + loopConfig.quarantineMs;
      if (previous <= now) {
        emitEvent({
          type: 'loop_quarantine',
          message: `Loop breaker quarantine threshold reached for ${params.toolName}`,
          details: {
            toolName: params.toolName,
            streak: state.streak,
            quarantineUntil: state.quarantineUntil,
            statusCode: params.statusCode ?? null,
          },
        });
      }
    } else if (state.streak >= loopConfig.warningThreshold) {
      emitEvent({
        type: 'loop_warning',
        message: `Loop breaker warning threshold reached for ${params.toolName}`,
        details: {
          toolName: params.toolName,
          streak: state.streak,
          statusCode: params.statusCode ?? null,
        },
      });
    }

    await loopStore.set(loopStateKey, state);
    await pruneLoopStates(loopConfig);
  };

  const getCircuitKey = (toolName: string, destination?: string): string => {
    const normalizedDestination = normalizeDestination(destination) ?? 'default';
    return `${resolved.tenantKey}:${toolName}:${normalizedDestination}`;
  };

  const enforceCircuitBeforeCall = async (
    toolName: string,
    destination: string | undefined,
    circuitConfig: ResolvedCircuitBreakerConfig
  ): Promise<void> => {
    if (!circuitConfig.enabled) {
      return;
    }
    const key = getCircuitKey(toolName, destination);
    const state = await circuitStore.get<CircuitState>(key);
    const now = Date.now();
    if (state?.openUntil && state.openUntil > now) {
      throw createFailure('Dependency temporarily unavailable (circuit breaker open)', 'NETWORK_ERROR');
    }
  };

  const recordCircuitCall = async (
    params: {
      toolName: string;
      destination?: string;
      failed: boolean;
    },
    circuitConfig: ResolvedCircuitBreakerConfig
  ): Promise<void> => {
    if (!circuitConfig.enabled) {
      return;
    }

    const now = Date.now();
    const key = getCircuitKey(params.toolName, params.destination);
    const state = (await circuitStore.get<CircuitState>(key)) ?? { samples: [] };
    state.samples.push({ timestamp: now, failed: params.failed });
    const minTimestamp = now - circuitConfig.windowMs;
    state.samples = state.samples.filter((sample) => sample.timestamp >= minTimestamp);

    if (state.samples.length >= circuitConfig.minRequests) {
      const failureCount = state.samples.filter((sample) => sample.failed).length;
      const failureRate = failureCount / state.samples.length;
      if (failureRate >= circuitConfig.failureRateThreshold) {
        const previous = state.openUntil ?? 0;
        state.openUntil = now + circuitConfig.cooldownMs;
        if (previous <= now) {
          emitEvent({
            type: 'circuit_open',
            message: `Circuit breaker opened for ${params.toolName}`,
            details: {
              key,
              failureCount,
              total: state.samples.length,
              failureRate,
              openUntil: state.openUntil,
            },
          });
        }
      }
    }

    await circuitStore.set(key, state);
  };

  const enforceRunBudget = async (context: ToolCallContext): Promise<void> => {
    if (typeof resolved.maxToolCalls !== 'number') {
      return;
    }

    const runKey = normalizeRunKey(context.runKey);
    const budgetKey = getRunBudgetKey(runKey);
    const state = (await budgetStore.get<RunBudgetState>(budgetKey)) ?? { count: 0 };

    if (state.count >= resolved.maxToolCalls) {
      emitEvent({
        type: 'budget_stop',
        message: `Tool-call budget exceeded for run "${runKey}"`,
        details: {
          runKey,
          toolName: context.toolName,
          maxToolCalls: resolved.maxToolCalls,
          usedCalls: state.count,
        },
      });
      throw createFailure(
        `Tool-call budget exceeded for run "${runKey}" (${resolved.maxToolCalls} max calls)`,
        'INVALID_REQUEST'
      );
    }

    state.count += 1;
    await budgetStore.set(budgetKey, state);
  };

  const enforcePolicy = async (context: ToolCallContext): Promise<void> => {
    if (!resolved.policy.enabled || resolved.policy.rules.length === 0) {
      return;
    }

    const matchingRule = findMatchingToolRule(resolved.policy.rules, context);
    if (!matchingRule) {
      return;
    }

    const reason = matchingRule.reason ?? 'Policy blocked tool call';
    const action: RuntimePolicyAction = matchingRule.action;

    if (action === 'allow') {
      return;
    }

    if (resolved.policy.mode === 'dryRun') {
      emitEvent({
        type: 'policy_dry_run',
        message: reason,
        details: {
          ruleId: matchingRule.id ?? null,
          toolName: context.toolName,
          destination: context.destination ?? null,
          action: context.action ?? null,
          simulatedAction: action,
        },
      });
      return;
    }

    if (action === 'deny') {
      emitEvent({
        type: 'policy_denied',
        message: reason,
        details: {
          ruleId: matchingRule.id ?? null,
          toolName: context.toolName,
          destination: context.destination ?? null,
          action: context.action ?? null,
        },
      });
      throw createFailure(`Policy denied tool call: ${reason}`, 'UNAUTHORIZED', 403);
    }

    emitEvent({
      type: 'policy_approval_required',
      message: reason,
      details: {
        ruleId: matchingRule.id ?? null,
        toolName: context.toolName,
        destination: context.destination ?? null,
        action: context.action ?? null,
      },
    });

    if (!resolved.policy.approvalHandler) {
      throw createFailure(
        `Policy requires approval but no approvalHandler is configured: ${reason}`,
        'UNAUTHORIZED',
        403
      );
    }

    const approved = await resolved.policy.approvalHandler({
      ruleId: matchingRule.id,
      reason: matchingRule.reason,
      toolName: context.toolName,
      destination: context.destination,
      action: context.action,
      args: context.args,
    });

    if (!approved) {
      emitEvent({
        type: 'policy_denied',
        message: 'Tool call approval denied',
        details: {
          ruleId: matchingRule.id ?? null,
          toolName: context.toolName,
        },
      });
      throw createFailure('Tool call approval denied by policy handler', 'UNAUTHORIZED', 403);
    }

    emitEvent({
      type: 'policy_approved',
      message: 'Tool call approved by policy handler',
      details: {
        ruleId: matchingRule.id ?? null,
        toolName: context.toolName,
      },
    });
  };

  const resolveRetryDecision = async (params: {
    context: ToolCallContext;
    rawError: unknown;
    normalizedError: ToolFailure;
    statusCode?: number;
    attempt: number;
    maxAttempts: number;
    cancelledByCaller: boolean;
    defaultRetryable: boolean;
  }): Promise<ToolRetryClassifierDecision> => {
    const fallback: ToolRetryClassifierDecision = {
      retryable: params.defaultRetryable,
    };

    if (!resolved.retryClassifier) {
      return fallback;
    }

    const result = await resolved.retryClassifier({
      error: {
        message: params.normalizedError.message,
        code: params.normalizedError.code,
        statusCode: params.normalizedError.statusCode,
      },
      rawError: params.rawError,
      statusCode: params.statusCode,
      cancelledByCaller: params.cancelledByCaller,
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
      toolName: params.context.toolName,
      destination: params.context.destination,
      action: params.context.action,
    });

    if (typeof result === 'boolean') {
      return { retryable: result };
    }

    if (!result || typeof result !== 'object') {
      return fallback;
    }

    return {
      retryable: result.retryable,
      reason: typeof result.reason === 'string' ? result.reason : undefined,
      delayMs:
        typeof result.delayMs === 'number' && Number.isFinite(result.delayMs) && result.delayMs >= 0
          ? Math.round(result.delayMs)
          : undefined,
    };
  };

  const run: ToolRuntimeControls['run'] = async (context, fn) => {
    const effective = resolveEffectiveCallConfig(resolved, context);
    const fingerprint = buildFingerprint(context.toolName, context.args);
    await enforcePolicy(context);
    await enforceBeforeVerifier(context);

    const replay = await tryReplayIdempotency(context);
    if (replay.hit) {
      return replay.value as Awaited<ReturnType<typeof fn>>;
    }

    await enforceRunBudget(context);
    await enforceLoopBeforeCall(fingerprint, effective.loopBreaker);
    const lockRef = await acquireResourceLock(
      context,
      effective.timeoutMs > 0 ? effective.timeoutMs + 1_000 : resolved.concurrency.leaseMs
    );

    try {
      const retry = effective.retry;

      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        await enforceCircuitBeforeCall(context.toolName, context.destination, effective.circuitBreaker);

        const timeoutMs = effective.timeoutMs;
        const { signal, cleanup, didTimeout } = createRunSignal(timeoutMs, context.signal);
        let errorPhase: 'execute' | 'after_success' = 'execute';

        try {
          const result = await raceWithAbort(signal, () => fn({ signal }));

          await recordCircuitCall(
            { toolName: context.toolName, destination: context.destination, failed: false },
            effective.circuitBreaker
          );

          errorPhase = 'after_success';
          await enforceSuccessVerifier(context, result);
          await storeIdempotencySuccess(context, result);

          await recordLoopOutcome({
            fingerprint,
            outcomeHash: buildOutcomeHash({ ok: true, data: result }),
            toolName: context.toolName,
          }, effective.loopBreaker);
          return result;
        } catch (rawError) {
          const statusCode = extractStatusCode(rawError);
          const cancelledByCaller = context.signal?.aborted === true;
          let normalized = normalizeFailure(rawError, {
            didTimeout: didTimeout(),
            cancelledByCaller,
            statusCode,
          });
          normalized = await applyErrorVerifier(context, normalized, rawError);

          if (errorPhase === 'execute') {
            await recordCircuitCall(
              { toolName: context.toolName, destination: context.destination, failed: true },
              effective.circuitBreaker
            );
          }

          const normalizedStatusCode = statusCode ?? normalized.statusCode;
          const defaultRetryable =
            attempt < retry.maxAttempts &&
            shouldRetryFailure(normalized, normalizedStatusCode, cancelledByCaller);
          const retryDecision = await resolveRetryDecision({
            context,
            rawError,
            normalizedError: normalized,
            statusCode: normalizedStatusCode,
            attempt,
            maxAttempts: retry.maxAttempts,
            cancelledByCaller,
            defaultRetryable,
          });
          const canRetry = attempt < retry.maxAttempts && retryDecision.retryable;

          if (!canRetry) {
            await recordLoopOutcome({
              fingerprint,
              outcomeHash: buildOutcomeHash({
                ok: false,
                statusCode: normalizedStatusCode,
                code: normalized.code,
                message: normalized.message,
              }),
              toolName: context.toolName,
              statusCode: normalizedStatusCode,
            }, effective.loopBreaker);
            await storeIdempotencyError(context, normalized);
            throw normalized;
          }

          const delayMs = retryDecision.delayMs ?? computeBackoffDelay(retry, attempt);
          emitEvent({
            type: 'retry',
            message: `Retrying tool call ${context.toolName} (attempt ${attempt + 1}/${retry.maxAttempts})`,
            details: {
              toolName: context.toolName,
              delayMs,
              statusCode: normalizedStatusCode ?? null,
              reason: normalized.message,
              classifierReason: retryDecision.reason ?? null,
            },
          });

          try {
            await sleepWithAbort(delayMs, context.signal);
          } catch {
            throw createFailure('Tool call cancelled by caller', 'NETWORK_ERROR');
          }
        } finally {
          cleanup();
        }
      }

      throw createFailure('Tool call failed after retries', 'NETWORK_ERROR');
    } finally {
      await releaseResourceLock(lockRef);
    }
  };

  const wrap: ToolRuntimeControls['wrap'] = (params) => {
    const handler = params.run ?? params.fn ?? params.function;
    if (!handler) {
      throw createFailure('wrap() requires a "run", "fn", or "function" property', 'VALIDATION_ERROR', undefined);
    }
    return async (...args) => {
      const runKey = params.resolveRunKey?.(...args) ?? params.runKey;
      const destination = params.resolveDestination?.(...args) ?? params.destination;
      const action = params.resolveAction?.(...args);
      const idempotencyKey = params.resolveIdempotencyKey?.(...args) ?? params.idempotencyKey;
      const resourceKey = params.resolveResourceKey?.(...args) ?? params.resourceKey;

      return run(
        {
          toolName: params.toolName,
          runKey,
          destination,
          action,
          args,
          idempotencyKey,
          resourceKey,
        },
        ({ signal }) => handler(args, { signal })
      );
    };
  };

  const reset: ToolRuntimeControls['reset'] = async (runKey) => {
    const normalizedRunKey = normalizeRunKey(runKey);
    await budgetStore.delete(getRunBudgetKey(normalizedRunKey));
  };

  return {
    run,
    wrap,
    reset,
  };
}

export const RuntimeControls = {
  create: createRuntimeControls,
};
