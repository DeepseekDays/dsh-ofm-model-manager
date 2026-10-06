/**
 * dsh-ofm-model-manager —— 全体模型管理（host 半端）
 * ============================================================================
 * v1 只管 Our Free Model 一个供应商。v2 升级成「全体模型管理系统」：provider
 * 目录里的**每一条**路由都进管理面板，每条模型都能单独启用/停用、单独重命名。
 *
 * 五个半端动作：
 *
 *   1) 改写模型目录（本文件的主角）。
 *      包一层 ctx.llm.listModels()：被停用的模型从返回值里滤掉，带自定义名称的
 *      模型把 name 换成用户填的那个（浅拷贝，不动 provider 交出来的对象）。
 *      DSH 的模型目录 buildModelCatalog()
 *      （@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js）里有一句
 *        groups.filter(group => group.models.length > 0)
 *      —— 模型数为 0 的 provider 分组会被整组丢弃。所以「停用最后一个模型」
 *      会让这个分组从选择器里消失，这正是需求要的语义。
 *      与 dsh-provider-toggle 的做法同源，区别只在这里是**逐模型**而不是整个 provider。
 *
 *      注意边界（dsh-llm 源码原话）："Core routing accepts unlisted model ids;
 *      catalog-driven entry points such as the GUI may require membership."
 *      也就是说：已经选着这个模型的旧会话不会被弄坏，请求照常发；只是选择器里
 *      不再提供它。这与「停用」的直觉一致。
 *
 *   2) 只读清单接口 GET /api/ofm-model-manager/models。
 *      被停用的模型在模型目录里已经看不见了，管理面板必须另有一条数据来源 ——
 *      而且 LlmModelInfo 只给 id/name/description/inputModalities，拿不到
 *      「这个模型属于哪条路由（是不是地区受限）」。这条路由一次性给全。
 *      只读、只认 GET/HEAD、走 trust 闸门（见 src/trust.js）。
 *      `?force=1` 让面板上的「重新读取」绕开 TTL 缓存。
 *
 *   3) 状态持久化与热生效。
 *      偏好存在本插件自己的 settings 命名空间，两个 volatile 字段：
 *        · `disabled`：偏好键数组（`provider|modelId`，裸 `modelId` 表示通配）；
 *        · `names`   ：偏好键 → 自定义显示名。
 *      volatile 是硬要求：只有 volatile 字段才允许被 settings 服务写入
 *      （dsh-settings 的 write() 里有 isVolatilePath 检查），也只有 volatile 字段
 *      走热更新而不是重启插件。
 *      走 DSH 原生 settings 服务 → 写进 profile 的 cordis.patch.yml；
 *      浏览器半端用现成的 ctx.remote.settings.describe()/mutate() 读写。
 *      写入触发 loader/volatile-update → 本插件重读配置并广播
 *      llm/adapters-updated → 浏览器的模型目录当场重载（不刷新页面）。
 *
 *   4) v1 配置的零迁移兼容。
 *      v1 的 `hidden`（裸模型 id 数组）与扁平 `names`（模型 id → 名称）在本插件的
 *      键口径下**原样读得动**（裸 id = 通配，对所有 provider 生效）。
 *      除此之外，每次写偏好都把「通配的那部分」镜像进 `hidden` ——
 *      万一用户回退到 v1，旧版照样认得出自己那份设置。
 *
 *   5) 模型清单缓存（src/manager.js 的 createModelCache）。
 *      面板一次要读所有 provider 的清单，而每次拨开关 / 敲名字都会触发一轮重读。
 *      TTL 内直接复用；llm/adapters-updated 与「重新读取」按钮会让它失效。
 *
 * ⚠️ 兼容性（本插件必须证明自己没有踩到别人）：
 *   · 与 dsh-provider-toggle 争用同一个补丁槽（llm 实例上的自有属性 listModels）——
 *     见 ensureFilter() 的说明，两边卸载时都不会把对方带走；
 *   · 与 dsh-opencode-go-model-list 这类「往 pi-ai 目录里塞模型」的插件并存：
 *     它们在更底层（getModels）动手，本插件在 listModels 出口过滤，顺序无冲突；
 *   · `hidden` 字段保留（不再作为权威来源），与 dsh-provider-toggle 的 `disabled`
 *     分属两个命名空间，不会互相覆盖。
 */

