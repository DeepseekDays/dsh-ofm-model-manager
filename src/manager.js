/**
 * dsh-ofm-model-manager / src/manager.js
 * ============================================================================
 * 纯逻辑层：不 import cordis、不 import node 内置模块、不碰网络。
 *
 * 六件事：
 *   1. 认出 provider 目录里的每一条路由（v2 起默认管**全部** provider）；
 *   2. 复合键：provider 与模型 id 可能重名，偏好按 (provider, modelId) 记账；
 *   3. v1 偏好的零迁移兼容：v1 只记裸模型 id，同一套复合键口径天然读得动；
 *   4. 把每个路由的模型清单 + 停用集合 + 自定义名称表合成为面板要的完整清单；
 *   5. 带 TTL 的模型清单缓存（时钟可注入，离线可测）；
 *   6. 搜索/筛选口径（host 与浏览器半端同口径）。
 *
 * ── 偏好键的口径（本插件唯一的「数据模型」）────────────────────────────────
 *
 * 每一条偏好（停用 / 自定义名称）的键都是**一个字符串**：
 *
 *     provider|modelId      —— 只对这一条路由下的这个模型生效
 *     modelId               —— 不带分隔符 = 对**所有** provider 生效（通配）
 *
 * 为什么用这个形状而不是「provider → { modelId: 值 }」的嵌套 dict：
 *   · v1 的 `hidden` 是裸 id 数组、`names` 是「id → 名称」的扁平 dict ——
 *     两者在本口径下**原样读得动**（裸 id = 通配），用户升级后一条设置都不丢，
 *     也不需要任何迁移动作；
 *   · 一个字段、一种元素类型，schema 简单到不会踩 schemastery 的类型坑；
 *   · 分隔符选竖线：provider id（z-ai、our-free-model）与模型 id
 *     （z-ai/glm-5.3-flash、gpt-oss:20b）都不会含它，而且它是 YAML 不用转义的
 *     普通字符 —— 写进 cordis.patch.yml 仍然可读（不选 NUL 就是为了这一点）。
 *
 * @module src/manager.js
 */

/** 旧版默认路由名单（v1 只认这两条）。保留是为了兼容口径与回归测试。 */
export const DEFAULT_ROUTES = Object.freeze(['our-free-model', 'our-free-model-region'])

/**
 * 「通配」桶：偏好键不带分隔符时，对所有 provider 生效。
 * 用空串表示 —— encodeKey('', id) 的返回值就是裸 id。
 */
export const ANY_PROVIDER = ''

/** 复合键分隔符（见文件头「偏好键的口径」）。 */
export const SEP = '|'

/**
 * 拼一条偏好的键。
 * @param {string} provider - 路由 id；空串 = 通配（对所有 provider 生效）。
 * @param {string} id - 模型 id。
 * @returns {string}
 */
export function encodeKey(provider, id) {
  const owner = String(provider ?? '')
  // 通配桶不写分隔符：读回来还是裸模型 id，v1 的配置因此原样兼容。
  return owner === '' ? String(id ?? '') : owner + SEP + String(id ?? '')
}

/**
 * 拆一条偏好键。没有分隔符的（v1 的裸 id）归到通配桶。
 * @param {string} key
 * @returns {{provider: string, id: string}}
 */
export function decodeKey(key) {
  const text = String(key ?? '')
  const at = text.indexOf(SEP)
  if (at < 0) return { provider: ANY_PROVIDER, id: text }
  return { provider: text.slice(0, at), id: text.slice(at + 1) }
}

/** 这条键是不是通配（v1 的裸模型 id）。 */
export function isWildcardKey(key) {
  return String(key ?? '').indexOf(SEP) < 0
}

/**
 * 解包一个配置字段：volatile ref（.get()）与普通值都读得动，Map 也容忍。
 * @param {unknown} field
 * @returns {unknown}
 */
export function unwrap(field) {
  // 顺序有讲究：Map 也有 .get()，必须先认 Map，再认 volatile ref。
  if (field instanceof Map) return Object.fromEntries(field)
  const raw = field !== null && typeof field === 'object' && typeof field.get === 'function'
    ? field.get()
    : field
  if (raw instanceof Map) return Object.fromEntries(raw)
  return raw
}

/**
 * 双形态读值：官方内置插件里配置字段是响应式 ref（.get()），第三方插件拿到的
 * 有时是已经解开的普通数组。两种都读，坏值一律回落到空数组。
 * @param {unknown} field - 配置字段。
 * @returns {string[]} 干净的键列表（去空串、去非字符串）。
 */
export function idList(field) {
  const raw = unwrap(field)
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) if (typeof item === 'string' && item !== '') out.push(item)
  return out
}

