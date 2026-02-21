import { RuntimeControls } from '../../../dist/index.js';
import { assertOk, waitWithAbort } from './helpers.js';
async function main() {
  // --- state adapter without keys() still supports loop pruning via tracked keys ---
  console.log('state adapter without keys() still supports loop pruning via tracked keys');

  const backingMap = new Map();
  const adapterWithoutKeys = {
    get: (key) => backingMap.get(key),
    set: (key, value) => {
      backingMap.set(key, value);
    },
    delete: (key) => {
      backingMap.delete(key);
    },
  };

  const controls = RuntimeControls.create({
    tenantKey: 'tenant-no-keys',
    retry: { maxAttempts: 1 },
    timeoutMs: 50,
    loopBreaker: {
      warningThreshold: 100,
      quarantineThreshold: 200,
      stopThreshold: 300,
      maxFingerprints: 20,
    },
    state: { loop: adapterWithoutKeys },
  });

  for (let index = 0; index < 25; index += 1) {
    await controls.run(
      {
        toolName: `tool-${index}`,
        args: { index },
      },
      async ({ signal }) => {
        await waitWithAbort(1, signal);
        return 'ok';
      }
    );
  }

  const loopKeys = Array.from(backingMap.keys()).filter((key) => key.startsWith('tenant-no-keys:loop:'));
  assertOk(loopKeys.length <= 20, `Expected at most 20 loop keys, got ${loopKeys.length}`);

  console.log('PASS');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
