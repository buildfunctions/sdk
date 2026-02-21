import { RuntimeControls } from '../../../dist/index.js';
import { assertFields, assertEqual, assertOk, assertRejects, sleep } from './helpers.js';
async function main() {
  // --- config values above max are clamped (e.g. circuit failureRateThreshold > 1) ---
  console.log('test: config values above max are clamped (e.g. circuit failureRateThreshold > 1)');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      circuitBreaker: {
        enabled: true,
        windowMs: 1000,
        minRequests: 1,
        failureRateThreshold: 9,
        cooldownMs: 80,
      },
      onEvent,
    });

    await assertRejects(
      () =>
        controls.run({ toolName: 'http', destination: 'clamp.localhost' }, async () => {
          throw Object.assign(new Error('down'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR' })
    );

    assertEqual(events.filter((event) => event.type === 'circuit_open').length, 1);
  }
  console.log('  passed');

  // --- circular args do not crash fingerprint hashing fallback path ---
  console.log('test: circular args do not crash fingerprint hashing fallback path');
  {
    const events = [];
    const onEvent = (event) => events.push(event);
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      loopBreaker: {
        warningThreshold: 2,
        quarantineThreshold: 99,
        stopThreshold: 99,
        maxFingerprints: 200,
      },
      onEvent,
    });

    const circular = {};
    circular.self = circular;

    await controls.run({ toolName: 'hash-tool', args: circular }, async () => 'same');
    await controls.run({ toolName: 'hash-tool', args: circular }, async () => 'same');

    assertEqual(events.filter((event) => event.type === 'loop_warning').length, 1);
  }
  console.log('  passed');

  // --- retry backoff jitter path is used when jitterRatio > 0 ---
  console.log('test: retry backoff jitter path is used when jitterRatio > 0');
  {
    const events = [];
    const onEvent = (event) => events.push(event);
    let attempts = 0;

    const originalRandom = Math.random;
    Math.random = () => 1;

    try {
      const controls = RuntimeControls.create({
        retry: {
          maxAttempts: 2,
          initialDelayMs: 10,
          maxDelayMs: 10,
          backoffFactor: 1,
          jitterRatio: 0.5,
        },
        onEvent,
      });

      const result = await controls.run({ toolName: 'jitter-tool' }, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('temporary'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }
        return 'ok';
      });

      assertEqual(result, 'ok');
      assertEqual(attempts, 2);

      const retryEvent = events.find((event) => event.type === 'retry');
      assertOk(retryEvent);
      assertEqual(retryEvent.details?.delayMs, 15);
    } finally {
      Math.random = originalRandom;
    }
  }
  console.log('  passed');

  // --- pre-aborted caller signal short-circuits execution ---
  console.log('test: pre-aborted caller signal short-circuits execution');
  {
    const controls = RuntimeControls.create({ retry: { maxAttempts: 1 } });
    const controller = new AbortController();
    controller.abort(new Error('already-aborted'));

    let executed = false;

    await assertRejects(
      () =>
        controls.run({ toolName: 'pre-aborted', signal: controller.signal }, async () => {
          executed = true;
          return 'never';
        }),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'cancelled',
        })
    );

    assertEqual(executed, false);
  }
  console.log('  passed');

  // --- aborting during an in-flight call rejects, even if execute resolves later ---
  console.log('test: aborting during an in-flight call rejects, even if execute resolves later');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
    });

    const controller = new AbortController();

    await assertRejects(
      () =>
        controls.run({ toolName: 'abort-race', signal: controller.signal }, async () => {
          setTimeout(() => controller.abort(new Error('cancel')), 5);
          return new Promise((resolve) => {
            setTimeout(() => resolve('late-success'), 30);
          });
        }),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'cancelled',
        })
    );

    await sleep(40);
  }
  console.log('  passed');

  // --- cancellation during retry delay maps to cancelled caller error ---
  console.log('test: cancellation during retry delay maps to cancelled caller error');
  {
    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 2,
        initialDelayMs: 25,
        maxDelayMs: 25,
        backoffFactor: 1,
        jitterRatio: 0,
      },
      retryClassifier: () => true,
    });

    const controller = new AbortController();
    let attempts = 0;

    await assertRejects(
      () =>
        controls.run({ toolName: 'retry-delay-cancel', signal: controller.signal }, async () => {
          attempts += 1;
          if (attempts === 1) {
            controller.abort(new Error('cancel-before-delay'));
          }
          throw Object.assign(new Error('temporary'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'cancelled',
        })
    );

    assertEqual(attempts, 1);
  }
  console.log('  passed');

  // --- status extraction supports statusCode/status/response.status shapes ---
  console.log('test: status extraction supports statusCode/status/response.status shapes');
  {
    const createControls = () =>
      RuntimeControls.create({
        retry: {
          maxAttempts: 2,
          initialDelayMs: 0,
          maxDelayMs: 0,
          backoffFactor: 1,
          jitterRatio: 0,
        },
      });

    const shapes = [
      { name: 'statusCode', value: { statusCode: 503 } },
      { name: 'status', value: { status: 503 } },
      { name: 'response.status', value: { response: { status: 503 } } },
    ];

    for (const shape of shapes) {
      let attempts = 0;
      const controls = createControls();

      const result = await controls.run({ toolName: `status-shape-${shape.name}` }, async () => {
        attempts += 1;
        if (attempts === 1) {
          throw shape.value;
        }
        return 'ok';
      });

      assertEqual(result, 'ok');
      assertEqual(attempts, 2);
    }
  }
  console.log('  passed');

  // --- non-Error throw normalizes to UNKNOWN_ERROR fallback ---
  console.log('test: non-Error throw normalizes to UNKNOWN_ERROR fallback');
  {
    const controls = RuntimeControls.create({ retry: { maxAttempts: 1 } });

    await assertRejects(
      () =>
        controls.run({ toolName: 'non-error' }, async () => {
          throw 42;
        }),
      (error) =>
        assertFields(error, {
          code: 'UNKNOWN_ERROR',
          messageIncludes: 'tool call failed',
        })
    );
  }
  console.log('  passed');

  // --- invalid retryClassifier return falls back to default decision ---
  console.log('test: invalid retryClassifier return falls back to default decision');
  {
    let attempts = 0;

    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
      retryClassifier: () => 'retry-maybe',
    });

    const result = await controls.run({ toolName: 'invalid-classifier' }, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('temporary'), { code: 'NETWORK_ERROR', statusCode: 503 });
      }
      return 'ok';
    });

    assertEqual(result, 'ok');
    assertEqual(attempts, 2);
  }
  console.log('  passed');

  // --- policy no-match branches allow execution when destination/action constraints are unmet ---
  console.log('test: policy no-match branches allow execution when destination/action constraints are unmet');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'needs-destination',
            action: 'deny',
            tools: ['shell'],
            destinations: ['api.secure.localhost'],
            reason: 'requires destination match',
          },
          {
            id: 'needs-prefix',
            action: 'deny',
            tools: ['shell'],
            actionPrefixes: ['delete'],
            reason: 'requires action prefix',
          },
        ],
      },
    });

    const noDestination = await controls.run({ toolName: 'shell' }, async () => 'ok-1');
    assertEqual(noDestination, 'ok-1');

    const destinationMismatch = await controls.run(
      { toolName: 'shell', destination: 'https://other.localhost/v1' },
      async () => 'ok-2'
    );
    assertEqual(destinationMismatch, 'ok-2');

    const noActionMatch = await controls.run(
      { toolName: 'shell', destination: 'https://other.localhost/v1', action: 'read_file' },
      async () => 'ok-3'
    );
    assertEqual(noActionMatch, 'ok-3');
  }
  console.log('  passed');

  // --- policy rule with non-matching tools is ignored ---
  console.log('test: policy rule with non-matching tools is ignored');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'http-only',
            action: 'deny',
            tools: ['http*'],
            reason: 'http tools denied',
          },
        ],
      },
    });

    const result = await controls.run({ toolName: 'shell' }, async () => 'ok');
    assertEqual(result, 'ok');
  }
  console.log('  passed');

  // --- policy destination specificity prefers exact destination over wildcard ---
  console.log('test: policy destination specificity prefers exact destination over wildcard');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'wildcard-destination',
            action: 'deny',
            tools: ['shell'],
            destinations: ['*.acme.localhost'],
            reason: 'wildcard-reason',
          },
          {
            id: 'exact-destination',
            action: 'deny',
            tools: ['shell'],
            destinations: ['api.acme.localhost'],
            reason: 'exact-reason',
          },
        ],
      },
    });

    await assertRejects(
      () => controls.run({ toolName: 'shell', destination: 'https://api.acme.localhost/v1' }, async () => 'never'),
      (error) =>
        assertFields(error, {
          code: 'UNAUTHORIZED',
          messageIncludes: 'exact-reason',
        })
    );
  }
  console.log('  passed');

  // --- policy exact tie currently resolves to earlier rule index ---
  console.log('test: policy exact tie currently resolves to earlier rule index');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'earlier',
            action: 'deny',
            tools: ['shell'],
            reason: 'earlier-reason',
          },
          {
            id: 'later',
            action: 'deny',
            tools: ['shell'],
            reason: 'later-reason',
          },
        ],
      },
    });

    await assertRejects(
      () => controls.run({ toolName: 'shell' }, async () => 'never'),
      (error) =>
        assertFields(error, {
          code: 'UNAUTHORIZED',
          messageIncludes: 'earlier-reason',
        })
    );
  }
  console.log('  passed');

  // --- loop breaker can be disabled ---
  console.log('test: loop breaker can be disabled');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      loopBreaker: {
        enabled: false,
        warningThreshold: 1,
        quarantineThreshold: 2,
        stopThreshold: 3,
        quarantineMs: 20,
        stopCooldownMs: 50,
        maxFingerprints: 20,
      },
      onEvent,
    });

    const context = {
      toolName: 'loop-disabled',
      args: { a: 1 },
    };

    for (let index = 0; index < 6; index += 1) {
      const result = await controls.run(context, async () => 'same-outcome');
      assertEqual(result, 'same-outcome');
    }

    const loopEvents = events.filter((event) => event.type.startsWith('loop_'));
    assertEqual(loopEvents.length, 0);
  }
  console.log('  passed');

  // --- loop pruning tolerates stale keys that resolve to undefined state ---
  console.log('test: loop pruning tolerates stale keys that resolve to undefined state');
  {
    const map = new Map();
    map.set('tenant-stale:loop:stale-only-key', undefined);

    const adapter = {
      get: (key) => map.get(key),
      set: (key, value) => {
        map.set(key, value);
      },
      delete: (key) => {
        map.delete(key);
      },
      keys: () => map.keys(),
    };

    const controls = RuntimeControls.create({
      tenantKey: 'tenant-stale',
      retry: { maxAttempts: 1 },
      loopBreaker: {
        warningThreshold: 100,
        quarantineThreshold: 200,
        stopThreshold: 300,
        maxFingerprints: 20,
      },
      state: { loop: adapter },
    });

    for (let index = 0; index < 25; index += 1) {
      await controls.run(
        { toolName: 'stale-loop-tool', args: { index } },
        async () => `ok-${index}`
      );
    }

    const loopKeys = Array.from(map.keys()).filter((key) => key.startsWith('tenant-stale:loop:'));
    assertOk(loopKeys.length <= 21, `Expected stale+bounded keys, got ${loopKeys.length}`);
  }
  console.log('  passed');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
