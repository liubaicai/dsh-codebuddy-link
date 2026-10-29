import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';


type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
type Reply = { ok?: boolean; status?: number; value?: unknown; error?: Error; wait?: Promise<void> };
// Normal runs exercise the shipped classic script. Source mode permits isolated UI
// tests while another worker owns dist, using the same wrapper/compiler options.
const code = process.env.DSH_CODEBUDDY_TEST_CLIENT_SOURCE === '1'
  ? `window.__ModuleLoader__.load({id:"dsh-codebuddy-link",factory:(require)=>{var module={exports:{}};var exports=module.exports;${ts.transpileModule(readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText}\nreturn module.exports;}});`
  : readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8');
const payload = () => ({
  config: { enabled: true, permissionMode: 'dontAsk', models: ['basic', 'hidden', 'custom'], hiddenModels: ['hidden'], defaultModel: 'basic', tools: 'Read,Edit' },
  account: { status: 'ok' },
  catalogModels: [{ id: 'basic', name: '基础模型' }, { id: 'hidden', name: '隐藏模型' }],
});

function harness(replies: Reply[] = [{ value: payload() }]) {
  let cursor = 0;
  const state: any[] = [];
  const effects: (() => void | (() => void))[] = [];
  const setups: (() => void | (() => void))[] = [];
  const cleanup: (() => void)[] = [];
  const calls: { url: string; init: any }[] = [];
  const registrations: { options: any; component: (props?: unknown) => unknown }[] = [];
  const disposers: (() => void)[] = [];
  let disposed = 0;
  let exported: any;
  let factory: any;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const sandbox = {
    setInterval: (callback: () => void, delay: number) => { assert.equal(delay, 2000); const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval: (id: number) => { timers.delete(id); },
    window: { __ModuleLoader__: { load: (entry: any) => {
      assert.equal(entry.id, 'dsh-codebuddy-link');
      assert.equal(typeof entry.factory, 'function');
      factory = entry.factory;
    } } },
    Error,
    URL,
    require: (id: string) => {
      assert.equal(id, 'react');
      return {
        createElement: (type: unknown, props: Record<string, any> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children: children.flat() }),
        useState: (initial: unknown) => {
          const index = cursor++;
          if (!(index in state)) state[index] = initial;
          return [state[index], (next: unknown) => { state[index] = typeof next === 'function' ? next(state[index]) : next; }];
        },
        useRef: (initial: unknown) => {
          const index = cursor++;
          if (!(index in state)) state[index] = { current: initial };
          return state[index];
        },
        useEffect: (effect: () => void | (() => void)) => {
          const index = cursor++;
          if (!(index in state)) { state[index] = true; effects.push(effect); setups.push(effect); }
        },
      };
    },
    AbortSignal: { timeout: (ms: number) => ({ timeout: ms }) },
    fetch: async (url: string, init: any) => {
      calls.push({ url, init });
      const reply = replies.shift();
      if (!reply) throw new Error('Unexpected request');
      if (reply.wait) await reply.wait;
      if (reply.error) throw reply.error;
      return { ok: reply.ok ?? true, status: reply.status ?? 200, json: async () => reply.value };
    },
  };
  runInNewContext(code, { ...sandbox, require: undefined });
  assert.equal(typeof factory, 'function');
  exported = factory(sandbox.require);
  assert.equal(typeof exported.apply, 'function');
  exported.apply({ slots: {
    inject: (_slot: string, register: () => () => void) => disposers.push(register()),
    register: (options: any, component: (props?: unknown) => unknown) => { registrations.push({ options, component }); return () => { disposed++; }; },
  } });
  function render(): Element {
    cursor = 0;
    const tree = registrations[0]!.component() as Element;
    while (effects.length) { const dispose = effects.shift()!(); if (dispose) cleanup.push(dispose); }
    return tree;
  }
  return { exported, registrations, disposers, calls, state, render, cleanup, timers,
    remount: () => { cleanup.splice(0).forEach(dispose => dispose()); for (const setup of setups) { const dispose = setup(); if (dispose) cleanup.push(dispose); } },
    tick: () => { for (const callback of timers.values()) callback(); }, disposed: () => disposed };
}
// Successful default account: mount reads status, refreshes account, then models.
function mounted(replies: Reply[] = [{ value: payload() }]) {
  const [initial, ...rest] = replies;
  return harness([initial!, initial!, initial!, ...rest]);
}
function nodes(tree: unknown): Element[] {
  if (!tree || typeof tree !== 'object' || !('children' in tree)) return [];
  const element = tree as Element;
  return [element, ...element.children.flatMap(nodes)];
}
function content(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return nodes(tree).flatMap(node => node.children.filter(value => typeof value === 'string' || typeof value === 'number')).join(' ');
}
function button(tree: Element, title: string): Element { return nodes(tree).find(node => node.type === 'button' && content(node).includes(title))!; }
function control(tree: Element, label: string, type: string): Element {
  const parent = nodes(tree).find(node => node.type === 'label' && node.children.includes(label));
  assert.ok(parent, label);
  return nodes(parent).find(node => node.type === type)!;
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('credit display uses two decimals without modifying response values', async () => {
  const response = { ...payload(), account: { status: 'ok', remaining: 12.3456, total: 20, used: 7.6544 } };
  const app = mounted([{ value: response }]); app.render(); await settle();
  const shown = content(app.render());
  assert.match(shown, /剩余：12\.35/); assert.match(shown, /总额：20\.00/); assert.match(shown, /已用：7\.65/);
  assert.equal(response.account.remaining, 12.3456);
});

test('discovered models can be selected and saved without typing IDs', async () => {
  const result = { ...payload(), catalogModels: [...payload().catalogModels, { id: 'discovered-id', name: 'Discovered' }] };
  const app = mounted([{ value: payload() }, { value: result }, { value: result }]);
  app.render(); await settle();
  let tree = app.render();
  button(tree, '获取模型列表').props.onClick(); await settle();
  tree = app.render();
  const label = nodes(tree).find(n => n.type === 'label' && content(n).includes('Discovered'))!;
  const checkbox = nodes(label).find(n => n.type === 'input')!;
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  tree = app.render();
  control(tree, '默认模型', 'select').props.onChange({ target: { value: 'discovered-id' } });
  tree = app.render(); button(tree, '保存设置').props.onClick(); await settle();
  assert.equal(app.calls[3]!.url, '/plugins/codebuddy-link/models');
  const saved = JSON.parse(app.calls[4]!.init.body);
  assert.ok(saved.models.includes('discovered-id'));
  assert.equal(saved.defaultModel, 'discovered-id');
  for (const n of nodes(tree).filter(n => ['button', 'select', 'textarea', 'input'].includes(String(n.type)))) assert.ok(n.props.style);
});

test('settings inherit host theme and heading rows align without asymmetric margins', async () => {
  const app = mounted(); app.render(); await settle(); const tree = app.render();
  assert.equal((tree.props.style as any).color, 'var(--dsw-alias-label-primary, inherit)');
  for (const title of ['账户与积分', '启用模型']) {
    const heading = nodes(tree).find(n => n.type === 'h3' && content(n) === title)!;
    assert.equal((heading.props.style as any).margin, 0);
    const parent = nodes(tree).find(n => n.children.includes(heading))!;
    assert.equal((parent.props.style as any).alignItems, 'center');
  }
  const styles = JSON.stringify(nodes(tree).map(n => n.props.style));
  assert.doesNotMatch(styles, /#202020|#646464|#f9f9fb|#fff9ed/);
  assert.match(styles, /--dsw-alias-bg-layer-1/);
});

test('registers all native slots with exact keys and disposer propagation', () => {
  const app = harness();
  assert.equal(app.exported.name, 'dsh-codebuddy-link-client');
  assert.deepEqual(Array.from(app.exported.inject), ['slots']);
  assert.deepEqual(app.registrations.map(item => [item.options.name, item.options.id ?? item.options.key]), [
    ['settings.section', 'codebuddy-link'], ['plugins.bundle.config', 'dsh-codebuddy-link'], ['plugins.row.config', 'dsh-codebuddy-link#codebuddy-link'],
  ]);
  for (const registration of app.registrations.slice(1)) {
    assert.equal(registration.component({ view: 'summary' }), null);
    assert.equal((registration.component({ view: 'detail' }) as Element).type, app.registrations[0]!.component);
  }
  app.disposers.forEach(dispose => dispose());
  assert.equal(app.disposed(), 3);
  assert.equal(app.calls.length, 0);
});

test('mount refreshes account then models once; unknown credits remain unknown', async () => {
  const app = mounted();
  assert.match(content(app.render()), /加载中/);
  await settle();
  const tree = app.render();
  assert.match(content(tree), /剩余：未知.*总额：未知.*已用：未知/);
  assert.match(content(tree), /WorkBuddy.*以接口返回为准/);
  assert.match(content(tree), /权限模式用于独立委派 CodeBuddy 工具与 ACP CLI（未跳过权限检查时）/);
  app.render();
  assert.equal(app.calls.length, 3);
  assert.equal(app.calls[0]!.url, '/plugins/codebuddy-link/status');
  assert.equal(app.calls[0]!.init.method, 'GET');
  assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/models']);
  for (const call of app.calls) {
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.mode, 'same-origin');
    assert.equal(call.init.signal.timeout, 20_000);
  }
  for (const call of app.calls.slice(1)) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.body, '{}');
  }
});

