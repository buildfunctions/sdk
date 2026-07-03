import 'dotenv/config'
import { Buildfunctions, Model } from '../../dist/index.js'
// import { Buildfunctions, Model } from 'buildfunctions'

const API_TOKEN = process.env.BUILDFUNCTIONS_API_TOKEN

async function testModelDelete() {
    console.log('Testing Model Delete...\n')

    if (!API_TOKEN) {
        console.error('Error: Set BUILDFUNCTIONS_API_TOKEN in .env file')
        process.exit(1)
    }

    let deployedModel = null

    try {
        // Step 1: Authenticate
        console.log('1. Authenticating...')
        const buildfunctions = await Buildfunctions({ apiToken: API_TOKEN })
        console.log('   Authenticated as:', buildfunctions.user.username)

        // List all models (typed SDK)
        console.log('\nListing all Models...')
        const allModels = await Model.list()
        console.log('   Total Models:', allModels.length)

        // Step 2: Find model
        console.log('\n2. Finding model...')

        deployedModel = await Model.findUnique({
            where: { name: "remote-model-for-sdk-test" }
        })

        if (!deployedModel) {
            console.log('   Model not found')
            process.exit(0)
        }

        console.log('   Model found')
        console.log('   ID:', deployedModel.id)
        console.log('   Name:', deployedModel.name)

        // Step 3: Delete model
        console.log('\n3. Deleting model...')
        await deployedModel.delete()
        console.log('   Model deleted')
        deployedModel = null

        console.log('\nModel delete test completed!')

    } catch (error) {
        console.error('\nTest failed:', error.message)
        if (error.stack) {
            console.error('Stack:', error.stack)
        }

        if (deployedModel) {
            console.log('Attempting cleanup...')
            try {
                await deployedModel.delete()
                console.log('   Model deleted')
            } catch (e) {
                console.error('Cleanup failed:', e.message)
            }
        }

        process.exit(1)
    }
}

testModelDelete()
