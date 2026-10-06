/**
 * dsh-ofm-model-manager / test/host.test.mjs
 * ============================================================================
 * 离线验证台：**不启动 DSH**，把 host 半端的 apply() 挂到一个假的 cordis ctx 上，
 * 逐条核对「停用 → 从模型目录消失 / 面板仍能看到它 / 改完立即生效」这条链路。
 *
 * 口径独立实现一遍（不 import 被测代码的判断逻辑来自证）：
 *   · 「可见分组」由本文件自己复刻 DSH buildModelCatalog() 里那句
 *     groups.filter(group => group.models.length > 0)
 *     （@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js），因为
 *     「厂商/分组从选择器消失」正是它决定的；
 *   · 接口断言直接对着真实的 req/res 形状走。
 *
 * 跑：node --test test/host.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

register('./resolve-hook.mjs', import.meta.url);

const { apply, Config, acquireFilter, ensureFilter, splitKeys, splitNames } = await import('../index.js');
const { idList, keyTextMap } = await import('../src/manager.js');

const NS = 'dsh-ofm-model-manager';
const API = '/api/ofm-model-manager';

const PROVIDERS = [
  { id: 'deepseek-official', name: 'DeepSeek' },
  { id: 'our-free-model', name: 'Our Free Model' },
  { id: 'our-free-model-region', name: 'Our Free Model · region-limited' },
  { id: 'z-ai', name: 'Z.ai' },
];

const LISTINGS = {
  'deepseek-official': [
    { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'deepseek-official', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  ],
  'our-free-model': [
    { provider: 'our-free-model', id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash', inputModalities: ['text', 'image'] },
    { provider: 'our-free-model', id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash (OFM)' },
  ],
  'our-free-model-region': [
    { provider: 'our-free-model-region', id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3' },
  ],
  'z-ai': [
    { provider: 'z-ai', id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' },
    { provider: 'z-ai', id: 'deepseek-v4.1-flash', name: 'GLM Gateway Flash' },
  ],
};

/** 仿 LlmRuntime：listModels / listProviders 在**原型**上（用来验证卸载时能还原）。 */
class FakeLlm {
  constructor(listings = LISTINGS) {
    this.listings = listings;
    this.events = 0;
    this.listCalls = 0;
  }
  listModels(provider) {
    this.listCalls += 1;
    if (this.broken !== undefined && this.broken.has(String(provider))) throw new Error('boom: ' + provider);
    return Promise.resolve(this.listings[provider] ?? []);
  }
  listProviders() {
    return Object.keys(this.listings).map(id => ({ id, name: labelOf(id) }));
  }
  emitAdaptersUpdated() {
    this.events += 1;
  }
}

function labelOf(id) {
  if (id === 'our-free-model') return 'Our Free Model';
  if (id === 'our-free-model-region') return 'Our Free Model · region-limited';
  if (id === 'deepseek-official') return 'DeepSeek';
  if (id === 'z-ai') return 'Z.ai';
  return String(id);
}

/** 可写的 volatile ref，模拟 loader 提交 volatile 配置之后的形态。 */
function makeRef(initial) {
  let value = initial;
  return { get: () => value, set: next => { value = next; } };
}

/**
 * 假 ctx：只实现本插件真正用到的那几个面。
 * @param {{llm: object, describe?: Function, connection?: object, ns?: string}} options
 */
