/**
 * Test GPU Function Deployment
 * Run: node tests/test-gpu-function.js
 */

import 'dotenv/config'
import { Buildfunctions } from '../dist/index.js'
// import { Buildfunctions } from 'buildfunctions'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testGpuFunction() {
  console.log('Testing GPU Function...\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in .env file')
    process.exit(1)
  }

  let buildfunctions = null
  let deployedFunction = null

  try {
    // Step 1: Authenticate
    console.log('1. Authenticating...')
    buildfunctions = await Buildfunctions({ apiToken: API_TOKEN })
    console.log('   Authenticated as:', buildfunctions.user.username)

    // Step 2: Deploy GPU Function
    console.log('\n2. Deploying GPU Function...')

    deployedFunction = await buildfunctions.functions.create({
      name: 'sdk-gpu-function-' + Date.now(),
      code: '/path/to/code/gpu_function_code.py',
      language: 'python',
      gpu: 'T4',
      vcpus: 30,
      memory: "50000MB",
      timeout: 300,
      requirements: ['transformers==4.47.1', 'torch', 'accelerate'],
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

    // Step 5: Clean up
    console.log('\n5. Deleting GPU Function...')
    await deployedFunction.delete()
    console.log('   GPU Function deleted')

    console.log('\nGPU Function test completed!')

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

testGpuFunction()
