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
  accountPool: { mode: 'fixed', selectedAccountId: 'account-1', accounts: [{ id: 'account-1', name: '主账户', enabled: true, authState: 'ready', createdAt: '2026-10-29T00:00:00.000Z', quota: { status: 'ok' } }] },
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
function deferred() {
  let release!: () => void;
  return {wait:new Promise<void>(resolve => {release = resolve;}), release:() => release()};
}

function accountRow(tree: Element, name = '主账户'): Element {
  return nodes(tree).find(node => node.props['aria-label'] === `账户 ${name}`)!;
}
function modelChip(tree: Element, id: string): Element {
  return nodes(tree).find(node => node.type === 'button' && String(node.props['aria-label']).endsWith(`(${id})`))!;
}
function withQuota(quota: Record<string, unknown>) {
  const result = payload();
  return {...result, accountPool:{...result.accountPool, accounts:result.accountPool.accounts.map(account => ({...account, quota}))}};
}
const startReply = (verificationUri = 'https://www.codebuddy.cn/oauth/authorize?state=example') => ({
  flowId: 'private-flow-id', verificationUri, expiresIn: 599, interval: 2, token: 'SHOULD-NOT-RENDER',
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
  app.disposers.forEach(dispose => dispose()); assert.equal(app.disposed(), 3); assert.equal(app.calls.length, 0);
});

test('compact account list shows quota precisely and has no removed controls or prose', async () => {
  const response = withQuota({status:'ok', remaining:12.3456, total:20, used:7.6544});
  const app = mounted([{value:response}]); app.render(); await settle(); const tree = app.render();
  assert.match(content(accountRow(tree)), /剩余：12\.35.*总额：20\.00.*已用：7\.65/);
  assert.equal(response.accountPool.accounts[0]!.quota.remaining, 12.3456);
  assert.ok(button(tree, '添加账户')); assert.ok(button(tree, '固定账户')); assert.ok(button(tree, '账户池'));
  for (const action of ['使用', '重命名', '停用', '重新授权', '刷新', '删除']) assert.ok(button(accountRow(tree), action));
  assert.doesNotMatch(content(tree), /JSON|WorkBuddy|地区|最大并发|排队等待上限|无进展提醒|工具配置|自定义模型|手动添加|·/);
  assert.equal(nodes(tree).filter(node => node.type === 'textarea').length, 0);
  assert.equal(nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox').length, 1);
  assert.doesNotMatch(code, /auth\/(?:import|clear)|authContent|customModel/);
});

test('settings use semantic theme with Radix fallbacks, compact borders and legible fonts', async () => {
  const app = mounted(); app.render(); await settle(); const tree = app.render();
  assert.equal(tree.props.style.color, 'var(--dsw-alias-label-primary, var(--gray-12, inherit))');
  for (const title of ['账户', '启用模型']) {
    const heading = nodes(tree).find(n => n.type === 'h3' && content(n) === title)!;
    assert.equal(heading.props.style.margin, 0);
    assert.equal(nodes(tree).find(n => n.children.includes(heading))!.props.style.alignItems, 'center');
  }
  for (const node of nodes(tree)) {
    const style = node.props.style;
    if (style?.fontSize) assert.ok(parseInt(style.fontSize) >= 12);
    for (const key of ['border', 'borderTop']) if (style?.[key]) assert.match(style[key], /^0\.5px /);
  }
  const styles = JSON.stringify(nodes(tree).map(n => n.props.style));
  assert.match(styles, /--dsw-alias-bg-layer-1/); assert.match(styles, /--gray-6/); assert.match(styles, /--accent-3/);
});

test('safety and danger help are real hover and focus tooltips, dismissible with Escape', async () => {
  const app = mounted(); app.render(); await settle();
  assert.equal(nodes(app.render()).filter(node => node.props.role === 'tooltip').length, 0);
  const findHelp = (label: string) => nodes(app.render()).find(node => node.props['aria-label'] === label)!;
  let trigger = findHelp('模型与独立委派安全说明');
  assert.equal(content(trigger), '?');
  trigger.props.onFocus();
  let tree = app.render(); let tooltip = nodes(tree).find(node => node.props.role === 'tooltip')!;
  assert.match(content(tooltip), /ACP 原生工具绕过 DSH 文件沙箱与确认流程/);
  assert.match(content(tooltip), /继承含凭据的环境变量或读取当前用户的文件/);
  assert.equal(findHelp('模型与独立委派安全说明').props['aria-describedby'], tooltip.props.id);
  trigger.props.onKeyDown({key:'Escape'}); assert.equal(nodes(app.render()).filter(node => node.props.role === 'tooltip').length, 0);
  trigger.props.onBlur();
  trigger = findHelp('跳过 CLI 权限检查风险说明');
  assert.equal(content(trigger), '危险');
  const wrapper = nodes(app.render()).find(node => node.children.some(child => child && typeof child === 'object' && (child as Element).props['aria-label'] === '跳过 CLI 权限检查风险说明'))!;
  wrapper.props.onMouseEnter();
  tree = app.render(); tooltip = nodes(tree).find(node => node.props.role === 'tooltip')!;
  assert.match(content(tooltip), /默认关闭.*dangerously-skip-permissions.*不会隐式应用到独立委派/);
  assert.match(content(tooltip), /不会自动批准/);
  wrapper.props.onMouseLeave(); assert.equal(nodes(app.render()).filter(node => node.props.role === 'tooltip').length, 0);
});

test('mount refreshes accounts then models, with same-origin bounded requests and no automatic OAuth', async () => {
  const app = mounted(); assert.match(content(app.render()), /加载中/); await settle(); app.render();
  assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/models']);
  assert.equal(app.calls[0]!.init.method, 'GET');
  for (const call of app.calls) { assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.mode, 'same-origin'); assert.equal(call.init.signal.timeout, 20000); }
  for (const call of app.calls.slice(1)) { assert.equal(call.init.method, 'POST'); assert.equal(call.init.body, '{}'); }
  assert.match(content(accountRow(app.render())), /剩余：未知.*总额：未知.*已用：未知/);
});

