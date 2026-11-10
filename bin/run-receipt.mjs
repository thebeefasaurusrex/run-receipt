#!/usr/bin/env node
import { probe } from '../lib/probe.mjs';

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help' || args[0] === '-h') {
  console.log("Usage: run-receipt <list | run | last | show> [check IDs] [--cwd <path>]");
} else {
  try {
    process.exitCode = await probe(args);
  } catch (error) {
    console.error('ERROR ' + String(error.message).replace(/\s+/g, ' ').slice(0, 500));
    process.exitCode = 2;
  }
}
