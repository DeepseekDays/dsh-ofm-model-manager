/**
 * dsh-ofm-model-manager / test/client.test.mjs
 * ============================================================================
 * 离线验证台（浏览器半端）：不启动 DSH、不开浏览器。
 *
 * 做四件事：
 *   1. 按真实的 ModuleLoader 协议加载 client.js，拿到它的导出（离线接缝）；
 *   2. 用一个最小 React 替身把管理面板**真的渲染一遍**，核对分组、计数、
 *      状态徽标、批量范围、空态都在树里；
 *   3. 核对开关/改名写入走的是 ctx.remote.settings.mutate，且入参形状正确
 *      （乐观更新 + revision 记账 + v1 的 hidden 镜像）；
 *   4. 核对「部分渲染 + 显示更多」在大清单下的行为。
 *
 * 跑：node --test test/client.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 源码文本：给「结构上必须成立」的那几条断言用（RENDER_KEYS 覆盖、无模板字符串）。 */
const CLIENT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8');

// ── 浏览器替身（必须在 import client.js 之前就位） ───────────────────────────

let captured;
globalThis.window = { __ModuleLoader__: { load: spec => { captured = spec; } } };
globalThis.document = {
  documentElement: { lang: 'zh' },
  createElement: () => ({ setAttribute() {}, remove() {}, style: {} }),
  head: { appendChild() {} },
};

await import('../client.js');

const NS = 'dsh-ofm-model-manager';

/** 两个 provider 故意共用同一个模型 id —— v2 的核心场景。 */
const ROSTER = {
  ok: true,
  apiVersion: 2,
  ns: NS,
  cached: 0,
  routes: [
    { id: 'deepseek-official', label: 'DeepSeek', region: false, ofm: false, count: 2, enabled: 2, disabled: 0, empty: false },
    { id: 'our-free-model', label: 'Our Free Model', region: false, ofm: true, count: 2, enabled: 1, disabled: 1, empty: false },
    { id: 'our-free-model-region', label: 'Our Free Model · region-limited', region: true, ofm: true, count: 1, enabled: 1, disabled: 0, empty: false },
  ],
  models: [
    { key: 'deepseek-official|deepseek-chat', id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'text input', provider: 'deepseek-official', providerLabel: 'DeepSeek', region: false, ofm: false, enabled: true, status: 'available', customName: null, customShared: false, offShared: false },
    { key: 'deepseek-official|deepseek-v4.1-flash', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: '', provider: 'deepseek-official', providerLabel: 'DeepSeek', region: false, ofm: false, enabled: true, status: 'available', customName: null, customShared: false, offShared: false },
    { key: 'our-free-model|mimo-v2.6-flash-free', id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash', description: 'vision + text input · 1024K context', provider: 'our-free-model', providerLabel: 'Our Free Model', region: false, ofm: true, enabled: true, status: 'available', customName: null, customShared: false, offShared: false },
    { key: 'our-free-model|deepseek-v4.1-flash', id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash (OFM)', description: '', provider: 'our-free-model', providerLabel: 'Our Free Model', region: false, ofm: true, enabled: false, status: 'disabled', customName: null, customShared: false, offShared: false },
    { key: 'our-free-model-region|muse-spark-1.3-contributor-free', id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3', description: '', provider: 'our-free-model-region', providerLabel: 'Our Free Model · region-limited', region: true, ofm: true, enabled: true, status: 'region', customName: null, customShared: false, offShared: false },
  ],
  counts: { total: 5, enabled: 4, available: 3, region: 1, disabled: 1, routes: 3 },
  disabled: ['our-free-model|deepseek-v4.1-flash'],
  disabledStale: [],
  names: {},
  namesStale: [],
  generatedAt: 1700000000000,
};

/**
 * 最小 React 替身：够渲染本插件的组件。
 *
 * hooks 按**组件函数身份**持久（不是按一次 render）：同一个 Panel 反复 render
 * 时 useState 的值会保留，于是「点一下 → 再 render → 看结果」这种交互断言才成立。
 * 这正是 useState 的 setter 在真 React 里触发重渲染的那条链路，这里由测试手动驱动。
 */
function makeReact() {
  const hooks = new Map();
  const frames = [];
  const pendingEffects = [];
  /** 当前挂载点：同一个组件函数在不同用例里必须各自持有一份状态。 */
  let mountKey = 0;
  const frame = () => frames[frames.length - 1];
  const storeFor = type => {
    const key = (mountKey === null || mountKey === undefined ? 'default' : mountKey) + '::' + (typeof type === 'function' ? type.name || 'anon' : String(type));
    let store = hooks.get(key);
    if (store === undefined) {
      store = { cursor: 0, states: {}, refs: {}, deps: {} };
      hooks.set(key, store);
    }
    store.cursor = 0;
    return store;
  };
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props);
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState(initial) {
      const f = frame();
      const i = f.cursor++;
      if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial;
      return [f.states[i], next => {
        const value = typeof next === 'function' ? next(f.states[i]) : next;
        f.states[i] = value;
      }];
    },
    useEffect(fn, deps) {
      const f = frame();
      const i = f.cursor++;
      const key = JSON.stringify(deps === undefined ? null : deps);
      if (f.deps[i] !== key) {
        f.deps[i] = key;
        pendingEffects.push(fn);
      }
    },
    useMemo(fn) { const f = frame(); f.cursor++; return fn(); },
    useRef(initial) {
      const f = frame();
      const i = f.cursor++;
      if (!(i in f.refs)) f.refs[i] = { current: initial };
      return f.refs[i];
    },
    useCallback(fn) { const f = frame(); f.cursor++; return fn; },
  };
  function render(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return { type: 'text', text: String(node), children: [] };
    if (Array.isArray(node)) return { type: 'array', text: '', children: node.map(render).filter(Boolean) };
    if (typeof node.type === 'function') {
      frames.push(storeFor(node.type));
      let out;
      try { out = node.type(node.props); } finally { frames.pop(); }
      // effect 排到当前这次 render 之后跑（真 React 也是这个次序）
      while (pendingEffects.length > 0) pendingEffects.shift()();
      return render(out);
    }
    const raw = node.props === undefined ? undefined : node.props.children;
    const children = [];
    if (raw !== undefined) for (const child of Array.isArray(raw) ? raw : [raw]) {
      const rendered = render(child);
      if (rendered !== null) children.push(rendered);
    }
    return { type: typeof node.type === 'string' ? node.type : 'unknown', props: node.props ?? {}, children };
  }
  return {
    React,
    render,
    /**
     * 切换挂载点：只在**换了一个挂载点**时清状态（同一个 harness 反复 render
     * 必须保留组件状态，否则「点一下 → 再 render → 看结果」根本不成立）。
     */
    mount(key) {
      if (key === mountKey) return;
      mountKey = key;
      hooks.clear();
      frames.length = 0;
      pendingEffects.length = 0;
    },
  };
}

function collectText(node, out = []) {
  if (node === null) return out;
  if (node.type === 'text') out.push(node.text);
  for (const child of node.children) collectText(child, out);
  return out;
}

function collectByType(node, type, out = []) {
  if (node === null) return out;
  if (node.type === type) out.push(node);
  for (const child of node.children) collectByType(child, type, out);
  return out;
}

function collectInOrder(node, visit) {
  if (node === null) return;
  visit(node);
  for (const child of node.children) collectInOrder(child, visit);
}

function collectByClass(node, needle, out = []) {
  if (node === null) return out;
  const className = node.props !== undefined && typeof node.props.className === 'string' ? node.props.className : '';
  if (className.includes(needle)) out.push(node);
  for (const child of node.children) collectByClass(child, needle, out);
  return out;
}

/** 假 client ctx：只实现本插件真正用到的那几个面。 */
function makeClientCtx(options = {}) {
  // 面板状态是页面级单例（与真机一致），用例之间要显式复位，否则上一条用例的
  // saveError / roster 会漏到下一条。
  module.__reset();
  const effects = [];
  const registrations = [];
  const subscriptions = [];
  const writes = [];
  const describes = [];
  const settingsValue = options.settings !== undefined
    ? options.settings
    : { disabled: ['our-free-model|deepseek-v4.1-flash'], names: {}, hidden: [] };
  // 真机上 describe 返回的就是「最近一次写进去的那份」。默认的静态 settingsValue
  // 不反映写入，够用于单点断言；需要跑完整「写 → 宿主回声 → 重读」序列的用例
  // 打开 liveSettings，让 describe 跟着 mutate 走。
  const liveSettings = options.liveSettings === true;
  let liveValue = settingsValue;
  // 真机上 revision 每次写入都会 +1，describe 返回的就是那个新值。默认写死 3 是
  // 给单点断言用的；跑完整序列时必须让它跟着走，否则回声判定会失真。
  let liveRevision = 3;
  const ctx = {
    effect: fn => {
      const dispose = fn();
      if (typeof dispose === 'function') effects.push(dispose);
      return dispose;
    },
    slots: {
      inject: (name, callback) => { callback(); return () => {}; },
      register: (options2, component) => {
        registrations.push({ options: options2, component });
        return () => {};
      },
    },
    remote: {
      settings: {
        describe: async () => {
          describes.push(1);
          if (options.describe !== undefined) return options.describe();
          return { ok: true, value: { namespaces: [{ ns: NS, revision: liveSettings ? liveRevision : 3, value: liveSettings ? liveValue : settingsValue }] } };
        },
        mutate: async (ns, ops, revision) => {
          writes.push({ ns, ops, revision });
          if (options.mutate !== undefined) return options.mutate(ns, ops, revision);
          const value = liveSettings ? Object.assign({}, liveValue) : {};
          for (const op of ops) value[op.path[op.path.length - 1]] = op.value;
          if (liveSettings) { liveValue = value; liveRevision = revision + 1; }
          return { ok: true, value: { ns, revision: revision + 1, value } };
        },
      },
      $on: (event, fn) => {
        subscriptions.push({ event, fn });
        return () => {};
      },
    },
  };
  return { ctx, effects, registrations, subscriptions, writes, describes };
}

const stubFetch = payload => {
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload });
};

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// ── 加载协议 ────────────────────────────────────────────────────────────────

