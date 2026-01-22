/**
 * Test GPU Function Deployment
 * Run: node tests/test-gpu-function.js
 */

import 'dotenv/config'
import { Buildfunctions } from '../dist/index.js'

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
    buildfunctions = await Buildfunctions({ apiKey: API_TOKEN })
    console.log('   Authenticated as:', buildfunctions.user.username)

    // Step 2: Deploy GPU Function
    console.log('\n2. Deploying GPU Function...')
    const functionCode = `import sys
import json

def handler():
    """
    GPU Function handler
    """
    try:
        import torch
        cuda_available = torch.cuda.is_available()
        device_count = torch.cuda.device_count() if cuda_available else 0
        device_name = torch.cuda.get_device_name(0) if cuda_available and device_count > 0 else "No GPU"

        print(f"Device set to: {device_name}")

        response_data = {
            "message": "Hello from GPU Function!",
            "cuda_available": cuda_available,
            "device_count": device_count,
            "device_name": device_name,
            "torch_version": torch.__version__
        }

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
            },
            "body": json.dumps(response_data)
        }
    except Exception as e:
        print(f"Error in handler: {e}", file=sys.stderr)
        return {
            "statusCode": 500,
            "headers": {
                "Content-Type": "application/json",
            },
            "body": json.dumps({"error": str(e)})
        }
`

    deployedFunction = await buildfunctions.functions.create({
      name: 'sdk-gpu-function-' + Date.now(),
      code: functionCode,
      language: 'python',
      gpu: 'T4',
      memory: 50000,
      timeout: 300,
      requirements: '',
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

    // Step 4: Clean up
    // console.log('\n4. Deleting GPU Function...')
    // await deployedFunction.delete()
    // console.log('   GPU Function deleted')

    // console.log('\nGPU Function test completed!')

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
