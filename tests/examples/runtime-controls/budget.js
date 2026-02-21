import { RuntimeControls } from '../../../dist/index.js';
import { createMapAdapter, assertFields, assertEqual, assertRejects } from './helpers.js';
async function main() {
  // --- maxToolCalls enforces per-run budget and reset clears it ---
  console.log('test: maxToolCalls enforces per-run budget and reset clears it');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      maxToolCalls: 2,
      retry: { maxAttempts: 1 },
      onEvent,
    });

    await controls.run({ toolName: 'shell', runKey: 'run-1' }, async () => 'ok-1');
    await controls.run({ toolName: 'shell', runKey: 'run-1' }, async () => 'ok-2');

    await assertRejects(
      () => controls.run({ toolName: 'shell', runKey: 'run-1' }, async () => 'blocked'),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'tool-call budget exceeded',
        })
    );

    assertEqual(events.filter((event) => event.type === 'budget_stop').length, 1);

    await controls.reset('run-1');
    const afterReset = await controls.run({ toolName: 'shell', runKey: 'run-1' }, async () => 'ok-3');
    assertEqual(afterReset, 'ok-3');
  }
  console.log('  passed');

  // --- budget counters are scoped by runKey ---
  console.log('test: budget counters are scoped by runKey');
  {
    const controls = RuntimeControls.create({
      maxToolCalls: 1,
      retry: { maxAttempts: 1 },
    });

    await controls.run({ toolName: 'ci', runKey: 'run-a' }, async () => 'a-1');
    await controls.run({ toolName: 'ci', runKey: 'run-b' }, async () => 'b-1');

    await assertRejects(
      () => controls.run({ toolName: 'ci', runKey: 'run-a' }, async () => 'a-2'),
      (error) => assertFields(error, { code: 'INVALID_REQUEST' })
    );

    await assertRejects(
      () => controls.run({ toolName: 'ci', runKey: 'run-b' }, async () => 'b-2'),
      (error) => assertFields(error, { code: 'INVALID_REQUEST' })
    );
  }
  console.log('  passed');

  // --- budget state adapter persists counters across controls instances ---
  console.log('test: budget state adapter persists counters across controls instances');
  {
    const { adapter } = createMapAdapter();

    const first = RuntimeControls.create({
      tenantKey: 'tenant-budget',
      maxToolCalls: 1,
      retry: { maxAttempts: 1 },
      state: { budget: adapter },
    });

    const second = RuntimeControls.create({
      tenantKey: 'tenant-budget',
      maxToolCalls: 1,
      retry: { maxAttempts: 1 },
      state: { budget: adapter },
    });

    await first.run({ toolName: 'shell', runKey: 'persisted-run' }, async () => 'ok');

    await assertRejects(
      () => second.run({ toolName: 'shell', runKey: 'persisted-run' }, async () => 'blocked'),
      (error) => assertFields(error, { code: 'INVALID_REQUEST' })
    );
  }
  console.log('  passed');

  // --- budget state is isolated by tenantKey when sharing adapter backend ---
  console.log('test: budget state is isolated by tenantKey when sharing adapter backend');
  {
    const { adapter } = createMapAdapter();

    const tenantA = RuntimeControls.create({
      tenantKey: 'tenant-a',
      maxToolCalls: 1,
      retry: { maxAttempts: 1 },
      state: { budget: adapter },
    });

    const tenantB = RuntimeControls.create({
      tenantKey: 'tenant-b',
      maxToolCalls: 1,
      retry: { maxAttempts: 1 },
      state: { budget: adapter },
    });

    await tenantA.run({ toolName: 'shell', runKey: 'same-run-key' }, async () => 'a-ok');
    const tenantBResult = await tenantB.run({ toolName: 'shell', runKey: 'same-run-key' }, async () => 'b-ok');

    assertEqual(tenantBResult, 'b-ok');
  }
  console.log('  passed');

  // --- reset only affects the selected runKey ---
  console.log('test: reset only affects the selected runKey');
  {
    const controls = RuntimeControls.create({
      maxToolCalls: 1,
      retry: { maxAttempts: 1 },
    });

    await controls.run({ toolName: 'tool', runKey: 'run-a' }, async () => 'a-1');
    await controls.run({ toolName: 'tool', runKey: 'run-b' }, async () => 'b-1');

    await controls.reset('run-a');

    const runAAfterReset = await controls.run({ toolName: 'tool', runKey: 'run-a' }, async () => 'a-2');
    assertEqual(runAAfterReset, 'a-2');

    await assertRejects(
      () => controls.run({ toolName: 'tool', runKey: 'run-b' }, async () => 'b-2'),
      (error) => assertFields(error, { code: 'INVALID_REQUEST' })
    );
  }
  console.log('  passed');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