test('managed ready account supersedes legacy quota gate; empty and unauthenticated pools skip discovery', async () => {
  const ready = {...payload(), account:{status:'auth-required'}};
  const app = mounted([{value:ready}]); app.render(); await settle(); assert.equal(app.calls.length, 3);
  for (const accounts of [[], [{...payload().accountPool.accounts[0]!, enabled:false}], [{...payload().accountPool.accounts[0]!, authState:'auth-required'}]]) {
    const result = {...payload(), accountPool:{mode:'pool', accounts}};
    const empty = harness([{value:result}, {value:result}]); empty.render(); await settle();
    assert.equal(empty.calls.length, 2);
  }
});

test('discovered model chips toggle visibility and save only the six editable settings', async () => {
  const discovered = {...payload(), catalogModels:[...payload().catalogModels, {id:'discovered-id', name:'Discovered'}]};
  const app = mounted([{value:payload()}, {value:discovered}, {value:discovered}]); app.render(); await settle();
  button(app.render(), '获取模型列表').props.onClick(); await settle();
  assert.equal(modelChip(app.render(), 'discovered-id').props['aria-pressed'], false);
  modelChip(app.render(), 'discovered-id').props.onClick();
  modelChip(app.render(), 'basic').props.onClick();
  assert.equal(control(app.render(), '默认模型', 'select').props.value, 'discovered-id');
  control(app.render(), '默认模型', 'select').props.onChange({target:{value:'discovered-id'}});
  control(app.render(), '权限模式', 'select').props.onChange({target:{value:'acceptEdits'}});
  control(app.render(), '默认推理强度', 'select').props.onChange({target:{value:'ultracode'}});
  const save = button(app.render(), '保存设置'); save.props.onClick(); save.props.onClick(); await settle();
  assert.equal(app.calls.length, 5);
  assert.deepEqual(JSON.parse(app.calls[4]!.init.body), {permissionMode:'acceptEdits', dangerouslySkipPermissions:false,
    models:['basic','hidden','custom','discovered-id'], hiddenModels:['hidden','basic'], defaultModel:'discovered-id', reasoningEffort:'ultracode'});
  assert.match(content(app.render()), /设置已保存/);
});

test('removed runtime settings and tools survive save by being omitted, not reset to defaults', async () => {
  const response = {...payload(), config:{...payload().config, tools:'CustomTool', maxConcurrency:7, queueTimeoutMs:12345, stallWarnMs:800, reasoningEffort:'high', executionMode:'bridge'}};
  const app = mounted([{value:response}, {value:response}]); app.render(); await settle();
  button(app.render(), '保存设置').props.onClick(); await settle();
  const saved = JSON.parse(app.calls[3]!.init.body);
  assert.deepEqual(Object.keys(saved).sort(), ['models','hiddenModels','defaultModel','permissionMode','reasoningEffort','dangerouslySkipPermissions'].sort());
  assert.equal(saved.reasoningEffort, 'high');
  assert.equal(app.state[1].tools, 'CustomTool'); assert.equal(app.state[1].maxConcurrency, 7);
});

test('hiding all models prevents save until an enabled default is chosen', async () => {
  const app = mounted(); app.render(); await settle();
  assert.equal(modelChip(app.render(), 'hidden').props['aria-pressed'], false);
  modelChip(app.render(), 'basic').props.onClick(); modelChip(app.render(), 'custom').props.onClick();
  assert.equal(control(app.render(), '默认模型', 'select').props.value, '');
  assert.equal(button(app.render(), '保存设置').props.disabled, true);
  modelChip(app.render(), 'basic').props.onClick();
  control(app.render(), '默认模型', 'select').props.onChange({target:{value:'basic'}});
  assert.equal(button(app.render(), '保存设置').props.disabled, false);
});

test('per-account rename, enable-disable, refresh and removal use exact minimal contracts and preserve drafts', async () => {
  const renamed = {...payload(), accountPool:{...payload().accountPool, accounts:[{...payload().accountPool.accounts[0]!, name:'项目账户'}]}};
  const disabled = {...renamed, accountPool:{...renamed.accountPool, accounts:[{...renamed.accountPool.accounts[0]!, enabled:false}]}};
  const removed = {...payload(), accountPool:{mode:'pool', accounts:[]}};
  const app = mounted([{value:payload()}, {value:renamed}, {value:disabled}, {value:renamed}, {value:renamed}, {value:removed}]);
  app.render(); await settle(); control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  button(accountRow(app.render()), '重命名').props.onClick();
  control(app.render(), '账户名称', 'input').props.onChange({target:{value:'  项目账户  '}});
  button(app.render(), '确认重命名').props.onClick(); await settle();
  button(accountRow(app.render(), '项目账户'), '停用').props.onClick(); await settle();
  assert.match(content(accountRow(app.render(), '项目账户')), /已停用/);
  button(accountRow(app.render(), '项目账户'), '启用').props.onClick(); await settle();
  button(accountRow(app.render(), '项目账户'), '刷新').props.onClick(); await settle();
  button(accountRow(app.render(), '项目账户'), '删除').props.onClick();
  assert.equal(app.calls.length, 7); // Deletion requires an explicit second click.
  button(app.render(), '确认删除').props.onClick(); await settle();
  assert.deepEqual(app.calls.slice(3).map(call => [call.url, JSON.parse(call.init.body)]), [
    ['/plugins/codebuddy-link/account/update', {id:'account-1', name:'项目账户'}],
    ['/plugins/codebuddy-link/account/update', {id:'account-1', enabled:false}],
    ['/plugins/codebuddy-link/account/update', {id:'account-1', enabled:true}],
    ['/plugins/codebuddy-link/account/refresh', {id:'account-1'}],
    ['/plugins/codebuddy-link/account/remove', {id:'account-1'}],
  ]);
  assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  assert.match(content(app.render()), /暂无账户/);
});

