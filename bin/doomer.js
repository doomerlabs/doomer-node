#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (process.argv.includes('--json')) console.error(JSON.stringify({ error: { code: error.code || 'command_failed', message: error.message, ...(error.recovery ? { recovery: error.recovery } : {}) } }));
  else {
    console.error(`Doomer: ${error.message}`);
    if (error.recovery) console.error(`${error.recovery.message}\nRun: ${error.recovery.command}`);
  }
  process.exitCode = 1;
}