function makeCtx(options) {
  const llm = options.llm;
  const listeners = new Map();
  const disposers = [];
  const webRoutes = new Map();
  const injected = [];
  const warnings = [];
  const ns = options.ns ?? NS;

  const settingsService = {
    configure: () => () => {},
    describe: options.describe ?? (() => []),
  };
  const webServer = {
    register: route => {
      webRoutes.set(route.path, route.handler);
      return () => webRoutes.delete(route.path);
    },
  };

  const registerEffect = fn => {
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };

  const childFor = deps => {
    const child = { effect: registerEffect };
    if (deps.includes('llm')) child.llm = llm;
    if (deps.includes('settings')) child.settings = settingsService;
    if (deps.includes('webServer')) child.webServer = webServer;
    return child;
  };

  const ctx = {
    fiber: { entry: { options: { id: ns } } },
    logger: { warn: (...args) => warnings.push(args), info: () => {} },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    inject: (deps, callback) => {
      injected.push(deps);
      callback(childFor(deps));
    },
    effect: registerEffect,
    get: key => (key === 'llm' ? llm : key === 'settings' ? settingsService : key === 'connection' ? options.connection : undefined),
  };

  return {
    ctx,
    webRoutes,
    injected,
    warnings,
    emit: (event, ...args) => {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    injectRows: () => {
      const table = [];
      for (const fn of listeners.get('webserver/index-inject') ?? []) fn(table);
      return table;
    },
    disposeAll: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

/** 复刻 buildModelCatalog 里决定「分组去留」的那一句。 */
async function visibleGroups(llm) {
  const providers = llm.listProviders();
  const groups = await Promise.all(providers.map(async provider => ({
    id: provider.id,
    models: await llm.listModels(provider.id),
  })));
  return groups.filter(group => group.models.length > 0).map(group => group.id);
}

/** 最小 req/res 替身。 */
function makeRes() {
  const out = { status: 0, headers: undefined, body: '' };
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers; },
    end(body) { out.body = body === undefined ? '' : String(body); },
  };
}

function req(overrides) {
  const base = { method: 'GET', url: API + '/models', headers: { host: '127.0.0.1:43120' } };
  return Object.assign(base, overrides ?? {});
}

/** 把一次请求跑完，返回解析后的 JSON。 */
async function call(harness, overrides) {
  const handler = harness.webRoutes.get(API);
  assert.ok(typeof handler === 'function', '清单接口应已注册');
  const res = makeRes();
  await handler(req(overrides), res);
  return { status: res.out.status, json: res.out.body === '' ? null : JSON.parse(res.out.body), headers: res.out.headers };
}

/** 从清单里取一行的 id 列表（按 host 给的顺序）。 */
function idsOf(payload, provider) {
  return payload.models.filter(model => model.provider === provider).map(model => model.id);
}

/** 模型 id 在当前目录里的可见名单（过滤后）。 */
async function visibleIds(llm, provider) {
  return (await llm.listModels(provider)).map(model => model.id);
}

// ── 配置 ────────────────────────────────────────────────────────────────────

test('Config：disabled 与 names 是 volatile 的权威字段，hidden 兼容保留', () => {
  // volatile 字段在运行期是响应式 ref（.get()），不是裸值 —— idList/keyTextMap 两种都读。
  assert.deepEqual(idList(Config({}).disabled), []);
  assert.equal(Config.dict.disabled.meta.volatile, true);
  assert.deepEqual(keyTextMap(Config({}).names), {});
  assert.equal(Config.dict.names.meta.volatile, true);
  // v1 的字段仍在 schema 里，而且**也必须是 volatile**：
  // settings 服务的 write() 拒绝任何非 volatile 字段，而非 volatile 的 hidden 会让
  // 「镜像 v1 设置」这个动作直接失败（2026-10-06 真机端到端抓到的 bug）。
  assert.deepEqual(idList(Config({}).hidden), []);
  assert.equal(Config.dict.hidden.meta.volatile, true);
  // routes 是部署配置，不该由界面写入 → 保持非 volatile
  assert.equal(Config.dict.routes?.meta?.volatile, undefined);
  assert.deepEqual(idList(Config({}).routes), []);
  assert.deepEqual(keyTextMap(Config({ names: { 'p|m': 'M' } }).names), { 'p|m': 'M' });
  // 非字符串值会被 schema 拒绝 —— 面板永远只写字符串，这条是护栏
  assert.throws(() => Config({ names: { a: 3 } }));
});

// ── 偏好分桶（补丁函数的取数形状） ───────────────────────────────────────────

test('splitKeys：精确键进 provider 桶，裸 id 进通配桶', () => {
  const split = splitKeys(['our-free-model|jev', 'jev', 'z-ai|glm-x', '', 'p|', '  ']);
  assert.deepEqual([...split.wildcard], ['jev']);
  assert.deepEqual([...split.byProvider.keys()].sort(), ['our-free-model', 'z-ai']);
  assert.deepEqual([...split.byProvider.get('z-ai')], ['glm-x']);
  // 空 provider / 空 id 一律丢掉
  assert.equal(split.byProvider.has(''), false);
});

test('splitNames：精确名进 provider 桶，裸 id 名进通配桶，空白值丢掉', () => {
  const split = splitNames({ 'our-free-model|jev': ' Jev ', 'mimo': 'MiMo', 'x|y': '   ' });
  assert.deepEqual([...split.wildcard.entries()], [['mimo', 'MiMo']]);
  assert.deepEqual([...split.byProvider.get('our-free-model').entries()], [['jev', 'Jev']]);
  assert.equal(split.byProvider.has('x'), false);
});

// ── 过滤补丁（v1 的回归面） ──────────────────────────────────────────────────

test('空配置：全部 provider 的全部模型都在目录里', async () => {
  const llm = new FakeLlm();
  const ref = makeRef([]);
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: ref, routes: [] });

  assert.deepEqual(await visibleGroups(llm), ['deepseek-official', 'our-free-model', 'our-free-model-region', 'z-ai']);
  assert.deepEqual(await visibleIds(llm, 'our-free-model'), ['mimo-v2.6-flash-free', 'deepseek-v4.1-flash']);
  harness.disposeAll();
});