test('explicit refresh posts JSON, displays real zero, and preserves unsaved edits', async () => {
  const refreshed = { ...payload(), account: { status: 'ok', remaining: 0, used: 5, total: 5, message: '<img src=x onerror=alert(1)>' } };
  const app = mounted([{ value: payload() }, { value: refreshed }, { value: refreshed }]);
  app.render(); await settle();
  control(app.render(), '权限模式', 'select').props.onChange({ target: { value: 'plan' } });
  button(app.render(), '刷新账户').props.onClick();
  assert.match(content(app.render()), /刷新中/);
  await settle();
  const tree = app.render();
  assert.equal(control(tree, '权限模式', 'select').props.value, 'plan');
  assert.match(content(tree), /剩余：0/);
  assert.match(content(tree), /<img src=x onerror=alert\(1\)>/);
  assert.ok(nodes(tree).every(node => !('dangerouslySetInnerHTML' in node.props) && node.type !== 'img'));
  const call = app.calls[3]!;
  assert.equal(call.url, '/plugins/codebuddy-link/refresh');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(call.init.body, '{}');
  assert.equal(call.init.method, 'POST');
});

test('custom models, visibility, default and tools serialize exact config contract', async () => {
  const app = mounted([{ value: payload() }, { value: payload() }]);
  app.render(); await settle();
  let tree = app.render();
  const checks = nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.name !== 'dangerouslySkipPermissions');
  assert.deepEqual(checks.map(node => node.props.checked), [true, false, true]);
  checks[0]!.props.onChange({ target: { checked: false } });
  assert.equal(control(app.render(), '默认模型', 'select').props.value, 'custom');
  assert.match(content(app.render()), /启用后不受DSH文件沙箱约束，默认留空/);
  control(app.render(), '自定义模型 ID', 'input').props.onChange({ target: { value: ' new-model ' } });
  button(app.render(), '添加并启用模型').props.onClick();
  tree = app.render();
  control(tree, '默认模型', 'select').props.onChange({ target: { value: 'new-model' } });
  control(app.render(), '权限模式', 'select').props.onChange({ target: { value: 'acceptEdits' } });
  control(app.render(), '独立委派工具配置（tools）', 'input').props.onChange({ target: { value: 'Read' } });
  button(app.render(), '保存设置').props.onClick();
  // A second click before React renders is coalesced by the in-flight ref.
  button(app.render(), '保存设置').props.onClick();
  await settle();
  assert.equal(app.calls.length, 4);
  assert.equal(app.calls[3]!.url, '/plugins/codebuddy-link/config');
  assert.deepEqual(JSON.parse(app.calls[3]!.init.body), { permissionMode: 'acceptEdits', dangerouslySkipPermissions: false, models: ['basic', 'hidden', 'custom', 'new-model'], hiddenModels: ['hidden', 'basic'], defaultModel: 'new-model', tools: 'Read', reasoningEffort:'auto', maxConcurrency:2, queueTimeoutMs:600000, stallWarnMs:90000 });
  assert.match(content(app.render()), /设置已保存/);
});