test('pool and fixed-account selection use separate minimal requests', async () => {
  const pooled = {...payload(), accountPool:{...payload().accountPool, mode:'pool'}};
  const app = mounted([{value:payload()}, {value:pooled}, {value:payload()}, {value:payload()}]); app.render(); await settle();
  assert.equal(button(app.render(), '固定账户').props['aria-pressed'], true);
  button(app.render(), '账户池').props.onClick(); await settle();
  assert.equal(button(app.render(), '账户池').props['aria-pressed'], true);
  button(accountRow(app.render()), '使用').props.onClick(); await settle();
  button(app.render(), '固定账户').props.onClick(); await settle();
  assert.deepEqual(app.calls.slice(3).map(call => JSON.parse(call.init.body)), [{mode:'pool'}, {mode:'fixed', accountId:'account-1'}, {mode:'fixed', accountId:'account-1'}]);
  assert.ok(app.calls.slice(3).every(call => call.url === '/plugins/codebuddy-link/account/select'));
});

test('account failure is private, retains rename draft and serializes overlapping actions', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const app = mounted([{value:payload()}, {ok:false, status:400, value:{error:'PRIVATE-TOKEN'}, wait}]); app.render(); await settle();
  button(accountRow(app.render()), '重命名').props.onClick();
  control(app.render(), '账户名称', 'input').props.onChange({target:{value:'New name'}});
  button(app.render(), '确认重命名').props.onClick(); app.tick(); button(accountRow(app.render()), '停用').props.onClick();
  assert.equal(app.calls.length, 4); release(); await settle();
  assert.match(content(app.render()), /HTTP 400/); assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-TOKEN/);
  assert.equal(control(app.render(), '账户名称', 'input').props.value, 'New name');
});

test('status parsing whitelists nested account and run data, rejecting malformed pool fields', async () => {
  const response = {...payload(), token:'PRIVATE-TOKEN', account:{status:'ok', token:'PRIVATE-TOKEN', message:'PRIVATE-MESSAGE'},
    accountPool:{...payload().accountPool, token:'PRIVATE-TOKEN', accounts:[{...payload().accountPool.accounts[0]!, token:'PRIVATE-TOKEN', credentials:{token:'PRIVATE-TOKEN'},
      quota:{status:'ok', token:'PRIVATE-TOKEN', message:'PRIVATE-MESSAGE', remaining:0}, catalogModels:[{id:'basic', name:'Basic', token:'PRIVATE-TOKEN'}]}]}};
  const app = mounted([{value:response}]); app.render(); await settle();
  assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-/); assert.doesNotMatch(JSON.stringify(app.render()), /PRIVATE-/);
  for (const pool of [null, {}, {mode:'other', accounts:[]}, {...payload().accountPool, selectedAccountId:42},
    {...payload().accountPool, accounts:[{...payload().accountPool.accounts[0]!, enabled:'yes'}]},
    {...payload().accountPool, accounts:[{...payload().accountPool.accounts[0]!, authState:'unknown'}]}]) {
    const invalid = harness([{value:{...payload(), accountPool:pool}}]); invalid.render(); await settle();
    assert.match(content(invalid.render()), /服务端状态格式无效/); assert.equal(invalid.calls.length, 1);
  }
});

const recoveryBanner = 'CodeBuddy 配置无法加载，模型调用已停用。请修复插件 settings.json 或管理员配置后重启 DSH；原文件未修改。';
const recoveryPayload = () => ({...payload(), config:{...payload().config, enabled:false}, settingsError:'PRIVATE-SETTINGS-PATH-AND-CREDENTIAL'});

test('settings recovery shows a fixed private banner and blocks save independently of notices and edits', async () => {
  const app = mounted([{value:recoveryPayload()}, {value:recoveryPayload()}, {value:recoveryPayload()}, {ok:false, status:503}]);
  app.render(); await settle(); let tree = app.render();
  assert.equal(app.state[0].settingsError, true);
  assert.ok(nodes(tree).some(node => node.props.role === 'alert' && content(node) === recoveryBanner));
  assert.equal(button(tree, '保存设置').props.disabled, true);
  const count = app.calls.length;
  button(tree, '保存设置').props.onClick(); await settle(); assert.equal(app.calls.length, count);
  button(tree, '刷新账户').props.onClick(); await settle();
  assert.match(content(app.render()), /账户状态已刷新/);
  control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  tree = app.render(); assert.ok(content(tree).includes(recoveryBanner)); assert.doesNotMatch(content(tree), /账户状态已刷新/);
  button(tree, '获取模型列表').props.onClick(); await settle(); tree = app.render();
  assert.match(content(tree), /HTTP 503/); assert.ok(content(tree).includes(recoveryBanner));
  button(tree, '保存设置').props.onClick(); await settle();
  assert.ok(app.calls.every(call => !/\/(?:config|reset)$/.test(call.url)));
  assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-/); assert.doesNotMatch(JSON.stringify(tree), /PRIVATE-/);
});