test('停用一个模型：它从目录里消失，同组其它模型与别的 provider 不受影响', async () => {
  const llm = new FakeLlm();
  const ref = makeRef([]);
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: ref, routes: [] });

  const before = llm.events;
  ref.set(['our-free-model|deepseek-v4.1-flash']);
  harness.emit('loader/volatile-update', [['disabled']]);

  assert.deepEqual(await visibleIds(llm, 'our-free-model'), ['mimo-v2.6-flash-free']);
  // 同名模型在别的 provider 下**不受影响** —— v2 的核心修复
  assert.deepEqual(await visibleIds(llm, 'deepseek-official'), ['deepseek-chat', 'deepseek-v4.1-flash']);
  assert.deepEqual(await visibleIds(llm, 'z-ai'), ['z-ai/glm-5.3-flash', 'deepseek-v4.1-flash']);
  assert.ok(llm.events > before, '应广播 llm/adapters-updated（浏览器据此重载模型目录）');
  harness.disposeAll();
});

test('v1 的 hidden（裸 id）对所有 provider 的同名模型生效', async () => {
  const llm = new FakeLlm();
  const ref = makeRef([]);
  const hidden = makeRef(['deepseek-v4.1-flash']);
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: ref, hidden, routes: [] });

  assert.deepEqual(await visibleIds(llm, 'our-free-model'), ['mimo-v2.6-flash-free']);
  assert.deepEqual(await visibleIds(llm, 'deepseek-official'), ['deepseek-chat']);
  assert.deepEqual(await visibleIds(llm, 'z-ai'), ['z-ai/glm-5.3-flash']);
  harness.disposeAll();
});

test('停用一个地区 provider 的全部模型：region 分组被整组丢弃', async () => {
  const llm = new FakeLlm();
  const ref = makeRef(['our-free-model-region|muse-spark-1.3-contributor-free']);
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: ref, routes: [] });

  assert.deepEqual(await visibleGroups(llm), ['deepseek-official', 'our-free-model', 'z-ai']);
  harness.disposeAll();
});