import z from '@deepseek-ai/schemastery'
import {
  SEP,
  buildRoster,
  createModelCache,
  decodeKey,
  disabledKeySet,
  effectiveNames,
  idList,
  isWildcardKey,
  keyTextMap,
  resolveRoutes,
  sameMap,
  sameSet,
  unwrap,
} from './src/manager.js'
import { rejectionFor } from './src/trust.js'

/** loader 诊断里显示的插件名。 */
export const name = 'ofm-model-manager'

/**
 * 插件配置。
 *
 * `disabled` 与 `names` 是用户偏好的唯二存放处，都必须 .volatile()。
 * 键的口径见 src/manager.js 文件头（`provider|modelId` 精确，裸 `modelId` 通配）。
 *
 * `hidden` 也必须 `.volatile()`：本插件每次写偏好都会把**通配键**镜像进它
 * （万一用户回退到 v1，旧版照样认得出自己那份设置）。settings 服务的 write() 会
 * 拒绝任何非 volatile 字段 —— 于是「镜像一下」这个动作本身就会让整次写入失败。
 *
 * `routes` 保持非 volatile：它是部署配置，不该由界面写入。
 */
export const Config = z.object({
  disabled: z.array(z.string()).default([]).volatile(),
  names: z.dict(z.string()).default({}).volatile(),
  hidden: z.array(z.string()).default([]).volatile(),
  routes: z.array(z.string()).default([]),
})

/** 兜底命名空间：正常情况下是 profile 里那条 entry 的 id（cordis.patch.yml 里写的）。 */
const NS_FALLBACK = 'dsh-ofm-model-manager'

/** 清单接口的前缀（比内核 /api 长，故 webServer 会先派发到这里）。 */
const API_PREFIX = '/api/ofm-model-manager'

/** 清单缓存的 TTL：拨开关 / 敲名字都不会让它失效，只有它自己到期。 */
const CACHE_TTL_MS = 60000

/** 挂在 llm 服务实例上的补丁状态（用 Symbol 防重复包装）。 */
const PATCH = Symbol.for('dsh-ofm-model-manager.patch')

/** profile 里那条 entry 的 id，即 settings 命名空间。 */
function namespaceOf(ctx) {
  const id = ctx?.fiber?.entry?.options?.id
  return typeof id === 'string' && id !== '' ? id : NS_FALLBACK
}

/**
 * 取（或安装）挂在 llm 实例上的逐模型过滤补丁。
 *
 * 用引用计数：插件被重新 apply（非 volatile 配置改动会重启插件）时不叠加多层包装，
 * 真正卸载时能把 listModels 还原回原型方法。
 *
 * @param {object} llm - ctx.llm 服务实例。
 * @param {object} shared - 本插件实例的共享状态（见 apply()）。
 * @returns {{ state: object, release: () => void }}
 */