test('recovery status immediately guards captured save handlers and malformed polls cannot clear it', async () => {
  const app = mounted([{value:payload()}, {value:recoveryPayload()}, {value:{...payload(), settingsError:false}}, {value:{...payload(), settingsError:''}}]);
  app.render(); await settle(); const capturedSave = button(app.render(), '保存设置').props.onClick;
  app.tick(); await settle(); capturedSave(); await settle();
  assert.equal(app.calls.length, 4); assert.equal(button(app.render(), '保存设置').props.disabled, true);
  app.tick(); await settle(); capturedSave(); await settle();
  assert.equal(app.calls.length, 5); assert.ok(content(app.render()).includes(recoveryBanner));
  app.tick(); await settle();
  assert.equal(app.state[0].settingsError, false); assert.equal(button(app.render(), '保存设置').props.disabled, false);
  assert.ok(!content(app.render()).includes(recoveryBanner));
});

test('settings recovery flag accepts only absent or string fields and never retains arbitrary text', async () => {
  for (const value of ['', ' ', 'PRIVATE-SETTINGS']) {
    const app = mounted([{value:{...payload(), settingsError:value}}]); app.render(); await settle();
    assert.equal(app.state[0].settingsError, value.length > 0);
    assert.equal(button(app.render(), '保存设置').props.disabled, value.length > 0);
    assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-SETTINGS/);
  }
  for (const settingsError of [null, true, false, 1, {}, []]) {
    const app = harness([{value:{...payload(), settingsError}}]); app.render(); await settle();
    assert.match(content(app.render()), /服务端状态格式无效/); assert.equal(app.calls.length, 1);
    assert.equal(button(app.render(), '保存设置'), undefined);
  }
});

const unsafeModelIds = ['', 'https://example.com/model', 'file:///tmp/model', '/tmp/model', './model', '../model',
  'C:/model', 'C:\\model', 'C:model', 'provider/name/extra', 'provider//name', 'provider/../name',
  'provider:/name', 'model\n', 'model\r', 'model\t', 'model\u0000', 'model\u007f', 'model name'];

test('config and all catalog model IDs use bare request validation through 256 characters', async () => {
  const values = [...[128,129,256,257].map(length => 'm'.repeat(length)), 'model:version-1.2_3', 'provider/name', ...unsafeModelIds];
  for (const id of values) {
    const valid = (id.startsWith('m') && /^m+$/.test(id) && id.length <= 256) || id === 'model:version-1.2_3';
    const base = payload();
    const responses = [
      {...base, config:{...base.config, models:[id]}},
      {...base, config:{...base.config, hiddenModels:[id]}},
      {...base, config:{...base.config, defaultModel:id}},
      {...base, catalogModels:[{id, name:'Model'}]},
      {...base, accountPool:{...base.accountPool, accounts:[{...base.accountPool.accounts[0]!, catalogModels:[{id, name:'Model'}]}]}},
    ];
    for (const [source, response] of responses.entries()) {
      const app = valid ? mounted([{value:response}]) : harness([{value:response}]); app.render(); await settle();
      assert.equal(app.state[0] !== null, valid, `${source}: ${JSON.stringify(id)}`);
      if (!valid) {
        assert.match(content(app.render()), /服务端状态格式无效/); assert.equal(app.calls.length, 1);
        assert.equal(button(app.render(), '保存设置'), undefined);
      }
    }
  }
});

test('run model metadata distinguishes bare requests from returned provider/name at 128/129/256/257', async () => {
  const values = [
    ...[128,129,256,257].flatMap(length => [
      {id:'m'.repeat(length), request:length <= 256, returned:length <= 256},
      {id:`provider/${'m'.repeat(length - 9)}`, request:false, returned:length <= 256},
    ]),
    {id:'model:version-1.2_3', request:true, returned:true},
    {id:'provider/name', request:false, returned:true},
    ...unsafeModelIds.map(id => ({id, request:false, returned:false})),
  ];
  for (const {id, request, returned} of values) {
    const run = {id:'run', source:'model', state:'completed', queuedAt:1, requestedModel:id, returnedModel:id, requestedEffort:'high'};
    const app = mounted([{value:{...payload(), runs:[run]}}]); app.render(); await settle();
    assert.equal(app.state[0].runs[0].requestedModel, request ? id : 'unknown', JSON.stringify(id));
    assert.equal(app.state[0].runs[0].returnedModel, returned ? id : undefined, JSON.stringify(id));
    const history = nodes(app.render()).find(node => node.props['aria-label'] === '运行记录')!;
    assert.ok(content(history).includes(`请求模型：${request ? id : 'unknown'}；返回模型：${returned ? id : '未知'}`));
  }
});

test('HTTP and network errors are private and preserve unsaved edits', async () => {
  const app = mounted([{value:payload()}, {ok:false, status:403, value:{error:'PRIVATE-TOKEN'}}, {error:new Error('PRIVATE-NETWORK')}]);
  app.render(); await settle(); control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  for (const expected of [/HTTP 403/, /请求失败，请重试/]) {
    button(app.render(), '保存设置').props.onClick(); await settle();
    assert.match(content(app.render()), expected); assert.doesNotMatch(content(app.render()), /PRIVATE-|设置已保存/);
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  }
});

test('invalid initial response exposes retry and recovers', async () => {
  const app = harness([{value:{config:{}}}, {error:new Error('PRIVATE')}, {value:payload()}, {value:payload()}, {value:payload()}]);
  app.render(); await settle(); assert.match(content(app.render()), /服务端状态格式无效/);
  button(app.render(), '重试加载').props.onClick(); await settle(); assert.match(content(app.render()), /请求失败，请重试/);
  button(app.render(), '重试加载').props.onClick(); await settle(); assert.ok(button(app.render(), '保存设置')); assert.equal(app.calls.length, 5);
});