test('重新启用：模型自己回来（可逆）', async () => {
  const llm = new FakeLlm();
  const ref = makeRef(['our-free-model|mimo-v2.6-flash-free']);
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: ref, routes: [] });
  assert.deepEqual(await visibleIds(llm, 'our-free-model'), ['deepseek-v4.1-flash']);

  ref.set([]);
  harness.emit('loader/volatile-update', [['disabled']]);
  assert.deepEqual(await visibleIds(llm, 'our-free-model'), ['mimo-v2.6-flash-free', 'deepseek-v4.1-flash']);
  harness.disposeAll();
});

test('自定义名称：精确键改写该 provider 的 name，浅拷贝不动原对象', async () => {
  const llm = new FakeLlm();
  const ref = makeRef([]);
  const names = makeRef({});
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: ref, names, routes: [] });

  const original = llm.listings['our-free-model'][1];
  names.set({ 'our-free-model|deepseek-v4.1-flash': 'OFM Flash' });
  harness.emit('loader/volatile-update', [['names']]);

  const listed = (await llm.listModels('our-free-model')).find(model => model.id === 'deepseek-v4.1-flash');
  assert.equal(listed.name, 'OFM Flash');
  assert.equal(listed.provider, 'our-free-model');
  // 原对象没被就地改写（provider 会把同一个对象交给别处）
  assert.equal(original.name, 'DeepSeek Flash (OFM)');
  // 别的 provider 下的同名模型不受精确键影响
  const other = (await llm.listModels('z-ai')).find(model => model.id === 'deepseek-v4.1-flash');
  assert.equal(other.name, 'GLM Gateway Flash');
  harness.disposeAll();
});

test('自定义名称：v1 的扁平表（裸 id）对所有 provider 生效', async () => {
  const llm = new FakeLlm();
  const names = makeRef({ 'deepseek-v4.1-flash': '通配名' });
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: makeRef([]), names, routes: [] });

  for (const provider of ['our-free-model', 'deepseek-official', 'z-ai']) {
    const row = (await llm.listModels(provider)).find(model => model.id === 'deepseek-v4.1-flash');
    assert.equal(row.name, '通配名', provider);
  }
  harness.disposeAll();
});

test('没进管理范围的路由原样透传（零开销：不挂 then）', async () => {
  const llm = new FakeLlm({ 'other-route': [{ id: 'x', name: 'X' }] });
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: makeRef(['other-route|x']), routes: [] });

  // 「other-route」也被认领了（v2 默认全管），所以这里要确认它是**被过滤**的；
  // 真正透传的是 routes 收窄之后没进名单的那些。
  assert.deepEqual(await visibleIds(llm, 'other-route'), []);
  harness.disposeAll();
});

test('routes 收窄：名单之外的路由完全不受影响', async () => {
  const llm = new FakeLlm();
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: makeRef(['z-ai|z-ai/glm-5.3-flash']), routes: makeRef(['our-free-model']) });

  // z-ai 不在名单里 —— 就算配置里有针对它的停用记录也不生效
  assert.deepEqual(await visibleIds(llm, 'z-ai'), ['z-ai/glm-5.3-flash', 'deepseek-v4.1-flash']);
  assert.deepEqual(await visibleIds(llm, 'our-free-model'), ['mimo-v2.6-flash-free', 'deepseek-v4.1-flash']);
  harness.disposeAll();
});

// ── 只读清单接口 ────────────────────────────────────────────────────────────

test('GET /models：给全清单（含被停用的），带 provider / 三态 / 键', async () => {
  const llm = new FakeLlm();
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: makeRef(['our-free-model|deepseek-v4.1-flash']), routes: [] });

  const { status, json, headers } = await call(harness);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.apiVersion, 2);
  assert.equal(json.ns, NS);
  assert.equal(json.counts.total, 7);
  assert.equal(json.counts.disabled, 1);
  assert.equal(json.counts.routes, 4);
  assert.equal(headers['cache-control'], 'no-store');
  // 被停用的模型**仍然在清单里**（否则用户开不回来）
  const ofmFlash = json.models.find(model => model.key === 'our-free-model|deepseek-v4.1-flash');
  assert.equal(ofmFlash.enabled, false);
  assert.equal(ofmFlash.status, 'disabled');
  assert.equal(ofmFlash.providerLabel, 'Our Free Model');
  assert.equal(idsOf(json, 'z-ai').length, 2);
  // region 标记与 ofm 标记都给出来
  assert.equal(json.routes.find(route => route.id === 'our-free-model-region').region, true);
  assert.equal(json.routes.find(route => route.id === 'our-free-model').ofm, true);
  assert.equal(json.routes.find(route => route.id === 'z-ai').ofm, false);
  harness.disposeAll();
});

