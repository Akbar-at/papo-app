import { readFileSync, writeFileSync } from 'node:fs';

const contract = readFileSync(new URL('../../../packages/contracts/openapi.yaml', import.meta.url), 'utf8');
writeFileSync(new URL('../src/contract.generated.ts', import.meta.url),
  `// Generated from packages/contracts/openapi.yaml. Do not edit by hand.\nexport const openapiYaml = ${JSON.stringify(contract)};\n`);