/**
 * 读「键 → 文本」表（配置里的 names）：只留字符串键、字符串值。
 * 空串值是**合法**的（用户把输入框清空了、开关还勾着），逐字保留。
 * @param {unknown} field
 * @returns {Object<string, string>}
 */
export function keyTextMap(field) {
  const raw = unwrap(field)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const key of Object.keys(raw)) {
    if (typeof key !== 'string' || key === '') continue
    const value = raw[key]
    if (typeof value !== 'string') continue
    out[key] = value
  }
  return out
}

/**
 * 把配置里的「停用」信息合成一个键集合。
 *
 * 两个字段并起来：
 *   · `disabled`（v2 的唯一权威字段，键可为 `provider|id` 或裸 `id`）；
 *   · `hidden`（v1 的裸 id 数组；v2 写回时会把通配键同步写进去，见 index.js）。
 *
 * @param {{disabled?: unknown, hidden?: unknown}} config
 * @returns {Set<string>}
 */
export function disabledKeySet(config = {}) {
  const out = new Set()
  for (const key of idList(config.disabled)) out.add(key)
  for (const key of idList(config.hidden)) out.add(encodeKey(ANY_PROVIDER, key))
  return out
}

/**
 * 这条偏好键对该模型是否生效。
 *   · 精确键：只对同 provider 的模型生效；
 *   · 通配键（裸 id）：对所有 provider 下这个 id 生效 —— 这正是 v1 `hidden` 的语义。
 *
 * @param {Set<string>} set
 * @param {string} provider
 * @param {string} id
 * @returns {boolean}
 */
export function hits(set, provider, id) {
  return set.has(encodeKey(provider, id)) || set.has(encodeKey(ANY_PROVIDER, id))
}

/** provider id/显示名里带 region 的，视为「地区受限」那一路。 */
export function isRegionRoute(provider) {
  const id = String(provider?.id ?? '')
  const name = String(provider?.name ?? '')
  return /(?:^|[-_.])region(?:[-_.]|$)/i.test(id) || /region/i.test(name)
}

/**
 * 这条路由像不像 Our Free Model 的？
 *
 * 认 id 也认显示名，两个都放宽：上游把 route id 或 ROUTE_LABELS 改掉时，
 * 只要它还叫 Our Free Model，本插件就还认得它。v2 起「认不认得出 OFM」不再
 * 决定**管不管**（全部 provider 都管），只用来在面板上做归类提示。
 */
export function looksLikeOfmRoute(provider) {
  const id = String(provider?.id ?? '')
  const name = String(provider?.name ?? '')
  return /our[-_ ]?free[-_ ]?model/i.test(id) || /our free model/i.test(name)
}

/**
 * 真正生效的自定义名称（键 → 去首尾空白后的名称）。
 *
 * 空串 / 纯空白视为「没设置」：用户把输入框清空的那一刻界面不应该突然显示一个空名字。
 *
 * @param {unknown} names - keyTextMap() 的产物（或任何键 → 名称的对象/Map）。
 * @returns {Map<string, string>}
 */
export function effectiveNames(names) {
  if (names instanceof Map) {
    const out = new Map()
    for (const [key, value] of names) {
      const trimmed = String(value).trim()
      if (trimmed === '') continue
      out.set(key, trimmed)
    }
    return out
  }
  const table = keyTextMap(names)
  const out = new Map()
  for (const key of Object.keys(table)) {
    const trimmed = table[key].trim()
    if (trimmed === '') continue
    out.set(key, trimmed)
  }
  return out
}

/**
 * 两张名称表是否等价（只比生效值，顺序无关）。
 * host 用它决定「要不要广播 llm/adapters-updated」。
 */
export function sameMap(a, b) {
  const left = a instanceof Map ? a : effectiveNames(a)
  const right = b instanceof Map ? b : effectiveNames(b)
  if (left.size !== right.size) return false
  for (const [key, value] of left) if (right.get(key) !== value) return false
  return true
}

/**
 * 模型在界面上显示的名字：有生效的自定义名称就用它，否则用系统默认名。
 *
 * 先查精确键（provider|id），再查通配键（裸 id）—— 与停用同一套优先级。
 *
 * @param {{id?: string, name?: string}} model
 * @param {unknown} names - 键 → 名称（或 effectiveNames() 的 Map）。
 * @param {string} [provider] - 该模型所属路由（用于拼精确键）。
 */
export function displayNameOf(model, names, provider) {
  const map = names instanceof Map ? names : effectiveNames(names)
  const id = String(model?.id ?? '')
  const custom = map.get(encodeKey(String(provider ?? ''), id)) ?? map.get(encodeKey(ANY_PROVIDER, id))
  if (custom !== undefined) return custom
  const fallback = model?.name
  return typeof fallback === 'string' && fallback !== '' ? fallback : id
}

