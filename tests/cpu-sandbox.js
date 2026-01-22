/**
 * Test CPU Sandbox
 * Run: node tests/test-cpu-sandbox.js
 */

import 'dotenv/config'
import { Buildfunctions, CPUSandbox } from '../dist/index.js'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testCpuSandbox() {
  console.log('Testing CPU Sandbox...\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in .env file')
    process.exit(1)
  }

  let sandbox = null

  try {
    // Step 1: Authenticate
    console.log('1. Authenticating...')
    const buildfunctions = await Buildfunctions({ apiKey: API_TOKEN })
    console.log('   Authenticated as:', buildfunctions.user.username)

    // Step 2: Create CPU Sandbox with handler code
    console.log('\n2. Creating CPU Sandbox...')

    const handlerCode = `import sys

def handler(event, context):
    response = {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': f'{{"message": "Hello from CPU Sandbox!", "python_version": "{sys.version}"}}'
    }
    return response
`

    sandbox = await CPUSandbox.create({
      name: 'sdk-cpu-sandbox-' + Date.now(),
      language: 'python',
      code: handlerCode,
      memory: 128,
      timeout: 30,
    })
    console.log('   CPU Sandbox created')
    console.log('   ID:', sandbox.id)
    console.log('   Name:', sandbox.name)
    console.log('   Runtime:', sandbox.runtime)
    console.log('   Endpoint:', sandbox.endpoint)

    // Step 3: Run CPU Sandbox
    console.log('\n3. Running CPU Sandbox...')
    const result = await sandbox.run()
    console.log('   Response:', JSON.stringify(result, null, 2))

    // Step 4: Clean up
    console.log('\n4. Deleting CPU Sandbox...')
    await sandbox.delete()
    console.log('   CPU Sandbox deleted')

    console.log('\nCPU Sandbox test completed!')

  } catch (error) {
    console.error('\nTest failed:', error.message)
    if (error.stack) {
      console.error('Stack:', error.stack)
    }

    if (sandbox) {
      console.log('Attempting cleanup...')
      try {
        await sandbox.delete()
        console.log('CPU Sandbox cleaned up')
      } catch (e) {
        console.error('Cleanup failed:', e.message)
      }
    }

    process.exit(1)
  }
}

testCpuSandbox()
