import { RuntimeControls } from '../../../dist/index.js';
import { assertFields, assertEqual, assertOk, assertRejects, waitWithAbort } from './helpers.js';
async function main() {
  // --- timeout converts to NETWORK_ERROR and surfaces timed-out message ---
  console.log('Test: timeout converts to NETWORK_ERROR and surfaces timed-out message');
  {
    const controls = RuntimeControls.create({
      timeoutMs: 10,
      retry: { maxAttempts: 1 },
    });

    await assertRejects(
      () =>
        controls.run({ toolName: 'slow-tool' }, async ({ signal }) => {
          await waitWithAbort(40, signal);
          return 'never';
        }),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'timed out',
        })
    );
  }
  console.log('  PASSED');

  // --- caller cancellation does not retry and maps to NETWORK_ERROR ---
  console.log('Test: caller cancellation does not retry and maps to NETWORK_ERROR');
  {
    let attempts = 0;
    const controls = RuntimeControls.create({
      timeoutMs: 200,
      retry: {
        maxAttempts: 4,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
    });

    const controller = new AbortController();

    await assertRejects(
      () =>
        controls.run({ toolName: 'cancelled-tool', signal: controller.signal }, async ({ signal }) => {
          attempts += 1;
          setTimeout(() => controller.abort(new Error('user-cancelled')), 5);
          await waitWithAbort(50, signal);
          return 'never';
        }),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'cancelled',
        })
    );

    assertEqual(attempts, 1);
  }
  console.log('  PASSED');

  // --- default retry policy retries retryable status codes and emits retry events ---
  console.log('Test: default retry policy retries retryable status codes and emits retry events');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    let attempts = 0;
    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
      onEvent,
    });

    const result = await controls.run({ toolName: 'provider-call' }, async () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error('provider unavailable'), { code: 'NETWORK_ERROR', statusCode: 503 });
      }
      return 'ok';
    });

    assertEqual(result, 'ok');
    assertEqual(attempts, 3);
    assertEqual(events.filter((event) => event.type === 'retry').length, 2);
  }
  console.log('  PASSED');

  // --- fatal buildfunctions errors do not retry ---
  console.log('Test: fatal buildfunctions errors do not retry');
  {
    let attempts = 0;
    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
    });

    await assertRejects(
      () =>
        controls.run({ toolName: 'validation-tool' }, async () => {
          attempts += 1;
          throw Object.assign(new Error('bad input'), { code: 'VALIDATION_ERROR', statusCode: 400 });
        }),
      (error) => assertFields(error, { code: 'VALIDATION_ERROR', statusCode: 400 })
    );

    assertEqual(attempts, 1);
  }
  console.log('  PASSED');

  // --- retryClassifier boolean return can suppress retries ---
  console.log('Test: retryClassifier boolean return can suppress retries');
  {
    let attempts = 0;
    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 3,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
      retryClassifier: () => false,
    });

    await assertRejects(
      () =>
        controls.run({ toolName: 'classifier-tool' }, async () => {
          attempts += 1;
          throw Object.assign(new Error('temporary outage'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR', statusCode: 503 })
    );

    assertEqual(attempts, 1);
  }
  console.log('  PASSED');

  // --- retryClassifier decision object can force retry with custom delay and reason ---
  console.log('Test: retryClassifier decision object can force retry with custom delay and reason');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    let attempts = 0;
    const seenClassifierInput = [];

    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 2,
        initialDelayMs: 100,
        maxDelayMs: 100,
        backoffFactor: 1,
        jitterRatio: 0,
      },
      retryClassifier: (ctx) => {
        seenClassifierInput.push(ctx);
        if (ctx.attempt === 1 && ctx.error.code === 'UNKNOWN_ERROR') {
          return { retryable: true, delayMs: 0, reason: 'force-once' };
        }
        return { retryable: false };
      },
      onEvent,
    });

    const result = await controls.run(
      {
        toolName: 'parser-tool',
        destination: 'https://api.parse.localhost/v1',
        action: 'parse_payload',
      },
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('parse explosion');
        }
        return 'ok';
      }
    );

    assertEqual(result, 'ok');
    assertEqual(attempts, 2);

    assertEqual(seenClassifierInput.length, 1);
    assertEqual(seenClassifierInput[0].toolName, 'parser-tool');
    assertEqual(seenClassifierInput[0].destination, 'https://api.parse.localhost/v1');
    assertEqual(seenClassifierInput[0].action, 'parse_payload');
    assertEqual(seenClassifierInput[0].attempt, 1);

    const retryEvent = events.find((event) => event.type === 'retry');
    assertOk(retryEvent);
    assertEqual(retryEvent.details?.delayMs, 0);
    assertEqual(retryEvent.details?.classifierReason, 'force-once');
  }
  console.log('  PASSED');

  console.log('\nAll timeout-cancel-retry tests passed!');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
