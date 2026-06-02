#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

import { generateConfigSchema } from './config-model.mjs';

const outPath = process.argv[2] || 'E:/hooks/config.schema.json';
const schema = generateConfigSchema();
writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
console.log(`Generated ${outPath}`);