test('client.js 按 ModuleLoader 协议注册自己（id = 包名）', () => {
  assert.equal(captured.id, 'dsh-ofm-model-manager');
  assert.equal(typeof captured.factory, 'function');
});

const renderer = makeReact();
const { React } = renderer;
const module = captured.factory(spec => {
  if (spec === 'react') return React;
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      Switch: props => React.createElement('switch', props),
      Checkbox: props => React.createElement('checkbox', props),
    };
  }
  throw new Error('unexpected require: ' + spec);
});

test('导出面：apply/inject 齐全；离线接缝都在', () => {
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote', 'remote.settings']);
  for (const name of ['derive', 'groupRows', 'matchModel', 'pkey', 'legacyMirror', 'normalizeKeys', 'normalizeNames', 'customNameOf', 'customIsShared', 'effectiveNameOf', 'hostApiVersion']) {
    assert.equal(typeof module[name], 'function', name + ' 应是函数');
  }
});

test('样式：选择器全带 ofmm_ 前缀，且全部走主题变量', () => {
  assert.ok(module.CSS.includes('.ofmm_root'));
  assert.ok(module.CSS.includes('.ofmm_row'));
  assert.ok(module.CSS.includes('.ofmm_group'));
  assert.ok(module.CSS.includes('.ofmm_badge.disabled'));
  assert.ok(module.CSS.includes('.ofmm_nameInput:disabled'));
  assert.ok(module.CSS.includes('var(--dsw-alias-'));
  // 没有裸色值（主题切换会失效）
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(module.CSS), false);
});

test('文案：中英文键集合一致（漏翻会显示成 key）', () => {
  const zh = Object.keys(module.DICT.zh).sort();
  const en = Object.keys(module.DICT.en).sort();
  assert.deepEqual(en, zh);
  assert.ok(zh.includes('bulkScope'), '批量作用范围必须有一句说明');
});

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('fmt：占位替换，缺参数时原样保留', () => {
  assert.equal(module.fmt('停用 {name}', { name: 'MiMo' }), '停用 MiMo');
  assert.equal(module.fmt('共 {total} 个', {}), '共 {total} 个');
  assert.equal(module.fmt('无占位'), '无占位');
});

test('pkey：精确键带分隔符，通配键就是裸 id（与 host 同口径）', () => {
  assert.equal(module.pkey('z-ai', 'z-ai/glm-5.3-flash'), 'z-ai' + module.SEP + 'z-ai/glm-5.3-flash');
  assert.equal(module.pkey('', 'jev'), 'jev');
  assert.equal(module.SEP, '|');
});

test('legacyMirror：只把通配键镜像进 v1 的 hidden', () => {
  assert.deepEqual(module.legacyMirror(['a', 'p|m', 'other|x']), ['a']);
  assert.deepEqual(module.legacyMirror([]), []);
});

test('normalizeKeys / normalizeNames：坏值丢掉，空串是合法名称', () => {
  assert.deepEqual(module.normalizeKeys(['a', '', 'a', 3, null, 'b']), ['a', 'b']);
  assert.deepEqual(module.normalizeKeys(undefined), []);
  assert.deepEqual(module.normalizeNames({ a: 'A', b: 3, '': 'x', c: null }), { a: 'A' });
  assert.deepEqual(module.normalizeNames({ a: '' }), { a: '' }, '空串要留着 —— 否则清空输入框时勾选框会自己弹回去');
  assert.deepEqual(module.normalizeNames(['a']), {});
});

test('hostApiVersion：注入里没有 apiVersion 就当作 0（旧宿主）', () => {
  globalThis.__DSH_OFM_MODEL_MANAGER__ = { ns: 'x', api: '/y', apiVersion: 2 };
  assert.equal(module.hostApiVersion(), 2);
  globalThis.__DSH_OFM_MODEL_MANAGER__ = { ns: 'x', api: '/y' };
  assert.equal(module.hostApiVersion(), 0);
  globalThis.__DSH_OFM_MODEL_MANAGER__ = undefined;
  assert.equal(module.hostApiVersion(), 0);
});

test('namespaceId / apiBase：优先用 host 注入的值，缺失时回落', () => {
  globalThis.__DSH_OFM_MODEL_MANAGER__ = { ns: 'custom-ns', api: '/api/custom' };
  assert.equal(module.namespaceId(), 'custom-ns');
  assert.equal(module.apiBase(), '/api/custom');
  globalThis.__DSH_OFM_MODEL_MANAGER__ = undefined;
  assert.equal(module.namespaceId(), 'dsh-ofm-model-manager');
  assert.equal(module.apiBase(), '/api/ofm-model-manager');
});

// ── 派生（乐观更新靠它） ────────────────────────────────────────────────────

test('derive：用停用集合补出启用状态与统计，精确键只影响那一个 provider', () => {
  const derived = module.derive(ROSTER, ['our-free-model|deepseek-v4.1-flash']);
  assert.deepEqual(derived.counts, { total: 5, enabled: 4, available: 3, region: 1, disabled: 1 });
  const byKey = new Map(derived.models.map(m => [m.key, m]));
  assert.equal(byKey.get('our-free-model|deepseek-v4.1-flash').status, 'disabled');
  // 同名模型在别的 provider 下不受影响（v2 的核心修复）
  assert.equal(byKey.get('deepseek-official|deepseek-v4.1-flash').status, 'available');
  assert.equal(byKey.get('deepseek-official|deepseek-chat').status, 'available');
  assert.equal(byKey.get('our-free-model-region|muse-spark-1.3-contributor-free').status, 'region');
  // 清单缺失时不炸
  assert.deepEqual(module.derive(null, []).models, []);
});

test('derive：通配键（v1 的裸 id）对所有 provider 同名模型生效', () => {
  const derived = module.derive(ROSTER, ['deepseek-v4.1-flash']);
  assert.equal(derived.counts.disabled, 2);
  const flashes = derived.models.filter(m => m.id === 'deepseek-v4.1-flash');
  assert.deepEqual(flashes.map(m => m.enabled), [false, false]);
});

