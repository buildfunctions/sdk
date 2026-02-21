import type {
  AgentLogicSafetyConfig,
  ToolCallVerifier,
  ToolCallVerifierContext,
  ToolPolicyRule,
  ToolRuntimeControlsConfig,
  ToolRuntimeStateAdapter,
  ToolVerifierDecision,
} from '../types/index.js';

interface ExitConditionState {
  steps: number;
  terminalReached: boolean;
}

interface RuntimeStateStore {
  get: <T>(key: string) => Promise<T | undefined>;
  set: <T>(key: string, value: T) => Promise<void>;
}

const DEFAULT_INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(all|any|previous)\s+instructions\b/i,
  /\bsystem\s+prompt\b/i,
  /\bdeveloper\s+message\b/i,
  /<script\b/i,
  /\brm\s+-rf\b/i,
];

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchPattern(value: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

function normalizeRunKey(runKey?: string): string {
  if (!runKey) {
    return 'default';
  }
  const trimmed = runKey.trim();
  return trimmed.length > 0 ? trimmed : 'default';
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
    };
  }

  return {
    get: async function <T>(key: string): Promise<T | undefined> {
      return adapter.get<T>(key);
    },
    set: async function <T>(key: string, value: T): Promise<void> {
      await adapter.set<T>(key, value);
    },
  };
}

function normalizeVerifierDecision(
  decision: boolean | ToolVerifierDecision | undefined
): { allow: boolean; reason?: string } {
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

function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, currentValue) => {
      if (typeof currentValue === 'object' && currentValue !== null) {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }
      return currentValue;
    });
  } catch {
    return String(value);
  }
}

function buildInjectionMatcher(config?: AgentLogicSafetyConfig): {
  enabled: boolean;
  reason: string;
  patterns: RegExp[];
} {
  const guard = config?.injectionGuard;
  if (!guard || guard.enabled === false) {
    return {
      enabled: false,
      reason: '',
      patterns: [],
    };
  }

  const patterns =
    guard.patterns && guard.patterns.length > 0
      ? guard.patterns.map((pattern) =>
          pattern instanceof RegExp ? pattern : new RegExp(escapeRegExp(pattern), 'i')
        )
      : DEFAULT_INJECTION_PATTERNS;

  return {
    enabled: true,
    reason: guard.reason ?? 'Potential prompt/tool injection pattern detected',
    patterns,
  };
}

function matchesTerminalAction(
  context: ToolCallVerifierContext,
  config?: AgentLogicSafetyConfig['exitCondition']
): boolean {
  const terminalActions = config?.terminalActions ?? [];
  if (terminalActions.length === 0 || !context.action) {
    return false;
  }

  return terminalActions.some((terminalAction) => {
    const toolPattern = terminalAction.toolNamePattern ?? '*';
    if (!matchPattern(context.toolName, toolPattern)) {
      return false;
    }
    return context.action?.startsWith(terminalAction.actionPrefix) === true;
  });
}

function buildIntentAllowlistPolicyRules(config?: AgentLogicSafetyConfig): ToolPolicyRule[] {
  const allowlist = config?.intentAllowlist;
  if (!allowlist || allowlist.enabled === false || allowlist.rules.length === 0) {
    return [];
  }

  const allowRules: ToolPolicyRule[] = allowlist.rules.map((rule, index) => ({
    id: rule.id ?? `agent_logic_allow_${index + 1}`,
    action: 'allow',
    tools: [rule.toolNamePattern],
    actionPrefixes: rule.actionPrefixes,
    destinations: rule.destinations,
    reason: rule.reason,
  }));

  const fallbackDeny: ToolPolicyRule = {
    id: 'agent_logic_deny_unlisted',
    action: 'deny',
    tools: ['*'],
    reason: allowlist.denyReason ?? 'Tool call is not in the configured intent allowlist',
  };

  return [...allowRules, fallbackDeny];
}

function mergeBeforeCallVerifiers(
  baseBeforeCall: ToolCallVerifier | undefined,
  safetyBeforeCall: ToolCallVerifier
): ToolCallVerifier {
  return async (context) => {
    if (baseBeforeCall) {
      const baseDecision = normalizeVerifierDecision(await baseBeforeCall(context));
      if (!baseDecision.allow) {
        return baseDecision;
      }
    }

    return safetyBeforeCall(context);
  };
}

/**
 * Applies an agent-logic safety layer on top of RuntimeControls config.
 *
 * This layer is intentionally separate from core runtime controls internals.
 * It composes through before-call verifiers and policy rules.
 */
export function applyAgentLogicSafety(
  baseConfig: ToolRuntimeControlsConfig = {},
  safetyConfig: AgentLogicSafetyConfig
): ToolRuntimeControlsConfig {
  const injectionMatcher = buildInjectionMatcher(safetyConfig);

  const exitConditionEnabled = safetyConfig.exitCondition?.enabled === true;
  const maxStepsPerRun = Math.max(
    1,
    Math.round((safetyConfig.exitCondition?.maxStepsPerRun ?? 30))
  );
  const blockAfterTerminal = safetyConfig.exitCondition?.blockAfterTerminal ?? true;
  const exitStateStore = createStateStore(safetyConfig.exitCondition?.stateAdapter);

  const safetyBeforeCall: ToolCallVerifier = async (context) => {
    if (injectionMatcher.enabled) {
      const candidate = [
        context.toolName,
        context.action ?? '',
        context.destination ?? '',
        safeSerialize(context.args),
      ].join('\n');

      const matched = injectionMatcher.patterns.find((pattern) => pattern.test(candidate));
      if (matched) {
        return {
          allow: false,
          reason: `${injectionMatcher.reason} (matched: ${matched.source})`,
        };
      }
    }

    if (exitConditionEnabled) {
      const runKey = normalizeRunKey(context.runKey);
      const stateKey = `agent_logic_exit:${runKey}`;
      const state =
        (await exitStateStore.get<ExitConditionState>(stateKey)) ?? {
          steps: 0,
          terminalReached: false,
        };

      if (state.terminalReached && blockAfterTerminal) {
        return {
          allow: false,
          reason: 'Run already reached terminal action; further tool calls are blocked',
        };
      }

      const nextSteps = state.steps + 1;
      const terminalReached = state.terminalReached || matchesTerminalAction(context, safetyConfig.exitCondition);

      await exitStateStore.set(stateKey, {
        steps: nextSteps,
        terminalReached,
      });

      if (!terminalReached && nextSteps > maxStepsPerRun) {
        return {
          allow: false,
          reason: `Exit condition not reached within ${maxStepsPerRun} tool calls`,
        };
      }
    }

    return { allow: true };
  };

  const allowlistPolicyRules = buildIntentAllowlistPolicyRules(safetyConfig);
  const allowlistPolicyEnabled = allowlistPolicyRules.length > 0;

  return {
    ...baseConfig,
    verifiers: {
      ...baseConfig.verifiers,
      beforeCall: mergeBeforeCallVerifiers(baseConfig.verifiers?.beforeCall, safetyBeforeCall),
    },
    policy: allowlistPolicyEnabled
      ? {
          enabled: true,
          mode: baseConfig.policy?.mode ?? 'enforce',
          approvalHandler: baseConfig.policy?.approvalHandler,
          rules: [...allowlistPolicyRules, ...(baseConfig.policy?.rules ?? [])],
        }
      : baseConfig.policy,
  };
}
