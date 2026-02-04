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

### 2. CPU Function

```javascript
import { Buildfunctions, CPUFunction } from 'buildfunctions'

const buildfunctions = await Buildfunctions({ apiToken: process.env.BUILDFUNCTIONS_API_TOKEN })

const deployedFunction = await CPUFunction.create({
  name: 'my-cpu-function',
  code: './cpu_function_code.py',
  language: 'python',
  memory: 128,
  timeout: 30
})

console.log('Endpoint:', deployedFunction.endpoint)

await deployedFunction.delete()
```

### 3. CPU Sandbox

```javascript
import { Buildfunctions, CPUSandbox } from 'buildfunctions'

const buildfunctions = await Buildfunctions({ apiToken: process.env.BUILDFUNCTIONS_API_TOKEN })

const sandbox = await CPUSandbox.create({
  name: 'my-cpu-sandbox',
  language: 'python',
  code: '/path/to/code/cpu_sandbox_code.py',
  memory: 128,
  timeout: 30,
})

const result = await sandbox.run()
console.log('Result:', result)

await sandbox.delete()
```

### 4. GPU Function

```javascript
import { Buildfunctions, GPUFunction } from 'buildfunctions'

const buildfunctions = await Buildfunctions({ apiToken: process.env.BUILDFUNCTIONS_API_TOKEN })

const deployedFunction = await GPUFunction.create({
  name: 'my-gpu-function',
  code: '/path/to/code/gpu_function_code.py',
  language: 'python',
  gpu: 'T4',
  vcpus: 30,
  memory: "50000MB",
  timeout: 300,
  requirements: ['transformers==4.47.1', 'torch', 'accelerate'],
})

console.log('Endpoint:', deployedFunction.endpoint)

await deployedFunction.delete()
```

### 5. GPU Sandbox with Local Model

```javascript
import { Buildfunctions, GPUSandbox } from 'buildfunctions'

const buildfunctions = await Buildfunctions({ apiToken: process.env.BUILDFUNCTIONS_API_TOKEN })

const sandbox = await GPUSandbox.create({
  name: 'my-gpu-sandbox',
  language: 'python',
  memory: 10000,
  timeout: 300,
  vcpus: 6,
  code: './gpu_sandbox_code.py',
  model: '/path/to/models/Qwen/Qwen3-8B',
  requirements: "torch"
})

const result = await sandbox.run()
console.log('Result:', result)

await sandbox.delete()
```

The SDK is currently in beta.