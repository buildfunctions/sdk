import { RuntimeControls } from '../../../dist/index.js';
import { assertFields, assertEqual, assertOk, assertDeepEqual, assertRejects } from './helpers.js';
async function main() {
  // --- run returns execute result and passes an AbortSignal ---
  console.log('test: run returns execute result and passes an AbortSignal');
  {
    const controls = RuntimeControls.create({ retry: { maxAttempts: 1 } });

    let receivedSignal;
    const result = await controls.run({ toolName: 'simple-tool' }, async ({ signal }) => {
      receivedSignal = signal;
      return 'ok';
    });

    assertEqual(result, 'ok');
    assertOk(receivedSignal instanceof AbortSignal);
    assertEqual(receivedSignal.aborted, false);
  }

  // --- wrap resolves run context from args and forwards args tuple ---
  console.log('test: wrap resolves run context from args and forwards args tuple');
  {
    const seen = [];
    const controls = RuntimeControls.create({ retry: { maxAttempts: 1 } });

    const wrapped = controls.wrap({
      toolName: 'http-fetch',
      resolveRunKey: (request) => `run-${request.id}`,
      resolveDestination: (request) => `https://${request.host}/v1/jobs`,
      resolveAction: (request) => `${request.method} ${request.path}`,
      run: async (args, { signal }) => {
        seen.push({
          argsLength: args.length,
          signalType: signal.constructor?.name,
          request: args[0],
        });
        return { ok: true, id: args[0].id };
      },
    });

    const request = {
      id: '1234',
      host: 'api.example.localhost',
      method: 'POST',
      path: '/tasks',
    };

    const result = await wrapped(request);

    assertDeepEqual(result, { ok: true, id: '1234' });
    assertEqual(seen.length, 1);
    assertEqual(seen[0].argsLength, 1);
    assertEqual(seen[0].signalType, 'AbortSignal');
    assertEqual(seen[0].request.host, 'api.example.localhost');
  }

  // --- reset clears the normalized default budget key ---
  console.log('test: reset clears the normalized default budget key');
  {
    const controls = RuntimeControls.create({
      maxToolCalls: 1,
      retry: { maxAttempts: 1 },
    });

    await controls.run({ toolName: 'default-budget-tool', runKey: '   ' }, async () => 'first');

    await assertRejects(
      () => controls.run({ toolName: 'default-budget-tool' }, async () => 'blocked'),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'tool-call budget exceeded',
        })
    );

    await controls.reset();

    const afterReset = await controls.run({ toolName: 'default-budget-tool' }, async () => 'after-reset');
    assertEqual(afterReset, 'after-reset');
  }

  // --- runKey budgets are isolated per run ---
  console.log('test: runKey budgets are isolated per run');
  {
    const controls = RuntimeControls.create({
      maxToolCalls: 1,
      retry: { maxAttempts: 1 },
    });

    await controls.run({ toolName: 'task-tool', runKey: 'run-a' }, async () => 'a-1');
    await controls.run({ toolName: 'task-tool', runKey: 'run-b' }, async () => 'b-1');

    await assertRejects(
      () => controls.run({ toolName: 'task-tool', runKey: 'run-a' }, async () => 'a-2'),
      (error) =>
        assertFields(error, {
          code: 'INVALID_REQUEST',
          messageIncludes: 'tool-call budget exceeded',
        })
    );

    const secondRunStillOpen = await controls.run({ toolName: 'task-tool', runKey: 'run-b' }, async () => {
      throw Object.assign(new Error('This should not run due budget for run-b'), { code: 'UNKNOWN_ERROR' });
    }).catch((error) => error);

    assertFields(secondRunStillOpen, { code: 'INVALID_REQUEST' });
  }
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