export function acquireFilter(llm, shared) {
  let state = llm[PATCH]
  if (state === undefined) {
    const original = llm.listModels.bind(llm)
    state = { original, patched: undefined, holders: 0 }
    const patched = (provider, signal) => {
      const id = String(provider)
      // 只管本插件认领的路由：没进共享表的路由原样透传。
      if (!shared.routes.some(route => route.id === id)) return state.original(provider, signal)
      const off = shared.offByProvider.get(id)
      const names = shared.namesByProvider.get(id)
      const wildcardOff = shared.wildcardOff
      const wildcardNames = shared.wildcardNames
      const hasOff = off !== undefined && off.size > 0
      const hasNames = names !== undefined && names.size > 0
      const hasWildcardOff = wildcardOff !== undefined && wildcardOff.size > 0
      const hasWildcardNames = wildcardNames !== undefined && wildcardNames.size > 0
      // 这条路由没有任何偏好时连 then 都不挂，返回 provider 的原始 promise（零开销透传）。
      if (!hasOff && !hasNames && !hasWildcardOff && !hasWildcardNames) return state.original(provider, signal)
      return Promise.resolve(state.original(provider, signal)).then(models => {
        if (!Array.isArray(models)) return models
        let out = models
        if (hasOff || hasWildcardOff) {
          out = out.filter(model => {
            const modelId = String(model?.id ?? '')
            // 精确键优先命中；通配键是 v1 的语义（对所有 provider 生效）。
            if (off !== undefined && off.has(modelId)) return false
            if (hasWildcardOff && wildcardOff.has(modelId)) return false
            return true
          })
        }
        if (hasNames || hasWildcardNames) {
          out = out.map(model => {
            const modelId = String(model?.id ?? '')
            const custom = (names !== undefined ? names.get(modelId) : undefined)
              ?? (wildcardNames !== undefined ? wildcardNames.get(modelId) : undefined)
            // 浅拷贝：provider 交出来的对象可能被别处复用，绝不在原地改 name。
            return custom === undefined ? model : Object.assign({}, model, { name: custom })
          })
        }
        return out
      })
    }
    state.patched = patched
    Object.defineProperty(llm, 'listModels', {
      value: patched, writable: true, configurable: true, enumerable: false,
    })
    Object.defineProperty(llm, PATCH, {
      value: state, writable: true, configurable: true, enumerable: false,
    })
  }
  // 未过滤的取数口：管理面板要看到「被停用的那些」，必须绕开自己的补丁。
  shared.original = state.original
  state.holders += 1
  return {
    state,
    release: () => {
      state.holders -= 1
      if (state.holders > 0) return
      if (llm[PATCH] !== state) return
      // 删掉自有属性 → 重新露出 LlmRuntime 原型上的 listModels
      Reflect.deleteProperty(llm, 'listModels')
      Reflect.deleteProperty(llm, PATCH)
    },
  }
}

/**
 * 补装过滤补丁 —— 只在「它确实被摘掉了」的时候动手。
 *
 * 为什么需要：同一个 llm 实例上可能还有别的插件（dsh-provider-toggle）包过
 * `listModels`，而它卸载时用的是 `Reflect.deleteProperty(llm, 'listModels')`。
 * 自有属性是同一个名字，删一次会把**我们**的包装一起带走 —— 那一刻之后
 * `llm.listModels` 又回到原型方法，逐模型过滤会静默失效（用户看到的是
 * 「开关点了没用」）。这里在每次重读配置时补一次。
 *
 * 判据刻意收得很紧：只在**自有属性整个消失**时补装。如果别人只是又包了一层
 * （自有属性还在），我们的包装仍在链路上，补装反而会把包装越堆越多。
 *
 * @param {object} llm - ctx.llm 服务实例。
 * @param {{ original?: Function }} shared - 本插件实例的共享状态。
 */
export function ensureFilter(llm, shared) {
  if (Object.hasOwn(llm, 'listModels')) return
  const state = llm[PATCH]
  if (state === undefined || typeof state.patched !== 'function') return
  state.original = llm.listModels.bind(llm)
  shared.original = state.original
  Object.defineProperty(llm, 'listModels', {
    value: state.patched, writable: true, configurable: true, enumerable: false,
  })
}

/**
 * 把偏好键集合拆成「按 provider 分桶」+「通配桶」。
 *
 * 补丁函数在每次 listModels 调用时跑，必须 O(1) 取到自己那条路由的偏好 ——
 * 所以在这里一次分好，而不是在过滤时逐条 decode。
 *
 * @param {Iterable<string>} keys - 偏好键。
 * @returns {{ wildcard: Set<string>, byProvider: Map<string, Set<string>> }}
 */
export function splitKeys(keys) {
  const byProvider = new Map()
  const wildcard = new Set()
  for (const key of keys) {
    // 空白键不该被当成一条偏好（手改配置文件很容易留下这种脏值）。
    if (typeof key !== 'string' || key.trim() === '') continue
    if (isWildcardKey(key)) { wildcard.add(key); continue }
    const { provider, id } = decodeKey(key)
    if (provider === '' || id === '') continue
    let bucket = byProvider.get(provider)
    if (bucket === undefined) { bucket = new Set(); byProvider.set(provider, bucket) }
    bucket.add(id)
  }
  return { wildcard, byProvider }
}

/**
 * 把「偏好键 → 名称」拆成按 provider 的两套生效表（去空白口径）。
 * @param {Object<string, string>} table - keyTextMap() 的产物。
 * @returns {{ wildcard: Map<string, string>, byProvider: Map<string, Map<string, string>> }}
 */