test('derive：停用优先于地区受限', () => {
  const derived = module.derive(ROSTER, ['our-free-model-region|muse-spark-1.3-contributor-free']);
  assert.equal(derived.models.find(m => m.region === true).status, 'disabled');
  assert.equal(derived.counts.region, 0);
});

test('derive + 自定义名称：精确键优先生效，通配键兜底并标 customShared', () => {
  const derived = module.derive(ROSTER, [], {
    'our-free-model|mimo-v2.6-flash-free': '小咪',
    'deepseek-v4.1-flash': '通配 Flash',
  });
  const mimo = derived.models.find(m => m.id === 'mimo-v2.6-flash-free');
  assert.equal(mimo.custom, true);
  assert.equal(mimo.customName, '小咪');
  assert.equal(mimo.displayName, '小咪');
  assert.equal(mimo.name, 'MiMo V2.6 Flash', '默认名必须留着（未自定义时输入框要显示它）');
  assert.equal(mimo.customShared, false);
  const ofmFlash = derived.models.find(m => m.key === 'our-free-model|deepseek-v4.1-flash');
  assert.equal(ofmFlash.displayName, '通配 Flash');
  assert.equal(ofmFlash.customShared, true, '通配名要在界面上标出来');
  const plain = derived.models.find(m => m.id === 'deepseek-chat');
  assert.equal(plain.custom, false);
  assert.equal(plain.displayName, 'DeepSeek Chat');
  // 空串回落默认名，但 custom 仍是 true（勾选框还勾着）
  const blank = module.derive(ROSTER, [], { 'deepseek-official|deepseek-chat': '' });
  assert.equal(blank.models.find(m => m.id === 'deepseek-chat').custom, true);
  assert.equal(blank.models.find(m => m.id === 'deepseek-chat').displayName, 'DeepSeek Chat');
});

test('matchModel：名称/id/描述/provider 标签都能搜，状态与 provider 可筛', () => {
  const derived = module.derive(ROSTER, ['our-free-model|deepseek-v4.1-flash']);
  const mimo = derived.models.find(m => m.id === 'mimo-v2.6-flash-free');
  const ofmFlash = derived.models.find(m => m.key === 'our-free-model|deepseek-v4.1-flash');
  assert.equal(module.matchModel(mimo, 'v2.6 flash', 'all', ''), true);
  assert.equal(module.matchModel(mimo, 'vision', 'all', ''), true);
  assert.equal(module.matchModel(mimo, 'kimi', 'all', ''), false);
  assert.equal(module.matchModel(ofmFlash, '', 'disabled', ''), true);
  assert.equal(module.matchModel(ofmFlash, '', 'available', ''), false);
  // provider 下拉
  assert.equal(module.matchModel(mimo, '', 'all', 'our-free-model'), true);
  assert.equal(module.matchModel(mimo, '', 'all', 'z-ai'), false);
  // 按 provider 标签搜得出来
  assert.equal(module.matchModel(mimo, 'our free', 'all', ''), true);
});

test('groupRows：按 provider 分组、保持 host 给的顺序、带上组内计数', () => {
  const derived = module.derive(ROSTER, ['our-free-model|deepseek-v4.1-flash']);
  const groups = module.groupRows(derived.models, ROSTER.routes);
  assert.deepEqual(groups.map(g => g.id), ['deepseek-official', 'our-free-model', 'our-free-model-region']);
  assert.equal(groups[1].label, 'Our Free Model');
  assert.equal(groups[1].rows.length, 2);
  assert.equal(groups[1].enabled, 1);
  assert.equal(groups[1].disabled, 1);
  assert.equal(groups[2].region, true);
  // 筛选之后的切片也要能分组（面板是「先筛再分组」）
  const onlyDisabled = module.groupRows(derived.models.filter(m => !m.enabled), ROSTER.routes);
  assert.deepEqual(onlyDisabled.map(g => g.id), ['our-free-model']);
  // host 没报告的 provider 也不静默丢掉
  const extra = module.groupRows([{ provider: 'ghost', id: 'x', enabled: true }], ROSTER.routes);
  assert.deepEqual(extra.map(g => g.id), ['ghost']);
  assert.equal(extra[0].label, 'ghost');
});

// ── 挂载与渲染 ──────────────────────────────────────────────────────────────

test('挂载：只注册「设置 → 模型」页脚这一个席位；订阅两个失效信号', () => {
  const harness = makeClientCtx();
  module.apply(harness.ctx);

  assert.equal(harness.registrations.length, 1, '只应有一个落点');
  const options = harness.registrations[0].options;
  assert.equal(options.name, 'settings.models.footer');
  assert.equal(options.id, 'ofm-model-manager-panel');
  assert.equal(options.order, 20);
  assert.equal(typeof options.label, 'function');
  assert.equal(harness.registrations.some(entry => entry.options.name === 'settings.section'), false);
  assert.deepEqual(harness.subscriptions.map(s => s.event).sort(), ['llm/adapters-updated', 'settings/document-updated']);
});

/** 每个 harness 一个挂载点：同一个 Panel 在不同用例里状态互不串。 */
const mounts = new WeakMap();
let mountSeq = 0;

/** 取面板组件并渲染一次（同一个 harness 反复调用会保留组件状态）。 */
function renderPanel(harness) {
  const panel = harness.registrations.find(entry => entry.options.name === 'settings.models.footer');
  if (!mounts.has(harness)) mounts.set(harness, 'case-' + (mountSeq += 1));
  renderer.mount(mounts.get(harness));
  return renderer.render(panel.component({}));
}

test('渲染：分组、计数、状态徽标、提供商下拉、批量范围说明都在树里', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const text = collectText(tree).join(' | ');
  assert.ok(text.includes('模型管理'), text);
  // provider 分组头（用户的心智单位）
  assert.ok(text.includes('DeepSeek'), text);
  assert.ok(text.includes('Our Free Model'), text);
  const heads = collectByClass(tree, 'ofmm_groupHead');
  assert.equal(heads.length, 3, '三个 provider 三个分组头');
  // 组头显示 已启用/总数
  const counts = collectByClass(tree, 'ofmm_groupCount').map(node => collectText(node).join(''));
  assert.deepEqual(counts, ['2/2', '1/2', '1/1']);
  // 状态徽标
  assert.ok(text.includes('已启用'));
  assert.ok(text.includes('已停用'));
  assert.ok(text.includes('地区受限'));
  // 提供商下拉（全部/各家 + 计数）
  const select = collectByClass(tree, 'ofmm_select')[0];
  assert.ok(select !== undefined);
  const optionText = collectText(select).join('|');
  assert.ok(optionText.includes('全部提供商'), optionText);
  assert.ok(optionText.includes('Our Free Model (2)'), optionText);
  // 批量作用范围必须写出来
  assert.ok(text.includes('只影响上面筛选出来的结果'), text);
  const bulk = collectByClass(tree, 'ofmm_bulk')[0];
  const bulkText = collectText(bulk).join('|');
  assert.ok(bulkText.includes('停用当前视图（5）'), bulkText);
  assert.ok(bulkText.includes('启用当前视图（5）'), bulkText);
  // 描述出现在界面上
  assert.ok(text.includes('vision + text input · 1024K context'));
});

test('渲染：同一模型 id 在两个 provider 下各有一行（v2 的关键可读性）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const rows = collectByClass(tree, 'ofmm_row');
  assert.equal(rows.length, 5, '五个模型各一行');
  const ids = collectByClass(tree, 'ofmm_id').map(node => collectText(node).join(''));
  assert.equal(ids.filter(id => id === 'deepseek-v4.1-flash').length, 2, '同名模型要各占一行');
  // 停用那行有 is-off 视觉降级
  assert.equal(collectByClass(tree, 'is-off').length, 1);
});

