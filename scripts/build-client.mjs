import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

// DSH serves client entries as classic scripts, not native ESM modules.
const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: 'client.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText;
const code = `window.__ModuleLoader__.load({ id: "dsh-codebuddy-link", factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n${compiled}\nreturn module.exports;\n} });\n`;
writeFileSync(new URL('../dist/client.js', import.meta.url), code);
// tsc's earlier ESM source map does not describe the factory output.
writeFileSync(new URL('../dist/client.js.map', import.meta.url), JSON.stringify({ version: 3, sources: [], names: [], mappings: '' }));
