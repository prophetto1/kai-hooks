#!/usr/bin/env node
// Validates the E:/hooks runtime control-plane files without external packages.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { generateConfigSchema, validateConfig } from './config-model.mjs';

const CONFIG_PATH = process.env.HOOKS_CONFIG_PATH || 'E:/hooks/config.json';
const SCHEMA_PATH = 'E:/hooks/config.schema.json';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}

function add(errors, condition, message) {
  if (!condition) errors.push(message);
}

function warningsForPaths(config) {
  const warnings = [];
  const hooksDir = config.shared?.paths?.hooksDir;
  if (typeof hooksDir !== 'string' || !existsSync(hooksDir)) {
    return { warnings, errors: ['shared.paths.hooksDir missing on disk'] };
  }

  const errors = [];
  for (const hook of config.hooks || []) {
    if (!hook.script?.path) continue;
    const path = join(hooksDir, hook.script.path);
    if (existsSync(path)) continue;
    const message = `hook script missing: ${path}`;
    if (hook.enabled === false) warnings.push(`${message} (disabled hook)`);
    else errors.push(message);
  }

  for (const script of config.scripts || []) {
    if (!script.script?.path) continue;
    const path = join(hooksDir, script.script.path);
    if (existsSync(path)) continue;
    const message = `script missing: ${path}`;
    if (script.enabled === false) warnings.push(`${message} (disabled script)`);
    else errors.push(message);
  }

  const protocolFile = (config.hooks || [])
    .find((hook) => hook?.id === 'inject-protocol')
    ?.settings?.sources?.protocol?.file;
  if (protocolFile) {
    const injectDir = dirname(join(hooksDir, 'inject-protocol/inject-protocol.mjs'));
    add(errors, existsSync(join(injectDir, protocolFile)), `protocol file missing: ${join(injectDir, protocolFile)}`);
  }

  return { warnings, errors };
}

function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

function main() {
  const errors = [];
  const warnings = [];
  const config = readJson(CONFIG_PATH);
  const schema = readJson(SCHEMA_PATH);
  const expectedSchema = generateConfigSchema();

  add(errors, stableStringify(schema) === stableStringify(expectedSchema), 'config.schema.json is not generated from _core/config-model.mjs');
  add(errors, config.$schema === './config.schema.json', 'config.$schema must point to ./config.schema.json');

  const modelResult = validateConfig(config);
  errors.push(...modelResult.errors);

  const pathResult = warningsForPaths(config);
  warnings.push(...pathResult.warnings);
  errors.push(...pathResult.errors);

  for (const warning of warnings) console.warn(`Warning: ${warning}`);
  if (errors.length) {
    console.error(`Runtime hook validation failed (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    return 1;
  }
  console.log('Runtime hook validation passed');
  return 0;
}

process.exitCode = main();