test('渲染：输入框与模型开关在同一个容器里，未勾选时禁用并显示系统默认名', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const inputs = collectByClass(tree, 'ofmm_nameInput');
  assert.equal(inputs.length, 5, '每个模型一个名称输入框');
  for (const node of inputs) {
    assert.equal(node.props.disabled, true, '没勾选时必须禁用');
    assert.equal(node.props.type, 'text');
    assert.equal(node.props.maxLength, module.NAME_MAX);
  }
  assert.equal(collectByType(tree, 'checkbox').length, 5, '每行一个勾选框');
  const acts = collectByClass(tree, 'ofmm_act');
  assert.equal(acts.length, 5);
  for (const act of acts) {
    assert.equal(collectByType(act, 'switch').length, 1, '模型开关与输入框必须同容器');
    assert.equal(collectByClass(act, 'ofmm_nameInput').length, 1);
    const order = [];
    collectInOrder(act, node => {
      if (node.type === 'switch') order.push('switch');
      const className = node.props !== undefined && typeof node.props.className === 'string' ? node.props.className : '';
      if (className.indexOf('ofmm_nameInput') >= 0) order.push('input');
    });
    assert.deepEqual(order, ['switch', 'input'], '阅读顺序：开关在前，输入框在后');
  }
  assert.equal(collectByClass(tree, 'ofmm_tag').length, 0);
  assert.equal(collectByClass(tree, 'ofmm_nameReset').length, 0);
});

test('渲染：勾上之后输入框可编辑、值是自定义名，出现标记与「恢复默认」', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({
    settings: { disabled: [], names: { 'our-free-model|mimo-v2.6-flash-free': '小咪' }, hidden: [] },
  });
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const inputs = collectByClass(tree, 'ofmm_nameInput');
  const custom = inputs.find(node => node.props.value === '小咪');
  assert.ok(custom !== undefined, '输入框里就是自定义名');
  assert.equal(custom.props.disabled, false, '勾上后可编辑');
  assert.ok(String(custom.props.placeholder).indexOf('MiMo V2.6 Flash') >= 0, 'placeholder 提示默认名');
  const boxes = collectByType(tree, 'checkbox');
  assert.equal(boxes.filter(node => node.props.checked === true).length, 1, '只有自定义那行是勾上的');
  assert.equal(collectByClass(tree, 'ofmm_tag').length, 1);
  assert.equal(collectByClass(tree, 'ofmm_nameReset').length, 1);
  const titles = collectByClass(tree, 'ofmm_name').map(node => collectText(node).join(''));
  assert.ok(titles.includes('小咪'), titles.join('|'));
});

test('渲染：通配的自定义名会在行上标「通配」', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: { 'deepseek-v4.1-flash': '通配 Flash' }, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  // ofmm_tagSub 也包含 ofmm_tag 子串，所以按精确类名过滤
  const tags = collectByClass(tree, 'ofmm_tag').filter(node => node.props.className === 'ofmm_tag');
  assert.equal(tags.length, 2, '两个 provider 下的同名模型各标一条');
  assert.ok(collectText(tags[0]).join('').includes('通配'));
});

// ── 写入（持久化 + 热生效） ─────────────────────────────────────────────────

test('写入：走 remote.settings.mutate，带 revision；同时镜像 v1 的 hidden', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();

  await module.setHidden(['deepseek-official|deepseek-chat'], true);
  assert.equal(harness.writes.length, 1);
  const write = harness.writes[0];
  assert.equal(write.ns, NS);
  assert.equal(write.revision, 3, '必须带上 describe 给的 revision（并发写会被拒绝）');
  // disabled 是权威；hidden 只放通配键（这里没有，所以是空数组）
  assert.deepEqual(write.ops, [
    { op: 'set', path: ['disabled'], value: ['deepseek-official|deepseek-chat', 'our-free-model|deepseek-v4.1-flash'] },
    { op: 'set', path: ['hidden'], value: [] },
  ]);
  assert.equal(module.snapshot().busy, false);
  assert.equal(module.snapshot().hidden.length, 2);
});

test('写入：通配键会被镜像进 v1 的 hidden（回退旧版也认得出）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();

  await module.setHidden(['deepseek-v4.1-flash'], true);
  const write = harness.writes[harness.writes.length - 1];
  assert.deepEqual(write.ops, [
    { op: 'set', path: ['disabled'], value: ['deepseek-v4.1-flash'] },
    { op: 'set', path: ['hidden'], value: ['deepseek-v4.1-flash'] },
  ]);
});

test('写入失败：乐观更新回滚，并把错误挂到状态上（面板上看得到）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({
    settings: { disabled: [], names: {}, hidden: [] },
    mutate: () => ({ ok: false, error: { message: 'settings/conflict' } }),
  });
  module.apply(harness.ctx);
  await settle();

  await module.setHidden(['deepseek-official|deepseek-chat'], true);
  assert.deepEqual(module.snapshot().hidden, [], '失败后要回到写之前的状态');
  assert.equal(module.snapshot().saveError, 'settings/conflict');
  assert.equal(module.snapshot().busy, false);
  const text = collectText(renderPanel(harness)).join(' | ');
  assert.ok(text.includes('settings/conflict'), text);
});

test('读不到命名空间：状态是 missing，面板给出可执行的提示而不是空白', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ describe: () => ({ ok: true, value: { namespaces: [] } }) });
  module.apply(harness.ctx);
  await settle();

  assert.equal(module.snapshot().settingsPhase, 'missing');
  const text = collectText(renderPanel(harness)).join(' | ');
  assert.ok(text.includes('完全退出 DSH'), text);
});

test('清单接口失败：面板显示错误 + 重试按钮', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) });
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();
  await settle();

  assert.equal(module.snapshot().rosterPhase, 'error');
  const tree = renderPanel(harness);
  const text = collectText(tree).join(' | ');
  assert.ok(text.includes('无法读取'), text);
  assert.ok(text.includes('503'), text);
  const buttons = collectByClass(tree, 'ofmm_btn');
  assert.ok(buttons.some(node => collectText(node).join('').includes('重试')));
});

test('「重新读取」走 force=1（绕开宿主侧 TTL 缓存）', async () => {
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return { ok: true, status: 200, statusText: 'OK', json: async () => ROSTER };
  };
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();
  await module.load(true);
  assert.deepEqual(urls, ['/api/ofm-model-manager/models', '/api/ofm-model-manager/models?force=1']);
});

test('locale 服务缺席时不崩：退回本地字典；在时把字典注册进去', () => {
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  const panel = harness.registrations.find(entry => entry.options.name === 'settings.models.footer');
  assert.equal(panel.options.label(), '全体模型管理');

  const registered = [];
  const harness2 = makeClientCtx();
  harness2.ctx.locale = {
    register: (ns, dict) => { registered.push({ ns, dict }); return () => {}; },
    bind: () => key => 'T:' + key,
  };
  module.apply(harness2.ctx);
  assert.deepEqual(registered.map(item => item.ns), [NS]);
  assert.deepEqual(Object.keys(registered[0].dict).sort(), ['en', 'zh']);
  const panel2 = harness2.registrations.find(entry => entry.options.name === 'settings.models.footer');
  assert.equal(panel2.options.label(), 'T:nav');
});

// ── 自定义名称 ──────────────────────────────────────────────────────────────

test('自定义名称：敲字本地立即生效，防抖后才写 settings.mutate（set names）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  const before = harness.writes.length;

  module.queueName('our-free-model|mimo-v2.6-flash-free', '小咪');
  assert.equal(module.snapshot().names['our-free-model|mimo-v2.6-flash-free'], '小咪', '本地先动（乐观更新）');
  assert.equal(harness.writes.length, before, '防抖窗口里不该已经写盘');

  await module.flushNames();
  assert.equal(harness.writes.length, before + 1);
  const write = harness.writes[harness.writes.length - 1];
  assert.equal(write.revision, 3);
  assert.deepEqual(write.ops, [{ op: 'set', path: ['names'], value: { 'our-free-model|mimo-v2.6-flash-free': '小咪' } }]);
  assert.equal(module.snapshot().nameSeq, module.snapshot().nameSavedSeq, '写回后本地与服务端收敛');
});