test('browser login starts on click, validates official link, polls manually and preserves dirty config', async () => {
  const app = mounted([{value:payload()}, {value:startReply()}, {value:{status:'pending'}}, {value:{status:'ok', token:'SHOULD-NOT-RENDER'}}, {value:payload()}, {value:payload()}]);
  app.render(); await settle(); control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  button(app.render(), '添加账户').props.onClick(); await settle();
  let tree = app.render(); const link = nodes(tree).find(node => node.type === 'a')!;
  assert.equal(link.props.href, startReply().verificationUri); assert.equal(link.props.target, '_blank'); assert.equal(link.props.rel, 'noopener noreferrer');
  assert.equal(app.calls[3]!.init.body, '{}'); assert.doesNotMatch(JSON.stringify(tree), /SHOULD-NOT-RENDER|private-flow-id/);
  button(tree, '检查登录结果').props.onClick(); await settle(); assert.match(content(app.render()), /尚未完成登录/);
  button(app.render(), '检查登录结果').props.onClick(); await settle();
  assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  assert.equal(nodes(app.render()).filter(node => node.type === 'a').length, 0);
  assert.equal(app.calls.length, 8); assert.deepEqual(JSON.parse(app.calls[4]!.init.body), {flowId:'private-flow-id'});
  assert.deepEqual(app.calls.slice(-2).map(call => call.url), ['/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/models']);
  assert.doesNotMatch(JSON.stringify(app.state), /SHOULD-NOT-RENDER/);
});

test('reauthorization targets one account and cancel preserves existing accounts', async () => {
  const app = mounted([{value:payload()}, {value:startReply()}, {value:{status:'cancelled'}}]); app.render(); await settle();
  button(accountRow(app.render()), '重新授权').props.onClick(); await settle();
  assert.deepEqual(JSON.parse(app.calls[3]!.init.body), {accountId:'account-1'});
  assert.equal(app.calls[3]!.url, '/plugins/codebuddy-link/auth/start');
  assert.equal(button(app.render(), '添加账户').props.disabled, true);
  button(app.render(), '取消登录').props.onClick(); await settle();
  assert.deepEqual(JSON.parse(app.calls[4]!.init.body), {flowId:'private-flow-id'});
  assert.equal(app.calls[4]!.url, '/plugins/codebuddy-link/auth/cancel');
  assert.ok(accountRow(app.render())); assert.equal(app.calls.length, 5);
});

test('unsafe OAuth URLs never become links', async () => {
  for (const url of ['http://www.codebuddy.cn/auth', 'https://www.codebuddy.cn.evil.test/', 'javascript:alert(1)', 'https://evil.test/', 'https://user:pass@www.codebuddy.cn/', 'https://www.codebuddy.cn:444/']) {
    const app = mounted([{value:payload()}, {value:startReply(url)}]); app.render(); await settle();
    button(app.render(), '添加账户').props.onClick(); await settle();
    assert.equal(nodes(app.render()).filter(node => node.type === 'a').length, 0, url); assert.match(content(app.render()), /授权链接不安全/);
  }
});

test('auth failures never expose response bodies or network secrets', async () => {
  const app = mounted([{value:payload()}, {ok:false, status:400, value:{error:'PRIVATE-TOKEN'}}, {error:new Error('PRIVATE-NETWORK')}, {value:{token:'PRIVATE-TOKEN'}}]);
  app.render(); await settle(); control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  for (const expected of [/HTTP 400/, /登录请求失败/, /登录响应格式无效/]) {
    button(app.render(), '添加账户').props.onClick(); await settle();
    assert.match(content(app.render()), expected); assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-/);
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  }
});

test('successful auth ends flow even if refresh fails, with private diagnostics', async () => {
  const app = mounted([{value:payload()}, {value:startReply()}, {value:{status:'ok'}}, {error:new Error('PRIVATE-TOKEN')}]);
  app.render(); await settle(); button(app.render(), '添加账户').props.onClick(); await settle();
  button(app.render(), '检查登录结果').props.onClick(); await settle();
  assert.equal(nodes(app.render()).filter(node => node.type === 'a').length, 0);
  assert.match(content(app.render()), /状态刷新失败/); assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-/);
});

test('danger toggle serializes explicit opt-in and malformed values fail closed', async () => {
  const response = {...payload(), config:{...payload().config, dangerouslySkipPermissions:true, executionMode:'bridge'}};
  const app = mounted([{value:payload()}, {value:response}]); app.render(); await settle();
  const danger = () => nodes(app.render()).find(node => node.props.name === 'dangerouslySkipPermissions')!;
  assert.equal(danger().props.checked, false); danger().props.onChange({target:{checked:true}});
  button(app.render(), '保存设置').props.onClick(); await settle();
  assert.equal(JSON.parse(app.calls[3]!.init.body).dangerouslySkipPermissions, true); assert.equal(danger().props.checked, true);
  assert.doesNotMatch(content(app.render()), /执行模式|bridge/);
  for (const value of ['true', 1, null]) {
    const invalid = harness([{value:{...payload(), config:{...payload().config, dangerouslySkipPermissions:value}}}]); invalid.render(); await settle();
    assert.match(content(invalid.render()), /服务端状态格式无效/); assert.equal(button(invalid.render(), '保存设置'), undefined);
  }
});

