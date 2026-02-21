# Runtime Controls

This is the single runtime-controls document for the SDK.

## What Are We Guarding?

Runtime controls guard **tool calls that cause real side effects**.

In the PR bot + bug bounty workflow, these are the guarded operations:

| Tool | Action | Real operation being guarded |
|---|---|---|
| `cpu-sandbox` | `run_baseline_tests` | Run generated code tests (for example `npm test` or `pytest`) |
| `repo-write` | `push_commit` | Push code to remote (`git push origin ai-fix-123`) |
| `pr-comment` | `post_comment` | Post PR comments via SCM API |
| `ticket-write` | `create_ticket` | Create external bug-bounty/security ticket |
| `repo-admin` | `delete_*` | Destructive repo operations (delete branch/repo) |
| `ci-metadata` | `read_metadata` | Repeated CI metadata reads |

If you do not wrap these calls, the agent can loop, retry forever, duplicate writes, or run unsafe actions.

## Copy/Paste: Explicit Guarded Commands

This is a concrete example with explicit commands and side effects.

```ts
import { RuntimeControls } from 'buildfunctions'
import { execa } from 'execa'

const controls = RuntimeControls.create({
  tenantKey: 'pr-bot-prod',
  timeoutMs: 45_000,
  maxToolCalls: 20,
  retry: { maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 10_000, backoffFactor: 2, jitterRatio: 0.2 },
  policy: {
    rules: [
      {
        id: 'deny-destructive-repo-actions',
        action: 'deny',
        tools: ['repo-admin'],
        actionPrefixes: ['delete'],
        reason: 'Destructive repo operations are blocked',
      },
      {
        id: 'approval-for-external-ticket-write',
        action: 'require_approval',
        tools: ['ticket-write'],
        destinations: ['*.external.localhost'],
        reason: 'External writes require human approval',
      },
    ],
    approvalHandler: async () => false,
  },
  concurrency: { enabled: true, waitMode: 'reject', leaseMs: 30_000 },
})

const guardedShell = controls.wrap({
  toolName: 'cpu-sandbox',
  runKey: 'pr-4821',
  action: 'run_baseline_tests',
  destination: 'sandbox.localhost',
  idempotencyKey: 'baseline:pr-4821:v1',
  run: async ([command], { signal }) => {
    // Actual command being guarded
    const result = await execa(command, { shell: true, reject: false, signal })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  },
})

const guardedPush = controls.wrap({
  toolName: 'repo-write',
  runKey: 'pr-4821',
  action: 'push_commit',
  destination: 'repo.localhost',
  resourceKey: 'repo:acme/web-app',
  run: async ([branch], { signal }) => {
    // Actual side effect being guarded
    return execa(`git push origin ${branch}`, { shell: true, signal })
  },
})

// Explicit guarded calls
await guardedShell('npm test')
await guardedPush('ai-fix-4821')
```

## What Each Control Actually Limits

| Control | What it limits in practice |
|---|---|
| `timeoutMs` | Stops long-running commands (for example hung test runs). |
| `retry` + `retryClassifier` | Retries transient failures (`503`, `429`) but not invalid requests. |
| `maxToolCalls` | Hard cap on tool-call count per `runKey` (not a provider billing meter). |
| `loopBreaker` | Stops repeated no-progress calls with same inputs/outcome. |
| `circuitBreaker` | Temporarily blocks calls to failing dependency destination. |
| `policy` | Blocks unsafe actions and enforces human approval gates. |
| `idempotency` | Prevents duplicate side effects (for example duplicate PR comments/tickets). |
| `concurrency` | Prevents simultaneous conflicting writes to same resource. |
| `verifiers` | Rejects bad inputs/results/errors with your own correctness rules. |
| `overrides` | Applies stricter/looser controls to specific tools/destinations. |
| `state` adapters | Persists guardrail state across processes/instances. |

## Agent Logic Safety Layer (Injection + Exit + Intent)

Use the helper below to add agent-logic checks without changing `RuntimeControls` internals.