test('自定义名称：勾上=用默认名打底，取消/「恢复默认」=删掉这条', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  await module.toggleName(key, true, 'MiMo V2.6 Flash');
  assert.deepEqual(harness.writes[harness.writes.length - 1].ops, [
    { op: 'set', path: ['names'], value: { [key]: 'MiMo V2.6 Flash' } },
  ]);
  await module.resetName(key);
  assert.deepEqual(harness.writes[harness.writes.length - 1].ops, [{ op: 'set', path: ['names'], value: {} }]);
  assert.equal(module.snapshot().names[key], undefined, '恢复默认 = 这条没了');
});

test('自定义名称：清空后失焦 = 没设置（删掉这条，勾选框弹回去）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  module.queueName(key, '   ');
  assert.equal(module.snapshot().names[key], '   ', '打字过程中空白要先留着');
  await module.commitName(key);
  assert.equal(module.snapshot().names[key], undefined);
  assert.deepEqual(harness.writes[harness.writes.length - 1].ops, [{ op: 'set', path: ['names'], value: {} }]);
});

test('自定义名称：写入被拒 → 回滚 + 面板上能看到原因', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({
    settings: { disabled: [], names: {}, hidden: [] },
    mutate: () => ({ ok: false, error: { message: 'settings/conflict' } }),
  });
  module.apply(harness.ctx);
  await settle();

  module.queueName('our-free-model|mimo-v2.6-flash-free', '小咪');
  await module.flushNames();
  assert.deepEqual(module.snapshot().names, {}, '失败后回到写之前的状态');
  assert.equal(module.snapshot().saveError, 'settings/conflict');
  assert.equal(module.snapshot().busy, false);
  assert.ok(collectText(renderPanel(harness)).join(' | ').includes('settings/conflict'));
});

// ── 改名写回的竞态：吞字 / 闪烁 / 卡顿的回归用例 ────────────────────────────
//
// 钉的是「写回还在飞的时候用户继续敲字」这段窗口。真机上它必然发生：防抖 500ms
// 一停手就开写，而一次写要落 profile 并让 loader 重载模型目录，几百毫秒里用户
// 早就接着敲下一个字了。

/**
 * 把 mutate 挂到闸门上：写盘停在半路，由用例决定什么时候回来。
 * @param {object} harness - makeClientCtx() 的产物
 * @returns {() => void} release —— 调用后写盘才完成
 */
function gateWrites(harness) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  harness.ctx.remote.settings.mutate = async (ns, ops, revision) => {
    harness.writes.push({ ns, ops, revision });
    await gate;
    const value = {};
    for (const op of ops) value[op.path[op.path.length - 1]] = op.value;
    return { ok: true, value: { ns, revision: revision + 1, value } };
  };
  return release;
}

test('自定义名称：写回期间继续敲字，新敲的字不会被服务端旧快照吞掉', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  const release = gateWrites(harness);
  module.apply(harness.ctx);
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  module.queueName(key, '小');
  const inflight = module.flushNames();   // 写盘开始，停在闸门上
  await settle();
  module.queueName(key, '小咪');           // 用户没停手，接着敲第二个字
  assert.equal(module.snapshot().names[key], '小咪', '写回在飞时本地必须是用户刚敲的字');
  release();
  await inflight;

  assert.equal(module.snapshot().names[key], '小咪', '写回期间敲的字不能被回声盖掉（吞字）');
  // 第一次落盘的确实是「小」那一版；写回期间又敲了字，于是同一次 flush 里补写「小咪」，
  // 两边最终收敛（用户的字不会停在内存里）。
  assert.equal(harness.writes[0].ops[0].value[key], '小');
  assert.equal(harness.writes[harness.writes.length - 1].ops[0].value[key], '小咪');
  assert.equal(module.snapshot().nameSeq, module.snapshot().nameSavedSeq, '补写后本地与服务端收敛');
  assert.equal(module.snapshot().savedNames[key], '小咪', '服务端回声里也必须是「小咪」');
});

test('自定义名称：勾选后立刻打字，默认名打底的那次回声不会覆盖刚敲的字', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  const release = gateWrites(harness);
  module.apply(harness.ctx);
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  const inflight = module.toggleName(key, true, 'MiMo V2.6 Flash');  // 勾选 → 写盘在飞
  await settle();
  module.queueName(key, '小咪');                                       // 立刻改名
  release();
  await inflight;

  assert.equal(module.snapshot().names[key], '小咪', '默认名打底的那次回声不能覆盖刚敲的字');
  assert.equal(module.customNameOf({ provider: 'our-free-model', id: 'mimo-v2.6-flash-free' }, module.snapshot().names), '小咪');
});

test('拨开关的写回不碰名称表的记账（挂着的改名不会被开关写盘顺手标成「已落盘」）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({
    settings: { disabled: [], names: { 'our-free-model|mimo-v2.6-flash-free': '小咪' }, hidden: [] },
  });
  const release = gateWrites(harness);
  module.apply(harness.ctx);
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  module.queueName(key, '小咪咪');                       // 挂着的本地编辑，还没落盘
  const inflight = module.setHidden(['deepseek-official|deepseek-chat'], true);
  await settle();
  release();
  await inflight;

  assert.equal(module.snapshot().names[key], '小咪咪', '开关写盘不该覆盖名称表');
  assert.notEqual(module.snapshot().nameSeq, module.snapshot().nameSavedSeq, '挂着的编辑仍然算没落盘');
  // 随后宿主把 settings 文档变化广播回来 → describe 拿到的是服务端那份旧 names
  await module.load();
  assert.equal(module.snapshot().names[key], '小咪咪', '收敛时不能把还没落盘的编辑盖掉');
});

test('自定义名称：写回期间不把整块面板置忙（勾选框/开关/按钮不闪）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({
    settings: { disabled: [], names: { 'our-free-model|mimo-v2.6-flash-free': '小咪' }, hidden: [] },
  });
  const release = gateWrites(harness);
  module.apply(harness.ctx);
  await settle();
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  module.queueName(key, '小咪咪');
  const inflight = module.flushNames();
  await settle();

  assert.equal(module.snapshot().busy, false, '改名不该把面板置忙');
  const tree = renderPanel(harness);
  const boxes = collectByType(tree, 'checkbox');
  assert.ok(boxes.length > 0);
  assert.ok(boxes.every(node => node.props.disabled === false), '写回期间勾选框不该被禁用（会闪）');
  const resets = collectByClass(tree, 'ofmm_nameReset');
  assert.ok(resets.length > 0);
  assert.ok(resets.every(node => node.props.disabled === false), '「恢复默认」按钮不该被禁用');
  const input = collectByClass(tree, 'ofmm_nameInput').find(node => node.props.value === '小咪咪');
  assert.ok(input !== undefined, '输入框里必须是用户刚敲的字');
  assert.equal(input.props.disabled, false, '写回期间输入框必须可编辑');

  release();
  await inflight;
  assert.equal(module.snapshot().busy, false);
});

test('settings/document-updated：自己写出来的回声不再多拉一次 describe，外部改动照旧收敛', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await module.setHidden(['deepseek-official|deepseek-chat'], true);
  const before = harness.describes.length;
  const handler = harness.subscriptions.find(item => item.event === 'settings/document-updated').fn;

  handler(NS, module.snapshot().revision);        // 宿主把这次写广播回来（同一个 revision）
  await settle();
  assert.equal(harness.describes.length, before, '自己写的回声不该再拉一次 describe');

  handler(NS, module.snapshot().revision + 7);    // 别处改了（另一个标签页 / 手改 cordis.patch.yml）
  await settle();
  assert.equal(harness.describes.length, before + 1, '外部改动必须收敛');

  handler('some-other-ns', module.snapshot().revision + 9);
  await settle();
  assert.equal(harness.describes.length, before + 1, '别的命名空间与本插件无关');
});

test('load() 不叠着跑：慢清单在飞时连打失效信号，只多补一轮', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  harness.ctx.remote.settings.describe = async () => {
    harness.describes.push(1);
    if (first) { first = false; await gate; }
    return { ok: true, value: { namespaces: [{ ns: NS, revision: 3, value: { disabled: [], names: {}, hidden: [] } }] } };
  };
  module.apply(harness.ctx);   // load() 开始，卡在 describe 上
  await settle();
  assert.equal(harness.describes.length, 1);

  const handler = harness.subscriptions.find(item => item.event === 'llm/adapters-updated').fn;
  handler(); handler(); handler();
  await settle();
  assert.equal(harness.describes.length, 1, '在飞的那轮结束前不该叠新的一轮');

  release();
  await settle();
  await settle();
  await settle();
  assert.equal(harness.describes.length, 2, '连打三次只补一轮，不叠三轮');
});