test('HTTP errors are visible without reporting success or discarding edits', async () => {
  const app = mounted([{ value: payload() }, { ok: false, status: 403 }]);
  app.render(); await settle();
  control(app.render(), '权限模式', 'select').props.onChange({ target: { value: 'plan' } });
  button(app.render(), '保存设置').props.onClick(); await settle();
  const tree = app.render();
  assert.match(content(tree), /HTTP 403/);
  assert.doesNotMatch(content(tree), /设置已保存/);
  assert.equal(control(tree, '权限模式', 'select').props.value, 'plan');
  assert.equal(button(tree, '保存设置').props.disabled, false);
});

test('hiding every model requires a nonempty enabled default before saving', async () => {
  const app = mounted();
  app.render(); await settle();
  let checks = nodes(app.render()).filter(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.name !== 'dangerouslySkipPermissions');
  checks[0]!.props.onChange({ target: { checked: false } });
  checks = nodes(app.render()).filter(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.name !== 'dangerouslySkipPermissions');
  checks[2]!.props.onChange({ target: { checked: false } });
  let tree = app.render();
  assert.equal(control(tree, '默认模型', 'select').props.value, '');
  assert.equal(button(tree, '保存设置').props.disabled, true);
  const placeholder = nodes(control(tree, '默认模型', 'select')).find(node => node.type === 'option' && node.props.value === '');
  assert.equal(placeholder?.props.disabled, true);
  assert.match(content(placeholder), /请选择/);
  checks = nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox' && node.props.name !== 'dangerouslySkipPermissions');
  checks[0]!.props.onChange({ target: { checked: true } });
  control(app.render(), '默认模型', 'select').props.onChange({ target: { value: 'basic' } });
  tree = app.render();
  assert.equal(button(tree, '保存设置').props.disabled, false);
});

test('HTTP 400 error detail is limited to 300 characters and rendered as plain text', async () => {
  const detail = '<img src=x onerror=alert(1)>' + '错'.repeat(400);
  const app = mounted([{ value: payload() }, { ok: false, status: 400, value: { error: detail } }]);
  app.render(); await settle();
  button(app.render(), '保存设置').props.onClick(); await settle();
  const tree = app.render();
  const alert = nodes(tree).find(node => node.props.role === 'alert');
  assert.equal(content(alert), `请求失败（HTTP 400）：${detail.slice(0, 300)}`);
  assert.ok(nodes(tree).every(node => !('dangerouslySetInnerHTML' in node.props) && node.type !== 'img'));
});