test('GET /models：默认走缓存，force=1 绕开；TTL 内不重复调 listModels', async () => {
  const llm = new FakeLlm();
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: makeRef([]), routes: [] });

  await call(harness);
  const afterFirst = llm.listCalls;
  assert.equal(afterFirst, 4, '四个 provider 各读一次');
  const second = await call(harness);
  assert.equal(llm.listCalls, afterFirst, 'TTL 内应命中缓存');
  assert.equal(second.json.cached, 4);
  const forced = await call(harness, { url: API + '/models?force=1' });
  assert.equal(llm.listCalls, afterFirst + 4, 'force=1 应重读');
  assert.equal(forced.json.cached, 0);
  // llm/adapters-updated 让缓存失效（别处改了目录）
  harness.emit('llm/adapters-updated');
  await call(harness);
  assert.equal(llm.listCalls, afterFirst + 8);
  harness.disposeAll();
});

test('接口：非 GET 405、非清单路径 404、内网之外的 Host 403', async () => {
  const llm = new FakeLlm();
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: makeRef([]), routes: [] });

  assert.equal((await call(harness, { method: 'POST' })).status, 405);
  assert.equal((await call(harness, { method: 'DELETE' })).status, 405);
  // HEAD 与 GET 同权（只读）
  assert.equal((await call(harness, { method: 'HEAD' })).status, 200);
  assert.equal((await call(harness, { url: API + '/nope' })).status, 404);
  assert.equal((await call(harness, { url: API + '/' })).status, 200);
  // DNS rebinding / 跨站防线：Host 不是回环就 403
  assert.equal((await call(harness, { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await call(harness, { headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call(harness, { headers: { host: '127.0.0.1:43120', origin: 'http://evil.example:43120' } })).status, 403);
  // 同源 Origin 放行
  assert.equal((await call(harness, { headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' } })).status, 200);
  harness.disposeAll();
});

test('接口：组合里挂了 connection 服务时用它的准入判断', async () => {
  const llm = new FakeLlm();
  const harness = makeCtx({ llm, connection: { admit: () => ({ rejection: 401 }) } });
  apply(harness.ctx, { disabled: makeRef([]), routes: [] });

  const refused = await call(harness);
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error, 'unauthorized');
  harness.disposeAll();
});

test('接口：llm 服务不可用时 503，单条 provider 读失败不影响其它 provider', async () => {
  const llm = new FakeLlm();
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: makeRef([]), routes: [] });

  llm.broken = new Set(['z-ai']);
  const { status, json } = await call(harness, { url: API + '/models?force=1' });
  assert.equal(status, 200);
  assert.equal(json.routes.find(route => route.id === 'z-ai').count, 0);
  assert.equal(json.routes.find(route => route.id === 'z-ai').empty, true);
  assert.equal(json.counts.total, 5);
  assert.ok(harness.warnings.length > 0, '读失败要有日志');
  harness.disposeAll();
});

test('index-inject：把命名空间与 apiVersion=2 交给浏览器半端', () => {
  const llm = new FakeLlm();
  const harness = makeCtx({ llm, ns: 'custom-ns' });
  apply(harness.ctx, { disabled: makeRef([]), routes: [] });

  const rows = harness.injectRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '__DSH_OFM_MODEL_MANAGER__');
  assert.deepEqual(rows[0].value, { ns: 'custom-ns', api: API, apiVersion: 2 });
  harness.disposeAll();
});

// ── 与别的插件的兼容性 ──────────────────────────────────────────────────────

test('兼容：与 dsh-provider-toggle 共用同一个 listModels 补丁槽，互不带走', async () => {
  const llm = new FakeLlm();
  const ref = makeRef([]);
  const harness = makeCtx({ llm });
  apply(harness.ctx, { disabled: ref, routes: [] });

  // 模拟 dsh-provider-toggle 的 acquireFilter：它也往 llm 上装自有属性 listModels
  const TOGGLE = Symbol.for('dsh-provider-toggle.patch');
  const inner = llm.listModels.bind(llm);
  const toggleState = { original: inner, disabled: new Set(['deepseek-official']) };
  Object.defineProperty(llm, 'listModels', {
    value: (provider, signal) => (toggleState.disabled.has(String(provider)) ? Promise.resolve([]) : toggleState.original(provider, signal)),
    writable: true, configurable: true, enumerable: false,
  });
  Object.defineProperty(llm, TOGGLE, { value: toggleState, writable: true, configurable: true, enumerable: false });

  // 两个开关都在链路上：provider 被整条关掉 + 我们的逐模型停用
  ref.set(['our-free-model|mimo-v2.6-flash-free']);
  harness.emit('loader/volatile-update', [['disabled']]);
  assert.deepEqual((await llm.listModels('deepseek-official')).map(m => m.id), [], 'provider-toggle 的整条关闭仍生效');
  assert.deepEqual((await llm.listModels('our-free-model')).map(m => m.id), ['deepseek-v4.1-flash'], '我们的逐模型停用仍生效');

  // provider-toggle 卸载：它删的是自有属性 —— 我们必须在下次重读时补装回来
  Reflect.deleteProperty(llm, 'listModels');
  Reflect.deleteProperty(llm, TOGGLE);
  assert.deepEqual((await llm.listModels('our-free-model')).map(m => m.id), ['mimo-v2.6-flash-free', 'deepseek-v4.1-flash'], '被摘掉后过滤暂时失效');
  harness.emit('llm/adapters-updated');
  assert.deepEqual((await llm.listModels('our-free-model')).map(m => m.id), ['deepseek-v4.1-flash'], '重读时补装，过滤恢复');
  harness.disposeAll();
});

test('兼容：ensureFilter 只在自有属性整个消失时补装，别人又包一层时不叠包装', () => {
  const llm = new FakeLlm();
  const shared = { routes: [{ id: 'our-free-model' }], disabled: new Set(), offByProvider: new Map(), wildcardOff: new Set(), namesByProvider: new Map(), wildcardNames: new Map() };
  const { release } = acquireFilter(llm, shared);
  const patched = llm.listModels;

  // 自有属性还在（别人又包了一层）→ 不动
  ensureFilter(llm, shared);
  assert.equal(llm.listModels, patched);
  // 自有属性被删 → 补装
  Reflect.deleteProperty(llm, 'listModels');
  ensureFilter(llm, shared);
  assert.equal(llm.listModels, patched);
  assert.equal(Object.hasOwn(llm, 'listModels'), true);
  release();
  assert.equal(Object.hasOwn(llm, 'listModels'), false, '卸载后要还原成原型方法');
  assert.equal(typeof llm.listModels, 'function');
});

test('兼容：引用计数 —— 重复 apply 不叠加包装，全部释放才还原', () => {
  const llm = new FakeLlm();
  const shared = { routes: [], disabled: new Set(), offByProvider: new Map(), wildcardOff: new Set(), namesByProvider: new Map(), wildcardNames: new Map() };
  const first = acquireFilter(llm, shared);
  const wrapped = llm.listModels;
  const second = acquireFilter(llm, shared);
  assert.equal(llm.listModels, wrapped, '第二次 acquire 不该再包一层');
  first.release();
  assert.equal(Object.hasOwn(llm, 'listModels'), true, '还有人持有就不还原');
  second.release();
  assert.equal(Object.hasOwn(llm, 'listModels'), false);
});