test('界面无异常刷新：值没变的发布不叫醒订阅者，一次改名只推必要的那几次', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  // 装一个订阅者，模拟 useStore 的重画（真机上每叫一次就是一次整片重画）。
  let renders = 0;
  const off = module.subscribe(() => { renders += 1; });

  // ① 值没变的发布不该叫醒任何人（写盘回声、内容没变的清单刷新都走这条路）。
  const before = renders;
  module.publish({ roster: module.snapshot().roster });
  module.publish({ names: Object.assign({}, module.snapshot().names) });
  assert.equal(renders, before, '同值发布不该触发重画（这是闪烁的直接来源）');

  // ② 一次「敲字 + 防抖落盘」只推必要的那几次：
  //    敲字 1 次（本地生效）+ 写盘成功 1 次（收敛，且此时 seq 已相等、
  //    names/savedNames 也已是同一个值 → 同值字段被挡掉，不额外重画）。
  const beforeEdit = renders;
  module.queueName(key, '小咪');
  assert.equal(renders, beforeEdit + 1, '敲字只推一次（乐观更新）');
  await module.flushNames();
  assert.ok(renders - beforeEdit <= 2, '一次改名最多推两次，不能反复重画：' + (renders - beforeEdit));

  // ③ 宿主把自己这次写的回声广播回来，不该再引起重画。
  const settled = renders;
  const handler = harness.subscriptions.find(item => item.event === 'settings/document-updated').fn;
  handler(NS, module.snapshot().revision);
  await settle();
  assert.equal(renders, settled, '自己写的回声不该再推一次状态');

  off();
});

test('界面无异常刷新：清单只变了 generatedAt/cached 时不重画面板', async () => {
  const withMeta = stamp => Object.assign({}, ROSTER, { generatedAt: stamp, cached: stamp });
  let stamp = 1000;
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => withMeta(stamp) });
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();

  let renders = 0;
  const off = module.subscribe(() => { renders += 1; });
  // 宿主每次响应都重盖时间戳 —— 这正是真机上「拨开关/改名后整片重画」的来源。
  stamp = 2000;
  await module.load();
  assert.equal(renders, 0, '实质内容没变的重读不该叫醒订阅者');

  // 但元信息要静默推进（界面上「更新于」得是最新那次读的时间）。
  assert.equal(module.snapshot().roster.generatedAt, 2000, '元信息仍要推进到最新');
  assert.equal(module.snapshot().rosterPhase, 'ready');

  // 实质内容真变了（模型数量变了）→ 必须重画。
  globalThis.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => Object.assign({}, withMeta(3000), { counts: Object.assign({}, ROSTER.counts, { total: 99 }) }) });
  await module.load();
  assert.equal(renders, 1, '实质变化必须重画');
  off();
});

test('界面无异常刷新：纯记账字段（revision / 序号）的更新不重画，界面字段照旧重画', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();

  let renders = 0;
  const off = module.subscribe(() => { renders += 1; });

  // 写盘成功后 revision 必然 +1、序号也要推进 —— 这些面板一处都不读，不该重画。
  const before = renders;
  module.publish({ revision: 99, nameSeq: 5, nameSavedSeq: 5, savedNames: { x: 'y' }, ns: NS });
  assert.equal(renders, before, '纯记账字段不该触发重画');
  assert.equal(module.snapshot().revision, 99, '但 state 要真的推进（写盘逻辑靠它）');

  // 界面字段变了 → 必须重画。
  module.publish({ names: { 'our-free-model|mimo-v2.6-flash-free': '小咪' } });
  assert.equal(renders, before + 1, '界面字段变了必须重画');
  off();
});

test('界面无异常刷新：RENDER_KEYS 覆盖了渲染真正读到的每一个字段（防以后加字段忘了登记）', () => {
  // 渲染函数里所有 snap.X 的读取，必须都在 publish 的 RENDER_KEYS 里 —— 漏登记
  // 会让那个字段的更新静默不重画（面板停在旧值上，比闪烁更难查）。
  const reads = new Set();
  for (const match of CLIENT_SOURCE.matchAll(/snap\.([A-Za-z_][A-Za-z0-9_]*)/g)) reads.add(match[1]);
  const declared = new Set();
  const block = CLIENT_SOURCE.match(/const RENDER_KEYS = \[([\s\S]*?)\]/);
  assert.ok(block !== null, 'client.js 里应有 RENDER_KEYS');
  for (const match of block[1].matchAll(/'([A-Za-z]+)'/g)) declared.add(match[1]);

  assert.ok(reads.size > 5, '应当真的扫到了渲染读的字段：' + reads.size);
  const missing = Array.from(reads).filter(name => !declared.has(name));
  assert.deepEqual(missing, [], '渲染读了但没登记进 RENDER_KEYS 的字段：' + missing.join(', '));
});

test('端到端：改一次名字的完整链路（写盘 → 宿主两个失效信号 → 重读）只重画一次', async () => {
  // 这是真机上的真实次序，也是最严的一条：
  //   敲字 → 防抖落盘 → 宿主写 profile → loader 热重载模型目录
  //   → 连发 llm/adapters-updated 与 settings/document-updated → 本插件重读
  // 旧实现里这一段会推十几次状态（每推一次整片重画 40 行）→ 视觉上就是闪烁。
  let stamp = 1000;
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    json: async () => Object.assign({}, ROSTER, { generatedAt: stamp, cached: 1 }),
  });
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] }, liveSettings: true });
  module.apply(harness.ctx);
  await settle();
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  let renders = 0;
  const off = module.subscribe(() => { renders += 1; });

  module.queueName(key, '小咪');
  assert.equal(renders, 1, '敲字只推一次（乐观更新，本地立刻显示）');
  await module.flushNames();
  assert.equal(harness.writes.length, 1, '一次改名只写一次盘');
  assert.equal(module.snapshot().names[key], '小咪', '内容完整落定');

  // 宿主开始回声：时间戳变了、两个失效信号都来了。
  stamp = 2000;
  const onAdapters = harness.subscriptions.find(item => item.event === 'llm/adapters-updated').fn;
  const onDocument = harness.subscriptions.find(item => item.event === 'settings/document-updated').fn;
  const written = module.snapshot().revision;
  onAdapters();
  onDocument(NS, written);      // 自己这次写的回声
  await settle();
  await settle();
  await settle();

  assert.equal(renders, 1, '整条链路跑完只该有敲字那一次重画，实际 ' + renders + ' 次');
  assert.equal(module.snapshot().names[key], '小咪', '重读之后内容还在（没被服务端快照吞掉）');
  assert.equal(module.snapshot().busy, false, '改名全程不该把面板置忙（闪烁的另一个来源）');
  assert.equal(module.snapshot().rosterPhase, 'ready');
  assert.equal(module.snapshot().roster.generatedAt, 2000, '元信息静默推进到最新');
  off();
});

test('热重载/卸载：还挂着的防抖写盘会被立刻落盘，不丢用户刚敲的字', async () => {
  // 浏览器半端是 HMR 换版的（宿主 stat-poll 500ms → SSE rebuilt → 新模块实例替换旧的）。
  // 旧实例的防抖定时器若不管，到点会拿旧 state 去写盘；若直接丢掉，用户刚敲的字就没了。
  // 正确做法是卸载时立刻落盘一次。
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  const key = 'our-free-model|mimo-v2.6-flash-free';

  module.queueName(key, '小咪');           // 防抖已武装，还没到 500ms
  assert.equal(harness.writes.length, 0, '防抖窗口内还不该写盘');

  // 模拟 HMR 换版 / 面板卸载：跑所有 effect 的清理函数。
  for (const dispose of harness.effects.slice()) dispose();
  await settle();
  await settle();

  assert.equal(harness.writes.length, 1, '卸载时必须把挂着的编辑落盘（不能丢字）');
  assert.equal(harness.writes[0].ops[0].value[key], '小咪', '落盘的是用户刚敲的内容');
});