/** 两个字符串集合是否相等（顺序无关）。 */
export function sameSet(a, b) {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/**
 * 本插件要管的已注册路由。
 *
 * v2 口径：**默认返回全部** provider —— 这就是「全体模型管理系统」。配置里的 routes
 * 从 v1 的「白名单」改成「可选的收窄名单」：填了就只显示这几条，留空就全都要。
 *
 * @param {Array<{id: string, name: string}>} providers - ctx.llm.listProviders() 的返回值。
 * @param {string[]} [configured] - 配置里显式声明的 route id（留空 = 全部）。
 * @returns {Array<{id: string, name: string, region: boolean, ofm: boolean}>}
 */
export function resolveRoutes(providers, configured = []) {
  const list = Array.isArray(providers) ? providers : []
  const wanted = new Set(configured.filter(id => typeof id === 'string' && id !== ''))
  const scopeAll = wanted.size === 0
  const out = []
  const seen = new Set()
  for (const provider of list) {
    const id = String(provider?.id ?? '')
    if (id === '' || seen.has(id)) continue
    if (!scopeAll && !wanted.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: String(provider?.name ?? id),
      region: isRegionRoute(provider),
      ofm: looksLikeOfmRoute(provider),
    })
  }
  return out
}

/**
 * 合成管理面板的完整清单。
 *
 * @param {object} input
 * @param {Array<{id: string, name: string, region: boolean, ofm: boolean}>} input.routes
 * @param {Map<string, Array<object>>} input.listings - route id -> **未过滤**的 LlmModelInfo[]。
 * @param {Set<string>|Iterable<string>} input.disabled - 停用的偏好键。
 * @param {Object<string, string>} [input.names] - 键 → 名称（原样，含空串条目）。
 * @param {number} [input.now] - 生成时间戳（测试用）。
 * @returns {object}
 */
export function buildRoster({ routes, listings, disabled, names, now }) {
  const disabledSet = disabled instanceof Set ? disabled : new Set(disabled ?? [])
  // 原样保留（含空串条目）—— 面板靠「这条键在不在」决定勾选框的状态。
  const nameTable = keyTextMap(names)
  const effective = effectiveNames(nameTable)
  const models = []
  const seen = new Set()
  // 出现过的模型 id（不带 provider）：通配键靠它判断「还生效吗」。
  // 少了这一份，v1 的裸 id 会永远被当成「已失效」（它天生不在 seen 的复合键里）。
  const seenIds = new Set()
  const routeRows = []
  for (const route of Array.isArray(routes) ? routes : []) {
    const raw = listings?.get?.(route.id)
    const list = Array.isArray(raw) ? raw : []
    let enabledCount = 0
    for (const model of list) {
      const id = String(model?.id ?? '')
      if (id === '') continue
      const key = encodeKey(route.id, id)
      seenIds.add(id)
      if (seen.has(key)) continue
      seen.add(key)
      const wildcard = encodeKey(ANY_PROVIDER, id)
      const off = hits(disabledSet, route.id, id)
      if (!off) enabledCount += 1
      const region = route.region === true
      const defaultName = typeof model?.name === 'string' && model.name !== '' ? model.name : id
      // 面板要区分「这条名字来自精确键还是通配键」——通配名会在每一行显示，
      // 用户需要知道它不是这一行专属的。
      const precise = Object.prototype.hasOwnProperty.call(nameTable, key)
      const fallbackCustom = Object.prototype.hasOwnProperty.call(nameTable, wildcard) ? nameTable[wildcard] : null
      const custom = precise ? nameTable[key] : fallbackCustom
      models.push({
        key,
        wildcardKey: wildcard,
        id,
        name: defaultName,
        displayName: displayNameOf({ id, name: defaultName }, effective, route.id),
        customName: custom,
        // 这条自定义名是通配的（对所有 provider 生效）还是这一行专属的。
        customShared: !precise && fallbackCustom !== null,
        description: typeof model?.description === 'string' ? model.description : '',
        inputModalities: Array.isArray(model?.inputModalities) ? [...model.inputModalities] : [],
        provider: route.id,
        providerLabel: route.name,
        region,
        ofm: route.ofm === true,
        enabled: !off,
        // 这条停用记录是通配的（对所有 provider 生效）还是这一行专属的。
        offShared: !disabledSet.has(key) && disabledSet.has(wildcard),
        // 三态：已启用 / 已停用 / 地区受限。停用优先 —— 一个地区受限的模型被停用
        // 之后，用户要看到的是「你把它停了」，不是「它地区受限」。
        status: off ? 'disabled' : region ? 'region' : 'available',
      })
    }
    routeRows.push({
      id: route.id,
      label: route.name,
      region: route.region === true,
      ofm: route.ofm === true,
      count: list.length,
      enabled: enabledCount,
      disabled: list.length - enabledCount,
      // 一条模型都没有：可能 provider 被 dsh-provider-toggle 整条关掉了，
      // 也可能它自己还没列出模型（还没配密钥 / 目录是空的）。面板把这两种说清楚。
      empty: list.length === 0,
    })
  }
  const counts = { total: models.length, enabled: 0, available: 0, region: 0, disabled: 0, routes: routeRows.length }
  for (const model of models) {
    if (!model.enabled) {
      counts.disabled += 1
      continue
    }
    counts.enabled += 1
    if (model.region) counts.region += 1
    else counts.available += 1
  }
  // 停用名单里可能留着已经不在清单里的旧键（上游下线了某个模型）。不静默丢弃：
  // 面板会提示「这几条停用记录已失效」，用户能一键清掉。
  // 通配键（v1 的裸 id）只要**任意** provider 下还有这个 id 就算生效。
  const stale = [...disabledSet]
    .filter(key => (isWildcardKey(key) ? !seenIds.has(key) : !seen.has(key)))
    .sort()
  // 自定义名称**不做自动清理**：上游下线一个模型、provider 暂时没列出模型，都不该
  // 让用户手填的名字消失。这里只把它们点名出来，清不清由用户决定。
  const namesStale = Object.keys(nameTable)
    .filter(key => (isWildcardKey(key) ? !seenIds.has(key) : !seen.has(key)))
    .sort()
  return {
    routes: routeRows,
    models,
    counts,
    disabled: [...disabledSet].sort(),
    disabledStale: stale,
    names: { ...nameTable },
    namesStale,
    generatedAt: typeof now === 'number' ? now : Date.now(),
  }
}