export function splitNames(table) {
  const byProvider = new Map()
  const wildcard = new Map()
  for (const [key, value] of effectiveNames(table)) {
    const { provider, id } = decodeKey(key)
    if (id === '') continue
    if (provider === '') { wildcard.set(id, value); continue }
    let bucket = byProvider.get(provider)
    if (bucket === undefined) { bucket = new Map(); byProvider.set(provider, bucket) }
    bucket.set(id, value)
  }
  return { wildcard, byProvider }
}

/**
 * 挂载。
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 已校验的插件配置（Config 的产物）。
 */
export function apply(ctx, config) {
  /** 本插件实例的共享状态：host 的三个 inject 分支共用它。 */
  const shared = {
    routes: [],
    disabled: new Set(),
    offByProvider: new Map(),
    wildcardOff: new Set(),
    names: new Map(),
    namesByProvider: new Map(),
    wildcardNames: new Map(),
    rawNames: {},
    cache: createModelCache({ ttlMs: CACHE_TTL_MS }),
    original: undefined,
    llm: undefined,
  }

  // 这个页面/权限我们自己接管：不要让设置界面再自动生成一张表单卡片。
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // 把命名空间 id 与接口前缀告诉浏览器半端（和 settings-models 注入
  // __DSH_MODELS_ONBOARDING__ 是同一个手法）。apiVersion 让浏览器半端能识别
  // 「宿主半端还没升级」的过渡态。
  ctx.on('webserver/index-inject', table => {
    table.push({
      kind: 'global',
      name: '__DSH_OFM_MODEL_MANAGER__',
      value: { ns: namespaceOf(ctx), api: API_PREFIX, apiVersion: 2 },
    })
  })

  // ── 模型目录过滤 + 状态读取 ─────────────────────────────────────────────────
  ctx.inject(['llm'], child => {
    const llm = child.llm
    shared.llm = llm
    const { release } = acquireFilter(llm, shared)

    /** 读 settings 命名空间当前的值（第三方插件拿到的 config 不是 ref 时的兜底）。 */
    const settingsValue = () => {
      const settings = ctx.get('settings')
      if (settings === undefined || typeof settings.describe !== 'function') return undefined
      let described
      try {
        described = settings.describe({ redactSecrets: true })
      } catch {
        return undefined
      }
      // host 侧的 describe() 直接返回描述符数组；远程形态才是 { namespaces }。
      const namespaces = Array.isArray(described)
        ? described
        : Array.isArray(described?.namespaces) ? described.namespaces : []
      const wanted = namespaceOf(ctx)
      const entry = namespaces.find(item => item?.ns === wanted)
      return entry?.value
    }

    /**
     * 读一个配置字段：volatile ref 与实际值都读得动；字段缺失时拐回 settings 文档。
     * @param {unknown} field
     * @param {() => unknown} fallback
     */
    const fieldValue = (field, fallback) => {
      if (field !== undefined && field !== null) return unwrap(field)
      return fallback()
    }

    /** 广播「模型拓扑变了」—— dsh-client-ui-model-selection 的 catalog.refresh() 监听的就是它。 */
    const announce = () => {
      try {
        llm.emitAdaptersUpdated?.()
      } catch (error) {
        ctx.logger?.warn?.('ofm-model-manager: failed to announce llm/adapters-updated')
        ctx.logger?.warn?.(error)
      }
    }

    /**
     * 重读配置与 provider 目录。
     * @param {boolean} announceWhenChanged - 值真的变了才广播（避免与自己的监听器形成回环）。
     */
    const refresh = announceWhenChanged => {
      ensureFilter(llm, shared)
      let providers = []
      try {
        providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      } catch (error) {
        ctx.logger?.warn?.('ofm-model-manager: listProviders failed')
        ctx.logger?.warn?.(error)
      }
      const value = settingsValue()
      const routes = resolveRoutes(providers, idList(fieldValue(config?.routes, () => value?.routes)))
      const keys = disabledKeySet({
        disabled: fieldValue(config?.disabled, () => value?.disabled),
        hidden: fieldValue(config?.hidden, () => value?.hidden),
      })
      const rawNames = keyTextMap(fieldValue(config?.names, () => value?.names))
      const splitOff = splitKeys(keys)
      const splitName = splitNames(rawNames)
      const routesChanged = routes.length !== shared.routes.length
        || routes.some((route, index) => route.id !== shared.routes[index]?.id)
      const changed = !sameSet(keys, shared.disabled)
        || !sameMap(rawNames, shared.rawNames)
        || routesChanged
      shared.routes = routes
      shared.disabled = keys
      shared.offByProvider = splitOff.byProvider
      shared.wildcardOff = splitOff.wildcard
      shared.rawNames = rawNames
      shared.names = effectiveNames(rawNames)
      shared.namesByProvider = splitName.byProvider
      shared.wildcardNames = splitName.wildcard
      if (announceWhenChanged && changed) announce()
    }

    refresh(false)

    // 挂载时也广播一次：插件被整体重载（非 volatile 字段改动）时不会有
    // loader/volatile-update，浏览器那侧得靠这个事件重载模型目录。
    queueMicrotask(announce)

    // volatile 配置变更 → 重读值 + 让浏览器重载模型目录。这是「改完立即生效」的关键。
    ctx.on('loader/volatile-update', () => refresh(true))

    // 别处改了路由拓扑/目录（OFM 刷新清单、provider-toggle 关掉一条路由）→
    // 重认路由并让清单缓存失效。这里**不**广播，否则会和上面的 announce 形成回环。
    ctx.on('llm/adapters-updated', () => {
      shared.cache.clear()
      refresh(false)
    })

    child.effect(() => () => release())
  })

  // ── 只读清单接口 ────────────────────────────────────────────────────────────
  //
  // 用 ctx.inject(deps, callback) 而不是在 apply 时 ctx.get('webServer')：
  // 插件加载早于浏览器半端发布这个服务，一次性读取会拿到 undefined（cordis 的
  // 已知坑，dsh-our-free-model 的注释里记了同一件事），路由就永远不会注册。
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler: createHandler(ctx, shared) }),
      'ofm-model-manager: roster route',
    )
  })
}