test('invalid response and network errors expose retry, then recover', async () => {
  const app = harness([{ value: { config: {} } }, { error: new Error('timeout') }, { value: payload() }, { value: payload() }, { value: payload() }]);
  app.render(); await settle();
  assert.match(content(app.render()), /服务端状态格式无效/);
  button(app.render(), '重试加载').props.onClick(); await settle();
  assert.match(content(app.render()), /timeout/);
  button(app.render(), '重试加载').props.onClick(); await settle();
  assert.ok(button(app.render(), '保存设置'));
  assert.equal(app.calls.length, 5);
});

test('auth import uses its own contract, clears JSON and preserves the model draft without exposing returned tokens', async () => {
  const secret = 'TOP-SECRET-TOKEN';
  const app = mounted([{ value: payload() }, { value: { configured: true, token: secret } },
    { value: { ...payload(), auth: { configured: true }, token: secret } },
    { value: { ...payload(), auth: { configured: true }, token: secret } }]);
  app.render(); await settle();
  assert.match(content(app.render()), /积分查询凭据：未配置/);
  control(app.render(), '权限模式', 'select').props.onChange({ target: { value: 'plan' } });
  control(app.render(), '导入登录 JSON', 'textarea').props.onChange({ target: { value: JSON.stringify({ token: secret }) } });
  button(app.render(), '导入登录信息').props.onClick();
  button(app.render(), '导入登录信息').props.onClick();
  await settle();
  const tree = app.render();
  assert.equal(app.calls.length, 6);
  assert.equal(app.calls[3]!.url, '/plugins/codebuddy-link/auth/import');
  assert.deepEqual(JSON.parse(app.calls[3]!.init.body), { content: JSON.stringify({ token: secret }) });
  assert.equal(app.calls[4]!.url, '/plugins/codebuddy-link/refresh');
  assert.equal(app.calls[5]!.url, '/plugins/codebuddy-link/models');
  assert.equal(control(tree, '导入登录 JSON', 'textarea').props.value, '');
  assert.equal(control(tree, '权限模式', 'select').props.value, 'plan');
  assert.match(content(tree), /积分查询凭据：已配置/);
  assert.match(content(tree), /不改变 CodeBuddy CLI 登录/);
  assert.doesNotMatch(JSON.stringify(tree), new RegExp(secret));
  assert.doesNotMatch(code, /\b(?:localStorage|console)\b/);
});

const startReply = (verificationUri = 'https://www.codebuddy.cn/oauth/authorize?state=example') => ({
  flowId: 'private-flow-id', verificationUri, expiresIn: 599, interval: 2, token: 'SHOULD-NOT-RENDER',
});

test('OAuth starts only on click, links safely, checks manually and refreshes on success', async () => {
  const app = mounted([{ value: payload() }, { value: startReply() }, { value: { status: 'pending', interval: 2 } },
    { value: { status: 'ok', token: 'SHOULD-NOT-RENDER' } }, { value: { ...payload(), auth: { configured: true } } },
    { value: { ...payload(), auth: { configured: true } } }]);
  app.render(); await settle();
  control(app.render(), '导入登录 JSON', 'textarea').props.onChange({ target: { value: '{"token":"draft-secret"}' } });
  control(app.render(), '权限模式', 'select').props.onChange({ target: { value: 'plan' } });
  assert.equal(app.calls.length, 3);
  button(app.render(), '使用 OAuth 登录').props.onClick(); await settle();
  let tree = app.render();
  const link = nodes(tree).find(node => node.type === 'a')!;
  assert.equal(link.props.href, startReply().verificationUri);
  assert.equal(link.props.target, '_blank');
  assert.equal(link.props.rel, 'noopener noreferrer');
  assert.equal(app.calls[3]!.init.body, '{}');
  assert.doesNotMatch(content(tree), /SHOULD-NOT-RENDER|private-flow-id/);
  app.render(); await settle();
  assert.equal(app.calls.length, 4);
  button(tree, '检查登录结果').props.onClick(); await settle();
  assert.match(content(app.render()), /尚未完成登录/);
  assert.deepEqual(JSON.parse(app.calls[4]!.init.body), { flowId: 'private-flow-id' });
  button(app.render(), '检查登录结果').props.onClick(); await settle();
  tree = app.render();
  assert.equal(control(tree, '导入登录 JSON', 'textarea').props.value, '');
  assert.equal(control(tree, '权限模式', 'select').props.value, 'plan');
  assert.equal(nodes(tree).filter(node => node.type === 'a').length, 0);
  assert.match(content(tree), /积分查询凭据：已配置/);
  assert.doesNotMatch(JSON.stringify(tree), /SHOULD-NOT-RENDER|draft-secret/);
  assert.equal(app.calls.length, 8);
  assert.deepEqual(app.calls.slice(-2).map(call => call.url), ['/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/models']);
});

