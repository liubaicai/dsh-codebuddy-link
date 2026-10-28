import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const send = object => process.stdout.write(JSON.stringify(object) + '\n');
if (input === 'hang' || input.startsWith('tree:') || input.startsWith('yield-tree:')) {
  if (input.includes('tree:')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(input.slice(input.indexOf(':') + 1), String(child.pid));
    if (input.startsWith('yield-tree:')) send({ type: 'assistant', message: { content: [{ type: 'text', text: 'ready' }] } });
  }
  setInterval(() => {}, 1000);
} else if (input === 'error') {
  process.stderr.write('SECRET_TOKEN'.repeat(20000));
  process.exitCode = 7;
} else if (input === 'malformed') {
  process.stdout.write('{not json');
} else if (input === 'missing') {
  send({ type: 'system', subtype: 'init' });
} else if (input === 'protocol-error') {
  send({ type: 'result', is_error: true, errors: ['401 SECRET_TOKEN'] });
} else {
  send({ type: 'system', subtype: 'init', session_id: 'test-session' });
  const text = input === 'argv' ? JSON.stringify(process.argv.slice(2)) : input === 'env' ? (process.env.CODEBUDDY_AUTH_TOKEN ?? 'ABSENT') : input;
  const bytes = Buffer.from(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text }], usage: { input_tokens: 2, output_tokens: 3 } } }) + '\n');
  for (let i = 0; i < bytes.length; i++) process.stdout.write(bytes.subarray(i, i + 1));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: text, usage: { input_tokens: 2, output_tokens: 3 }, structured_output: { ok: true } }));
}