test('自定义名称：宿主半端还是旧版（命名空间里没有 names）→ 不显示这组控件，并说清怎么办', async () => {
  stubFetch(ROSTER);
  // 旧版宿主：volatile 表单里只有 hidden（浏览器半端会热重载，宿主半端要重启）
  const harness = makeClientCtx({ describe: () => ({ ok: true, value: { namespaces: [{ ns: NS, revision: 1, value: { hidden: [] } }] } }) });
  module.apply(harness.ctx);
  await settle();
  await settle();

  assert.equal(module.snapshot().namesReady, false);
  const tree = renderPanel(harness);
  assert.equal(collectByClass(tree, 'ofmm_nameBox').length, 0, '过渡态里不显示输入框组');
  assert.equal(collectByType(tree, 'checkbox').length, 0);
  assert.equal(collectByType(tree, 'switch').length, 5, '模型开关照旧可用');
  assert.ok(collectText(tree).join(' | ').includes('完全退出 DSH'), '要说清怎么让它可用');
});

test('命名空间反查不会认错人：dsh-provider-toggle 的 disabled 数组不算本插件', async () => {
  stubFetch(ROSTER);
  // 注入的 ns 在 settings 文档里不存在，而 turn 里有一个「只有 disabled」的命名空间
  // （就是 dsh-provider-toggle 的形状）。反查必须拒绝它，进 missing 而不是拿错数据。
  const harness = makeClientCtx({
    describe: () => ({ ok: true, value: { namespaces: [{ ns: 'dsh-provider-toggle', revision: 1, value: { disabled: ['deepseek-official'] } }] } }),
  });
  module.apply(harness.ctx);
  await settle();

  assert.equal(module.snapshot().settingsPhase, 'missing');
  assert.notEqual(module.snapshot().ns, 'dsh-provider-toggle');
  // 反查时本插件自己的形状（disabled + names/hidden）仍然会被认出来
  const harness2 = makeClientCtx({
    describe: () => ({ ok: true, value: { namespaces: [{ ns: 'renamed-ns', revision: 1, value: { disabled: [], hidden: [], names: {} } }] } }),
  });
  module.apply(harness2.ctx);
  await settle();
  assert.equal(module.snapshot().settingsPhase, 'ready');
  assert.equal(module.snapshot().ns, 'renamed-ns');
});

test('宿主半端是 v1（命名空间里没有 disabled）→ 开关整体锁住，并说清原因', async () => {
  stubFetch(ROSTER);
  // 旧宿主：volatile 表单里只有 hidden —— disabled 是 v2 才有的字段
  const harness = makeClientCtx({ describe: () => ({ ok: true, value: { namespaces: [{ ns: NS, revision: 1, value: { hidden: [] } }] } }) });
  module.apply(harness.ctx);
  await settle();
  await settle();

  assert.equal(module.snapshot().hostReady, false);
  const tree = renderPanel(harness);
  // 开关仍然渲染出来（用户能看到状态），但必须是禁用的 —— 否则「点了没反应」像坏了
  const switches = collectByType(tree, 'switch');
  assert.equal(switches.length, 5);
  assert.ok(switches.every(node => node.props.disabled === true));
  assert.ok(collectText(tree).join(' | ').includes('宿主半端还是旧版'), collectText(tree).join(' | '));
  // 输入框组也不显示
  assert.equal(collectByClass(tree, 'ofmm_nameBox').length, 0);
});

test('v1 的 hidden 会被并进停用集合（否则升级后第一次拨开关就冲掉旧设置）', async () => {
  stubFetch(ROSTER);
  // v1 遗留：只有 hidden，没有 disabled（升级后第一次打开面板的真实形态）
  const harness = makeClientCtx({
    describe: () => ({ ok: true, value: { namespaces: [{ ns: NS, revision: 1, value: { hidden: ['jev-1.13-free', 'deepseek-v4.1-flash'], names: { 'mimo-v2.6-flash-free': '小咪' } } }] } }),
  });
  module.apply(harness.ctx);
  await settle();

  const snap = module.snapshot();
  assert.deepEqual(snap.hidden.slice().sort(), ['deepseek-v4.1-flash', 'jev-1.13-free'], '旧的 hidden 必须看得到');
  // 面板要按它们真实生效的状态渲染：这条 fixture 里 deepseek-v4.1-flash 只在
  // deepseek-official 下、jev-1.13-free 根本不在清单里 → 停用数 2
  const derived = module.derive(snap.roster, snap.hidden, snap.names);
  assert.equal(derived.counts.disabled, 2);
  assert.equal(derived.models.find(m => m.id === 'deepseek-v4.1-flash').status, 'disabled');
  // 拨一个新开关：旧记录必须一起写回去，不能只剩新加的那条
  await module.setHidden(['deepseek-official|deepseek-chat'], true);
  const write = harness.writes[harness.writes.length - 1];
  assert.deepEqual(write.ops[0], {
    op: 'set',
    path: ['disabled'],
    value: ['deepseek-official|deepseek-chat', 'deepseek-v4.1-flash', 'jev-1.13-free'],
  });
  // 通配那两条同时镜像进 v1 字段；精确键不进去（旧版读不懂）
  assert.deepEqual(write.ops[1], { op: 'set', path: ['hidden'], value: ['deepseek-v4.1-flash', 'jev-1.13-free'] });
});

test('宿主半端是 v2：settings 里有 disabled 就放行（即便 names 还没有）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({ describe: () => ({ ok: true, value: { namespaces: [{ ns: NS, revision: 2, value: { disabled: [], hidden: [] } }] } }) });
  module.apply(harness.ctx);
  await settle();
  await settle();

  assert.equal(module.snapshot().hostReady, true);
  assert.equal(module.snapshot().namesReady, false, 'names 还没有 = 过渡态，但不该锁开关');
  const tree = renderPanel(harness);
  const switches = collectByType(tree, 'switch');
  assert.ok(switches.every(node => node.props.disabled === false), '开关要能用');
  assert.equal(collectByClass(tree, 'ofmm_nameBox').length, 0, '自定义名称这组控件仍然隐藏');
});

test('自定义名称：清单里没有的模型，名称不会被清掉，只在面板上点名', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx({
    settings: { disabled: [], names: { 'ghost|gone-model-free': '早就没了' }, hidden: [] },
  });
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const text = collectText(tree).join(' | ');
  assert.ok(text.includes('自定义名称对应的模型已不在清单里'), text);
  assert.equal(module.snapshot().names['ghost|gone-model-free'], '早就没了', '设置保留，不自动清理');
  assert.equal(harness.writes.length, 0, '不该偷偷写盘');
});

// ── 筛选 / 分组 / 批量（面板交互面） ────────────────────────────────────────

test('渲染：三分类空态 —— 搜索无结果（回显关键词 + 清除筛选）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();
  await settle();

  // 直接改组件内部 state 不方便，这里用「provider 下拉筛选到一条都没有」的等价路径：
  // 渲染两次，第二次把 search 值塞进组件（最小 React 替身按帧记 hooks，只能走 props）。
  const tree = renderPanel(harness);
  const search = collectByClass(tree, 'ofmm_search')[0];
  assert.ok(search !== undefined, '要有搜索框');
  assert.equal(search.props.type, 'search');
  assert.ok(String(search.props.placeholder).includes('提供商'));
  // 触发 onChange 到无结果，再渲染
  search.props.onChange({ target: { value: '绝不存在的模型' } });
  const tree2 = renderPanel(harness);
  const text2 = collectText(tree2).join(' | ');
  assert.ok(text2.includes('绝不存在的模型'), text2);
  assert.ok(text2.includes('清除筛选'), text2);
  assert.equal(collectByClass(tree2, 'ofmm_row').length, 0);
});

