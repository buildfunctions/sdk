#!/usr/bin/env node

/**
 * Buildfunctions CLI
 */
import test from './test.js';

declare const console: any, process: any;

// Available commands
const commands: Record<string, () => string> = {
  test,
};

// Get command from arguments
const command = process.argv[2];

if (command && commands[command]) {
  console.log(commands[command]!());
} else {
  console.log('Available commands: test');
}