/**
 * 清单接口的处理器。只读：GET / 与 GET /models 之外一律 404，非 GET/HEAD 一律 405。
 *
 * 查询参数 `force=1` 绕开 TTL 缓存重读所有 provider（面板上的「重新读取」按钮）。
 *
 * @param {object} ctx - 插件上下文（每次请求现取 llm / connection，避免持有过早引用）。
 * @param {object} shared - 本插件实例的共享状态。
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createHandler(ctx, shared) {
  return async function handler(req, res) {
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    const rejection = rejectionFor(req, ctx.get?.('connection'))
    if (rejection !== undefined) return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })

    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return send(405, { error: 'method-not-allowed' })

    let routePath = '/'
    let force = false
    try {
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      routePath = url.pathname.replace(API_PREFIX, '').replace(/\/+$/, '') || '/'
      force = url.searchParams.get('force') === '1'
    } catch {
      return send(400, { error: 'bad-request' })
    }
    if (routePath !== '/' && routePath !== '/models') return send(404, { error: 'not-found' })

    const llm = ctx.get?.('llm')
    if (llm === undefined) return send(503, { error: 'llm-unavailable' })

    // 取数刻意走 shared.original（未过滤的那一份）：被停用的模型必须仍然出现在
    // 管理面板里，否则用户没有办法把它们开回来。
    const read = shared.original ?? llm.listModels.bind(llm)
    const listings = new Map()
    const cache = shared.cache
    let cached = 0
    for (const route of shared.routes) {
      try {
        const hit = await cache.get(route.id, () => read(route.id), { force })
        if (hit.cached) cached += 1
        listings.set(route.id, hit.models)
      } catch (error) {
        ctx.logger?.warn?.('ofm-model-manager: listModels("' + route.id + '") failed')
        ctx.logger?.warn?.(error)
        listings.set(route.id, [])
      }
    }
    const roster = buildRoster({
      routes: shared.routes,
      listings,
      disabled: shared.disabled,
      names: shared.rawNames,
    })
    return send(200, {
      ok: true,
      apiVersion: 2,
      ns: namespaceOf(ctx),
      cached,
      ...roster,
    })
  }
}