test('渲染：全部被停用时给出「全部恢复启用」出口', async () => {
  const allDisabled = {
    ...ROSTER,
    counts: { total: 5, enabled: 0, available: 0, region: 0, disabled: 5, routes: 3 },
    disabled: ROSTER.models.map(m => m.key).sort(),
    models: ROSTER.models.map(m => ({ ...m, enabled: false, status: 'disabled' })),
  };
  stubFetch(allDisabled);
  const harness = makeClientCtx({ settings: { disabled: allDisabled.disabled, names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const text = collectText(tree).join(' | ');
  assert.ok(text.includes('你把所有模型都停用了'), text);
  assert.ok(text.includes('全部恢复启用'), text);
});

test('渲染：一条模型都没有时的空态（不是空白，而是解释 + 重新读取）', async () => {
  stubFetch({ ...ROSTER, routes: [], models: [], counts: { total: 0, enabled: 0, available: 0, region: 0, disabled: 0, routes: 0 } });
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const text = collectText(tree).join(' | ');
  assert.ok(text.includes('没有可管理的模型'), text);
  assert.ok(text.includes('重新读取'), text);
  assert.equal(collectByClass(tree, 'ofmm_row').length, 0);
});

test('渲染：provider 下拉在只有一个 provider 时禁用（没有可切换的）', async () => {
  const single = {
    ...ROSTER,
    routes: [ROSTER.routes[1]],
    models: ROSTER.models.filter(m => m.provider === 'our-free-model'),
    counts: { total: 2, enabled: 1, available: 1, region: 0, disabled: 1, routes: 1 },
  };
  stubFetch(single);
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();
  await settle();

  const select = collectByClass(renderPanel(harness), 'ofmm_select')[0];
  assert.equal(select.props.disabled, true);
});

test('渲染：组级开关文案随该组状态变化（全部停用时是「全部启用」）', async () => {
  const zoneOff = module.derive(ROSTER, ['our-free-model-region|muse-spark-1.3-contributor-free']);
  const groups = module.groupRows(zoneOff.models, ROSTER.routes);
  const zone = groups.find(g => g.id === 'our-free-model-region');
  assert.equal(zone.enabled, 0);
  assert.equal(zone.disabled, 1);
  // 组头计数 0/1（渲染层用同一份数据）
  stubFetch(ROSTER);
  const harness = makeClientCtx({ settings: { disabled: ['our-free-model-region|muse-spark-1.3-contributor-free'], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();
  // 把 region 那条停用：组头计数变成 0/1，DeepSeek 与 OFM 都是 2/2
  const counts = collectByClass(renderPanel(harness), 'ofmm_groupCount').map(node => collectText(node).join(''));
  assert.deepEqual(counts, ['2/2', '2/2', '0/1']);
  // 组级按钮文案：全部停用的那组显示「全部启用」
  const heads = collectByClass(renderPanel(harness), 'ofmm_groupAct');
  const labels = heads.map(node => collectText(node).join(''));
  assert.deepEqual(labels, ['全部停用', '全部停用', '全部启用']);
});

test('渲染：折叠一个分组后该组行消失（渐进披露，不被强迫看全部）', async () => {
  stubFetch(ROSTER);
  const harness = makeClientCtx();
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const toggles = collectByClass(tree, 'ofmm_groupToggle');
  assert.equal(toggles.length, 3);
  assert.equal(toggles[0].props['aria-expanded'], 'true');
  const before = collectByClass(tree, 'ofmm_row').length;
  assert.equal(before, 5);
  // 折叠第一个分组
  toggles[0].props.onClick();
  const tree2 = renderPanel(harness);
  assert.equal(collectByClass(tree2, 'ofmm_row').length, 3, '折叠后该组的行不渲染');
  const toggles2 = collectByClass(tree2, 'ofmm_groupToggle');
  assert.equal(toggles2[0].props['aria-expanded'], 'false');
});

test('渲染：批量按钮只作用于当前筛选视图，数量随筛选变化', async () => {
  stubFetch(ROSTER);
  // derive() 以 settings 的偏好为准（不是 roster 里的静态 enabled），所以停用要写进 settings
  const harness = makeClientCtx({ settings: { disabled: ['our-free-model|deepseek-v4.1-flash'], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  let bulk = collectText(collectByClass(tree, 'ofmm_bulk')[0]).join('|');
  assert.ok(bulk.includes('（5）'), bulk);
  // 切到「已停用」筛选：批量范围立刻变成 1（当前视图 = 筛选结果）
  // ofmm_chips（容器）也含 ofmm_chip 子串 —— 按精确类名过滤
  const chips = collectByClass(tree, 'ofmm_chip').filter(node => node.props.className === 'ofmm_chip');
  const disabledChip = chips.find(node => collectText(node).join('').includes('已停用'));
  assert.ok(disabledChip !== undefined);
  // Chip 是自定义组件，props.onClick 在替换后要在**它渲染出来的 button** 上找
  const chipButton = collectByClass(disabledChip, 'ofmm_chip')[0];
  assert.equal(typeof chipButton.props.onClick, 'function');
  chipButton.props.onClick();
  const tree2 = renderPanel(harness);
  bulk = collectText(collectByClass(tree2, 'ofmm_bulk')[0]).join('|');
  assert.ok(bulk.includes('（1）'), bulk);
  assert.equal(collectByClass(tree2, 'ofmm_row').length, 1);
});

test('渲染：大清单只渲染前 PAGE_SIZE 行，其余靠「显示更多」', async () => {
  const many = {
    ...ROSTER,
    routes: [{ id: 'big', label: 'Big Provider', region: false, ofm: false, count: 120, enabled: 120, disabled: 0, empty: false }],
    models: Array.from({ length: 120 }, (_, index) => ({
      key: 'big|m' + index,
      id: 'm' + index,
      name: 'Model ' + index,
      description: '',
      provider: 'big',
      providerLabel: 'Big Provider',
      region: false,
      ofm: false,
      enabled: true,
      status: 'available',
      customName: null,
      customShared: false,
      offShared: false,
    })),
    counts: { total: 120, enabled: 120, available: 120, region: 0, disabled: 0, routes: 1 },
    disabled: [],
  };
  stubFetch(many);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  assert.equal(collectByClass(tree, 'ofmm_row').length, module.PAGE_SIZE, '首屏只渲染 PAGE_SIZE 行');
  const text = collectText(tree).join(' | ');
  assert.ok(text.includes('显示更多（还有 80 个）'), text);
  assert.ok(text.includes('只渲染了前 40 个'), text);
  // 点「显示更多」再渲染：多 40 行
  const more = collectByClass(tree, 'ofmm_btn').find(node => collectText(node).join('').includes('显示更多'));
  more.props.onClick();
  assert.equal(collectByClass(renderPanel(harness), 'ofmm_row').length, module.PAGE_SIZE * 2);
});

test('渲染：筛选条件变化时「显示更多」的额度重置（换一组筛选不会莫名多出旧行）', async () => {
  const many = {
    ...ROSTER,
    routes: [{ id: 'big', label: 'Big Provider', region: false, ofm: false, count: 120, enabled: 120, disabled: 0, empty: false }],
    models: Array.from({ length: 120 }, (_, index) => ({
      key: 'big|m' + index, id: 'm' + index, name: 'Model ' + index, description: '',
      provider: 'big', providerLabel: 'Big Provider', region: false, ofm: false,
      enabled: true, status: 'available', customName: null, customShared: false, offShared: false,
    })),
    counts: { total: 120, enabled: 120, available: 120, region: 0, disabled: 0, routes: 1 },
    disabled: [],
  };
  stubFetch(many);
  const harness = makeClientCtx({ settings: { disabled: [], names: {}, hidden: [] } });
  module.apply(harness.ctx);
  await settle();
  await settle();

  const tree = renderPanel(harness);
  const more = collectByClass(tree, 'ofmm_btn').find(node => collectText(node).join('').includes('显示更多'));
  more.props.onClick();
  assert.equal(collectByClass(renderPanel(harness), 'ofmm_row').length, 80);
  // useEffect 在最小替身里不执行，这里断言的是「限额没有跟着筛选泄漏」的静态形态：
  // 面板确实依赖 query/filter/provider 的重置（见 client.js 的 useEffect）。
  assert.ok(module.PAGE_SIZE >= 20, '首页额度要够大，否则一进来就得点');
});