```ts
import { RuntimeControls, applyAgentLogicSafety } from 'buildfunctions'

const controls = RuntimeControls.create(
  applyAgentLogicSafety(
    {
      tenantKey: 'pr-bot-prod',
      retry: { maxAttempts: 2 },
    },
    {
      injectionGuard: {
        enabled: true,
        patterns: [/ignore\\s+previous\\s+instructions/i],
      },
      exitCondition: {
        enabled: true,
        maxStepsPerRun: 30,
        terminalActions: [{ toolNamePattern: 'agent-control', actionPrefix: 'finish' }],
        blockAfterTerminal: true,
      },
      intentAllowlist: {
        enabled: true,
        rules: [
          { toolNamePattern: 'cpu-sandbox', actionPrefixes: ['run_baseline_tests'] },
          { toolNamePattern: 'repo-write', actionPrefixes: ['push_'] },
          { toolNamePattern: 'pr-comment', actionPrefixes: ['post_'] },
        ],
      },
    }
  )
)
```

What this adds:

- injection-like payload rejection before tool execution
- mandatory exit-condition enforcement (max steps + terminal action expectations)
- tool-intent allowlist enforcement through policy

## Behavior Coverage Matrix

Runtime-controls behavior is covered by the runtime-controls suite:

| Scenario | Guardrail triggered | Source file |
|---|---|---|
| Wrap / run / reset API surface | context propagation + runKey reset behavior | `tests/examples/runtime-controls/api-surface.js` |
| Docs wrapper and agent-safety examples | wrapper flow + injection guard rejection | `tests/examples/runtime-controls/docs-examples.js` |
| Retry and cancellation behavior | retry classifier + timeout/cancel paths | `tests/examples/runtime-controls/timeout-cancel-retry.js` |
| Tool-call budget behavior | `budget_stop` and runKey/tenant scoping | `tests/examples/runtime-controls/budget.js` |
| Loop protection behavior | `loop_warning`, `loop_quarantine`, `loop_stop` | `tests/examples/runtime-controls/loop-breaker.js` |
| Circuit behavior | `circuit_open` and destination isolation | `tests/examples/runtime-controls/circuit-breaker.js` |
| Policy behavior | `policy_denied`, approval, dry-run precedence | `tests/examples/runtime-controls/policy.js` |
| Idempotency and concurrency behavior | `idempotency_replay`, `concurrency_wait`, `concurrency_rejected` | `tests/examples/runtime-controls/verifiers-idempotency-concurrency.js` |
| Observability behavior | event sinks + sink failure handling | `tests/examples/runtime-controls/observability.js` |
| Agent-logic safety behavior | injection + exit-condition + intent allowlist | `tests/examples/runtime-controls/agent-logic-safety.js` |

## Full Configuration Reference (All Knobs)

Defaults are from `src/runtime-controls/index.ts`.

| Config | Default | What it controls |
|---|---|---|
| `tenantKey` | `"default"` | Namespace for runtime state keys |
| `timeoutMs` | `60000` | Per-call timeout (`0` disables timeout) |
| `maxToolCalls` | unset | Per-`runKey` call budget |
| `retry.maxAttempts` | `4` | Total attempts including first |
| `retry.initialDelayMs` | `250` | Backoff base delay |
| `retry.maxDelayMs` | `10000` | Backoff cap |
| `retry.backoffFactor` | `2` | Exponential multiplier |
| `retry.jitterRatio` | `0.2` | Delay jitter `0..1` |
| `retryClassifier` | unset | Custom retry decision / delay override |
| `loopBreaker.enabled` | `true` | Enables repeated-pattern protection |
| `loopBreaker.warningThreshold` | `5` | Emits `loop_warning` |
| `loopBreaker.quarantineThreshold` | `8` | Emits `loop_quarantine` and blocks for `quarantineMs` |
| `loopBreaker.stopThreshold` | `12` | Emits `loop_stop` and blocks for `stopCooldownMs` |
| `loopBreaker.quarantineMs` | `15000` | Quarantine duration |
| `loopBreaker.stopCooldownMs` | `120000` | Stop duration |
| `loopBreaker.maxFingerprints` | `200` | Max loop fingerprints retained |
| `circuitBreaker.enabled` | `true` | Enables dependency circuit protection |
| `circuitBreaker.windowMs` | `30000` | Sliding failure window |
| `circuitBreaker.minRequests` | `20` | Requests required before open decision |
| `circuitBreaker.failureRateThreshold` | `0.6` | Open when `failureRate >= threshold` |
| `circuitBreaker.cooldownMs` | `60000` | Open duration |
| `policy.enabled` | `true` | Enables rule enforcement/simulation |
| `policy.mode` | `"enforce"` | `"dryRun"` emits simulation events only |
| `policy.rules` | `[]` | Rule list (`allow`/`deny`/`require_approval`) |
| `policy.approvalHandler` | unset | Required for enforced `require_approval` |
| `verifiers.beforeCall` | unset | Reject before execution |
| `verifiers.afterSuccess` | unset | Reject result after success |
| `verifiers.afterError` | unset | Transform/reject normalized errors |
| `idempotency.enabled` | `true` | Enables replay by `idempotencyKey` |
| `idempotency.ttlMs` | unset | Replay record expiration |
| `idempotency.includeErrors` | `false` | Replay final errors when enabled |
| `idempotency.namespaceByRunKey` | `true` | Scope replay by run key |
| `concurrency.enabled` | `false` | Enables locking by `resourceKey` |
| `concurrency.leaseMs` | `30000` | Lock lease |
| `concurrency.waitMode` | `"reject"` | `reject` immediately or `wait` |
| `concurrency.waitTimeoutMs` | `5000` | Wait timeout in `wait` mode |
| `concurrency.pollIntervalMs` | `50` | Poll interval in `wait` mode |
| `overrides.tools` | unset | Per-tool timeout/retry/loop/circuit overrides |
| `overrides.destinations` | unset | Per-destination timeout/retry/loop/circuit overrides |
| `state.loop` | in-memory | Loop state adapter |
| `state.circuit` | in-memory | Circuit state adapter |
| `state.budget` | in-memory | Budget state adapter |
| `state.lock` | in-memory | Lock state adapter |
| `state.idempotency` | in-memory | Idempotency state adapter |
| `onEvent` | unset | Main event callback |
| `eventSinks` | `[]` | Async event fan-out sinks |
| `onEventSinkFailure` | unset | Sink failure hook |