test('cancel clears pasted JSON without clearing existing credentials; explicit clear refreshes status', async () => {
  const configured = { ...payload(), auth: { configured: true } };
  const app = mounted([{ value: configured }, { value: startReply() }, { value: { status: 'cancelled' } },
    { value: { configured: false } }, { value: payload() }]);
  app.render(); await settle();
  control(app.render(), '导入登录 JSON', 'textarea').props.onChange({ target: { value: '{"token":"secret"}' } });
  button(app.render(), '使用 OAuth 登录').props.onClick(); await settle();
  button(app.render(), '取消登录').props.onClick(); await settle();
  assert.equal(control(app.render(), '导入登录 JSON', 'textarea').props.value, '');
  assert.match(content(app.render()), /积分查询凭据：已配置/);
  assert.equal(app.calls[4]!.url, '/plugins/codebuddy-link/auth/cancel');
  assert.deepEqual(JSON.parse(app.calls[4]!.init.body), { flowId: 'private-flow-id' });
  assert.equal(app.calls.length, 5);
  button(app.render(), '清除积分查询凭据').props.onClick(); await settle();
  assert.equal(app.calls[5]!.url, '/plugins/codebuddy-link/auth/clear');
  assert.equal(app.calls[5]!.init.body, '{}');
  assert.match(content(app.render()), /积分查询凭据：未配置/);
});

test('unsafe OAuth URLs never become links', async () => {
  for (const url of ['http://www.codebuddy.cn/auth', 'https://www.codebuddy.cn.evil.test/', 'javascript:alert(1)',
    'https://evil.test/', 'https://user:pass@www.codebuddy.cn/', 'https://www.codebuddy.cn:444/']) {
    const app = mounted([{ value: payload() }, { value: startReply(url) }]);
    app.render(); await settle();
    button(app.render(), '使用 OAuth 登录').props.onClick(); await settle();
    assert.equal(nodes(app.render()).filter(node => node.type === 'a').length, 0, url);
    assert.match(content(app.render()), /授权链接不安全/);
  }
});

test('auth failures do not expose server tokens, discard JSON or reset drafts; cancelled import clears JSON', async () => {
  const app = mounted([{ value: { ...payload(), auth: { configured: 'invalid' } } },
    { ok: false, status: 400, value: { error: 'SENSITIVE'.repeat(100) } },
    { error: new Error('SENSITIVE network data') }, { value: { token: 'SENSITIVE' } }]);
  app.render(); await settle();
  control(app.render(), '权限模式', 'select').props.onChange({ target: { value: 'plan' } });
  control(app.render(), '导入登录 JSON', 'textarea').props.onChange({ target: { value: '{}' } });
  for (const expected of [/HTTP 400/, /登录请求失败/, /登录响应格式无效/]) {
    button(app.render(), '导入登录信息').props.onClick(); await settle();
    assert.match(content(app.render()), expected);
    assert.doesNotMatch(content(app.render()), /SENSITIVE/);
    assert.equal(control(app.render(), '导入登录 JSON', 'textarea').props.value, '{}');
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  }
  button(app.render(), '取消导入').props.onClick();
  assert.equal(control(app.render(), '导入登录 JSON', 'textarea').props.value, '');
  assert.equal(app.calls.length, 6);
});

test('successful auth clears JSON even when its status refresh fails', async () => {
  const app = mounted([{ value: payload() }, { value: { configured: true } }, { error: new Error('SENSITIVE') }]);
  app.render(); await settle();
  control(app.render(), '导入登录 JSON', 'textarea').props.onChange({ target: { value: '{}' } });
  button(app.render(), '导入登录信息').props.onClick(); await settle();
  assert.equal(control(app.render(), '导入登录 JSON', 'textarea').props.value, '');
  assert.match(content(app.render()), /状态刷新失败/);
  assert.doesNotMatch(content(app.render()), /SENSITIVE/);
});

test('danger toggle is always enabled and stale executionMode fields are ignored', async () => {
  const saved = {...payload(), config:{...payload().config, dangerouslySkipPermissions:true}};
  const app = mounted([{value:payload()}, {value:saved}]); app.render(); await settle();
  const danger = () => nodes(app.render()).find(node => node.props.name === 'dangerouslySkipPermissions')!;
  assert.equal(danger().props.checked, false);
  assert.notEqual(danger().props.disabled, true);
  assert.doesNotMatch(content(app.render()), /Provider 执行模式/);
  assert.match(content(app.render()), /不再提供 bridge\/工具协议解析模式/);
  assert.match(content(app.render()), /ACP 原生工具绕过 DSH 文件沙箱与确认流程/);
  danger().props.onChange({target:{checked:true}});
  button(app.render(), '保存设置').props.onClick(); await settle();
  const body = JSON.parse(app.calls[3]!.init.body);
  assert.equal(body.executionMode, undefined); assert.equal(body.dangerouslySkipPermissions, true);
  assert.equal(danger().props.checked, true);
  // A mixed-version server still echoing the retired field cannot re-introduce the switch.
  const stale = {...payload(), config:{...payload().config, executionMode:'bridge', dangerouslySkipPermissions:true}};
  const older = mounted([{value:stale}]); older.render(); await settle();
  const staleDanger = () => nodes(older.render()).find(node => node.props.name === 'dangerouslySkipPermissions')!;
  assert.equal(staleDanger().props.checked, true); assert.notEqual(staleDanger().props.disabled, true);
  assert.doesNotMatch(content(older.render()), /Provider 执行模式/);
});

