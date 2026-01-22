<p align="center">
  <h1 align="center">
  <a href="https://www.buildfunctions.com" target="_blank">
    <img src="./public/readme/buildfunctions-header.svg" alt="logo" width="900">
  </a>
  </h1>
</p>

<h1 align="center">The Buildfunctions SDK for Agents</h1>

<p align="center">
  <!-- <a href="https://discord.com/users/buildfunctions" target="_blank">
    <img src="./public/readme/discord-button.png" height="32" />
  </a>&nbsp; -->
  <a href="https://www.buildfunctions.com/docs/sdk/quickstart" target="_blank">
    <img src="./public/readme/read-the-docs-button.png" height="32" />
  </a>&nbsp;
</p>

<p align="center">
<a href="https://www.npmjs.com/package/buildfunctions" target="_blank">
  <img src="https://img.shields.io/badge/npm-@buildfunctions-green">
</a>
</p>

<p align="center">
  <h1 align="center">
  <a href="https://www.buildfunctions.com" target="_blank">
    <img src="./public/readme/buildfunctions-logo-and-servers-dark.svg" alt="logo" width="900">
  </a>
  </h1>
</p>

> Hardware-isolated execution environments for AI agents

## Installation

```bash
npm install buildfunctions
```

## Quick Start

### 1. Create an API Token

Get your API token at [buildfunctions.com/settings](https://www.buildfunctions.com/settings)

### 2. Authenticate

```javascript
import { Buildfunctions, GPUSandbox } from 'buildfunctions'

const apiKey = process.env.BUILDFUNCTIONS_API_KEY

// Initialize
const buildfunctions = new Buildfunctions({ apiKey })
if (!buildfunctions) {
  throw new Error('Failed to initialize Buildfunctions SDK')
}
```

### 3. Create a GPU Sandbox

```javascript
...
// Create a GPU Sandbox with Python and PyTorch 
const sandbox = await GPUSandbox.create({
  name: 'secure-agent-action',
  memory: "64GB",
  vcpu: 32,
  timeout: 1200,
  language: 'python',
  requirements: ['transformers', 'torch', 'accelerate'],
  model: './Qwen/Qwen3-8B', // model path (local or remote)
})

// Upload inference script from path (or just inline code)
await sandbox.upload({ filePath: 'inference_script.py' })

// Run script in a hardware-isolated virtual machine with full GPU access
const result = await sandbox.run(
  `python inference_script.py "${prompt}"`
)
...
```

The SDK is currently in beta.
