/**
 * dsh-ofm-model-manager / test/manager.test.mjs
 * ============================================================================
 * 纯逻辑层（src/manager.js）的离线断言：偏好键口径、v1 兼容、路由认领、
 * 清单合成、三态、搜索口径、TTL 缓存。
 * 不启动 DSH、不碰网络、不 import cordis。
 *
 * 跑：node --test test/manager.test.mjs   （或 node test/all.mjs 全量、进程内）
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANY_PROVIDER,
  DEFAULT_ROUTES,
  SEP,
  buildRoster,
  createModelCache,
  decodeKey,
  disabledKeySet,
  displayNameOf,
  effectiveNames,
  encodeKey,
  hits,
  idList,
  isRegionRoute,
  isWildcardKey,
  keyTextMap,
  looksLikeOfmRoute,
  matchModel,
  resolveRoutes,
  sameMap,
  sameSet,
  unwrap,
} from '../src/manager.js';

const PROVIDERS = [
  { id: 'deepseek-official', name: 'DeepSeek' },
  { id: 'our-free-model', name: 'Our Free Model' },
  { id: 'our-free-model-region', name: 'Our Free Model · region-limited' },
  { id: 'z-ai', name: 'Z.ai' },
];

/** 三个 provider 故意共用同一个模型 id（deepseek-v4.1-flash）—— 这正是 v2 的核心场景。 */
const LISTINGS = new Map([
  ['deepseek-official', [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'text input' },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  ]],
  ['our-free-model', [
    { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash', description: 'vision + text input', inputModalities: ['text', 'image'] },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash (OFM)' },
  ]],
  ['our-free-model-region', [
    { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3' },
  ]],
  ['z-ai', [
    { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash' },
    { id: 'deepseek-v4.1-flash', name: 'GLM Gateway Flash' },
  ]],
]);

function rosterOf(disabled, names) {
  return buildRoster({
    routes: resolveRoutes(PROVIDERS, []),
    listings: LISTINGS,
    disabled: disabled instanceof Set ? disabled : new Set(disabled ?? []),
    names: names ?? {},
  });
}

// ── 偏好键口径 ──────────────────────────────────────────────────────────────

test('encodeKey/decodeKey：精确键带分隔符，通配键就是裸 id', () => {
  assert.equal(encodeKey('our-free-model', 'jev-1.13-free'), 'our-free-model' + SEP + 'jev-1.13-free');
  // 通配桶不写分隔符：读回来还是裸 id（v1 的配置因此原样兼容）
  assert.equal(encodeKey(ANY_PROVIDER, 'jev-1.13-free'), 'jev-1.13-free');
  assert.deepEqual(decodeKey('our-free-model|jev-1.13-free'), { provider: 'our-free-model', id: 'jev-1.13-free' });
  // 模型 id 自己带斜杠/冒号/点，也不会和分隔符打架
  assert.deepEqual(decodeKey('z-ai|z-ai/glm-5.3-flash'), { provider: 'z-ai', id: 'z-ai/glm-5.3-flash' });
  assert.deepEqual(decodeKey('gpt-oss:20b'), { provider: ANY_PROVIDER, id: 'gpt-oss:20b' });
  assert.equal(isWildcardKey('gpt-oss:20b'), true);
  assert.equal(isWildcardKey('z-ai|gpt-oss:20b'), false);
  // 分隔符是竖线（YAML 不必转义），不是 NUL
  assert.equal(SEP, '|');
});

test('unwrap：volatile ref / 普通值 / Map 都读得动', () => {
  assert.deepEqual(unwrap({ get: () => ['a'] }), ['a']);
  assert.deepEqual(unwrap(['a']), ['a']);
  assert.deepEqual(unwrap(new Map([['a', 'A']])), { a: 'A' });
  assert.equal(unwrap(undefined), undefined);
});

test('idList：两种形态 + 坏值一律丢掉', () => {
  assert.deepEqual(idList({ get: () => ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(idList(['a', '', 3, null, 'b']), ['a', 'b']);
  assert.deepEqual(idList(undefined), []);
  assert.deepEqual(idList('a'), []);
});

test('keyTextMap：只留字符串键 + 字符串值；空串是合法值（用户清空了输入框）', () => {
  assert.deepEqual(keyTextMap({ a: 'A' }), { a: 'A' });
  assert.deepEqual(keyTextMap({ a: 'A', b: 3, '': 'x', c: null }), { a: 'A' });
  assert.deepEqual(keyTextMap({ get: () => ({ a: 'A' }) }), { a: 'A' });
  assert.deepEqual(keyTextMap(['a']), {});
  assert.deepEqual(keyTextMap('a'), {});
  assert.deepEqual(keyTextMap({ a: '' }), { a: '' });
});

test('disabledKeySet：disabled 与 v1 的 hidden 合并，hidden 归到通配桶', () => {
  const set = disabledKeySet({ disabled: ['z-ai|glm-x'], hidden: ['jev-1.13-free'] });
  assert.deepEqual([...set].sort(), ['jev-1.13-free', 'z-ai|glm-x']);
  assert.deepEqual(disabledKeySet({}), disabledKeySet({ disabled: [], hidden: [] }));
  assert.equal(disabledKeySet({}).size, 0);
  // volatile ref 也读得动
  assert.deepEqual([...disabledKeySet({ disabled: { get: () => ['a|b'] } })], ['a|b']);
});

test('hits：精确键只对本 provider 生效，通配键对所有 provider 生效', () => {
  const set = new Set(['deepseek-official|deepseek-v4.1-flash', 'jev-1.13-free']);
  assert.equal(hits(set, 'deepseek-official', 'deepseek-v4.1-flash'), true);
  // 同名模型在别的 provider 下不受精确键影响 —— 这是 v2 修掉的核心问题
  assert.equal(hits(set, 'z-ai', 'deepseek-v4.1-flash'), false);
  // 通配键到处都命中（v1 语义）
  assert.equal(hits(set, 'anything', 'jev-1.13-free'), true);
});

test('effectiveNames：纯空白 / 空串视为没设置，其余 trim 后生效', () => {
  const map = effectiveNames({ a: '  MiMo  ', b: '', c: '   ', d: 'X' });
  assert.deepEqual([...map.entries()], [['a', 'MiMo'], ['d', 'X']]);
  assert.equal(map.size, 2);
  assert.deepEqual([...effectiveNames(undefined).entries()], []);
  assert.deepEqual([...effectiveNames(new Map([['a', ' A ']]))], [['a', 'A']]);
});

test('sameMap / sameSet：顺序无关、空白等价', () => {
  assert.equal(sameMap({ a: 'X' }, { a: ' X ' }), true);
  assert.equal(sameMap({ a: 'X' }, { a: 'Y' }), false);
  assert.equal(sameMap({ a: 'X' }, { a: 'X', b: 'Y' }), false);
  assert.equal(sameMap({}, {}), true);
  assert.equal(sameSet(new Set(['a']), new Set(['a'])), true);
  assert.equal(sameSet(new Set(['a']), new Set(['b'])), false);
});

test('displayNameOf：精确键 > 通配键 > 系统默认名 > id', () => {
  const model = { id: 'deepseek-v4.1-flash', name: 'Default Name' };
  assert.equal(displayNameOf(model, { 'z-ai|deepseek-v4.1-flash': 'Precise' }, 'z-ai'), 'Precise');
  assert.equal(displayNameOf(model, { 'deepseek-v4.1-flash': 'Wild' }, 'z-ai'), 'Wild');
  // 精确键在别的 provider 下不生效，但通配键会兜底
  assert.equal(displayNameOf(model, { 'z-ai|deepseek-v4.1-flash': 'Precise', 'deepseek-v4.1-flash': 'Wild' }, 'deepseek-official'), 'Wild');
  assert.equal(displayNameOf(model, {}, 'z-ai'), 'Default Name');
  assert.equal(displayNameOf({ id: 'no-name' }, {}, 'z-ai'), 'no-name');
  // 纯空白不算设置
  assert.equal(displayNameOf(model, { 'z-ai|deepseek-v4.1-flash': '   ' }, 'z-ai'), 'Default Name');
});

// ── 路由认领 ────────────────────────────────────────────────────────────────

test('resolveRoutes：v2 默认认领**全部** provider（这就是「全体模型管理」）', () => {
  const routes = resolveRoutes(PROVIDERS, []);
  assert.deepEqual(routes.map(route => route.id), ['deepseek-official', 'our-free-model', 'our-free-model-region', 'z-ai']);
  assert.equal(routes.length, 4);
  assert.equal(routes[0].ofm, false);
  assert.equal(routes[1].ofm, true);
  assert.equal(routes[2].region, true);
  assert.equal(routes[3].ofm, false);
});

test('resolveRoutes：配置了 routes 就收窄成那几条（v1 的白名单语义变成可选项）', () => {
  const routes = resolveRoutes(PROVIDERS, ['our-free-model', 'z-ai', 'nonexistent']);
  assert.deepEqual(routes.map(route => route.id), ['our-free-model', 'z-ai']);
});

test('resolveRoutes：坏输入不炸，重复 id 只留一条', () => {
  assert.deepEqual(resolveRoutes(undefined, []), []);
  assert.deepEqual(resolveRoutes('nope', []), []);
  const routes = resolveRoutes([{ id: '' }, { id: 'a' }, { id: 'a' }, {}], []);
  assert.deepEqual(routes.map(route => route.id), ['a']);
});

test('isRegionRoute / looksLikeOfmRoute：认 id 也认显示名', () => {
  assert.equal(isRegionRoute({ id: 'our-free-model-region', name: 'Our Free Model' }), true);
  assert.equal(isRegionRoute({ id: 'x', name: 'Region-limited lane' }), true);
  assert.equal(isRegionRoute({ id: 'our-free-model', name: 'Our Free Model' }), false);
  assert.equal(looksLikeOfmRoute({ id: 'our-free-model', name: 'x' }), true);
  assert.equal(looksLikeOfmRoute({ id: 'x', name: 'Our Free Model' }), true);
  assert.equal(looksLikeOfmRoute({ id: 'z-ai', name: 'Z.ai' }), false);
  assert.ok(DEFAULT_ROUTES.includes('our-free-model'));
});

// ── 清单合成 ────────────────────────────────────────────────────────────────

test('buildRoster：覆盖全部 provider，每个模型带自己的 provider 与复合键', () => {
  const roster = buildRoster({ routes: resolveRoutes(PROVIDERS, []), listings: LISTINGS, disabled: new Set(), names: {} });
  assert.deepEqual(roster.routes.map(route => route.id), ['deepseek-official', 'our-free-model', 'our-free-model-region', 'z-ai']);
  assert.equal(roster.counts.routes, 4);
  assert.equal(roster.counts.total, 7);
  assert.equal(roster.counts.enabled, 7);
  assert.equal(roster.counts.disabled, 0);
  // 同名模型在两个 provider 下各出现一次，键不同
  const flashes = roster.models.filter(model => model.id === 'deepseek-v4.1-flash');
  assert.equal(flashes.length, 3);
  assert.deepEqual(flashes.map(model => model.provider), ['deepseek-official', 'our-free-model', 'z-ai']);
  assert.deepEqual(flashes.map(model => model.key), [
    'deepseek-official|deepseek-v4.1-flash',
    'our-free-model|deepseek-v4.1-flash',
    'z-ai|deepseek-v4.1-flash',
  ]);
  // 每行的 providerLabel 也带出来（面板分组要显示）
  assert.equal(flashes[2].providerLabel, 'Z.ai');
  const zone = roster.models.find(model => model.id === 'muse-spark-1.3-contributor-free');
  assert.equal(zone.region, true);
  assert.equal(zone.status, 'region');
});

test('buildRoster：精确键只停用那一个 provider 的同名模型（v2 的核心修复）', () => {
  const roster = rosterOf(['our-free-model|deepseek-v4.1-flash']);
  const flashes = roster.models.filter(model => model.id === 'deepseek-v4.1-flash');
  assert.deepEqual(flashes.map(model => model.enabled), [true, false, true]);
  assert.deepEqual(flashes.map(model => model.status), ['available', 'disabled', 'available']);
  assert.equal(roster.counts.disabled, 1);
  assert.equal(roster.routes[1].disabled, 1);
  assert.equal(roster.routes[1].enabled, 1);
});

test('buildRoster：通配键（v1 的裸 id）对所有 provider 的同名模型生效', () => {
  const roster = rosterOf(['deepseek-v4.1-flash']);
  const flashes = roster.models.filter(model => model.id === 'deepseek-v4.1-flash');
  assert.deepEqual(flashes.map(model => model.enabled), [false, false, false]);
  assert.equal(roster.counts.disabled, 3);
  // 面板要能标出「这条停用是通配的」
  assert.equal(flashes[0].offShared, true);
  assert.equal(rosterOf(['our-free-model|deepseek-v4.1-flash']).models.filter(m => m.id === 'deepseek-v4.1-flash')[0].offShared, false);
});

test('buildRoster：v1 的 hidden 与 v2 的 disabled 能同时存在（升级不改配置也不丢）', () => {
  const keys = disabledKeySet({ disabled: ['z-ai|z-ai/glm-5.3-flash'], hidden: ['mimo-v2.6-flash-free'] });
  const roster = rosterOf(keys);
  assert.equal(roster.models.find(m => m.id === 'z-ai/glm-5.3-flash').enabled, false);
  assert.equal(roster.models.find(m => m.id === 'mimo-v2.6-flash-free').enabled, false);
  assert.equal(roster.counts.disabled, 2);
});

test('buildRoster：停用整个 provider 的每条模型，该组 enabled 归零（组会整组消失）', () => {
  const keys = ['our-free-model-region|muse-spark-1.3-contributor-free'];
  const roster = rosterOf(keys);
  const zone = roster.routes.find(route => route.id === 'our-free-model-region');
  assert.equal(zone.enabled, 0);
  assert.equal(zone.disabled, 1);
  assert.equal(zone.count, 1);
});

test('buildRoster：自定义名称精确键优先，通配键兜底并标出 customShared', () => {
  const roster = rosterOf([], {
    'our-free-model|deepseek-v4.1-flash': 'OFM Flash',
    'mimo-v2.6-flash-free': '小咪',
  });
  const ofmFlash = roster.models.find(m => m.key === 'our-free-model|deepseek-v4.1-flash');
  assert.equal(ofmFlash.customName, 'OFM Flash');
  assert.equal(ofmFlash.displayName, 'OFM Flash');
  assert.equal(ofmFlash.customShared, false);
  const mimo = roster.models.find(m => m.id === 'mimo-v2.6-flash-free');
  assert.equal(mimo.displayName, '小咪');
  assert.equal(mimo.customShared, true);
  // 同一张表里别的模型不受影响
  assert.equal(roster.models.find(m => m.id === 'deepseek-chat').displayName, 'DeepSeek Chat');
  // 时间戳可注入（测试用）
  assert.equal(buildRoster({ routes: [], listings: new Map(), disabled: [], names: {}, now: 123 }).generatedAt, 123);
});

test('buildRoster：失效的停用记录与失效的名称都被点名，不静默丢弃', () => {
  const roster = rosterOf(['ghost|gone', 'jev-1.13-free'], { 'ghost|gone': 'Ghost', 'old|thing': 'Old' });
  assert.deepEqual(roster.disabledStale, ['ghost|gone', 'jev-1.13-free']);
  assert.deepEqual(roster.namesStale, ['ghost|gone', 'old|thing']);
  // 生效中的那条不算 stale
  assert.deepEqual(rosterOf(['z-ai|z-ai/glm-5.3-flash']).disabledStale, []);
});

test('buildRoster：生效中的**通配键**不算失效（v1 的裸 id 天生不在复合键里）', () => {
  // deepseek-v4.1-flash 存在于三个 provider 下 → 通配记录仍然生效，不该被点名
  const roster = rosterOf(['deepseek-v4.1-flash'], { 'deepseek-v4.1-flash': '通配 Flash' });
  assert.deepEqual(roster.disabledStale, []);
  assert.deepEqual(roster.namesStale, []);
  assert.equal(roster.counts.disabled, 3, '通配停用对三个 provider 都生效');
  // 真的不在清单里的通配键才算失效
  assert.deepEqual(rosterOf(['jev-1.13-free']).disabledStale, ['jev-1.13-free']);
  // 混合：精确失效 + 通配生效
  const mixed = rosterOf(['ghost|gone', 'deepseek-v4.1-flash'], { 'ghost|gone': 'Ghost', 'deepseek-v4.1-flash': 'W' });
  assert.deepEqual(mixed.disabledStale, ['ghost|gone']);
  assert.deepEqual(mixed.namesStale, ['ghost|gone']);
});

test('buildRoster：清单为空 / 坏行都能跑', () => {
  const empty = buildRoster({ routes: resolveRoutes(PROVIDERS, []), listings: new Map(), disabled: [], names: {} });
  assert.equal(empty.counts.total, 0);
  assert.equal(empty.routes.length, 4);
  assert.ok(empty.routes.every(route => route.empty === true));
  const bad = buildRoster({
    routes: [{ id: 'p', name: 'P', region: false, ofm: false }],
    listings: new Map([['p', [{ id: '' }, { id: 'ok' }, { id: 'ok' }, null]]]),
    disabled: [],
    names: {},
  });
  assert.deepEqual(bad.models.map(m => m.id), ['ok']);
  // 完全没输入也不炸
  assert.equal(buildRoster({}).counts.total, 0);
});

// ── 搜索 / 筛选 ─────────────────────────────────────────────────────────────

test('matchModel：按状态、provider、名称/id/描述/provider 标签匹配', () => {
  const roster = rosterOf(['z-ai|z-ai/glm-5.3-flash'], { 'z-ai|z-ai/glm-5.3-flash': '我的 GLM' });
  const glm = roster.models.find(m => m.id === 'z-ai/glm-5.3-flash');
  assert.equal(matchModel(glm), true);
  assert.equal(matchModel(glm, { filter: 'disabled' }), true);
  assert.equal(matchModel(glm, { filter: 'available' }), false);
  // 自定义名称参与搜索（按自己起的名字搜得出来）
  assert.equal(matchModel(glm, { query: '我的' }), true);
  assert.equal(matchModel(glm, { query: 'glm' }), true);
  assert.equal(matchModel(glm, { query: 'z-ai' }), true);
  // provider 下拉：精确匹配
  assert.equal(matchModel(glm, { provider: 'z-ai' }), true);
  assert.equal(matchModel(glm, { provider: 'deepseek-official' }), false);
  // 多词是 AND（词序无关）
  assert.equal(matchModel(glm, { query: 'glm 我的' }), true);
  assert.equal(matchModel(glm, { query: 'glm 不存在' }), false);
  assert.equal(matchModel(glm, { query: '   ' }), true);
  assert.equal(matchModel(null, { query: 'x' }), false);
});

test('matchModel：地区受限筛选（region 状态）', () => {
  const roster = rosterOf([]);
  const zone = roster.models.find(m => m.region === true);
  const plain = roster.models.find(m => m.region === false);
  assert.equal(matchModel(zone, { filter: 'region' }), true);
  assert.equal(matchModel(plain, { filter: 'region' }), false);
});

// ── 缓存 ────────────────────────────────────────────────────────────────────

test('createModelCache：TTL 内复用、过期重取、force 绕开、clear 清空', async () => {
  let now = 1000;
  const cache = createModelCache({ ttlMs: 100, now: () => now });
  let calls = 0;
  const loader = async () => { calls += 1; return [{ id: 'a' }, { id: 'b' }] };
  assert.equal(cache.ttlMs, 100);
  assert.equal(cache.size, 0);
  const first = await cache.get('p', loader);
  assert.equal(first.cached, false);
  assert.equal(calls, 1);
  assert.equal(cache.size, 1);
  // TTL 内：命中缓存，不调 loader
  now = 1050;
  const second = await cache.get('p', loader);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.deepEqual(second.models, first.models);
  // force 绕开缓存
  const forced = await cache.get('p', loader, { force: true });
  assert.equal(forced.cached, false);
  assert.equal(calls, 2);
  // 过期重取
  now = 1300;
  const third = await cache.get('p', loader);
  assert.equal(third.cached, false);
  assert.equal(calls, 3);
  // 单个失效 / 全清
  cache.invalidate('p');
  assert.equal(cache.size, 0);
  await cache.get('p', loader);
  await cache.get('q', loader);
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
  // 坏返回值落成空数组，不把 undefined 传下去
  const bad = await cache.get('r', async () => undefined);
  assert.deepEqual(bad.models, []);
});