test('run records default collapsed, cap latest five, include account name, and whitelist metadata', async () => {
  const raw = {source:'model', requestedModel:'requested', requestedEffort:'high', contextWindow:128000, contextSource:'fallback',
    contextOverrideSent:true, reasoningConfirmed:true, warning:true, queuePosition:0, totalCostUsd:0,
    accountId:'account-1', accountName:'主账户', prompt:'PRIVATE-PROMPT', rawOutput:'PRIVATE-OUTPUT', error:'PRIVATE-ERROR', path:'PRIVATE-PATH', token:'PRIVATE-TOKEN'};
  const runs = Array.from({length:25}, (_, i) => ({...raw, id:`run-${i}`, state:['completed','failed','waiting','responding','queued'][i % 5], queuedAt:i}));
  const app = mounted([{value:{...payload(), runs:[null, {id:'invalid'}, ...runs]}}]); app.render(); await settle(); const tree = app.render();
  const history = nodes(tree).find(node => node.props['aria-label'] === '运行记录')!;
  assert.equal(history.type, 'details'); assert.notEqual(history.props.open, true); assert.equal(tree.children.at(-1), history);
  assert.deepEqual(nodes(history).filter(node => node.type === 'article').map(node => node.props.key), ['run-24','run-23','run-22','run-21','run-20']);
  assert.match(content(history), /主账户/); assert.match(content(history), /请求推理强度：high（服务端未确认）/);
  assert.match(content(history), /DSH 上下文预算：128000.*回退配置.*未向 CLI 覆盖/);
  assert.match(content(history), /积分：未知；费用（USD）：0\.00/); assert.match(content(history), /长时间无进展/);
  assert.ok(app.state[0].runs.every((run:any) => run.contextOverrideSent === false && run.reasoningConfirmed === false));
  assert.doesNotMatch(JSON.stringify(app.state), /PRIVATE-/); assert.doesNotMatch(content(tree), /·/);
});

test('two-second status polling preserves drafts, coalesces reads and ignores late results after unmount', async () => {
  const poll = deferred();
  const app = mounted([{value:payload()}, {value:{...payload(), config:{...payload().config, permissionMode:'acceptEdits'}}, wait:poll.wait}]);
  app.render(); await settle(); control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  app.tick(); app.tick();
  assert.equal(button(app.render(), '刷新账户').props.disabled, false);
  assert.equal(app.calls.length, 4); assert.equal(app.calls[3]!.url, '/plugins/codebuddy-link/status');
  poll.release(); await settle(); assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  assert.equal(app.state[0].config.permissionMode, 'acceptEdits');
  app.cleanup.forEach(dispose => dispose()); app.tick(); assert.equal(app.calls.length, 4);
  const latePoll = deferred();
  const late = mounted([{value:payload()}, {value:withQuota({status:'ok', remaining:123}), wait:latePoll.wait}]);
  late.render(); await settle(); late.tick();
  late.cleanup.forEach(dispose => dispose()); const before = JSON.stringify(late.state);
  latePoll.release(); await settle(); assert.equal(JSON.stringify(late.state), before);
});

test('enabled save, refresh, model, account and login clicks reserve the lock and wait for polling', async () => {
  for (const action of ['save', 'refresh', 'models', 'account', 'login']) {
    const poll = deferred(); const operation = deferred(); const discovery = deferred();
    const saved = {...payload(), config:{...payload().config, permissionMode:'plan'}};
    const endpoint = {save:'config', refresh:'refresh', models:'models', account:'account/update', login:'auth/start'}[action]!;
    const app = mounted([{value:payload()}, {value:withQuota({status:'ok', remaining:999}), wait:poll.wait},
      {value:action === 'login' ? startReply() : saved, wait:operation.wait}, {value:saved, wait:discovery.wait}]);
    app.render(); await settle();
    control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
    app.tick(); app.tick(); const before = app.state[0];
    const tree = app.render();
    const click = action === 'account' ? button(accountRow(tree), '停用')
      : button(tree, {save:'保存设置', refresh:'刷新账户', models:'获取模型列表', login:'添加账户'}[action]!);
    assert.equal(click.props.disabled, false, action);
    click.props.onClick(); click.props.onClick();
    // Even handlers captured before the lock cannot start a competing mutation.
    button(tree, '保存设置').props.onClick(); button(tree, '刷新账户').props.onClick();
    button(tree, '添加账户').props.onClick(); button(accountRow(tree), '停用').props.onClick(); app.tick();
    assert.equal(app.calls.length, 4, action);
    assert.equal(button(app.render(), '保存设置').props.disabled, true, action);
    assert.match(content(app.render()), action === 'login' ? /登录操作中/ : action === 'save' ? /保存中/ : action === 'refresh' ? /刷新中/ : action === 'account' ? /更新中/ : /加载中/);
    poll.release(); await settle();
    assert.equal(app.calls.length, 5, action);
    assert.equal(app.calls[4]!.url, `/plugins/codebuddy-link/${endpoint}`);
    assert.equal(app.state[0], before, 'superseded poll cannot publish its stale snapshot');
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
    if (action === 'save') assert.equal(JSON.parse(app.calls[4]!.init.body).permissionMode, 'plan');
    if (action === 'account') assert.deepEqual(JSON.parse(app.calls[4]!.init.body), {id:'account-1', enabled:false});
    app.tick(); button(tree, '添加账户').props.onClick(); assert.equal(app.calls.length, 5);
    operation.release(); await settle();
    if (action === 'refresh') {
      assert.equal(app.calls[5]!.url, '/plugins/codebuddy-link/models');
      app.tick(); button(tree, '保存设置').props.onClick(); assert.equal(app.calls.length, 6);
      assert.equal(button(app.render(), '保存设置').props.disabled, true);
      discovery.release(); await settle();
    }
    assert.equal(button(app.render(), '保存设置').props.disabled, false, action);
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
    assert.match(content(app.render()), action === 'login' ? /官方页面授权/ : action === 'save' ? /设置已保存/ : action === 'refresh' ? /账户状态已刷新/ : action === 'account' ? /账户已更新/ : /CodeBuddy/);
  }
});

