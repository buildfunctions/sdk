/**
 * Test CPU Function Deployment
 * Run: node tests/test-cpu-function.js
 */

import 'dotenv/config'
import { Buildfunctions } from '../dist/index.js'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testCpuFunction() {
  console.log('Testing CPU Function...\n')

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

    // Step 2: Deploy CPU Function
    console.log('\n2. Deploying CPU Function...')
    const functionCode = `
def handler(event, context):

    response = {
        'statusCode': 200,
        'headers': {'Content-Type': 'text/plain'},
        'body': f'Hello, world! A Python function built to run on Buildfunctions!'
    }

    return response
`

    deployedFunction = await buildfunctions.functions.create({
      name: 'sdk-cpu-function-' + Date.now(),
      code: functionCode,
      language: 'python',
      memory: 128,
      timeout: 30
    })

    console.log('   CPU Function deployed')
    console.log('   ID:', deployedFunction.id)
    console.log('   Name:', deployedFunction.name)
    console.log('   Endpoint:', deployedFunction.endpoint)

    // Step 3: Verify CPU Function exists in list
    console.log('\n3. Verifying CPU Function in list...')
    const functions = await buildfunctions.functions.list()
    const found = functions.find(f => f.id === deployedFunction.id)

    if (found) {
      console.log('   CPU Function found in list')
    } else {
      console.log('   CPU Function not found in list (may take a moment)')
    }

    // Step 4: Clean up
    // console.log('\n5. Deleting CPU Function...')
    // await deployedFunction.delete()
    // console.log('   CPU Function deleted')

    // console.log('\nCPU Function test completed!')

  } catch (error) {
    console.error('\nTest failed:', error.message)
    console.error('Error details:', error)

    if (deployedFunction) {
      console.log('Attempting cleanup...')
      try {
        await deployedFunction.delete()
        console.log('CPU Function cleaned up')
      } catch (e) {
        console.error('Cleanup failed:', e.message)
      }
    }

    process.exit(1)
  }
}

testCpuFunction()
