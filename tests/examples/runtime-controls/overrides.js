import { RuntimeControls } from '../../../dist/index.js';
import { assertFields, assertEqual, assertRejects, waitWithAbort } from './helpers.js';
async function main() {
  // --- tool override wins over destination override when both match ---
  console.log('test: tool override wins over destination override when both match');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      timeoutMs: 100,
      overrides: {
        destinations: {
          'api.service.localhost': { timeoutMs: 1 },
        },
        tools: {
          shell: { timeoutMs: 40 },
        },
      },
    });

    const successful = await controls.run(
      { toolName: 'shell', destination: 'https://api.service.localhost/v1' },
      async ({ signal }) => {
        await waitWithAbort(15, signal);
        return 'ok';
      }
    );
    assertEqual(successful, 'ok');

    await assertRejects(
      () =>
        controls.run(
          { toolName: 'http', destination: 'https://api.service.localhost/v1' },
          async ({ signal }) => {
            await waitWithAbort(15, signal);
            return 'never';
          }
        ),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'timed out',
        })
    );
  }
  console.log('  passed');

  // --- destination override specificity prefers exact over wildcard over global ---
  console.log('test: destination override specificity prefers exact over wildcard over global');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      timeoutMs: 100,
      overrides: {
        destinations: {
          '*': { timeoutMs: 1 },
          '*.service.localhost': { timeoutMs: 25 },
          'api.service.localhost': { timeoutMs: 80 },
        },
      },
    });

    const exactResult = await controls.run(
      { toolName: 'http', destination: 'https://api.service.localhost/v1' },
      async ({ signal }) => {
        await waitWithAbort(30, signal);
        return 'exact-ok';
      }
    );
    assertEqual(exactResult, 'exact-ok');

    const wildcardResult = await controls.run(
      { toolName: 'http', destination: 'https://foo.service.localhost/v1' },
      async ({ signal }) => {
        await waitWithAbort(20, signal);
        return 'wildcard-ok';
      }
    );
    assertEqual(wildcardResult, 'wildcard-ok');

    await assertRejects(
      () =>
        controls.run(
          { toolName: 'http', destination: 'https://other.localhost/v1' },
          async ({ signal }) => {
            await waitWithAbort(20, signal);
            return 'never';
          }
        ),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'timed out',
        })
    );
  }
  console.log('  passed');

  // --- tool override specificity prefers exact over prefix over global ---
  console.log('test: tool override specificity prefers exact over prefix over global');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      timeoutMs: 200,
      overrides: {
        tools: {
          '*': { timeoutMs: 5 },
          'http*': { timeoutMs: 20 },
          'http-fetch': { timeoutMs: 40 },
        },
      },
    });

    const exact = await controls.run({ toolName: 'http-fetch' }, async ({ signal }) => {
      await waitWithAbort(30, signal);
      return 'exact';
    });
    assertEqual(exact, 'exact');

    const prefix = await controls.run({ toolName: 'http-stream' }, async ({ signal }) => {
      await waitWithAbort(15, signal);
      return 'prefix';
    });
    assertEqual(prefix, 'prefix');

    await assertRejects(
      () =>
        controls.run({ toolName: 'db-query' }, async ({ signal }) => {
          await waitWithAbort(15, signal);
          return 'never';
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR', messageIncludes: 'timed out' })
    );
  }
  console.log('  passed');

  // --- tool override can raise retry attempts above global retry config ---
  console.log('test: tool override can raise retry attempts above global retry config');
  {
    let flakyAttempts = 0;
    let normalAttempts = 0;

    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
      overrides: {
        tools: {
          'flaky-tool': {
            retry: {
              maxAttempts: 2,
              initialDelayMs: 0,
              maxDelayMs: 0,
              backoffFactor: 1,
              jitterRatio: 0,
            },
          },
        },
      },
    });

    const flakyResult = await controls.run({ toolName: 'flaky-tool' }, async () => {
      flakyAttempts += 1;
      if (flakyAttempts === 1) {
        throw Object.assign(new Error('temporary'), { code: 'NETWORK_ERROR', statusCode: 503 });
      }
      return 'flaky-ok';
    });

    assertEqual(flakyResult, 'flaky-ok');
    assertEqual(flakyAttempts, 2);

    await assertRejects(
      () =>
        controls.run({ toolName: 'normal-tool' }, async () => {
          normalAttempts += 1;
          throw Object.assign(new Error('temporary'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR' })
    );

    assertEqual(normalAttempts, 1);
  }
  console.log('  passed');

  // --- tool override can disable circuit breaker for selected tools ---
  console.log('test: tool override can disable circuit breaker for selected tools');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      circuitBreaker: {
        enabled: true,
        windowMs: 1000,
        minRequests: 1,
        failureRateThreshold: 1,
        cooldownMs: 120,
      },
      overrides: {
        tools: {
          'safe-tool': {
            circuitBreaker: {
              enabled: false,
            },
          },
        },
      },
    });

    await assertRejects(
      () =>
        controls.run({ toolName: 'safe-tool', destination: 'safe.localhost' }, async () => {
          throw Object.assign(new Error('down'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR' })
    );

    const safeSecondCall = await controls.run({ toolName: 'safe-tool', destination: 'safe.localhost' }, async () => 'ok');
    assertEqual(safeSecondCall, 'ok');

    await assertRejects(
      () =>
        controls.run({ toolName: 'unsafe-tool', destination: 'unsafe.localhost' }, async () => {
          throw Object.assign(new Error('down'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR' })
    );

    await assertRejects(
      () => controls.run({ toolName: 'unsafe-tool', destination: 'unsafe.localhost' }, async () => 'blocked'),
      (error) => assertFields(error, { code: 'NETWORK_ERROR', messageIncludes: 'circuit breaker open' })
    );
  }
  console.log('  passed');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
