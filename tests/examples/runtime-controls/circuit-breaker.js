import { RuntimeControls } from '../../../dist/index.js';
import { createMapAdapter, assertFields, assertEqual, assertRejects } from './helpers.js';
async function main() {
  // --- circuit breaker opens on high failure rate and blocks during cooldown ---
  {
    console.log('circuit breaker opens on high failure rate and blocks during cooldown');
    const events = [];
    const onEvent = (event) => events.push(event);
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      circuitBreaker: {
        enabled: true,
        windowMs: 1000,
        minRequests: 2,
        failureRateThreshold: 0.5,
        cooldownMs: 120,
      },
      onEvent,
    });

    await assertRejects(
      () =>
        controls.run({ toolName: 'http', destination: 'api.service.localhost' }, async () => {
          throw Object.assign(new Error('upstream down'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR', statusCode: 503 })
    );

    await assertRejects(
      () =>
        controls.run({ toolName: 'http', destination: 'api.service.localhost' }, async () => {
          throw Object.assign(new Error('upstream still down'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR', statusCode: 503 })
    );

    assertEqual(events.filter((event) => event.type === 'circuit_open').length, 1);

    await assertRejects(
      () => controls.run({ toolName: 'http', destination: 'api.service.localhost' }, async () => 'blocked'),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'circuit breaker open',
        })
    );
  }

  // --- circuit breaker does not open when failure rate stays below threshold ---
  {
    console.log('circuit breaker does not open when failure rate stays below threshold');
    const events = [];
    const onEvent = (event) => events.push(event);
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      circuitBreaker: {
        enabled: true,
        windowMs: 1000,
        minRequests: 4,
        failureRateThreshold: 0.75,
        cooldownMs: 120,
      },
      onEvent,
    });

    for (let index = 0; index < 2; index += 1) {
      await assertRejects(
        () =>
          controls.run({ toolName: 'fetch', destination: 'stats.localhost' }, async () => {
            throw Object.assign(new Error('transient'), { code: 'NETWORK_ERROR', statusCode: 503 });
          }),
        (error) => assertFields(error, { code: 'NETWORK_ERROR' })
      );
    }

    for (let index = 0; index < 3; index += 1) {
      const result = await controls.run({ toolName: 'fetch', destination: 'stats.localhost' }, async () => 'ok');
      assertEqual(result, 'ok');
    }

    assertEqual(events.filter((event) => event.type === 'circuit_open').length, 0);
  }

  // --- circuit state adapter persists open state across instances and normalizes destination host ---
  {
    console.log('circuit state adapter persists open state across instances and normalizes destination host');
    const { adapter } = createMapAdapter();

    const first = RuntimeControls.create({
      tenantKey: 'tenant-circuit',
      retry: { maxAttempts: 1 },
      circuitBreaker: {
        enabled: true,
        windowMs: 1000,
        minRequests: 1,
        failureRateThreshold: 1,
        cooldownMs: 120,
      },
      state: { circuit: adapter },
    });

    await assertRejects(
      () =>
        first.run({ toolName: 'http', destination: 'https://api.persist.localhost/v1/jobs' }, async () => {
          throw Object.assign(new Error('down'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR' })
    );

    const second = RuntimeControls.create({
      tenantKey: 'tenant-circuit',
      retry: { maxAttempts: 1 },
      circuitBreaker: {
        enabled: true,
        windowMs: 1000,
        minRequests: 1,
        failureRateThreshold: 1,
        cooldownMs: 120,
      },
      state: { circuit: adapter },
    });

    await assertRejects(
      () => second.run({ toolName: 'http', destination: 'api.persist.localhost' }, async () => 'blocked'),
      (error) =>
        assertFields(error, {
          code: 'NETWORK_ERROR',
          messageIncludes: 'circuit breaker open',
        })
    );
  }

  // --- circuit key is isolated by destination host ---
  {
    console.log('circuit key is isolated by destination host');
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      circuitBreaker: {
        enabled: true,
        windowMs: 1000,
        minRequests: 1,
        failureRateThreshold: 1,
        cooldownMs: 120,
      },
    });

    await assertRejects(
      () =>
        controls.run({ toolName: 'http', destination: 'api-a.localhost' }, async () => {
          throw Object.assign(new Error('host-a down'), { code: 'NETWORK_ERROR', statusCode: 503 });
        }),
      (error) => assertFields(error, { code: 'NETWORK_ERROR' })
    );

    const otherDestination = await controls.run({ toolName: 'http', destination: 'api-b.localhost' }, async () => 'ok');
    assertEqual(otherDestination, 'ok');
  }
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