## Policy and Override Precedence

### Policy rule winner

Order used to select matching rule:

1. higher `tools` specificity
2. higher `destinations` specificity
3. longer `actionPrefixes` match
4. stricter action (`deny` > `require_approval` > `allow`)
5. earlier rule index on exact tie (current behavior)

### Override merge order

1. destination override applies first
2. tool override applies second

Tool override wins when both set same field.

## Runtime Events

| Event | Meaning |
|---|---|
| `retry` | A retry attempt was scheduled |
| `loop_warning` | Repeated no-progress pattern warning |
| `loop_quarantine` | Pattern quarantined |
| `loop_stop` | Pattern hard-stopped |
| `circuit_open` | Dependency circuit opened |
| `budget_stop` | Run budget exceeded |
| `policy_denied` | Policy denied a call |
| `policy_approval_required` | Approval required by policy |
| `policy_approved` | Approval granted |
| `policy_dry_run` | Simulated policy decision (dry-run mode) |
| `verifier_rejected` | Verifier rejected call/result/error |
| `idempotency_replay` | Prior result/error replayed |
| `concurrency_wait` | Waiting on resource lock |
| `concurrency_rejected` | Lock rejected or wait timeout |

## Examples and Test Locations

Runtime-controls examples and tests:

- `tests/examples/runtime-controls/index.js` — test suite entry point
- `tests/examples/runtime-controls/api-surface.js` — core API (run/wrap/reset)
- `tests/examples/runtime-controls/agent-logic-safety.js` — injection + exit + intent allowlist
- `tests/examples/runtime-controls/pre-execution/injection-guard.js` — live injection-guard + real CPU sandbox
- `tests/examples/runtime-controls/pre-execution/exit-condition.js` — live exit-condition + real CPU sandbox
- `tests/examples/runtime-controls/pre-execution/intent-allowlist.js` — live intent-allowlist + real CPU sandbox

Run commands:

```bash
node tests/dist/runtime-controls/index.js
node tests/examples/runtime-controls/index.js
node tests/live/runtime-controls/index.js

# Optional live pre-execution tests (require BUILDFUNCTIONS_API_TOKEN)
node tests/live/runtime-controls/pre-execution/injection-guard.js
node tests/live/runtime-controls/pre-execution/exit-condition.js
node tests/live/runtime-controls/pre-execution/intent-allowlist.js
```

## FAQ

### Do I need Buildfunctions API token to use RuntimeControls?

No. Wrapper mode works without `apiToken`.

### What should I wrap first?

Wrap side-effecting calls first:

1. repo writes
2. external ticket creation
3. sandbox/test execution
4. PR comments

### What should be denied by default?

Start by denying destructive actions (`delete*`) and requiring approval for external writes.
