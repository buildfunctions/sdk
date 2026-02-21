import { RuntimeControls } from '../../../dist/index.js';
import { assertFields, assertEqual, assertRejects } from './helpers.js';
async function main() {
  // --- policy deny action blocks call and emits policy_denied event ---
  console.log('policy deny action blocks call and emits policy_denied event');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'deny-shell-delete',
            action: 'deny',
            tools: ['shell'],
            actionPrefixes: ['delete'],
            reason: 'delete blocked',
          },
        ],
      },
      onEvent,
    });

    await assertRejects(
      () => controls.run({ toolName: 'shell', action: 'delete_file' }, async () => 'never'),
      (error) =>
        assertFields(error, {
          code: 'UNAUTHORIZED',
          statusCode: 403,
          messageIncludes: 'policy denied',
        })
    );

    assertEqual(events.filter((event) => event.type === 'policy_denied').length, 1);
  }

  // --- require_approval without approval handler is rejected ---
  console.log('require_approval without approval handler is rejected');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'approval-required',
            action: 'require_approval',
            tools: ['ticket-write'],
            reason: 'needs approval',
          },
        ],
      },
      onEvent,
    });

    await assertRejects(
      () => controls.run({ toolName: 'ticket-write', action: 'create' }, async () => 'never'),
      (error) =>
        assertFields(error, {
          code: 'UNAUTHORIZED',
          statusCode: 403,
          messageIncludes: 'requires approval',
        })
    );

    assertEqual(events.filter((event) => event.type === 'policy_approval_required').length, 1);
    assertEqual(events.filter((event) => event.type === 'policy_denied').length, 0);
  }

  // --- require_approval with handler emits denied when handler returns false ---
  console.log('require_approval with handler emits denied when handler returns false');
  {
    const events = [];
    const onEvent = (event) => events.push(event);
    const approvalContexts = [];

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'approval-required',
            action: 'require_approval',
            tools: ['external-write'],
            destinations: ['*.external.localhost'],
            reason: 'human gate',
          },
        ],
        approvalHandler: async (context) => {
          approvalContexts.push(context);
          return false;
        },
      },
      onEvent,
    });

    await assertRejects(
      () =>
        controls.run(
          {
            toolName: 'external-write',
            destination: 'https://billing.external.localhost/v1',
            action: 'create_invoice',
            args: { amount: 42 },
          },
          async () => 'never'
        ),
      (error) =>
        assertFields(error, {
          code: 'UNAUTHORIZED',
          statusCode: 403,
          messageIncludes: 'approval denied',
        })
    );

    assertEqual(approvalContexts.length, 1);
    assertEqual(approvalContexts[0].toolName, 'external-write');
    assertEqual(events.filter((event) => event.type === 'policy_approval_required').length, 1);
    assertEqual(events.filter((event) => event.type === 'policy_denied').length, 1);
  }

  // --- require_approval with handler emits approved event and allows call ---
  console.log('require_approval with handler emits approved event and allows call');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'approval-required',
            action: 'require_approval',
            tools: ['external-write'],
            reason: 'manual approval needed',
          },
        ],
        approvalHandler: async () => true,
      },
      onEvent,
    });

    const result = await controls.run({ toolName: 'external-write', action: 'create' }, async () => 'ok');

    assertEqual(result, 'ok');
    assertEqual(events.filter((event) => event.type === 'policy_approval_required').length, 1);
    assertEqual(events.filter((event) => event.type === 'policy_approved').length, 1);
  }

  // --- policy matching prefers specificity and stricter actions ---
  console.log('policy matching prefers specificity and stricter actions');
  {
    const controlsSpecific = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          { id: 'allow-all', action: 'allow', tools: ['*'], destinations: ['*'] },
          {
            id: 'deny-exact',
            action: 'deny',
            tools: ['http'],
            destinations: ['api.acme.localhost'],
            reason: 'sensitive endpoint',
          },
        ],
      },
    });

    await assertRejects(
      () => controlsSpecific.run({ toolName: 'http', destination: 'https://api.acme.localhost/v1' }, async () => 'never'),
      (error) => assertFields(error, { code: 'UNAUTHORIZED', statusCode: 403 })
    );

    const controlsTie = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          { id: 'allow-shell', action: 'allow', tools: ['shell'] },
          { id: 'deny-shell', action: 'deny', tools: ['shell'], reason: 'manual only' },
        ],
      },
    });

    await assertRejects(
      () => controlsTie.run({ toolName: 'shell', action: 'exec' }, async () => 'never'),
      (error) => assertFields(error, { code: 'UNAUTHORIZED', statusCode: 403 })
    );
  }

  // --- policy actionPrefixes use longest matching prefix ---
  console.log('policy actionPrefixes use longest matching prefix');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        rules: [
          {
            id: 'allow-write',
            action: 'allow',
            tools: ['repo-admin'],
            actionPrefixes: ['write'],
          },
          {
            id: 'deny-dangerous-write',
            action: 'deny',
            tools: ['repo-admin'],
            actionPrefixes: ['write:dangerous'],
            reason: 'dangerous writes blocked',
          },
        ],
      },
    });

    await assertRejects(
      () => controls.run({ toolName: 'repo-admin', action: 'write:dangerous:force' }, async () => 'never'),
      (error) => assertFields(error, { code: 'UNAUTHORIZED' })
    );

    const safe = await controls.run({ toolName: 'repo-admin', action: 'write:standard' }, async () => 'ok');
    assertEqual(safe, 'ok');
  }

  // --- policy can be disabled globally ---
  console.log('policy can be disabled globally');
  {
    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        enabled: false,
        rules: [
          {
            action: 'deny',
            tools: ['*'],
            reason: 'would deny everything if enabled',
          },
        ],
      },
    });

    const result = await controls.run({ toolName: 'any-tool' }, async () => 'ok');
    assertEqual(result, 'ok');
  }

  // --- policy dryRun mode emits policy_dry_run and allows deny rules ---
  console.log('policy dryRun mode emits policy_dry_run and allows deny rules');
  {
    const events = [];
    const onEvent = (event) => events.push(event);

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        mode: 'dryRun',
        rules: [
          {
            id: 'deny-shell',
            action: 'deny',
            tools: ['shell'],
            reason: 'deny in simulation',
          },
        ],
      },
      onEvent,
    });

    const result = await controls.run({ toolName: 'shell' }, async () => 'ok');
    assertEqual(result, 'ok');

    assertEqual(events.filter((event) => event.type === 'policy_dry_run').length, 1);
    assertEqual(events.filter((event) => event.type === 'policy_denied').length, 0);
  }

  // --- policy dryRun mode skips approval handler for require_approval ---
  console.log('policy dryRun mode skips approval handler for require_approval');
  {
    const events = [];
    const onEvent = (event) => events.push(event);
    let approvalCalls = 0;

    const controls = RuntimeControls.create({
      retry: { maxAttempts: 1 },
      policy: {
        mode: 'dryRun',
        rules: [
          {
            id: 'require-approval',
            action: 'require_approval',
            tools: ['ticket-write'],
            reason: 'approval in simulation',
          },
        ],
        approvalHandler: async () => {
          approvalCalls += 1;
          return false;
        },
      },
      onEvent,
    });

    const result = await controls.run({ toolName: 'ticket-write' }, async () => 'ok');
    assertEqual(result, 'ok');
    assertEqual(approvalCalls, 0);
    assertEqual(events.filter((event) => event.type === 'policy_dry_run').length, 1);
    assertEqual(events.filter((event) => event.type === 'policy_approval_required').length, 0);
  }

  console.log('All policy tests passed');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
