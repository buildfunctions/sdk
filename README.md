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

const buildfunctions = await Buildfunctions({ apiToken: process.env.BUILDFUNCTIONS_API_TOKEN })
```

### 3. Create a GPU Sandbox

```javascript
// Create a GPU Sandbox with Python and PyTorch
const sandbox = await GPUSandbox.create({
  name: 'my-gpu-sandbox',
  language: 'python',
  code: './inference.py',
  memory: 10000,
  timeout: 300,
  model: '/path/to/local/model',
  requirements: 'torch'
})

// Run the sandbox
const result = await sandbox.run()

// Clean up
await sandbox.delete()
```

The SDK is currently in beta.