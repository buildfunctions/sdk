/**
 * Test GPU Sandbox with Local Model
 * Run: node tests/test-gpu-sandbox-local-model.js
 */

import 'dotenv/config'
// import { Buildfunctions, GPUSandbox } from '../dist/index.js'
import { Buildfunctions, GPUSandbox } from 'buildfunctions'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testGpuSandboxWithModel() {
  console.log('Testing GPU Sandbox with Local Model...\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in .env file')
    process.exit(1)
  }

  let sandbox = null

  try {
    // Step 1: Authenticate
    console.log('1. Authenticating...')
    const buildfunctions = await Buildfunctions({ apiToken: API_TOKEN })
    console.log('   Authenticated as:', buildfunctions.user.username)

    // Step 2: Create GPU Sandbox with handler code and local model
    console.log('\n2. Creating GPU Sandbox with local model...')

    sandbox = await GPUSandbox.create({
      name: 'sdk-gpu-sandbox-model-' + Date.now(),
      language: 'python',
      memory: 10000,
      timeout: 300,
      vcpus: 6,
      code: './gpu_sandbox_code.py',
      model: '/path/to/models/Qwen/Qwen3-8B',
      requirements: "torch"
    })
    console.log('   GPU Sandbox created')
    console.log('   ID:', sandbox.id)
    console.log('   Name:', sandbox.name)
    console.log('   Runtime:', sandbox.runtime)
    console.log('   GPU:', sandbox.gpu)
    console.log('   Endpoint:', sandbox.endpoint)

    // Step 3: Run GPU Sandbox
    console.log('\n3. Running GPU Sandbox...')
    const result = await sandbox.run()
    console.log('   Response:', JSON.stringify(result, null, 2))

    // Step 4: Clean up
    console.log('\n4. Deleting GPU Sandbox...')
    await sandbox.delete()
    console.log('   GPU Sandbox deleted')

    console.log('\nGPU Sandbox with local model test completed!')

  } catch (error) {
    console.error('\nTest failed:', error.message)
    if (error.stack) {
      console.error('Stack:', error.stack)
    }

    if (sandbox) {
      console.log('Attempting cleanup...')
      try {
        await sandbox.delete()
        console.log('GPU Sandbox cleaned up')
      } catch (e) {
        console.error('Cleanup failed:', e.message)
      }
    }

    process.exit(1)
  }
}

testGpuSandboxWithModel()
