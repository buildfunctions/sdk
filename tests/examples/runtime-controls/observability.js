import { RuntimeControls } from '../../../dist/index.js';
import { assertEqual, assertOk, sleep } from './helpers.js';
async function main() {
  // --- eventSinks receive runtime-control events ---
  console.log('test: eventSinks receive runtime-control events');
  {
    const sinkEvents = [];

    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
      eventSinks: [
        (event) => {
          sinkEvents.push(event);
        },
      ],
    });

    let attempts = 0;
    const result = await controls.run({ toolName: 'sink-tool' }, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('temporary outage'), { code: 'NETWORK_ERROR', statusCode: 503 });
      }
      return 'ok';
    });

    assertEqual(result, 'ok');

    await sleep(0);

    const retryEvent = sinkEvents.find((event) => event.type === 'retry');
    assertOk(retryEvent);
    assertEqual(retryEvent.details?.toolName, 'sink-tool');
  }
  console.log('  passed');

  // --- onEventSinkFailure captures sink failures without breaking tool execution ---
  console.log('test: onEventSinkFailure captures sink failures without breaking tool execution');
  {
    const sinkFailures = [];

    const controls = RuntimeControls.create({
      retry: {
        maxAttempts: 2,
        initialDelayMs: 0,
        maxDelayMs: 0,
        backoffFactor: 1,
        jitterRatio: 0,
      },
      eventSinks: [
        () => {
          throw new Error('sink failed');
        },
      ],
      onEventSinkFailure: (params) => {
        sinkFailures.push(params);
      },
    });

    let attempts = 0;
    const result = await controls.run({ toolName: 'sink-error-tool' }, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('temporary outage'), { code: 'NETWORK_ERROR', statusCode: 503 });
      }
      return 'ok';
    });

    assertEqual(result, 'ok');

    await sleep(0);

    assertEqual(sinkFailures.length, 1);
    assertEqual(sinkFailures[0].sinkIndex, 0);
    assertEqual(sinkFailures[0].event.type, 'retry');
    if (!/sink failed/i.test(String(sinkFailures[0].failure))) {
      throw new Error(`Expected failure to match /sink failed/i but got: ${String(sinkFailures[0].failure)}`);
    }
  }
  console.log('  passed');

  console.log('All observability tests passed');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