test('malformed execution settings fail closed rather than enabling native tools', async () => {
  for (const patch of [{dangerouslySkipPermissions:'true'}, {dangerouslySkipPermissions:1}, {dangerouslySkipPermissions:null}]) {
    const app = harness([{value:{...payload(), config:{...payload().config, ...patch}}}]);
    app.render(); await settle();
    assert.match(content(app.render()), /服务端状态格式无效/);
    assert.equal(button(app.render(), '保存设置'), undefined);
    assert.equal(app.calls.length, 1);
  }
  // Retired executionMode echoes are ignored rather than fatal.
  const app = harness([{value:{...payload(), config:{...payload().config, executionMode:'native'}}}]);
  app.render(); await settle();
  assert.doesNotMatch(content(app.render()), /服务端状态格式无效/);
  assert.ok(button(app.render(), '保存设置'));
});

test('runtime controls default for legacy payloads, validate ranges and serialize settings', async () => {
  const app = mounted([{value:payload()}, {value:payload()}]); app.render(); await settle();
  assert.equal(control(app.render(), '默认推理强度', 'select').props.value, 'auto');
  assert.equal(control(app.render(), '最大并发数', 'input').props.value, 2);
  control(app.render(), '默认推理强度', 'select').props.onChange({target:{value:'ultracode'}});
  for (const bad of ['', '0', '17', '1.5']) {
    control(app.render(), '最大并发数', 'input').props.onChange({target:{value:bad}});
    assert.equal(button(app.render(), '保存设置').props.disabled, true);
  }
  control(app.render(), '最大并发数', 'input').props.onChange({target:{value:'16'}});
  control(app.render(), '排队等待上限（毫秒）', 'input').props.onChange({target:{value:'1'}});
  control(app.render(), '无进展提醒（毫秒，0 关闭）', 'input').props.onChange({target:{value:'0'}});
  assert.equal(button(app.render(), '保存设置').props.disabled, false);
  button(app.render(), '保存设置').props.onClick(); await settle();
  const config = JSON.parse(app.calls[3]!.init.body);
  assert.equal(config.reasoningEffort, 'ultracode'); assert.equal(config.maxConcurrency, 16);
  assert.equal(config.queueTimeoutMs, 1); assert.equal(config.stallWarnMs, 0);
});

test('runs display honest metadata, zero costs and unknown values while ignoring raw fields', async () => {
  const run = {id:'run', source:'model', state:'waiting', requestedModel:'requested-id', requestedEffort:'high', queuedAt:100,
    contextWindow:128000, contextSource:'fallback', contextOverrideSent:false, reasoningConfirmed:false, warning:true, queuePosition:0,
    totalCostUsd:0, prompt:'PRIVATE-PROMPT', rawOutput:'PRIVATE-OUTPUT', error:'PRIVATE-ERROR', path:'PRIVATE-PATH'};
  const app = mounted([{value:{...payload(), runs:[run, {...run, id:'done', state:'completed', returnedModel:'returned-id', totalCredits:0, totalCostUsd:undefined}, {...run, id:'unsafe-url', requestedModel:'C:/Users/PRIVATE-PATH', returnedModel:'https://host/PRIVATE-TOKEN'}, {id:'invalid'}]}}]);
  app.render(); await settle(); const shown = content(app.render());
  assert.match(shown, /请求模型：requested-id；返回模型：未知/);
  assert.match(shown, /返回模型：returned-id/); assert.match(shown, /请求推理强度：high（服务端未确认）/);
  assert.match(shown, /DSH 上下文预算：128000.*回退配置.*未向 CLI 覆盖/);
  assert.match(shown, /积分：未知；费用（USD）：0\.00/); assert.match(shown, /积分：0\.00；费用（USD）：未知/);
  assert.match(shown, /长时间无进展/); assert.match(shown, /当前进程内存.*5.*2 秒/);
  assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-/); assert.doesNotMatch(shown, /·/);
});

test('runs show latest five total by queuedAt below Save, without active-first exceptions or private fields', async () => {
  const raw = {source:'model', requestedModel:'requested', requestedEffort:'high',
    contextOverrideSent:true, reasoningConfirmed:true, warning:true, queuePosition:0,
    prompt:'PRIVATE-PROMPT', rawOutput:'PRIVATE-OUTPUT', error:'PRIVATE-ERROR', path:'PRIVATE-PATH', token:'PRIVATE-TOKEN'};
  const terminal = Array.from({length:55}, (_, i) => ({...raw, id:`terminal-${i}`, state:['completed','failed','cancelled'][i % 3], queuedAt:1000 - i}));
  const live = Array.from({length:85}, (_, i) => ({...raw, id:`live-${i}`, state:['waiting','responding','starting','queued'][i % 4], queuedAt:100 - i}));
  for (const count of [4, 85]) {
    const app = mounted([{value:{...payload(), runs:[null, {id:'invalid'}, ...live.slice(0, count), ...terminal.toReversed()]}}]);
    app.render(); await settle(); const tree = app.render();
    const articles = nodes(tree).filter(node => node.type === 'article');
    assert.deepEqual(articles.map(node => node.props.key), terminal.slice(0, 5).map(run => run.id));
    assert.equal(articles.length, 5);
    assert.match(content(tree), /最近 5 条运行记录.*合计最多 5 条/);
    const history = nodes(tree).find(node => node.props['aria-label'] === '运行记录')!;
    assert.equal(tree.children.at(-1), history);
    assert.ok(nodes(tree).indexOf(button(tree, '保存设置')) < nodes(tree).indexOf(history));
    assert.ok(app.state[0].runs.every((run: any) => run.contextOverrideSent === false && run.reasoningConfirmed === false));
    assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-/);
    assert.doesNotMatch(JSON.stringify(tree), /PRIVATE-/);
  }
});