/**
 * 面板搜索/筛选口径（host 的 /models 不做过滤，浏览器半端用这个，两边同口径）。
 * 自定义名称、默认名称、模型 id、描述、**所属 provider** 都参与匹配 ——
 * 用户按自己起的名字或按供应商搜必须搜得到。
 *
 * @param {object} model - buildRoster() 出来的一行。
 * @param {{query?: string, filter?: string, provider?: string}} [options]
 * @returns {boolean}
 */
export function matchModel(model, options = {}) {
  const query = options.query ?? ''
  const filter = options.filter ?? 'all'
  const provider = options.provider ?? ''
  if (filter !== 'all' && model?.status !== filter) return false
  if (provider !== '' && model?.provider !== provider) return false
  const needle = String(query).trim().toLowerCase()
  if (needle === '') return true
  const haystack = [
    model?.name, model?.displayName, model?.customName, model?.id,
    model?.description, model?.provider, model?.providerLabel,
  ].map(value => String(value ?? '')).join(' ').toLowerCase()
  return needle.split(/\s+/).every(part => haystack.includes(part))
}

/**
 * 带 TTL 的模型清单缓存。
 *
 * 为什么需要：管理面板一次要读**所有** provider 的清单，而每次拨开关 /
 * 敲名字都会触发一轮重读。没有缓存的话，每敲一个字就把每个 provider 的
 * listModels 全跑一遍 —— 这在 provider 多、清单大的时候会明显拖慢界面。
 *
 * 失效时机（由 host 半端驱动）：
 *   · TTL 到期（默认 60s）兜底；
 *   · llm/adapters-updated（别处改了路由/目录）→ clear()；
 *   · 用户在面板上点「重新读取」→ 带 force 读。
 *
 * @param {{ttlMs?: number, now?: () => number}} [options]
 */
export function createModelCache(options = {}) {
  const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : 60000
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  const entries = new Map()
  return {
    /**
     * 取一个 provider 的模型清单。
     * @param {string} provider
     * @param {() => Promise<Array<object>>} loader - 未命中时的取数函数。
     * @param {{force?: boolean}} [opts]
     * @returns {Promise<{models: Array<object>, cached: boolean}>}
     */
    async get(provider, loader, opts = {}) {
      const at = clock()
      const hit = entries.get(provider)
      if (opts.force !== true && hit !== undefined && at - hit.at < ttlMs) {
        return { models: hit.models, cached: true }
      }
      const models = await loader()
      const list = Array.isArray(models) ? models : []
      entries.set(provider, { models: list, at: clock() })
      return { models: list, cached: false }
    },
    /** 单个 provider 失效。 */
    invalidate(provider) { entries.delete(String(provider)) },
    /** 全清（llm/adapters-updated 时用）。 */
    clear() { entries.clear() },
    /** 当前缓存的 provider 条数（诊断/测试用）。 */
    get size() { return entries.size },
    /** TTL（测试断言用）。 */
    get ttlMs() { return ttlMs },
  }
}



