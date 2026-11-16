#!/usr/bin/env node
// Writes commands.json from src/library/commands.js manifest(). Run after changing a command.
// tests/test-commands.mjs fails when the file and the manifest differ.
import { writeFileSync } from 'node:fs';
import { manifest } from '../src/library/commands.js';
const out = new URL('../commands.json', import.meta.url);
writeFileSync(out, JSON.stringify(manifest(), null, 2) + '\n');
console.log(`commands.json: ${manifest().commands.length} commands`);
