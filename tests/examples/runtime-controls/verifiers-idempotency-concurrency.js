import { RuntimeControls } from '../../../dist/index.js';
import { assertFields, assertEqual, assertOk, assertDeepEqual, assertRejects, waitWithAbort, sleep } from './helpers.js';
async function main() {
  // --- before-call verifier can reject tool invocation ---
  console.log('test: before-call verifier can reject tool invocation');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      verifiers: {
        beforeCall: () => ({ allow: false, reason: 'manual gate failed' }),
      },
      onEvent,
    });

    await assertRejects(
      () => controls.run({ toolName: 'shell', action: 'exec' }, async () => 'never'),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'verifier rejected tool call',
        })
    );

    const rejected = events.find((event) => event.type === 'verifier_rejected');
    assertOk(rejected);
    assertEqual(rejected.details?.phase, 'before_call');
  }
  console.log('pass\n');

  // --- after-success verifier can reject result without retrying ---
  console.log('test: after-success verifier can reject result without retrying');
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
      verifiers: {
        afterSuccess: () => ({ allow: false, reason: 'result shape invalid' }),
      },
    });

    await assertRejects(
      () =>
        controls.run({ toolName: 'result-tool' }, async () => {
          attempts += 1;
          return { ok: true };
        }),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'verifier rejected tool result',
        })
    );

    assertEqual(attempts, 1);
  }
  console.log('pass\n');

  // --- idempotency replays successful result without re-executing tool ---
  console.log('test: idempotency replays successful result without re-executing tool');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    let calls = 0;
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      idempotency: { enabled: true },
      onEvent,
    });

    const context = {
      toolName: 'ticket-create',
      runKey: 'run-idem-1',
      idempotencyKey: 'ticket-77',
    };

    const first = await controls.run(context, async () => {
      calls += 1;
      return { ticketId: 'OPS-77' };
    });

    const second = await controls.run(context, async () => {
      calls += 1;
      return { ticketId: 'OPS-should-not-happen' };
    });

    assertDeepEqual(first, { ticketId: 'OPS-77' });
    assertDeepEqual(second, { ticketId: 'OPS-77' });
    assertEqual(calls, 1);
    assertEqual(events.filter((event) => event.type === 'idempotency_replay').length, 1);
  }
  console.log('pass\n');

  // --- idempotency can replay final errors when includeErrors is enabled ---
  console.log('test: idempotency can replay final errors when includeErrors is enabled');
  {
    let calls = 0;

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      idempotency: {
        enabled: true,
        includeErrors: true,
      },
    });

    const context = {
      toolName: 'provider-call',
      runKey: 'run-idem-2',
      idempotencyKey: 'provider-op-42',
    };

    await assertRejects(
      () =>
        controls.run(context, async () => {
          calls += 1;
          throw Object.assign(new Error('provider down'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR', statusCode: 503 })
    );

    await assertRejects(
      () =>
        controls.run(context, async () => {
          calls += 1;
          throw Object.assign(new Error('should not execute'), { code: 'UNKNOWN_ERROR', statusCode: 500 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR', statusCode: 503 })
    );

    assertEqual(calls, 1);
  }
  console.log('pass\n');

  // --- idempotency record expires when ttlMs elapses ---
  console.log('test: idempotency record expires when ttlMs elapses');
  {
    let calls = 0;

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      idempotency: {
        enabled: true,
        ttlMs: 20,
      },
    });

    const context = {
      toolName: 'ttl-tool',
      runKey: 'run-idem-ttl',
      idempotencyKey: 'same-op',
    };

    const first = await controls.run(context, async () => {
      calls += 1;
      return `result-${calls}`;
    });

    await sleep(30);

    const second = await controls.run(context, async () => {
      calls += 1;
      return `result-${calls}`;
    });

    assertEqual(first, 'result-1');
    assertEqual(second, 'result-2');
    assertEqual(calls, 2);
  }
  console.log('pass\n');

  // --- concurrency reject mode blocks simultaneous access to same resource ---
  console.log('test: concurrency reject mode blocks simultaneous access to same resource');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      concurrency: {
        enabled: true,
        waitMode: 'reject',
        leaseMs: 500,
      },
      onEvent,
    });

    const first = controls.run(
      {
        toolName: 'repo-write',
        resourceKey: 'repo:buildfunctions/sdk-night-agent',
      },
      async ({ signal }) => {
        await waitWithAbort(60, signal);
        return 'first-done';
      }
    );

    await sleep(10);

    await assertRejects(
      () =>
        controls.run(
          {
            toolName: 'repo-write',
            resourceKey: 'repo:buildfunctions/sdk-night-agent',
          },
          async () => 'second-done'
        ),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'concurrency lock',
        })
    );

    const firstResult = await first;
    assertEqual(firstResult, 'first-done');
    assertEqual(events.filter((event) => event.type === 'concurrency_rejected').length, 1);
  }
  console.log('pass\n');

  // --- concurrency wait mode serializes conflicting calls ---
  console.log('test: concurrency wait mode serializes conflicting calls');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      concurrency: {
        enabled: true,
        waitMode: 'wait',
        waitTimeoutMs: 300,
        pollIntervalMs: 10,
        leaseMs: 500,
      },
    });

    const sequence = [];

    const first = controls.run(
      {
        toolName: 'repo-write',
        resourceKey: 'repo:buildfunctions/sdk-night-agent',
      },
      async ({ signal }) => {
        sequence.push('first-start');
        await waitWithAbort(60, signal);
        sequence.push('first-end');
        return 'first';
      }
    );

    await sleep(5);

    const second = controls.run(
      {
        toolName: 'repo-write',
        resourceKey: 'repo:buildfunctions/sdk-night-agent',
      },
      async () => {
        sequence.push('second-start');
        return 'second';
      }
    );

    const firstResult = await first;
    const secondResult = await second;

    assertEqual(firstResult, 'first');
    assertEqual(secondResult, 'second');
    assertDeepEqual(sequence, ['first-start', 'first-end', 'second-start']);
  }
  console.log('pass\n');

  // --- concurrency wait mode times out when lock is not released in time ---
  console.log('test: concurrency wait mode times out when lock is not released in time');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      concurrency: {
        enabled: true,
        waitMode: 'wait',
        waitTimeoutMs: 30,
        pollIntervalMs: 10,
        leaseMs: 500,
      },
      onEvent,
    });

    const first = controls.run(
      {
        toolName: 'db-write',
        resourceKey: 'db:tenant-1',
      },
      async ({ signal }) => {
        await waitWithAbort(80, signal);
        return 'first';
      }
    );

    await sleep(5);

    await assertRejects(
      () =>
        controls.run(
          {
            toolName: 'db-write',
            resourceKey: 'db:tenant-1',
          },
          async () => 'second'
        ),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'lock wait timeout',
        })
    );

    await first;

    assertEqual(events.filter((event) => event.type === 'concurrency_wait').length, 1);
    assertEqual(events.filter((event) => event.type === 'concurrency_rejected').length, 1);
  }
  console.log('pass\n');

  // --- wrap resolves idempotencyKey and resourceKey from arguments ---
  console.log('test: wrap resolves idempotencyKey and resourceKey from arguments');
  {
    let calls = 0;

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      idempotency: { enabled: true },
      concurrency: { enabled: true, waitMode: 'reject', leaseMs: 500 },
    });

    const wrapped = controls.wrap({
      toolName: 'ticket-write',
      resolveRunKey: (input) => input.runKey,
      resolveIdempotencyKey: (input) => input.idempotencyKey,
      resolveResourceKey: (input) => input.resourceKey,
      run: async ([input], { signal }) => {
        calls += 1;
        await waitWithAbort(5, signal);
        return { id: `ticket-${input.idempotencyKey}` };
      },
    });

    const input = {
      runKey: 'wrap-run',
      idempotencyKey: '777',
      resourceKey: 'ticket:777',
    };

    const first = await wrapped(input);
    const second = await wrapped(input);

    assertDeepEqual(first, { id: 'ticket-777' });
    assertDeepEqual(second, { id: 'ticket-777' });
    assertEqual(calls, 1);
  }
  console.log('pass\n');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
