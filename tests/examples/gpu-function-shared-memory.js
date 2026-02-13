import 'dotenv/config'
import { Buildfunctions, GPUFunction } from '../../dist/index.js'
// import { Buildfunctions, GPUFunction } from 'buildfunctions'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testGpuFunctionSharedMemory() {
  console.log('Testing GPU Function with Shared Memory (gpuCount: 2)...\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in .env file')
    process.exit(1)
  }

  let deployedFunction = null

  try {
    // Step 1: Authenticate
    console.log('1. Authenticating...')
    const buildfunctions = await Buildfunctions({ apiToken: API_TOKEN })
    console.log('   Authenticated as:', buildfunctions.user.username)

    // Step 2: Deploy GPU Function with gpuCount: 2
    console.log('\n2. Deploying GPU Function with gpuCount: 2...')

    deployedFunction = await GPUFunction.create({
      name: 'sdk-gpu-func-shared-mem-' + Date.now(),
      code: '/path/to/code/gpu_function_shared_memory_code.py',
      language: 'python',
      gpu: 'T4G',
      vcpus: 6,
      gpuCount: 2,
      memory: "10000MB",
      timeout: 300,
      requirements: 'torch',
    })

    console.log('   GPU Function deployed')
    console.log('   ID:', deployedFunction.id)
    console.log('   Name:', deployedFunction.name)
    console.log('   Endpoint:', deployedFunction.endpoint)

    // Step 3: Verify GPU Function exists in list
    console.log('\n3. Verifying GPU Function in list...')
    const functions = await buildfunctions.functions.list()
    const found = functions.find(f => f.id === deployedFunction.id)

    if (found) {
      console.log('   GPU Function found in list')
      console.log('   Is GPU:', found.isGPUF)
    } else {
      console.log('   GPU Function not found in list (may take a moment)')
    }

    // Step 4: Wait and call the endpoint
    console.log('\n4. Waiting 10 seconds before calling endpoint...')
    await new Promise(resolve => setTimeout(resolve, 10000))

    console.log('   Calling endpoint:', deployedFunction.endpoint)
    const response = await fetch(deployedFunction.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true })
    })
    const responseData = await response.text()
    console.log('   Status:', response.status)
    console.log('   Response:', responseData)

    // Step 5: Verify GPU memory and device info in response
    console.log('\n5. Verifying GPU info...')
    try {
      const parsed = JSON.parse(responseData)
      const data = parsed.body ? JSON.parse(parsed.body) : parsed

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
    } catch (e) {
      console.log('   Could not parse response for GPU verification:', e.message)
    }

    // Step 6: Delete GPU Function
    console.log('\n6. Deleting GPU Function...')
    await deployedFunction.delete()
    deployedFunction = null
    console.log('   GPU Function deleted')

    console.log('\nGPU Function shared memory test completed!')

  } catch (error) {
    console.error('\nTest failed:', error.message)

    if (deployedFunction) {
      console.log('Attempting cleanup...')
      try {
        await deployedFunction.delete()
        console.log('GPU Function cleaned up')
      } catch (e) {
        console.error('Cleanup failed:', e.message)
      }
    }

    process.exit(1)
  }
}

testGpuFunctionSharedMemory()
