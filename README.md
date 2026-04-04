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

> The Buildfunctions SDK provides a client interface for interacting with the Buildfunctions platform

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

## Runtime Controls: Help Keep Your Agent Running Unattended

Wrap any tool call with composable guardrails — no API key required, no sandbox needed. RuntimeControls works standalone around your own functions, or combined with Buildfunctions sandboxes.

**Available control layers (configure per workflow):**
retries with backoff, per-run tool-call budgets, circuit breakers, loop detection, timeout + cancellation, policy gates, injection guards, idempotency, concurrency locks, and event-based observability via event sinks.

### 1. Wrap Any Tool Call (No API Key)

```javascript
import { RuntimeControls } from 'buildfunctions'

const controls = RuntimeControls.create({
  maxToolCalls: 50,
  timeoutMs: 30_000,
  retry: { maxAttempts: 3, initialDelayMs: 200, backoffFactor: 2 },
  loopBreaker: { warningThreshold: 5, quarantineThreshold: 8, stopThreshold: 12 },
  onEvent: (event) => console.log(`[controls] ${event.type}: ${event.message}`),
})

// Wrap any function — an API call, a shell command, an LLM tool invocation
const guardedFetch = controls.wrap({
  toolName: 'api-call',
  runKey: 'agent-run-1',
  destination: 'https://api.example.com',
  run: async ([payload]) => {
    const res = await fetch('https://api.example.com/data', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return res.json()
  },
})

const result = await guardedFetch({ query: 'latest results' })
console.log(result)

// Reset budget counters when starting a new run
await controls.reset('agent-run-1')
```

### 2. With Hardware-Isolated Sandbox + Agent Safety

```javascript
import { Buildfunctions, CPUSandbox, RuntimeControls, applyAgentLogicSafety } from 'buildfunctions'

await Buildfunctions({ apiToken: process.env.BUILDFUNCTIONS_API_TOKEN })

const sandbox = await CPUSandbox.create({
  name: 'guarded-sandbox',
  language: 'python',
  code: './my_handler.py',
  memory: 128,
  timeout: 30,
})

const controls = RuntimeControls.create(
  applyAgentLogicSafety(
    {
      maxToolCalls: 20,
      retry: { maxAttempts: 2, initialDelayMs: 200, backoffFactor: 2 },
      onEvent: (event) => console.log(`[controls] ${event.type}: ${event.message}`),
    },
    {
      injectionGuard: {
        enabled: true,
        patterns: [/ignore\s+previous\s+instructions/i, /\brm\s+-rf\b/i],
      },
    }
  )
)

const result = await controls.run(
  {
    toolName: 'cpu-sandbox-run',
    runKey: 'sandbox-run-1',
    destination: sandbox.endpoint,
    action: 'execute',
  },
  async () => sandbox.run()
)

console.log('Result:', JSON.stringify(result, null, 2))
await sandbox.delete()
```

## Documentation

Full runtime controls documentation: https://www.buildfunctions.com/docs/runtime-controls

## Beta Status

The SDK is currently in beta. If you encounter any issues or have specific syntax requirements, please reach out and contact us at team@buildfunctions.com, and we’ll work to address them.

## Terms

Runtime controls are provided as best-effort tools to help manage application behavior and resource usage. They do not guarantee prevention of all unintended outcomes. Users are responsible for monitoring their own workloads. See our [Terms of Service](https://www.buildfunctions.com/terms-of-service) for full details.

By using this SDK, you agree to the [Terms of Service](https://www.buildfunctions.com/terms-of-service).

## License

Licensed under the Apache License, Version 2.0. See LICENSE for the full license text.
