import 'dotenv/config'
import { Buildfunctions, GPUSandbox } from '../../dist/index.js'
// import { Buildfunctions, GPUSandbox } from 'buildfunctions'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testGpuSandboxSharedMemory() {
  console.log('Testing GPU Sandbox with Shared Memory (gpuCount: 2)...\n')

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

    // Step 2: Create GPU Sandbox with gpuCount: 2
    console.log('\n2. Creating GPU Sandbox with gpuCount: 2...')

    sandbox = await GPUSandbox.create({
      name: 'sdk-gpu-sandbox-shared-mem-' + Date.now(),
      language: 'python',
      memory: "10000MB",
      timeout: 300,
      vcpus: 6,
      gpuCount: 2,
      code: '/path/to/code/gpu_sandbox_shared_memory_code.py',
      requirements: 'torch'
    })
    console.log('   GPU Sandbox created')
    console.log('   ID:', sandbox.id)
    console.log('   Name:', sandbox.name)
    console.log('   Endpoint:', sandbox.endpoint)

    // Step 3: Run GPU Sandbox
    console.log('\n3. Running GPU Sandbox...')
    const result = await sandbox.run()
    console.log('   Result:', JSON.stringify(result, null, 2))

    // Step 4: Verify GPU memory and device info in response
    console.log('\n4. Verifying GPU info...')
    const response = result.response
    const body = typeof response === 'string' ? JSON.parse(response) : response
    const data = body.body ? JSON.parse(body.body) : body

    console.log('   CUDA available:', data.cuda_available)
    console.log('   Device count:', data.device_count)

    if (data.devices && data.devices.length > 0) {
      let totalMemoryMb = 0
      for (const device of data.devices) {
        console.log(`   Device ${device.index}: ${device.name} - ${device.memory_total_mb}MB total, ${device.memory_free_mb}MB free`)
        totalMemoryMb += device.memory_total_mb
      }
      console.log(`   Combined GPU memory: ${totalMemoryMb}MB across ${data.devices.length} devices`)
    }

    if (data.device_count >= 2) {
      console.log('   PASS: Multiple GPU devices detected')
    } else {
      console.log('   WARN: Expected 2 devices, got', data.device_count)
    }

    // Step 5: Delete GPU Sandbox
    console.log('\n5. Deleting GPU Sandbox...')
    await sandbox.delete()
    sandbox = null
    console.log('   GPU Sandbox deleted')

    console.log('\nGPU Sandbox shared memory test completed!')

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

testGpuSandboxSharedMemory()
