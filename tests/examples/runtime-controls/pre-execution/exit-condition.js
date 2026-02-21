import 'dotenv/config'
import { Buildfunctions, CPUSandbox, RuntimeControls, applyAgentLogicSafety } from '../../../../dist/index.js'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function main() {
  console.log('Pre-Execution: Exit Condition + Real CPU Sandbox')
  console.log('=================================================\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in your environment or .env file')
    process.exit(1)
  }

  await Buildfunctions({ apiToken: API_TOKEN })

  let sandbox = null

  try {
    sandbox = await CPUSandbox.create({
      name: 'sdk-pre-exec-exit-' + Date.now(),
      language: 'python',
      code: `
import json

def handler(event, context):
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"ok": True, "step": "completed"})
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

    // ── Test 1: Allowed steps execute against real sandbox, then blocked at max ──

    console.log('\n1. maxStepsPerRun enforced — real sandbox calls succeed until limit')

    const controls = RuntimeControls.create(
      applyAgentLogicSafety(
        { retry: { maxAttempts: 2, initialDelayMs: 150, maxDelayMs: 500, backoffFactor: 2, jitterRatio: 0 } },
        {
          exitCondition: {
            enabled: true,
            maxStepsPerRun: 2,
            terminalActions: [
              { toolNamePattern: 'agent-control', actionPrefix: 'finish' },
            ],
            blockAfterTerminal: true,
          },
        }
      )
    )

    const runKey = 'exit-test-1'

    // Step 1 — real sandbox execution
    const step1 = await controls.run(
      { toolName: 'cpu-sandbox-run', runKey, destination: sandbox.endpoint, action: 'execute' },
      async () => sandbox.run()
    )
    console.log('   Step 1 Result:', JSON.stringify(step1, null, 2))

    // Step 2 — real sandbox execution
    const step2 = await controls.run(
      { toolName: 'cpu-sandbox-run', runKey, destination: sandbox.endpoint, action: 'execute' },
      async () => sandbox.run()
    )
    console.log('   Step 2 Result:', JSON.stringify(step2, null, 2))

    // Step 3 — should be blocked (maxStepsPerRun = 2, no terminal action reached)
    let exitBlocked = false
    try {
      await controls.run(
        { toolName: 'cpu-sandbox-run', runKey, destination: sandbox.endpoint, action: 'execute' },
        async () => sandbox.run()
      )
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'INVALID_REQUEST' && String(error.message).toLowerCase().includes('exit condition')) {
        exitBlocked = true
      } else {
        throw error
      }
    }

    if (!exitBlocked) throw new Error('Expected exit condition to block step 3')
    console.log('   ✓ Step 3 blocked — exit condition not reached within max steps')

    // ── Test 2: Terminal action allows finish, then blocks post-terminal calls ──

    console.log('\n2. Terminal action allows finish, blocks subsequent calls')

    const terminalRunKey = 'exit-test-terminal'

    // Finish action — should succeed
    const finished = await controls.run(
      { toolName: 'agent-control', runKey: terminalRunKey, action: 'finish' },
      async () => 'done'
    )

    if (finished !== 'done') throw new Error('Expected terminal action to succeed')
    console.log('   Terminal action (finish) succeeded')

    // Post-terminal call — should be blocked
    let postTerminalBlocked = false
    try {
      await controls.run(
        { toolName: 'cpu-sandbox-run', runKey: terminalRunKey, destination: sandbox.endpoint, action: 'execute' },
        async () => sandbox.run()
      )
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'INVALID_REQUEST' && String(error.message).toLowerCase().includes('terminal action')) {
        postTerminalBlocked = true
      } else {
        throw error
      }
    }

    if (!postTerminalBlocked) throw new Error('Expected post-terminal call to be blocked')
    console.log('   ✓ Post-terminal sandbox call blocked')

    // ── Cleanup ──

    console.log('\nCleaning up...')
    await sandbox.delete()
    sandbox = null
    console.log('Sandbox deleted')

    console.log('\n✓ All exit condition pre-execution tests passed!')
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
