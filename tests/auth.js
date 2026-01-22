/**
 * Test SDK Authentication
 * Run: node tests/test-auth.js
 */

import 'dotenv/config'
import { Buildfunctions } from '../dist/index.js'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testAuth() {
  console.log('Testing SDK Authentication...\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in .env file')
    process.exit(1)
  }

  try {
    // Step 1: Authenticate
    console.log('1. Authenticating...')
    const buildfunctions = await Buildfunctions({ apiKey: API_TOKEN })
    console.log('   Authenticated as:', buildfunctions.user.username)
    console.log('   User ID:', buildfunctions.user.id)
    console.log('   Session expires:', buildfunctions.sessionExpiresAt)

    // Step 2: List Functions
    console.log('\n2. Listing Functions...')
    let allFunctions = []
    let page = 1
    let hasMore = true

    while (hasMore) {
      const functions = await buildfunctions.functions.list({ page })
      allFunctions = allFunctions.concat(functions)
      hasMore = functions.length === 10
      page++
    }

    const cpuFunctions = allFunctions.filter(f => !f.isGPUF)
    const gpuFunctions = allFunctions.filter(f => f.isGPUF)

    console.log('   Total Functions:', allFunctions.length)
    console.log('   CPU Functions:', cpuFunctions.length)
    console.log('   GPU Functions:', gpuFunctions.length)

    if (allFunctions.length > 0) {
      console.log('   Most recent:', allFunctions[0].name)
    }

    // Step 3: List Sandboxes
    console.log('\n3. Listing Sandboxes...')
    const http = buildfunctions.getHttpClient()
    const sandboxes = await http.get('/api/sdk/sandbox')
    console.log('   CPU Sandboxes:', sandboxes.cpuCount || 0)
    console.log('   GPU Sandboxes:', sandboxes.gpuCount || 0)

    console.log('\nSDK Authentication test completed!')

  } catch (error) {
    console.error('\nTest failed:', error.message)
    process.exit(1)
  }
}

testAuth()