test('latest-five cap includes mixed live and finished runs in recency order', async () => {
  const runs = ['completed', 'queued', 'failed', 'responding', 'waiting', 'starting', 'cancelled'].map((state, i) => ({
    id:`run-${i}`, source:'ask', requestedModel:'basic', requestedEffort:'auto', state, queuedAt:i,
  }));
  const app = mounted([{value:{...payload(), runs}}]); app.render(); await settle();
  assert.deepEqual(nodes(app.render()).filter(node => node.type === 'article').map(node => node.props.key), ['run-6', 'run-5', 'run-4', 'run-3', 'run-2']);
});

test('two-second status polling preserves drafts, coalesces loads and ignores late results after unmount', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const app = mounted([{value:payload()}, {value:{...payload(), config:{...payload().config, permissionMode:'acceptEdits'}}, wait}]);
  app.render(); await settle();
  control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  app.tick(); app.tick(); button(app.render(), '刷新账户').props.onClick();
  assert.equal(app.calls.length, 4); assert.equal(app.calls[3]!.url, '/plugins/codebuddy-link/status');
  release(); await settle(); assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  app.cleanup.forEach(dispose => dispose()); app.tick(); assert.equal(app.calls.length, 4);

  let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
  const late = mounted([{value:payload()}, {value:{...payload(), account:{status:'ok', remaining:123}}, wait:gate}]);
  late.render(); await settle(); late.tick(); const before = late.state[0];
  late.cleanup.forEach(dispose => dispose()); finish(); await settle(); assert.equal(late.state[0], before);
});

test('runtime polling and auth requests never overlap or poll OAuth automatically', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const app = mounted([{value:payload()}, {value:startReply(), wait}, {value:payload()}]);
  app.render(); await settle(); button(app.render(), '使用 OAuth 登录').props.onClick();
  app.tick(); assert.equal(app.calls.length, 4);
  release(); await settle(); app.tick(); await settle();
  assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/models', '/plugins/codebuddy-link/auth/start', '/plugins/codebuddy-link/status']);
});

test('mount serializes status, account and models, blocks overlaps, and preserves drafts throughout', async () => {
  const gates = Array.from({length:3}, () => {
    let release!: () => void;
    return {wait:new Promise<void>(resolve => {release = resolve;}), release:() => release()};
  });
  const discovered = {...payload(), config:{...payload().config, permissionMode:'acceptEdits'}, catalogModels:[{id:'found', name:'Found'}]};
  const app = harness([{value:payload(), wait:gates[0]!.wait}, {value:payload(), wait:gates[1]!.wait},
    {value:discovered, wait:gates[2]!.wait}, {value:discovered}, {value:discovered}]);
  app.render(); app.tick();
  assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status']);
  gates[0]!.release(); await settle();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1]!.url, '/plugins/codebuddy-link/refresh');
  control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  app.tick(); button(app.render(), '刷新账户').props.onClick(); button(app.render(), '使用 OAuth 登录').props.onClick();
  assert.equal(app.calls.length, 2);
  gates[1]!.release(); await settle();
  assert.equal(app.calls[2]!.url, '/plugins/codebuddy-link/models');
  app.tick(); button(app.render(), '获取模型列表').props.onClick();
  assert.equal(app.calls.length, 3);
  gates[2]!.release(); await settle();
  assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  assert.match(content(app.render()), /Found/);
  app.tick(); await settle(); app.tick(); await settle();
  assert.deepEqual(app.calls.slice(3).map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/status']);
  assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
});

test('invalid refreshed accounts never request models on mount or manual refresh', async () => {
  for (const status of ['auth-required', 'unavailable', 'error']) {
    const invalid = {...payload(), account:{status}};
    const app = harness([{value:payload()}, {value:invalid}, {value:invalid}]);
    app.render(); await settle();
    assert.equal(app.calls.length, 2);
    control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
    button(app.render(), '刷新账户').props.onClick(); await settle();
    assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/refresh']);
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
    assert.equal(button(app.render(), '刷新账户').props.disabled, false);
  }
});

