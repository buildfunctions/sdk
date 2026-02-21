import 'dotenv/config'
import { Buildfunctions, CPUSandbox, RuntimeControls, applyAgentLogicSafety } from '../../../../dist/index.js'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function main() {
  console.log('Pre-Execution: Intent Allowlist + Real CPU Sandbox')
  console.log('===================================================\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in your environment or .env file')
    process.exit(1)
  }

  await Buildfunctions({ apiToken: API_TOKEN })

  let sandbox = null

  try {
    sandbox = await CPUSandbox.create({
      name: 'sdk-pre-exec-allowlist-' + Date.now(),
      language: 'python',
      code: `
import json

def handler(event, context):
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"ok": True})
    }
`,
      memory: '128MB',
      timeout: 30,
    })

    console.log('   Sandbox created')
    console.log('   ID:', sandbox.id)
    console.log('   Name:', sandbox.name)
    console.log('   Runtime:', sandbox.runtime)
    console.log('   Endpoint:', sandbox.endpoint)

    const runtimeEvents = []

    const controls = RuntimeControls.create(
      applyAgentLogicSafety(
        {
          retry: { maxAttempts: 2, initialDelayMs: 150, maxDelayMs: 500, backoffFactor: 2, jitterRatio: 0 },
          onEvent: (event) => runtimeEvents.push(event),
        },
        {
          intentAllowlist: {
            enabled: true,
            rules: [
              { toolNamePattern: 'cpu-sandbox-run', actionPrefixes: ['execute', 'test_'] },
              { toolNamePattern: 'agent-control', actionPrefixes: ['finish'] },
            ],
            denyReason: 'Tool/action is outside intent allowlist',
          },
        }
      )
    )

    // ── Test 1: Allowed tool+action executes against real sandbox ──

    console.log('\n1. Allowed tool + action reaches real sandbox')

    const result = await controls.run(
      {
        toolName: 'cpu-sandbox-run',
        runKey: 'allowlist-test-1',
        destination: sandbox.endpoint,
        action: 'execute',
      },
      async () => sandbox.run()
    )

    console.log('   Result:', JSON.stringify(result, null, 2))

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Expected 2xx, got ${result.status}`)
    }
    console.log('   ✓ cpu-sandbox-run/execute allowed')

    // ── Test 2: Allowed action prefix matches ──

    console.log('\n2. Action prefix match (test_unit) reaches real sandbox')

    const result2 = await controls.run(
      {
        toolName: 'cpu-sandbox-run',
        runKey: 'allowlist-test-2',
        destination: sandbox.endpoint,
        action: 'test_unit',
      },
      async () => sandbox.run()
    )

    console.log('   Result:', JSON.stringify(result2, null, 2))

    if (result2.status < 200 || result2.status >= 300) {
      throw new Error(`Expected 2xx, got ${result2.status}`)
    }
    console.log('   ✓ cpu-sandbox-run/test_unit allowed')

    // ── Test 3: Denied tool blocked before sandbox runs ──

    console.log('\n3. Unlisted tool (repo-delete) blocked before sandbox execution')

    let toolDenied = false
    try {
      await controls.run(
        {
          toolName: 'repo-delete',
          runKey: 'allowlist-test-3',
          destination: sandbox.endpoint,
          action: 'delete_all',
        },
        async () => sandbox.run()
      )
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'UNAUTHORIZED' && String(error.message).toLowerCase().includes('allowlist')) {
        toolDenied = true
      } else {
        throw error
      }
    }

    if (!toolDenied) throw new Error('Expected unlisted tool to be denied')
    console.log('   ✓ repo-delete/delete_all denied — sandbox never called')

    // ── Test 4: Allowed tool but wrong action is denied ──

    console.log('\n4. Allowed tool (cpu-sandbox-run) but wrong action (drop_database) denied')

    let actionDenied = false
    try {
      await controls.run(
        {
          toolName: 'cpu-sandbox-run',
          runKey: 'allowlist-test-4',
          destination: sandbox.endpoint,
          action: 'drop_database',
        },
        async () => sandbox.run()
      )
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'UNAUTHORIZED' && String(error.message).toLowerCase().includes('allowlist')) {
        actionDenied = true
      } else {
        throw error
      }
    }

    if (!actionDenied) throw new Error('Expected wrong action to be denied')
    console.log('   ✓ cpu-sandbox-run/drop_database denied')

    // ── Verify policy_denied events were emitted ──

    const deniedEvents = runtimeEvents.filter((e) => e.type === 'policy_denied')
    if (deniedEvents.length !== 2) {
      throw new Error(`Expected 2 policy_denied events, got ${deniedEvents.length}`)
    }
    console.log('\n   ✓ 2 policy_denied events emitted')

    // ── Cleanup ──

    console.log('\nCleaning up...')
    await sandbox.delete()
    sandbox = null
    console.log('Sandbox deleted')

    console.log('\n✓ All intent allowlist pre-execution tests passed!')
  } catch (error) {
    console.error('\nTest failed:', error instanceof Error ? error.message : String(error))
    if (error instanceof Error && error.stack) console.error('Stack:', error.stack)
    if (sandbox) {
      try { await sandbox.delete(); console.log('Sandbox cleaned up') } catch (e) {
        console.error('Cleanup failed:', e instanceof Error ? e.message : String(e))
      }
    }
    process.exit(1)
  }
}

main()
