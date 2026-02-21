import { RuntimeControls } from '../../../dist/index.js';
import { createMapAdapter, assertFields, assertEqual, assertOk, assertRejects } from './helpers.js';
async function main() {
  // --- loop breaker emits warning/quarantine and blocks while quarantine is active ---
  {
    console.log('loop breaker emits warning/quarantine and blocks while quarantine is active');

    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      loopBreaker: {
        warningThreshold: 2,
        quarantineThreshold: 3,
        stopThreshold: 10,
        quarantineMs: 80,
        stopCooldownMs: 500,
        maxFingerprints: 200,
      },
      onEvent,
    });

    const context = {
      toolName: 'fix-suggester',
      args: { runId: 'run-22', mode: 'auto' },
    };

    await controls.run(context, async () => 'same-outcome');
    await controls.run(context, async () => 'same-outcome');
    await controls.run(context, async () => 'same-outcome');

    assertEqual(events.filter((event) => event.type === 'loop_warning').length, 1);
    assertEqual(events.filter((event) => event.type === 'loop_quarantine').length, 1);

    await assertRejects(
      () => controls.run(context, async () => 'blocked'),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'quarantined',
        })
    );

    console.log('  passed');
  }

  // --- loop breaker stop threshold emits stop event and blocks subsequent calls ---
  {
    console.log('loop breaker stop threshold emits stop event and blocks subsequent calls');

    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      loopBreaker: {
        warningThreshold: 2,
        quarantineThreshold: 99,
        stopThreshold: 3,
        stopCooldownMs: 100,
        maxFingerprints: 200,
      },
      onEvent,
    });

    const context = {
      toolName: 'recommender',
      args: { id: 44 },
    };

    for (let index = 0; index < 3; index += 1) {
      await assertRejects(
        () =>
          controls.run(context, async () => {
            throw Object.assign(new Error('no progress'), { code: 'UNKNOWN_ERROR', statusCode: 422 });
          }),
        (error) => assertFields(error, { code: 'UNKNOWN_ERROR', statusCode: 422 })
      );
    }

    assertEqual(events.filter((event) => event.type === 'loop_stop').length, 1);

    await assertRejects(
      () => controls.run(context, async () => 'blocked'),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'loop breaker blocked',
        })
    );

    console.log('  passed');
  }

  // --- loop fingerprint uses stable argument hashing regardless of object key order ---
  {
    console.log('loop fingerprint uses stable argument hashing regardless of object key order');

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

    await controls.run(
      {
        toolName: 'http',
        args: { alpha: 1, beta: 2 },
      },
      async () => 'same'
    );

    await controls.run(
      {
        toolName: 'http',
        args: { beta: 2, alpha: 1 },
      },
      async () => 'same'
    );

    assertEqual(events.filter((event) => event.type === 'loop_warning').length, 1);

    console.log('  passed');
  }

  // --- loop state adapter persists streaks across controls instances ---
  {
    console.log('loop state adapter persists streaks across controls instances');

    const { adapter } = createMapAdapter();

    const first = RuntimeControls.create({
      tenantKey: 'tenant-loop',
      retry: { maxAttempts: 1 },
      loopBreaker: {
        warningThreshold: 2,
        quarantineThreshold: 99,
        stopThreshold: 99,
        maxFingerprints: 200,
      },
      state: { loop: adapter },
    });

    const events = [];
    const onEvent = (event) => events.push(event);

    const second = RuntimeControls.create({
      tenantKey: 'tenant-loop',
      retry: { maxAttempts: 1 },
      loopBreaker: {
        warningThreshold: 2,
        quarantineThreshold: 99,
        stopThreshold: 99,
        maxFingerprints: 200,
      },
      state: { loop: adapter },
      onEvent,
    });

    const context = {
      toolName: 'persisted-tool',
      args: { jobId: 'abc' },
    };

    await first.run(context, async () => 'same');
    await second.run(context, async () => 'same');

    assertEqual(events.filter((event) => event.type === 'loop_warning').length, 1);

    console.log('  passed');
  }

  // --- loop state pruning keeps fingerprint map bounded by maxFingerprints floor ---
  {
    console.log('loop state pruning keeps fingerprint map bounded by maxFingerprints floor');

    const { map, adapter } = createMapAdapter();

    const controls = RuntimeControls.create({
      tenantKey: 'tenant-prune',
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
        {
          toolName: 'fingerprinted-tool',
          args: { index },
        },
        async () => `ok-${index}`
      );
    }

    const loopKeys = Array.from(map.keys()).filter((key) => key.startsWith('tenant-prune:loop:'));
    assertOk(loopKeys.length <= 20, `Expected at most 20 loop keys, got ${loopKeys.length}`);

    console.log('  passed');
  }
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