test('mount refresh errors remain visible and polling does not retry external services', async () => {
  for (const failedStage of ['refresh', 'models']) {
    const replies: Reply[] = [{value:payload()}];
    if (failedStage === 'models') replies.push({value:{...payload(), account:{status:'ok', remaining:12}}});
    replies.push({ok:false, status:503}, {value:payload()});
    const app = harness(replies); app.render(); await settle();
    assert.match(content(app.render()), /HTTP 503/);
    assert.equal(app.calls.at(-1)!.url, `/plugins/codebuddy-link/${failedStage}`);
    assert.equal(button(app.render(), '保存设置').props.disabled, false);
    if (failedStage === 'models') assert.match(content(app.render()), /剩余：12\.00/);
    control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
    app.tick(); await settle();
    assert.equal(app.calls.at(-1)!.url, '/plugins/codebuddy-link/status');
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
    assert.match(content(app.render()), /HTTP 503/);
  }
});

test('manual model follow-up errors preserve drafts and do not report refresh success', async () => {
  const app = mounted([{value:payload()}, {value:payload()}, {ok:false, status:502}]);
  app.render(); await settle();
  control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  button(app.render(), '刷新账户').props.onClick(); await settle();
  assert.deepEqual(app.calls.slice(-2).map(call => call.url), ['/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/models']);
  assert.match(content(app.render()), /HTTP 502/);
  assert.doesNotMatch(content(app.render()), /账户状态已刷新/);
  assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
});

test('unmount at each mount-chain stage ignores late responses and starts no follow-up', async () => {
  for (const stage of [0, 1, 2]) {
    let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
    const app = harness(Array.from({length:3}, (_, index) => ({value:payload(), ...(index === stage ? {wait} : {})})));
    app.render(); await settle();
    assert.equal(app.calls.length, stage + 1);
    app.cleanup.forEach(dispose => dispose()); const before = JSON.stringify(app.state);
    release(); await settle();
    assert.equal(JSON.stringify(app.state), before);
    assert.equal(app.calls.length, stage + 1);
    assert.equal(app.timers.size, 0);
  }
});

test('stale mount generation cannot publish results, request models, or unlock the new mount', async () => {
  let oldRelease!: () => void; const oldWait = new Promise<void>(resolve => {oldRelease = resolve;});
  let newRelease!: () => void; const newWait = new Promise<void>(resolve => {newRelease = resolve;});
  const app = harness([{value:payload()}, {value:{...payload(), account:{status:'ok', remaining:999}}, wait:oldWait},
    {value:payload(), wait:newWait}, {value:{...payload(), account:{status:'auth-required'}}}]);
  app.render(); await settle();
  control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  app.remount(); const before = JSON.stringify(app.state);
  oldRelease(); await settle(); app.tick();
  assert.equal(JSON.stringify(app.state), before);
  assert.equal(app.calls.length, 3);
  newRelease(); await settle();
  assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh']);
  assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  assert.equal(app.timers.size, 1);
});

test('auth model follow-up failure is private and invalid post-login accounts skip models', async () => {
  for (const status of ['ok', 'auth-required']) {
    const app = mounted([{value:payload()}, {value:{configured:true}}, {value:{...payload(), account:{status}}},
      {error:new Error('PRIVATE-AUTH-RESPONSE')}]);
    app.render(); await settle();
    control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
    control(app.render(), '导入登录 JSON', 'textarea').props.onChange({target:{value:'{}'}});
    button(app.render(), '导入登录信息').props.onClick(); await settle();
    assert.equal(app.calls.length, status === 'ok' ? 6 : 5);
    assert.equal(control(app.render(), '导入登录 JSON', 'textarea').props.value, '');
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
    if (status === 'ok') assert.match(content(app.render()), /状态刷新失败/);
    assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-AUTH/);
  }
});

test('auth refresh chain keeps its lock and ignores each late follow-up after unmount', async () => {
  for (const stage of ['refresh', 'models']) {
    let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
    const app = mounted([{value:payload()}, {value:{configured:true}},
      {value:payload(), ...(stage === 'refresh' ? {wait} : {})}, {value:payload(), ...(stage === 'models' ? {wait} : {})}]);
    app.render(); await settle();
    control(app.render(), '导入登录 JSON', 'textarea').props.onChange({target:{value:'{}'}});
    button(app.render(), '导入登录信息').props.onClick(); await settle();
    const count = stage === 'refresh' ? 5 : 6;
    app.tick(); button(app.render(), '刷新账户').props.onClick(); button(app.render(), '保存设置').props.onClick();
    assert.equal(app.calls.length, count);
    app.cleanup.forEach(dispose => dispose()); const before = JSON.stringify(app.state);
    release(); await settle();
    assert.equal(JSON.stringify(app.state), before);
    assert.equal(app.calls.length, count);
  }
});

test('unmounted request cannot update state; client uses no DOM APIs and clears polling', async () => {
  const app = harness();
  app.render();
  app.cleanup.forEach(dispose => dispose());
  await settle();
  assert.equal(app.state[0], null);
  assert.equal(app.timers.size, 0);
  app.tick(); assert.equal(app.calls.length, 1);
  // The loader registration is the sole permitted window reference.
  assert.doesNotMatch(code.replace('window.__ModuleLoader__', '__ModuleLoader__'), /\b(?:document|window|innerHTML|createPortal)\b/);
});