test('manual login check and cancellation wait for status polls without losing their flow', async () => {
  for (const action of ['poll', 'cancel']) {
    const poll = deferred();
    const app = mounted([{value:payload()}, {value:startReply()}, {value:payload(), wait:poll.wait},
      {value:{status:action === 'poll' ? 'ok' : 'cancelled'}}, {value:payload()}, {value:payload()}]);
    app.render(); await settle(); button(app.render(), '添加账户').props.onClick(); await settle();
    control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
    app.tick(); const click = button(app.render(), action === 'poll' ? '检查登录结果' : '取消登录');
    assert.equal(click.props.disabled, false); click.props.onClick(); app.tick(); assert.equal(app.calls.length, 5);
    poll.release(); await settle();
    assert.equal(app.calls[5]!.url, `/plugins/codebuddy-link/auth/${action}`);
    assert.deepEqual(JSON.parse(app.calls[5]!.init.body), {flowId:'private-flow-id'});
    assert.equal(nodes(app.render()).filter(node => node.type === 'a').length, 0);
    assert.equal(app.calls.length, action === 'poll' ? 8 : 6);
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
  }
});

test('failed status polls release waiting save, refresh and login operations without leaking errors', async () => {
  for (const failure of [{error:new Error('PRIVATE-POLL')}, {ok:false, status:503}, {value:{invalid:true}}]) {
    for (const [label, endpoint] of [['保存设置', 'config'], ['刷新账户', 'refresh'], ['添加账户', 'auth/start']]) {
      const poll = deferred();
      const app = mounted([{value:payload()}, {...failure, wait:poll.wait},
        {value:endpoint === 'auth/start' ? startReply() : payload()}, {value:payload()}]);
      app.render(); await settle(); app.tick(); button(app.render(), label!).props.onClick();
      assert.equal(app.calls.length, 4); poll.release(); await settle();
      assert.equal(app.calls[4]!.url, `/plugins/codebuddy-link/${endpoint}`);
      assert.equal(app.calls.length, endpoint === 'refresh' ? 6 : 5);
      assert.equal(button(app.render(), '保存设置').props.disabled, false);
      assert.doesNotMatch(content(app.render()), /PRIVATE-|HTTP 503|服务端状态格式无效|请求失败/);
    }
  }
});

test('disposal cancels operations waiting for a poll, including when the poll fails', async () => {
  for (const failed of [false, true]) {
    for (const label of ['保存设置', '刷新账户', '添加账户', '停用']) {
      const poll = deferred();
      const app = mounted([{value:payload()}, {value:payload(), ...(failed ? {error:new Error('PRIVATE-POLL')} : {}), wait:poll.wait}]);
      app.render(); await settle(); app.tick(); button(app.render(), label).props.onClick();
      app.cleanup.forEach(dispose => dispose()); const before = JSON.stringify(app.state);
      poll.release(); await settle(); app.tick();
      assert.equal(app.calls.length, 4, label); assert.equal(app.timers.size, 0);
      assert.equal(JSON.stringify(app.state), before, label);
    }
  }
});

test('a stale poll and waiting operation cannot publish or unlock a remounted generation', async () => {
  for (const label of ['保存设置', '刷新账户', '添加账户', '停用']) {
    const oldPoll = deferred(); const newPoll = deferred();
    const app = mounted([{value:payload()}, {value:withQuota({status:'ok', remaining:999}), wait:oldPoll.wait},
      {value:payload()}, {value:payload()}, {value:payload()}, {value:payload(), wait:newPoll.wait}, {value:payload()}]);
    app.render(); await settle(); app.tick(); button(app.render(), label).props.onClick();
    app.remount(); await settle(); app.tick(); assert.equal(app.calls.length, 8);
    const before = JSON.stringify(app.state); oldPoll.release(); await settle(); app.tick();
    assert.equal(JSON.stringify(app.state), before); assert.equal(app.calls.length, 8);
    // The old poll's finally must not clear the new generation's poll promise.
    button(app.render(), '保存设置').props.onClick(); assert.equal(app.calls.length, 8);
    newPoll.release(); await settle(); assert.equal(app.calls.length, 9);
    assert.equal(app.calls[8]!.url, '/plugins/codebuddy-link/config');
    assert.equal(button(app.render(), '保存设置').props.disabled, false);
  }
});

test('runtime polling and auth requests never overlap or poll OAuth automatically', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const app = mounted([{value:payload()}, {value:startReply(), wait}, {value:payload()}]);
  app.render(); await settle(); button(app.render(), '添加账户').props.onClick(); app.tick(); assert.equal(app.calls.length, 4);
  release(); await settle(); app.tick(); await settle();
  assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/models', '/plugins/codebuddy-link/auth/start', '/plugins/codebuddy-link/status']);
});

