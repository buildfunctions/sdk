import 'dotenv/config'
import { Buildfunctions, GPUSandbox, Model } from '../../dist/index.js'
// import { Buildfunctions, GPUSandbox, Model } from 'buildfunctions'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testGpuSandboxWithModel() {
  console.log('Testing GPU Sandbox with Model...\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in .env file')
    process.exit(1)
  }

  let model = null
  let sandbox = null

  try {
    // Step 1: Authenticate
    console.log('1. Authenticating...')
    const buildfunctions = await Buildfunctions({ apiToken: API_TOKEN })
    console.log('   Authenticated as:', buildfunctions.user.username)

    // Step 2: Find pre-uploaded model
    console.log('\n2. Finding model...')
    const deployedModel = await Model.findUnique({
      where: { name: "remote-model-for-sdk-test"}
    })

    if (!deployedModel) {
      console.log('   Model not found — upload it first with model-upload.js')
      process.exit(1)
    }

    console.log('   Model found:', deployedModel.name)

    // Step 3: Create GPU Sandbox referencing the uploaded model by name
    console.log('\n3. Creating GPU Sandbox with model reference...')

    sandbox = await GPUSandbox.create({
      name: 'sdk-gpu-sandbox-model-' + Date.now(),
      language: 'python',
      memory: "10000MB",
      timeout: 300,
      vcpus: 6,
      code: '/path/to/code/gpu_sandbox_code.py',
      model: deployedModel.name,
      requirements: "torch"
    })
    console.log('   GPU Sandbox created')
    console.log('   ID:', sandbox.id)
    console.log('   Name:', sandbox.name)
    console.log('   Runtime:', sandbox.runtime)
    console.log('   GPU:', sandbox.gpu)
    console.log('   Endpoint:', sandbox.endpoint)

    // Step 4: Run GPU Sandbox
    console.log('\n4. Running GPU Sandbox...')
    const result = await sandbox.run()
    console.log('   Result:', JSON.stringify(result, null, 2))

    // Step 5: Clean up
    console.log('\n5. Deleting GPU Sandbox...')
    await sandbox.delete()
    sandbox = null
    console.log('   GPU Sandbox deleted')

    console.log('\nGPU Sandbox with model test completed!')

  } catch (error) {
    console.error('\nTest failed:', error.message)
    if (error.stack) {
      console.error('Stack:', error.stack)
    }

    if (sandbox) {
      console.log('Attempting sandbox cleanup...')
      try {
        await sandbox.delete()
        console.log('GPU Sandbox cleaned up')
      } catch (e) {
        console.error('Sandbox cleanup failed:', e.message)
      }
    }

    if (model) {
      console.log('Attempting model cleanup...')
      try {
        await model.delete()
        console.log('Model cleaned up')
      } catch (e) {
        console.error('Model cleanup failed:', e.message)
      }
    }

    process.exit(1)
  }
}

testGpuSandboxWithModel()
