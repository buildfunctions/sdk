import 'dotenv/config'
import { Buildfunctions, Model } from '../../dist/index.js'
// import { Buildfunctions, Model } from 'buildfunctions'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testModelUpload() {
  console.log('Testing Model Upload...\n')

  if (!API_TOKEN) {
    console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in .env file')
    process.exit(1)
  }

  let model = null

  try {
    // Step 1: Authenticate
    console.log('1. Authenticating...')
    const buildfunctions = await Buildfunctions({ apiToken: API_TOKEN })
    console.log('   Authenticated as:', buildfunctions.user.username)

    // Step 2: Upload model
    console.log('\n2. Uploading model...')

    model = await Model.create({
      path: '/path/to/models/Llama-3.2-3B-Instruct-bnb-4bit',
      name: "remote-model-for-sdk-test"
    })
    console.log('   Model uploaded')
    console.log('   ID:', model.id)
    console.log('   Name:', model.name)

    console.log('\nModel upload test completed!')

  } catch (error) {
    console.error('\nTest failed:', error.message)
    if (error.stack) {
      console.error('Stack:', error.stack)
    }

    process.exit(1)
  }
}

testModelUpload()