test('mount serializes status, account and models, blocks overlaps, and preserves drafts throughout', async () => {
  const gates = Array.from({length:3}, () => { let release!: () => void; return {wait:new Promise<void>(resolve => {release = resolve;}), release:() => release()}; });
  const discovered = {...payload(), config:{...payload().config, permissionMode:'acceptEdits'}, catalogModels:[{id:'found', name:'Found'}]};
  const app = harness([{value:payload(), wait:gates[0]!.wait}, {value:payload(), wait:gates[1]!.wait},
    {value:discovered, wait:gates[2]!.wait}, {value:discovered}, {value:discovered}]);
  app.render(); app.tick(); assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status']);
  gates[0]!.release(); await settle(); assert.equal(app.calls[1]!.url, '/plugins/codebuddy-link/refresh');
  control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  app.tick(); button(app.render(), '刷新账户').props.onClick(); button(app.render(), '添加账户').props.onClick(); assert.equal(app.calls.length, 2);
  gates[1]!.release(); await settle(); assert.equal(app.calls[2]!.url, '/plugins/codebuddy-link/models');
  app.tick(); button(app.render(), '获取模型列表').props.onClick(); assert.equal(app.calls.length, 3);
  gates[2]!.release(); await settle(); assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan'); assert.match(content(app.render()), /Found/);
  app.tick(); await settle(); app.tick(); await settle();
  assert.deepEqual(app.calls.slice(3).map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/status']);
  assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan');
});

test('refresh failures stay visible and polling never retries external account or model services', async () => {
  for (const failedStage of ['refresh', 'models']) {
    const replies: Reply[] = [{value:payload()}];
    if (failedStage === 'models') replies.push({value:withQuota({status:'ok', remaining:12})});
    replies.push({ok:false, status:503}, {value:payload()});
    const app = harness(replies); app.render(); await settle();
    assert.match(content(app.render()), /HTTP 503/); assert.equal(app.calls.at(-1)!.url, `/plugins/codebuddy-link/${failedStage}`);
    assert.equal(button(app.render(), '保存设置').props.disabled, false);
    if (failedStage === 'models') assert.match(content(app.render()), /剩余：12\.00/);
    control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}}); app.tick(); await settle();
    assert.equal(app.calls.at(-1)!.url, '/plugins/codebuddy-link/status');
    assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan'); assert.match(content(app.render()), /HTTP 503/);
  }
});

test('unmount at each mount-chain stage ignores late responses and starts no follow-up', async () => {
  for (const stage of [0, 1, 2]) {
    let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
    const app = harness(Array.from({length:3}, (_, index) => ({value:payload(), ...(index === stage ? {wait} : {})})));
    app.render(); await settle(); assert.equal(app.calls.length, stage + 1);
    app.cleanup.forEach(dispose => dispose()); const before = JSON.stringify(app.state); release(); await settle();
    assert.equal(JSON.stringify(app.state), before); assert.equal(app.calls.length, stage + 1); assert.equal(app.timers.size, 0);
  }
});

test('stale mount generation cannot publish results, request models, or unlock the new mount', async () => {
  let oldRelease!: () => void; const oldWait = new Promise<void>(resolve => {oldRelease = resolve;});
  let newRelease!: () => void; const newWait = new Promise<void>(resolve => {newRelease = resolve;});
  const empty = {...payload(), accountPool:{mode:'pool', accounts:[]}};
  const app = harness([{value:payload()}, {value:withQuota({status:'ok', remaining:999}), wait:oldWait}, {value:payload(), wait:newWait}, {value:empty}]);
  app.render(); await settle(); control(app.render(), '权限模式', 'select').props.onChange({target:{value:'plan'}});
  app.remount(); const before = JSON.stringify(app.state); oldRelease(); await settle(); app.tick();
  assert.equal(JSON.stringify(app.state), before); assert.equal(app.calls.length, 3); newRelease(); await settle();
  assert.deepEqual(app.calls.map(call => call.url), ['/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh', '/plugins/codebuddy-link/status', '/plugins/codebuddy-link/refresh']);
  assert.equal(control(app.render(), '权限模式', 'select').props.value, 'plan'); assert.equal(app.timers.size, 1);
});

test('auth refresh chain holds lock and ignores each late follow-up after unmount', async () => {
  for (const stage of ['refresh', 'models']) {
    let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
    const app = mounted([{value:payload()}, {value:startReply()}, {value:{status:'ok'}},
      {value:payload(), ...(stage === 'refresh' ? {wait} : {})}, {value:payload(), ...(stage === 'models' ? {wait} : {})}]);
    app.render(); await settle(); button(app.render(), '添加账户').props.onClick(); await settle();
    button(app.render(), '检查登录结果').props.onClick(); await settle(); const count = stage === 'refresh' ? 6 : 7;
    app.tick(); button(app.render(), '刷新账户').props.onClick(); button(app.render(), '保存设置').props.onClick(); assert.equal(app.calls.length, count);
    app.cleanup.forEach(dispose => dispose()); const before = JSON.stringify(app.state); release(); await settle();
    assert.equal(JSON.stringify(app.state), before); assert.equal(app.calls.length, count);
  }
});

test('unmounted account mutation cannot update state', async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => {release = resolve;});
  const app = mounted([{value:payload()}, {value:withQuota({status:'ok', remaining:999}), wait}]); app.render(); await settle();
  button(accountRow(app.render()), '刷新').props.onClick(); app.cleanup.forEach(dispose => dispose());
  const before = JSON.stringify(app.state); release(); await settle(); assert.equal(JSON.stringify(app.state), before); assert.equal(app.calls.length, 4);
});

test('client has no unsafe HTML, persistence, logging or direct DOM access and clears polling', async () => {
  const app = harness(); app.render(); app.cleanup.forEach(dispose => dispose()); await settle();
  assert.equal(app.state[0], null); assert.equal(app.timers.size, 0); app.tick(); assert.equal(app.calls.length, 1);
  assert.doesNotMatch(code.replace('window.__ModuleLoader__', '__ModuleLoader__'), /\b(?:document|window|innerHTML|createPortal|localStorage|console|dangerouslySetInnerHTML)\b/);
});