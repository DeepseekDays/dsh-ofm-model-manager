/**
 * dsh-ofm-model-manager —— 全体模型管理（client 半端 / 浏览器）
 * ============================================================================
 * v1 只管 Our Free Model 一个供应商，面板是一长条平铺列表。
 * v2 升级成「全体模型管理系统」，落点仍然只有一处：「设置 → 模型」页底部的
 * settings.models.footer 席位（用户正是在这个页面上管模型）。
 *
 * 数据来源两条，各管一件事：
 *   · 模型清单（名称/描述/id/所属 provider/是否地区受限）来自本插件自己的只读
 *     接口 GET /api/ofm-model-manager/models —— 被停用的模型在 DSH 的模型目录里
 *     已经看不见了，面板必须另有一条「完整清单」的来源；
 *   · 启用/停用状态与自定义名称来自 ctx.remote.settings（DSH 原生 settings 服务，
 *     命名空间就是本插件在 profile 里那条 entry），所以它是持久的，而且写入触发
 *     loader/volatile-update → 宿主广播 llm/adapters-updated → 目录热重载。
 *
 * 界面结构（按调研到的成熟做法取舍，见 README 的「界面设计」一节）：
 *   · 三层控件各管一段：搜索框管精确、状态 chips 管属性、供应商下拉管分组；
 *   · provider 折叠分组，组头显示 已启用/总数 与一个组级开关（最安全的批量操作）；
 *   · 批量按钮只作用于**当前筛选视图**，文案写明范围，不做无声的「全选全库」；
 *   · 行内开关 + 行内重命名（开关在前、输入框在后）；
 *   · 渲染条数有上限 + 「显示更多」，避免几百上千条时把设置页拖住
 *     （不引虚拟滚动库：本文件手写 ModuleLoader bundle，除 react 与 primitives 外
 *      没有依赖）；
 *   · 三分类空态：没有 provider / 全部被停用 / 搜索无结果。
 *
 * 手写 ModuleLoader bundle：没有构建步骤，除 shell 已经提供的 react 与
 * @deepseek-ai/dsh-client-ui-primitives 之外没有依赖。所有颜色走主题变量，
 * 深/浅色切换都不用改代码。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ofm-model-manager',
  factory: require => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const Switch = primitives.Switch
    // DSH 设计系统的勾选框（同色同尺寸，不自己画一个）
    const Checkbox = primitives.Checkbox

    const SOURCE = 'dsh-ofm-model-manager'
    /** 本地化命名空间（也用作字典注册名）。 */
    const NS = 'dsh-ofm-model-manager'
    /** 「设置 → 模型」页脚席位的 id。 */
    const FOOTER_ID = 'ofm-model-manager-panel'
    /** 兜底命名空间与接口前缀；正常情况下由 host 半端 index-inject 注入。 */
    const NS_FALLBACK = 'dsh-ofm-model-manager'
    const API_FALLBACK = '/api/ofm-model-manager'
    /** 自定义名称的长度上限（跟着 DSH 模型名的量级走，同时是输入框的 maxLength）。 */
    const NAME_MAX = 64
    /** 输入防抖：停手 500ms 才写一次（每次写都会落 profile 的 patch 文件并重载模型目录）。 */
    const NAME_DEBOUNCE_MS = 500
    /** 单次渲染的模型行上限；超过就出「显示更多」。 */
    const PAGE_SIZE = 40
    /** 复合键分隔符：必须与 host 半端 src/manager.js 的 SEP 一致。 */
    const SEP = '|'

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 新增文案一律同时给中英两份：locale.register 拿的是整只字典，缺 key 会回落成
    // key 本身（界面上出现 ofmm.xxx 这种东西）。
    const DICT = {
      zh: {
        nav: '全体模型管理',
        title: '模型管理',
        subtitle: '管理所有提供商的模型：逐条启用/停用、逐个改名；停用的模型从「选择模型」列表里消失',
        hint: '停用的模型会从主界面「选择模型」栏和 /model 弹窗里消失；已经选着它的会话不受影响，请求照常发。自定义名称会直接换掉「选择模型」里显示的名字。改动立即生效，不用刷新页面。',
        search: '搜索名称、id、描述或提供商',
        filterAll: '全部',
        filterAvailable: '已启用',
        filterRegion: '地区受限',
        filterDisabled: '已停用',
        providerAll: '全部提供商',
        'status.available': '已启用',
        'status.disabled': '已停用',
        'status.region': '地区受限',
        'action.enable': '启用 {name}',
        'action.disable': '停用 {name}',
        'group.enable': '启用 {provider} 的全部模型',
        'group.disable': '停用 {provider} 的全部模型',
        'group.collapse': '折叠 {provider}',
        'group.expand': '展开 {provider}',
        'group.enableShort': '全部启用',
        'group.disableShort': '全部停用',
        bulkEnable: '启用当前视图（{n}）',
        bulkDisable: '停用当前视图（{n}）',
        bulkScope: '批量操作只影响上面筛选出来的结果，不会动没显示出来的模型。',
        loading: '正在读取模型清单…',
        empty: '没有匹配的模型。',
        emptySearch: '没有匹配「{query}」的模型。',
        clearFilters: '清除筛选',
        emptyAllDisabled: '你把所有模型都停用了。',
        restoreAll: '全部恢复启用',
        none: '没有可管理的模型：所有提供商都还没列出模型（可能还没配密钥），或者提供商被整体关掉了。',
        error: '无法读取：{message}',
        retry: '重试',
        reload: '重新读取',
        saveFailed: '保存失败',
        count: '共 {total} 个模型 · {routes} 个提供商 · 已启用 {enabled} · 已停用 {disabled}',
        regionHint: '其中 {n} 个按出口地区放行（「地区受限」）。',
        staleHint: '有 {n} 条停用记录已失效（模型已不在清单里）。',
        staleClean: '清理',
        updated: '清单更新于 {time}',
        cached: '（{n} 个来自缓存）',
        nsMissing: '读不到本插件的 settings 命名空间，开关暂时不可用。请完全退出 DSH 再启动一次。',
        'custom.toggle': '自定义名称',
        'custom.mark': '自定义',
        'custom.shared': '通配',
        'custom.sharedTitle': '这个名称对所有提供商下同名模型都生效',
        'custom.title': '为 {name} 设置自定义显示名称',
        'custom.resetTitle': '把 {name} 恢复成系统默认名称',
        'custom.placeholder': '默认：{name}',
        'custom.reset': '恢复默认',
        'custom.stale': '有 {n} 个自定义名称对应的模型已不在清单里（升级或模型更新时会保留）。',
        'custom.hostStale': '宿主半端还没加载到带自定义名称的这一版，输入框暂时不显示：完全退出 DSH（含托盘）再启动一次。',
        hostStale: '宿主半端还是旧版（没有 disabled 字段），开关改了不会生效：完全退出 DSH（含托盘）再启动一次。',
        'showMore': '显示更多（还有 {n} 个）',
        'shownLimit': '为保证流畅，当前只渲染了前 {shown} 个（共 {total} 个）。继续筛选或点「显示更多」。',
        'offShared': '通配',
        'offSharedTitle': '这条停用记录来自旧版设置，对所有提供商下同名模型都生效',
      },
      en: {
        nav: 'All model manager',
        title: 'Model manager',
        subtitle: 'Manage every provider\u2019s models: per-model enable/disable and per-model rename; disabled models leave the model picker',
        hint: 'Disabled models disappear from the composer model menu and the /model popup. A session already using one keeps working — requests still go through. A custom name replaces the label shown in the model picker. Changes apply immediately; no page refresh needed.',
        search: 'Search name, id, description or provider',
        filterAll: 'All',
        filterAvailable: 'Enabled',
        filterRegion: 'Region-limited',
        filterDisabled: 'Disabled',
        providerAll: 'All providers',
        'status.available': 'Enabled',
        'status.disabled': 'Disabled',
        'status.region': 'Region-limited',
        'action.enable': 'Enable {name}',
        'action.disable': 'Disable {name}',
        'group.enable': 'Enable every model of {provider}',
        'group.disable': 'Disable every model of {provider}',
        'group.collapse': 'Collapse {provider}',
        'group.expand': 'Expand {provider}',
        'group.enableShort': 'Enable all',
        'group.disableShort': 'Disable all',
        bulkEnable: 'Enable the current view ({n})',
        bulkDisable: 'Disable the current view ({n})',
        bulkScope: 'Bulk actions only touch the filtered results above; models that are not shown stay untouched.',
        loading: 'Loading the model roster\u2026',
        empty: 'No model matches.',
        emptySearch: 'No model matches \u201c{query}\u201d.',
        clearFilters: 'Clear filters',
        emptyAllDisabled: 'You disabled every model.',
        restoreAll: 'Enable all again',
        none: 'Nothing to manage: no provider has listed any model yet (a missing API key does that), or the providers are switched off as a whole.',
        error: 'Could not read: {message}',
        retry: 'Retry',
        reload: 'Reload',
        saveFailed: 'Save failed',
        count: '{total} models · {routes} providers · {enabled} enabled · {disabled} disabled',
        regionHint: '{n} of them are let through by egress region (\u201cRegion-limited\u201d).',
        staleHint: '{n} disabled entries are stale (the model is gone from the roster).',
        staleClean: 'Clean up',
        updated: 'Roster updated {time}',
        cached: '({n} from cache)',
        nsMissing: 'This plugin settings namespace is not exposed, so the switches are unavailable. Fully quit DSH and start it again.',
        'custom.toggle': 'Custom name',
        'custom.mark': 'custom',
        'custom.shared': 'global',
        'custom.sharedTitle': 'This name applies to every provider that lists a model with the same id',
        'custom.title': 'Set a custom display name for {name}',
        'custom.resetTitle': 'Restore the system default name of {name}',
        'custom.placeholder': 'Default: {name}',
        'custom.reset': 'Reset',
        'custom.stale': '{n} custom names point at models that are no longer listed (they survive upgrades and model updates).',
        'custom.hostStale': 'The host half has not loaded the custom-name version yet, so the inputs are hidden: fully quit DSH and start it again.',
        hostStale: 'The host half is still the older build (no disabled field), so switch changes would not take effect: fully quit DSH and start it again.',
        'showMore': 'Show more ({n} left)',
        'shownLimit': 'To stay responsive only the first {shown} of {total} rows are rendered. Narrow the filter or press Show more.',
        'offShared': 'global',
        'offSharedTitle': 'This disabled entry comes from the older settings format and applies to every provider listing a model with the same id',
      },
    }

    // ── 小工具 ──────────────────────────────────────────────────────────────
    /** 拼偏好键：provider 与 modelId 之间用 SEP 连接。空 provider = 通配。 */
    function pkey(provider, id) {
      const owner = String(provider === null || provider === undefined ? '' : provider)
      const model = String(id === null || id === undefined ? '' : id)
      return owner === '' ? model : owner + SEP + model
    }

    /** {name} 占位替换（不用正则，保持这份文件里没有反斜杠转义）。 */
    function fmt(text, params) {
      var out = String(text)
      if (params === undefined || params === null) return out
      const keys = Object.keys(params)
      for (const key of keys) out = out.split('{' + key + '}').join(String(params[key]))
      return out
    }

    function guessLocale() {
      const lang = String(
        (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang)
        || (typeof navigator !== 'undefined' && navigator.language)
        || 'zh'
      )
      return lang.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
    }

    function injected() {
      const value = globalThis.__DSH_OFM_MODEL_MANAGER__
      return value !== null && typeof value === 'object' ? value : {}
    }

    function namespaceId() {
      const ns = injected().ns
      return typeof ns === 'string' && ns !== '' ? ns : NS_FALLBACK
    }

    function apiBase() {
      const api = injected().api
      return typeof api === 'string' && api !== '' ? api : API_FALLBACK
    }

    /**
     * 宿主半端报告的接口版本。
     * 0 表示「注入里没有 apiVersion」= 宿主还是 v1（只认 hidden / 扁平 names）。
     */
    function hostApiVersion() {
      const version = injected().apiVersion
      return typeof version === 'number' && version > 0 ? version : 0
    }

    function messageOf(error) {
      return String(error && error.message !== undefined ? error.message : error)
    }

    /** 只读清单接口。同源、不带凭据以外的任何东西。 */
    async function api(path) {
      const response = await fetch(apiBase() + path, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!response.ok) {
        const detail = (String(response.status) + ' ' + String(response.statusText || '')).trim()
        throw new Error(detail)
      }
      return await response.json()
    }

    /**
     * 把任意来源的偏好键数组收干净：只留非空字符串。
     * @param {unknown} raw
     * @returns {string[]}
     */
    function normalizeKeys(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      const seen = new Set()
      for (const item of raw) {
        if (typeof item !== 'string' || item === '' || seen.has(item)) continue
        seen.add(item)
        out.push(item)
      }
      return out
    }

    /**
     * 把任意来源的名称表收干净：只留「字符串键 + 字符串值」。
     *
     * 空串是**合法**值（用户把输入框清空了、开关还勾着），这里刻意不过滤空串 ——
     * 过滤掉的话，用户清空输入框的瞬间勾选框就会自己弹回去、输入框跟着变灰，
     * 等于打字打到一半被抢走。空串在取用时才回落到默认名（见 effectiveNameOf）。
     *
     * @param {unknown} raw
     * @returns {Object<string, string>}
     */
    function normalizeNames(raw) {
      const out = {}
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
      const keys = Object.keys(raw)
      for (const key of keys) {
        const value = raw[key]
        if (key !== '' && typeof value === 'string') out[key] = value
      }
      return out
    }

    /** 这条模型 id 是否被某条停用偏好命中（精确优先，通配兜底）。 */
    function isOff(hiddenSet, provider, id) {
      return hiddenSet.has(pkey(provider, id)) || hiddenSet.has(id)
    }

    /** 这条模型的自定义名称；精确键优先，通配键兜底；没有就是 null。 */
    function customNameOf(model, table) {
      const precise = pkey(model.provider, model.id)
      if (Object.prototype.hasOwnProperty.call(table, precise)) return table[precise]
      if (Object.prototype.hasOwnProperty.call(table, model.id)) return table[model.id]
      return null
    }

    /** 这条自定义名是通配的（对所有 provider 生效）还是这一行专属的。 */
    function customIsShared(model, table) {
      const precise = pkey(model.provider, model.id)
      if (Object.prototype.hasOwnProperty.call(table, precise)) return false
      return Object.prototype.hasOwnProperty.call(table, model.id)
    }

    /** 生效的显示名：有非空白的自定义名称就用它，否则用系统默认名。 */
    function effectiveNameOf(model, table) {
      const custom = customNameOf(model, table)
      if (custom !== null && custom.trim() !== '') return custom.trim()
      return String(model !== null && typeof model === 'object' && model.name !== undefined ? model.name : '')
    }

    /**
     * 用「当前停用集合 + 当前自定义名称表」给清单里的每个模型补上状态与生效名。
     *
     * 刻意在浏览器侧算：拨开关 / 敲名字时不必等清单重新拉一遍，界面当场就对
     * （乐观更新）。
     *
     * @param {object} roster - host 的清单（默认名在 model.name 上）。
     * @param {string[]} hidden - 停用偏好键。
     * @param {Object<string, string>} [names] - 偏好键 → 自定义名称。
     */
    function derive(roster, hidden, names) {
      const hiddenSet = new Set(normalizeKeys(hidden))
      const table = normalizeNames(names)
      const source = roster !== null && typeof roster === 'object' && Array.isArray(roster.models) ? roster.models : []
      const models = source.map(model => {
        const enabled = !isOff(hiddenSet, model.provider, model.id)
        const customName = customNameOf(model, table)
        return Object.assign({}, model, {
          enabled,
          // 勾选框看 custom，输入框的「可编辑」也看它；customName 原样保留（可能是空串）。
          custom: customName !== null,
          customName,
          customShared: customIsShared(model, table),
          displayName: effectiveNameOf(model, table),
          // 三态：已停用 > 地区受限 > 已启用。停用优先 —— 用户把它停了之后，
          // 他想看到的是「你停了它」，不是「它地区受限」。
          status: !enabled ? 'disabled' : model.region === true ? 'region' : 'available',
        })
      })
      const counts = { total: models.length, enabled: 0, available: 0, region: 0, disabled: 0 }
      for (const model of models) {
        if (!model.enabled) { counts.disabled += 1; continue }
        counts.enabled += 1
        if (model.region === true) counts.region += 1
        else counts.available += 1
      }
      return { models, counts }
    }

    /**
     * 面板的搜索 + 筛选口径（与 host 侧 src/manager.js 的 matchModel 同口径）。
     *
     * @param {object} model - derive() 出来的一行。
     * @param {string} query
     * @param {string} filter - all | available | region | disabled
     * @param {string} provider - '' = 全部提供商
     */
    function matchModel(model, query, filter, provider) {
      if (filter !== 'all' && model.status !== filter) return false
      if (provider !== '' && model.provider !== provider) return false
      const needle = String(query || '').trim().toLowerCase()
      if (needle === '') return true
      const hay = [
        model.name, model.displayName, model.customName, model.id,
        model.description, model.provider, model.providerLabel,
      ].map(value => String(value === undefined || value === null ? '' : value)).join(' ').toLowerCase()
      const parts = needle.split(' ').filter(part => part !== '')
      for (const part of parts) if (hay.indexOf(part) < 0) return false
      return true
    }

    /**
     * 把筛选出来的行按 provider 分组（保持 roster.routes 的顺序与标签）。
     *
     * @param {Array<object>} rows
     * @param {Array<object>} routes - host 给的 route 行（id/label/region/ofm/count）。
     * @returns {Array<{id: string, label: string, region: boolean, rows: Array<object>, enabled: number, disabled: number}>}
     */
    function groupRows(rows, routes) {
      const byId = new Map()
      for (const row of rows) {
        let bucket = byId.get(row.provider)
        if (bucket === undefined) { bucket = []; byId.set(row.provider, bucket) }
        bucket.push(row)
      }
      const groups = []
      const known = new Set()
      for (const route of Array.isArray(routes) ? routes : []) {
        const list = byId.get(route.id)
        if (list === undefined) continue
        known.add(route.id)
        let enabled = 0
        for (const row of list) if (row.enabled) enabled += 1
        groups.push({
          id: route.id,
          label: String(route.label === undefined ? route.id : route.label),
          region: route.region === true,
          rows: list,
          enabled,
          disabled: list.length - enabled,
        })
      }
      // host 没报告的 provider（理论上不会发生）也不静默丢掉。
      for (const [id, list] of byId) {
        if (known.has(id)) continue
        let enabled = 0
        for (const row of list) if (row.enabled) enabled += 1
        groups.push({ id, label: id, region: false, rows: list, enabled, disabled: list.length - enabled })
      }
      return groups
    }

    // ── 页面级单例状态 ───────────────────────────────────────────────────────
    let pluginCtx
    /**
     * 面板状态的初值。写成工厂函数而不是字面量：状态是**页面级单例**，
     * 「插件被重新挂载」与离线验证台都需要一份干净初值（见文件末尾的 __reset 接缝）。
     */
    function initialState() {
      return {
        settingsPhase: 'idle', // idle | loading | ready | missing | error
        rosterPhase: 'idle',   // idle | loading | ready | error
        ns: null,
        revision: undefined,
        /** 停用的偏好键。 */
        hidden: [],
        /** 自定义名称表（偏好键 → 名称）；空串 = 开关还勾着但名字是空的。 */
        names: {},
        /** 本地编辑序号 / 已落盘序号：两者不等就说明还有没写回去的编辑。 */
        nameSeq: 0,
        nameSavedSeq: 0,
        /** 最后一次确认落盘的服务端名称表 —— 写失败时回滚到它（不是回滚到乐观值）。 */
        savedNames: {},
        /**
         * 宿主半端是否已经加载了带 names 字段的这一版。
         *
         * 浏览器半端是**热重载**的（client-hmr 每 500ms 比对 client.js 的 mtime），
         * 宿主半端不是（要完全退出 DSH 再启动）。所以「界面是新的、宿主还是旧的」
         * 这个过渡态真实存在：此时 settings 命名空间里根本没有 names 字段，勾选框
         * 点了只会写失败。宁可先不显示这组控件，并在面板上说清怎么让它可用。
         */
        namesReady: false,
        /**
         * 宿主半端是否已经是 v2（settings 命名空间里有 disabled 字段）。
         *
         * 比 namesReady 更关键：旧宿主不认 disabled，开关点了写下去也没人读——
         * 界面必须整体锁住并说清楚，不能让用户以为「点了没反应」。
         */
        hostReady: false,
        roster: null,
        /** 读失败（清单 / settings 文档）—— 面板整体进错误态。 */
        error: null,
        /** 写失败（拨开关 / 改名）—— 只在面板里挂一条提示，乐观更新已回滚。 */
        saveError: null,
        busy: false,
      }
    }
    let state = initialState()
    const listeners = new Set()
    /** 名称输入的防抖定时器（页面级单例，与 state 同寿命）。 */
    let nameTimer
    /** 名称写入串行链：两次写撞同一个 revision 会被 settings 判 conflict。 */
    let nameChain = Promise.resolve()
    /**
     * 在飞的「整份重读」轮次；非 null 说明已经有一轮在跑。
     *
     * 宿主一次写会连发好几个失效信号（llm/adapters-updated 自己一条、
     * settings/document-updated 一条），逐个起一轮重读就会叠着拉清单 ——
     * 面板在打字期间被反复重画，看着就是卡顿 + 闪烁。
     */
    let loadInFlight = null
    /** 在飞那一轮结束前又来了失效信号 → 结束后只补一轮（多次合并成一次）。 */
    let loadQueued = false
    let loadQueuedForce = false
    /** 正在写盘的开关类写回条数：并发写不会把 busy 提前放掉。 */
    let busyCount = 0
    /** 本插件自己写出来的 revision：用来认出宿主广播回来的「自己的回声」。 */
    let lastWrittenRevision

    /**
     * 结构相等（只处理 JSON 形状：原始值 / 数组 / 纯对象）。
     *
     * publish() 用它挡掉「值没变」的更新：面板是订阅式重画的，哪怕只是把同一份
     * 清单对象换个引用发布一次，React 也会把 40 行整片重画 —— 打字期间就是闪烁。
     */
    function sameValue(a, b) {
      if (a === b) return true
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
      const aIsArray = Array.isArray(a)
      if (aIsArray !== Array.isArray(b)) return false
      if (aIsArray) {
        if (a.length !== b.length) return false
        for (let index = 0; index < a.length; index += 1) if (!sameValue(a[index], b[index])) return false
        return true
      }
      const keys = Object.keys(a)
      if (keys.length !== Object.keys(b).length) return false
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false
        if (!sameValue(a[key], b[key])) return false
      }
      return true
    }

    /**
     * 会出现在界面上的字段。只有这些变了才值得叫醒订阅者（= 让 React 重画）。
     *
     * 其余字段（revision / ns / savedNames / nameSeq / nameSavedSeq）纯粹是内部记账：
     * 面板一处都不读它们。写盘成功后 revision 必然 +1、序号也要推进，若把这些也算作
     * 「变了」，用户每敲一次名字落盘都会白重画一次整片面板 —— 这正是输入期间的卡顿与
     * 闪烁来源之一。
     *
     * ⚠️ 往面板里加新字段的读取时，必须同步加进这个集合，否则该字段的更新会静默
     * 不重画。下面的用例「记账字段的更新不重画，但界面字段照旧」会把这类疏漏钉出来。
     */
    const RENDER_KEYS = [
      'roster', 'rosterPhase', 'hidden', 'names', 'namesReady', 'hostReady',
      'busy', 'settingsPhase', 'error', 'saveError',
    ]

    /**
     * 发布状态补丁：值真的变了才动 state；**且只有界面字段变了才叫醒订阅者**。
     *
     * 同步改 state（snapshot() / 写盘逻辑都要能当场读到最新值），但没有可见变化就
     * 不通知 —— 这是「界面无异常刷新」的关键：写盘成功后的收敛、宿主回声触发的重读、
     * 内容没变的清单刷新、纯记账的序号推进，全都不该让面板重画一遍。
     */
    function publish(patch) {
      let changed = false
      let visible = false
      const next = Object.assign({}, state)
      for (const key of Object.keys(patch)) {
        const value = patch[key]
        if (sameValue(state[key], value)) continue
        next[key] = value
        changed = true
        if (RENDER_KEYS.indexOf(key) >= 0) visible = true
      }
      if (!changed) return
      state = next
      if (!visible) return
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch (error) {
          console.error(SOURCE + ': listener failed', error)
        }
      }
    }

    /**
     * 写开关类偏好时把面板置忙（锁住这一排开关，避免连点撞 revision）。
     *
     * 只数**开关**的写回：改名走的是另一条路（见 writeNames），绝不能把整块面板
     * 置忙 —— 那会让每一行的勾选框、「恢复默认」按钮在打字期间反复变灰再变回来，
     * 正是用户看到的闪烁；输入框虽然还留着可编辑，但整片重画也会打断输入。
     */
    function beginBusy() {
      busyCount += 1
      publish({ busy: true })
    }

    function endBusy() {
      busyCount = busyCount > 0 ? busyCount - 1 : 0
      publish({ busy: busyCount > 0 })
    }

    /**
     * 只改 state、**不叫醒订阅者**。
     *
     * 用在「这份新数据对界面没有任何可见影响」的场合：把 state 推进到最新，等下一次
     * 真正有意义的更新再一起画出来，中间不做无谓的重画。
     */
    function publishQuiet(patch) {
      state = Object.assign({}, state, patch)
    }

    /**
     * 清单的「实质内容」：去掉每次读都必然不同的元信息。
     *
     * 宿主每次响应都重新盖 generatedAt（当前时间）、cached 也随缓存命中数变，
     * 所以整份 payload 永远不相等 —— 直接比会以为「清单变了」，于是拨一次开关、
     * 敲一次名字都重画 40 行。
     */
    function rosterContent(payload) {
      if (payload === null || typeof payload !== 'object') return payload
      const out = Object.assign({}, payload)
      delete out.generatedAt
      delete out.cached
      return out
    }

    /** 两份清单的实质内容是否相同（只看模型/路由/停用这些会渲染出来的东西）。 */
    function sameRoster(a, b) {
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
      return sameValue(rosterContent(a), rosterContent(b))
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /** 读回停用集合（describe 同时负责推进 revision 记账）。 */
    async function refreshSettings() {
      const ctx = pluginCtx
      if (ctx === undefined) return
      if (state.settingsPhase !== 'ready') publish({ settingsPhase: 'loading' })
      let response
      try {
        response = await ctx.remote.settings.describe()
      } catch (error) {
        publish({ settingsPhase: 'error', error: messageOf(error) })
        return
      }
      if (response === undefined || response.ok !== true) {
        publish({ settingsPhase: 'error', error: String(response && response.error && response.error.message ? response.error.message : 'settings.describe() failed') })
        return
      }
      const namespaces = response.value !== null && typeof response.value === 'object' && Array.isArray(response.value.namespaces) ? response.value.namespaces : []
      // 首选注入进来的 id。
      //
      // 找不到才反查一次，判据是「disabled 数组 + names 或 hidden」：
      // dsh-provider-toggle 的命名空间也有一个 disabled 数组（那是 provider id），
      // 只认 disabled 会认错人。加一个本插件独有字段做鉴别。
      const wanted = state.ns !== null ? state.ns : namespaceId()
      const looksLikeOurs = item => item !== null && typeof item === 'object'
        && item.value !== null && typeof item.value === 'object'
        && Array.isArray(item.value.disabled)
        && (Object.prototype.hasOwnProperty.call(item.value, 'names') || Object.prototype.hasOwnProperty.call(item.value, 'hidden'))
      const entry = namespaces.find(item => item !== null && typeof item === 'object' && item.ns === wanted)
        || namespaces.find(looksLikeOurs)
      if (entry === undefined) {
        if (state.settingsPhase !== 'missing' || state.ns !== wanted) console.warn(SOURCE + ': settings namespace "' + wanted + '" is not exposed — switches are unavailable')
        publish({ settingsPhase: 'missing', ns: wanted, error: null })
        return
      }
      const body = entry.value !== null && typeof entry.value === 'object' ? entry.value : {}
      // 本地还有没落盘的编辑时，别用服务端的旧快照盖掉它（防抖窗口里
      // settings/document-updated 完全可能触发一次 describe）。落盘后两个序号相等，
      // 照常收敛到服务端的值。
      const pending = state.nameSeq !== state.nameSavedSeq
      const settled = normalizeNames(body.names)
      // names 是不是这个命名空间的字段 —— 宿主半端加载了新版本才会有它。
      const namesReady = Object.prototype.hasOwnProperty.call(body, 'names')
      // 旧宿主只认 hidden：没有 disabled 就说明它还是 v1，开关不能放行。
      const hostReady = Object.prototype.hasOwnProperty.call(body, 'disabled') || hostApiVersion() >= 2
      // 停用集合要把 v1 的 hidden（裸 id = 通配）一起并进来。
      // 少了这一步，升级后第一次拨开关就会把用户 v1 时代的停用记录整批冲掉 ——
      // 面板看不到它们，于是写回时也不会带上它们（2026-10-06 真机端到端抓到）。
      const hidden = normalizeKeys(body.disabled)
      const legacy = normalizeKeys(body.hidden)
      for (const key of legacy) if (hidden.indexOf(key) < 0) hidden.push(key)
      publish({
        settingsPhase: 'ready',
        ns: entry.ns,
        namesReady,
        hostReady,
        revision: entry.revision,
        hidden,
        names: pending ? state.names : settled,
        savedNames: pending ? state.savedNames : settled,
        error: null,
      })
    }

    /** 读完整清单（含被停用的模型）。force=true 绕开宿主侧的 TTL 缓存。 */
    async function refreshRoster(force) {
      if (state.rosterPhase !== 'ready') publish({ rosterPhase: 'loading' })
      try {
        const payload = await api(force === true ? '/models?force=1' : '/models')
        if (payload === undefined || payload.ok !== true) throw new Error(String(payload && payload.error ? payload.error : 'roster refused'))
        // 静默路径只在「界面可见的字段本来就已是目标值」时才走：否则 React 手里还是
        // 上一份快照（loading / error），静默更新会让面板卡在旧状态上。
        //
        // 而且只在**后台刷新**（失效信号触发的重读）里静默：用户主动点「重新读取」
        // 时即便内容没变，也要重画一次把「更新于」的时间戳推上去 —— 否则点了没反应。
        if (force !== true && state.rosterPhase === 'ready' && state.error === null && sameRoster(state.roster, payload)) {
          // 实质内容没变（只有 generatedAt / cached 在动）→ 静默换掉元信息，不叫醒
          // 订阅者：否则每次改名写回后的重读都要重画整块面板。
          publishQuiet({ roster: payload })
          return
        }
        publish({ rosterPhase: 'ready', roster: payload, error: null })
      } catch (error) {
        publish({ rosterPhase: 'error', error: messageOf(error) })
      }
    }

    /**
     * 整份重读（settings 文档 + 模型清单）。
     *
     * **不叠着跑**：一轮在飞时再来的失效信号只记一笔，等这轮结束补跑一轮（多次
     * 合并成一次）。宿主一次写会连发 llm/adapters-updated 与 settings/document-updated
     * 两个信号，逐个起一轮就会同时拉两份清单，面板在打字期间被反复重画。
     */
    function load(force) {
      if (loadInFlight !== null) {
        loadQueued = true
        if (force === true) loadQueuedForce = true
        return loadInFlight
      }
      loadInFlight = Promise.all([refreshSettings(), refreshRoster(force)]).then(() => {
        loadInFlight = null
        if (!loadQueued) return undefined
        const queuedForce = loadQueuedForce
        loadQueued = false
        loadQueuedForce = false
        return load(queuedForce)
      })
      return loadInFlight
    }

    /**
     * 写回启用/停用状态。
     *
     * @param {string[]} keys - 要改的偏好键（pkey(provider, id)）。
     * @param {boolean} hide - true = 停用（从选择列表里隐藏），false = 启用。
     */
    async function setHidden(keys, hide) {
      const ctx = pluginCtx
      if (ctx === undefined || state.settingsPhase !== 'ready' || state.ns === null) return
      const next = new Set(state.hidden)
      for (const key of keys) {
        if (hide) next.add(key)
        else next.delete(key)
      }
      // 排序后再写：配置文件的 diff 只反映真实变化，不反映点击顺序。
      await writePrefs({ hidden: Array.from(next).sort() })
    }

    /**
     * 把停用集合与名称表一起写回 settings（一次写就够，减少热重载次数）。
     *
     * 写回时顺手把「通配」的那部分镜像进 v1 的 hidden 字段 —— 万一用户回退到旧版
     * 插件，旧版照样认得出自己那份设置。只写通配键，精确键旧版读不懂，放进去只会
     * 污染它。
     *
     * @param {{hidden?: string[], names?: Object<string, string>}} patch
     */
    async function writePrefs(patch) {
      const ctx = pluginCtx
      if (ctx === undefined || state.settingsPhase !== 'ready' || state.ns === null) return undefined
      const previous = state
      const hidden = patch.hidden !== undefined ? patch.hidden : previous.hidden
      const names = patch.names !== undefined ? patch.names : previous.names
      const ops = []
      if (patch.hidden !== undefined) {
        ops.push({ op: 'set', path: ['disabled'], value: hidden })
        ops.push({ op: 'set', path: ['hidden'], value: legacyMirror(hidden) })
      }
      if (patch.names !== undefined) {
        ops.push({ op: 'set', path: ['names'], value: names })
      }
      if (ops.length === 0) return undefined
      // 乐观更新：界面先动，失败再回滚。
      //
      // 只有**开关**的写回才置忙：改名的写回若也置忙，整块面板（每一行的勾选框、
      // 每一行的「恢复默认」按钮）都会跟着变灰再变回来 —— 用户看到的就是闪烁。
      const isNameWrite = patch.names !== undefined
      publish(Object.assign({ saveError: null }, patch))
      if (!isNameWrite) beginBusy()
      let response
      try {
        response = await ctx.remote.settings.mutate(previous.ns, ops, previous.revision)
      } catch (error) {
        response = undefined
        console.error(SOURCE + ': settings.mutate threw', error)
      }
      if (response !== undefined && response.ok === true) {
        const value = response.value !== null && typeof response.value === 'object' && response.value.value !== null && typeof response.value.value === 'object'
          ? response.value.value
          : {}
        const revision = response.value !== null && typeof response.value === 'object' && response.value.revision !== undefined
          ? response.value.revision
          : previous.revision
        // 记住「这个 revision 是我自己写出来的」：宿主随后广播回来的
        // settings/document-updated 是这次写的回声，没必要再拉一次 describe。
        lastWrittenRevision = revision
        const settledNames = normalizeNames(value.names !== undefined ? value.names : names)
        const next = {
          settingsPhase: 'ready',
          ns: previous.ns,
          revision,
          hidden: normalizeKeys(value.disabled !== undefined ? value.disabled : hidden),
        }
        if (isNameWrite) {
          // 名称表只在「确实是名称写回」时才记账。
          //
          // 两处都要按本地是否还有更新的编辑来分岔：
          //  - 没有 → 收敛到服务端回声（写完就是它，界面不该再动）；
          //  - 有 → 保留本地值和本地序号，别让服务端回声把刚敲的字吞掉。
          // 拨开关的写回**完全不碰** names / savedNames / nameSavedSeq —— 否则一次
          // 开关写盘就会把还挂着的改名顺手标成「已落盘」，本地编辑再也认不出。
          const stillPending = state.nameSeq !== previous.nameSeq
          next.names = stillPending ? state.names : settledNames
          next.savedNames = settledNames
          next.nameSavedSeq = stillPending ? state.nameSavedSeq : state.nameSeq
        }
        publish(next)
        if (!isNameWrite) endBusy()
        return response
      }
      console.error(SOURCE + ': write refused', response && response.error)
      const refused = {
        hidden: previous.hidden,
        saveError: String(response && response.error && response.error.message ? response.error.message : DICT[guessLocale()]['saveFailed']),
      }
      if (isNameWrite) {
        // 回滚只回滚「没有更新编辑」的那种情况；写回期间用户又敲了字，本地值要留着
        // （否则失败一次就把用户刚敲的内容整段吞掉）。
        if (state.nameSeq === previous.nameSeq) refused.names = previous.savedNames
      } else {
        busyCount = 0
        refused.busy = false
      }
      publish(refused)
      await refreshSettings()
      return response
    }

    /** v1 的 hidden 只认裸模型 id：只镜像通配键（不含分隔符的那些）。 */
    function legacyMirror(keys) {
      const out = []
      for (const key of keys) {
        if (typeof key !== 'string' || key === '') continue
        if (key.indexOf(SEP) >= 0) continue
        out.push(key)
      }
      return out
    }

    // ── 自定义名称：本地立即生效 + 防抖落盘 ─────────────────────────────────
    /**
     * 本地先改（乐观），再按防抖写回。
     *
     * 为什么不在 onChange 里直接写：一次写会把整份 volatile 表单写回 profile 的
     * cordis.patch.yml，敲一个字写一次太重；而且每次写都会让 loader 广播
     * llm/adapters-updated（模型目录重载），连打会把界面拖住。
     *
     * @param {string} key - 偏好键。
     * @param {string|null} value - 新名称；null = 删掉这条（恢复默认名）。
     */
    function queueName(key, value) {
      const next = Object.assign({}, state.names)
      if (value === null) delete next[key]
      else next[key] = value
      publish({ names: next, nameSeq: state.nameSeq + 1, saveError: null })
      if (nameTimer !== undefined) clearTimeout(nameTimer)
      nameTimer = setTimeout(() => { nameTimer = undefined; void flushNames() }, NAME_DEBOUNCE_MS)
    }

    /**
     * 把当前名称表写回 settings（串行化：两次写撞 revision 会被判 conflict）。
     *
     * 循环写在**同一条链**里：写回期间用户又敲了字，就接着把最新那一版送上去，
     * 直到本地没有未落盘的编辑为止。刻意不在 writeNames 里 await 自己这条链 ——
     * 那会等一个「必须等本次返回才可能完成」的 promise，直接死锁。
     */
    function flushNames() {
      if (nameTimer !== undefined) {
        clearTimeout(nameTimer)
        nameTimer = undefined
      }
      const run = async () => {
        let first = true
        for (;;) {
          // 补跑的轮次里如果已经收敛，就不必再写一遍。
          if (!first && state.nameSeq === state.nameSavedSeq) return
          first = false
          const seq = state.nameSeq
          const response = await writeNames()
          if (response === undefined || response.ok !== true) return
          // 写回期间没有新编辑 → 收敛，收工。
          if (state.nameSeq === seq) return
        }
      }
      nameChain = nameChain.then(run, run)
      return nameChain
    }

    /**
     * 写回「此刻最新」的名称表，并把结果交给调用方。
     *
     * 记账（names / savedNames / nameSavedSeq）由 writePrefs 按「本地是否还有更新的
     * 编辑」统一处理，这里只负责发起这一写。
     *
     * @returns {Promise<object|undefined>} mutate 的应答（没写则是 undefined）
     */
    async function writeNames() {
      const ctx = pluginCtx
      if (ctx === undefined || state.settingsPhase !== 'ready' || state.ns === null) return undefined
      return await writePrefs({ names: Object.assign({}, state.names) })
    }

    /**
     * 勾选框：勾上 → 用系统默认名打底（马上就能改）；取消 → 删掉这条，回到默认名。
     *
     * @param {string} key - 偏好键（面板一律写**精确键**；通配键只在读取时兜底）。
     * @param {boolean} checked - 勾选后的状态。
     * @param {string} fallback - 系统默认名（打底用）。
     */
    function toggleName(key, checked, fallback) {
      queueName(key, checked ? String(fallback === undefined || fallback === null ? '' : fallback) : null)
      return flushNames()
    }

    /** 失焦/回车：把「清空了」的名字当没设置（删掉这条，勾选框自己弹回去）。 */
    function commitName(key) {
      const current = state.names[key]
      if (typeof current === 'string' && current.trim() === '') queueName(key, null)
      return flushNames()
    }

    /** 「恢复默认」按钮：删掉这条自定义名称（需求里的重置）。 */
    function resetName(key) {
      queueName(key, null)
      return flushNames()
    }

    // ── 组件 ────────────────────────────────────────────────────────────────
    /** 订阅单例状态；顺带补一次读取（页面可能比插件挂载晚）。 */
    function useStore() {
      const [snap, setSnap] = React.useState(state)
      React.useEffect(() => {
        setSnap(state)
        const unsubscribe = subscribe(() => setSnap(state))
        void load()
        return unsubscribe
      }, [])
      return snap
    }

    /**
     * 一行模型。左边是名称（生效名）/id/描述；右边是**同一个容器里的**一组控件，
     * 顺序就是阅读顺序 —— 模型启用开关 → 自定义名称勾选框 → 名称输入框。
     *
     * 输入框的两种形态：
     *   · 未勾选（custom=false）→ 禁用，里面显示**系统默认名**，灰显；
     *   · 勾选 → 可编辑，值是用户填的名字（可能是空串，此时靠 placeholder 提示默认名）。
     */
    function Row(props) {
      const model = props.model
      const t = props.t
      const action = fmt(model.enabled ? t('action.disable') : t('action.enable'), { name: model.name })
      const customTitle = fmt(t('custom.title'), { name: model.name })
      const resetTitle = fmt(t('custom.resetTitle'), { name: model.name })
      const custom = model.custom === true
      // 未自定义时输入框里就是默认名（禁用状态也要显示它，这是需求明确要求的）。
      const shown = custom ? String(model.customName === null || model.customName === undefined ? '' : model.customName) : model.name
      const key = pkey(model.provider, model.id)
      return h('li', { className: model.enabled ? 'ofmm_row' : 'ofmm_row is-off' },
        h('div', { className: 'ofmm_main' },
          h('div', { className: 'ofmm_line' },
            h('span', { className: 'ofmm_name', title: model.displayName }, model.displayName),
            custom ? h('span', { className: 'ofmm_tag', title: model.customShared === true ? t('custom.sharedTitle') : customTitle },
              t('custom.mark'),
              model.customShared === true ? h('i', { className: 'ofmm_tagSub' }, t('custom.shared')) : null) : null,
            h('span', { className: 'ofmm_badge ' + model.status }, t('status.' + model.status))),
          h('code', { className: 'ofmm_id', title: model.id }, model.id),
          model.description !== '' ? h('p', { className: 'ofmm_desc' }, model.description) : null),
        h('div', { className: 'ofmm_act' },
          h(Switch, {
            checked: model.enabled,
            disabled: props.busy,
            label: action,
            title: action,
            onChange: next => props.onToggle(key, next),
          }),
          props.namesReady === true
            ? h('div', { className: 'ofmm_nameBox' },
              h(Checkbox, {
                checked: custom,
                disabled: props.busy,
                label: t('custom.toggle'),
                title: customTitle,
                onChange: next => { props.onNameToggle(key, next, model.name) },
              }),
              h('input', {
                className: 'ofmm_nameInput',
                type: 'text',
                value: shown,
                // 写回期间不禁用输入框（否则打字打到一半会被抢走焦点）；只有
                // settings 读不到（blocked）或没勾选时才禁用。
                disabled: !custom || props.blocked,
                maxLength: NAME_MAX,
                placeholder: fmt(t('custom.placeholder'), { name: model.name }),
                'aria-label': customTitle,
                title: customTitle,
                onChange: event => { props.onName(key, event.target.value) },
                onBlur: () => { props.onNameBlur(key) },
                onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur() },
              }),
              custom
                ? h('button', {
                  type: 'button',
                  className: 'ofmm_btn ofmm_nameReset',
                  disabled: props.busy,
                  title: resetTitle,
                  onClick: () => { props.onNameReset(key) },
                }, t('custom.reset'))
                : null)
            : null))
    }

    function Chip(props) {
      return h('button', {
        type: 'button',
        className: 'ofmm_chip',
        'aria-pressed': props.active,
        onClick: props.onClick,
      }, props.label, props.count === undefined ? null : h('b', null, String(props.count)))
    }

    /**
     * provider 分组：组头一行（折叠箭头 + 名称 + 计数 + 组级开关），下面挂行。
     *
     * 组级开关是最安全的批量操作 —— 用户的心智单位就是「这家供应商的模型」。
     */
    function Group(props) {
      const group = props.group
      const t = props.t
      const collapsed = props.collapsed === true
      const withinIds = group.rows.map(row => pkey(row.provider, row.id))
      const allOff = group.enabled === 0 && group.rows.length > 0
      const groupAction = fmt(t(allOff ? 'group.enable' : 'group.disable'), { provider: group.label })
      return h('section', { className: 'ofmm_group' },
        h('div', { className: 'ofmm_groupHead' },
          h('button', {
            type: 'button',
            className: 'ofmm_groupToggle',
            'aria-expanded': collapsed ? 'false' : 'true',
            title: fmt(t(collapsed ? 'group.expand' : 'group.collapse'), { provider: group.label }),
            onClick: () => props.onCollapse(group.id),
          },
            h('span', { className: 'ofmm_caret' }, collapsed ? '\u25B8' : '\u25BE'),
            h('span', { className: 'ofmm_groupName', title: group.id }, group.label),
            group.region ? h('span', { className: 'ofmm_badge region' }, t('status.region')) : null),
          h('span', { className: 'ofmm_groupCount' }, String(group.enabled) + '/' + String(group.rows.length)),
          h('div', { className: 'ofmm_groupAct' },
            h('button', {
              type: 'button',
              className: 'ofmm_btn',
              disabled: props.busy,
              title: groupAction,
              onClick: () => props.onGroupToggle(withinIds, allOff),
            }, allOff ? t('group.enableShort') : t('group.disableShort')))),
        collapsed ? null : h('ul', { className: 'ofmm_list' }, group.rows.map(row => h(Row, {
          key: pkey(row.provider, row.id),
          model: row,
          t,
          busy: props.busy,
          blocked: props.blocked,
          namesReady: props.namesReady,
          onToggle: props.onToggle,
          onNameToggle: props.onNameToggle,
          onName: props.onName,
          onNameBlur: props.onNameBlur,
          onNameReset: props.onNameReset,
        }))))
    }

    /**
     * 管理与选择面板 —— 渲染在「设置 → 模型」页底部（settings.models.footer 席位）。
     *
     * 三层控件各管一段（搜索管精确、chips 管状态、下拉管 provider），下面才是列表。
     * 列表按 provider 分组、可折叠；渲染条数有上限，避免几百条时拖住设置页。
     */
    function Panel(props) {
      const t = props.t
      const snap = useStore()
      const [query, setQuery] = React.useState('')
      const [filter, setFilter] = React.useState('all')
      const [provider, setProvider] = React.useState('')
      const [collapsed, setCollapsed] = React.useState({})
      const [limit, setLimit] = React.useState(PAGE_SIZE)

      const derived = React.useMemo(
        () => derive(snap.roster, snap.hidden, snap.names),
        [snap.roster, snap.hidden, snap.names],
      )
      const visible = React.useMemo(
        () => derived.models.filter(model => matchModel(model, query, filter, provider)),
        [derived.models, query, filter, provider],
      )
      // 渲染上限只作用在**已经筛选过**的结果上：先筛后截，用户看到的顺序才稳定。
      const shown = React.useMemo(() => visible.slice(0, limit), [visible, limit])
      const groups = React.useMemo(
        () => groupRows(shown, snap.roster === null ? [] : snap.roster.routes),
        [shown, snap.roster],
      )
      // 每次筛选条件变化都把「显示更多」收回原位，否则换一组筛选会莫名多出一堆行。
      React.useEffect(() => { setLimit(PAGE_SIZE) }, [query, filter, provider])

      const routeRows = snap.roster !== null && typeof snap.roster === 'object' && Array.isArray(snap.roster.routes) ? snap.roster.routes : []
      const stale = React.useMemo(
        () => (snap.roster !== null && Array.isArray(snap.roster.disabledStale) ? snap.roster.disabledStale : [])
          .filter(key => snap.hidden.indexOf(key) >= 0),
        [snap.roster, snap.hidden],
      )
      // 自定义名称**不自动清理**：模型暂时不在清单里（插件升级、上游下线、provider
      // 还没列出模型）也要保留用户填的名字，只在面板上点名。
      const namesStale = React.useMemo(
        () => Object.keys(snap.names).filter(key => derived.models.every(model => pkey(model.provider, model.id) !== key && model.id !== key)),
        [snap.names, derived.models],
      )

      /** 宿主半端加载到带 names 的这一版之前，不显示自定义名称这组控件。 */
      const namesReady = snap.namesReady === true
      /** 宿主半端还是 v1：任何偏好都写不进去，整体锁住并解释。 */
      const hostReady = snap.hostReady === true
      const busy = snap.busy === true || snap.settingsPhase !== 'ready' || !hostReady
      /** settings 读不到 / 宿主是旧版时，输入框与组级开关也要禁用（此时点了也存不下去）。 */
      const blocked = snap.settingsPhase !== 'ready' || !hostReady
      /** 当前视图（筛选后）的全部偏好键 —— 批量操作只作用在它上面。 */
      const visibleKeys = React.useMemo(
        () => visible.map(model => pkey(model.provider, model.id)),
        [visible],
      )

      const chips = [
        { key: 'all', count: derived.counts.total },
        { key: 'available', count: derived.counts.available },
        { key: 'region', count: derived.counts.region },
        { key: 'disabled', count: derived.counts.disabled },
      ].map(item => Object.assign(item, { label: t('filter' + item.key.charAt(0).toUpperCase() + item.key.slice(1)) }))

      const failed = snap.settingsPhase === 'error' || snap.rosterPhase === 'error'
      const loading = !failed && (snap.rosterPhase === 'loading' || snap.rosterPhase === 'idle')
      const missing = snap.settingsPhase === 'missing'
      const filtering = query.trim() !== '' || filter !== 'all' || provider !== ''
      const allDisabled = derived.counts.total > 0 && derived.counts.enabled === 0

      const onToggle = (key, next) => { void setHidden([key], !next) }
      const onGroupToggle = (ids, allOff) => {
        // 组级开关：把这一组**当前可见**的模型一起改。allOff 时是「全部启用」，
        // 否则是「全部停用」—— 与按钮上写的文案一致。
        void setHidden(ids, !allOff)
      }
      const onCollapse = id => {
        setCollapsed(previous => {
          const next = Object.assign({}, previous)
          if (next[id] === true) delete next[id]
          else next[id] = true
          return next
        })
      }
      const clearFilters = () => { setQuery(''); setFilter('all'); setProvider('') }

      var body
      if (failed) {
        body = h('div', { className: 'ofmm_state ofmm_err' },
          h('span', null, fmt(t('error'), { message: snap.error === null ? '' : snap.error })),
          h('button', { type: 'button', className: 'ofmm_btn', onClick: () => { void load() } }, t('retry')))
      } else if (loading) {
        body = h('div', { className: 'ofmm_state' }, h('span', null, t('loading')))
      } else if (derived.models.length === 0) {
        // 三分类空态之一：一条模型都没有可管（provider 全被关掉 / 都还没列出模型）。
        body = h('div', { className: 'ofmm_state' },
          h('span', null, t('none')),
          h('button', { type: 'button', className: 'ofmm_btn', onClick: () => { void load(true) } }, t('reload')))
      } else {
        body = h(React.Fragment, null,
          h('div', { className: 'ofmm_bar' },
            h('input', {
              className: 'ofmm_search',
              type: 'search',
              value: query,
              placeholder: t('search'),
              'aria-label': t('search'),
              onChange: event => setQuery(event.target.value),
            }),
            h('select', {
              className: 'ofmm_select',
              value: provider,
              'aria-label': t('providerAll'),
              title: t('providerAll'),
              disabled: routeRows.length < 2,
              onChange: event => setProvider(event.target.value),
            },
              h('option', { value: '' }, t('providerAll')),
              routeRows.map(route => h('option', { key: route.id, value: route.id },
                String(route.label) + ' (' + String(route.count) + ')'))),
            h('div', { className: 'ofmm_chips' },
              chips.map(chip => h(Chip, {
                key: chip.key,
                label: chip.label,
                count: chip.count,
                active: filter === chip.key,
                onClick: () => setFilter(chip.key),
              }))))
          ,
          h('div', { className: 'ofmm_bar' },
            h('span', { className: 'ofmm_sum' },
              h('span', null, fmt(t('count'), {
                total: derived.counts.total,
                routes: routeRows.length,
                enabled: derived.counts.enabled,
                disabled: derived.counts.disabled,
              })),
              derived.counts.region > 0 ? h('span', null, ' · ' + fmt(t('regionHint'), { n: derived.counts.region })) : null,
              snap.roster !== null && snap.roster.generatedAt
                ? h('span', null, ' · ' + fmt(t('updated'), { time: new Date(snap.roster.generatedAt).toLocaleTimeString() }))
                : null,
              snap.roster !== null && typeof snap.roster.cached === 'number' && snap.roster.cached > 0
                ? h('span', null, ' ' + fmt(t('cached'), { n: snap.roster.cached }))
                : null),
            h('div', { className: 'ofmm_bulk' },
              h('button', {
                type: 'button', className: 'ofmm_btn', disabled: busy || visibleKeys.length === 0,
                title: t('bulkScope'),
                onClick: () => { void setHidden(visibleKeys, false) },
              }, fmt(t('bulkEnable'), { n: visibleKeys.length })),
              h('button', {
                type: 'button', className: 'ofmm_btn', disabled: busy || visibleKeys.length === 0,
                title: t('bulkScope'),
                onClick: () => { void setHidden(visibleKeys, true) },
              }, fmt(t('bulkDisable'), { n: visibleKeys.length })))),
          h('p', { className: 'ofmm_scope' }, t('bulkScope')),
          missing ? h('div', { className: 'ofmm_state ofmm_err' }, h('span', null, t('nsMissing'))) : null,
          !missing && !hostReady ? h('div', { className: 'ofmm_state ofmm_err' }, h('span', null, t('hostStale'))) : null,
          !missing && hostReady && !namesReady ? h('div', { className: 'ofmm_note' }, h('span', null, t('custom.hostStale'))) : null,
          snap.saveError !== null && !failed
            ? h('div', { className: 'ofmm_state ofmm_err' }, h('span', null, snap.saveError))
            : null,
          allDisabled
            ? h('div', { className: 'ofmm_note' },
              h('span', null, t('emptyAllDisabled')),
              h('button', {
                type: 'button', className: 'ofmm_btn', disabled: busy,
                onClick: () => { void setHidden(derived.models.map(model => pkey(model.provider, model.id)), false) },
              }, t('restoreAll')))
            : null,
          stale.length > 0 ? h('div', { className: 'ofmm_note' },
            h('span', null, fmt(t('staleHint'), { n: stale.length })),
            h('button', { type: 'button', className: 'ofmm_btn', disabled: busy, onClick: () => { void setHidden(stale, false) } }, t('staleClean'))) : null,
          namesStale.length > 0 ? h('div', { className: 'ofmm_note' },
            h('span', null, fmt(t('custom.stale'), { n: namesStale.length }))) : null,
          visible.length === 0
            // 三分类空态之二：筛选后没有结果。
            ? h('div', { className: 'ofmm_state' },
              h('span', null, query.trim() === '' ? t('empty') : fmt(t('emptySearch'), { query: query.trim() })),
              h('button', { type: 'button', className: 'ofmm_btn', onClick: clearFilters }, t('clearFilters')))
            : h('div', { className: 'ofmm_groups' }, groups.map(group => h(Group, {
              key: group.id,
              group,
              t,
              collapsed: collapsed[group.id] === true,
              busy,
              blocked,
              namesReady,
              onCollapse,
              onGroupToggle,
              onToggle,
              onNameToggle: (key, next, fallback) => { void toggleName(key, next, fallback) },
              onName: (key, value) => { queueName(key, value) },
              onNameBlur: key => { void commitName(key) },
              onNameReset: key => { void resetName(key) },
            }))),
          visible.length > shown.length
            ? h('div', { className: 'ofmm_bar' },
              h('button', {
                type: 'button', className: 'ofmm_btn',
                onClick: () => setLimit(previous => previous + PAGE_SIZE),
              }, fmt(t('showMore'), { n: visible.length - shown.length })),
              h('span', { className: 'ofmm_sum' }, fmt(t('shownLimit'), { shown: shown.length, total: visible.length })))
            : null,
          h('p', { className: 'ofmm_hint' }, t('hint')),
          h('div', { className: 'ofmm_bar' },
            h('button', { type: 'button', className: 'ofmm_btn', onClick: () => { void load(true) } }, t('reload'))))
      }

      return h('section', { className: 'ofmm_root ofmm_footer' },
        h('div', { className: 'ofmm_top' },
          h('div', { className: 'ofmm_topTitle' }, t('title')),
          h('div', { className: 'ofmm_topSub' }, t('subtitle'))),
        body)
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 逐条成串（用 join('') 而不是模板字符串）：这份文件因此不含任何反引号/反斜杠，
    // 便于离线测试台用同一份源码做文本断言。
    const CSS = [
      '.ofmm_root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
      '.ofmm_root *{box-sizing:border-box}',
      '.ofmm_footer{margin-top:14px;padding:14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);max-width:1080px}',
      '.ofmm_top{display:flex;flex-direction:column;gap:3px}',
      '.ofmm_topTitle{font-size:14.5px;font-weight:650}',
      '.ofmm_topSub{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ofmm_bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ofmm_search{flex:1 1 200px;min-width:150px;padding:5px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}',
      '.ofmm_search:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.ofmm_select{max-width:230px;padding:5px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}',
      '.ofmm_select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.ofmm_chips{display:flex;gap:5px;flex-wrap:wrap}',
      '.ofmm_chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:11.5px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.ofmm_chip b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}',
      '.ofmm_chip[aria-pressed="true"]{border-color:currentColor;color:var(--dsw-alias-label-primary)}',
      '.ofmm_chip[aria-pressed="true"] b{color:inherit}',
      '.ofmm_bulk{display:flex;gap:6px;margin-left:auto}',
      '.ofmm_btn{font:inherit;font-size:11.5px;padding:3px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.ofmm_btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.ofmm_btn:disabled{opacity:.5;cursor:default}',
      '.ofmm_sum{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
      '.ofmm_scope{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}',
      '.ofmm_groups{display:flex;flex-direction:column;gap:10px}',
      '.ofmm_group{border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.ofmm_groupHead{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--dsw-alias-bg-layer-3)}',
      '.ofmm_groupToggle{display:inline-flex;align-items:center;gap:7px;flex:1;min-width:0;font:inherit;font-size:12.5px;font-weight:600;color:inherit;background:none;border:0;padding:2px 0;cursor:pointer;text-align:left}',
      '.ofmm_caret{width:10px;flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.ofmm_groupName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ofmm_groupCount{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);flex:none}',
      '.ofmm_groupAct{display:flex;gap:6px;flex:none}',
      '.ofmm_list{list-style:none;margin:0;padding:6px;display:flex;flex-direction:column;gap:6px;max-height:44vh;overflow-y:auto}',
      '.ofmm_row{display:flex;align-items:center;gap:12px;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3)}',
      '.ofmm_row.is-off{opacity:.62;background:var(--dsw-alias-bg-layer-1)}',
      '.ofmm_main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}',
      '.ofmm_line{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ofmm_name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ofmm_id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ofmm_desc{margin:0;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.ofmm_badge{font-size:10.5px;padding:2px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.ofmm_badge.available{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.ofmm_badge.region{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}',
      '.ofmm_badge.disabled{color:var(--dsw-alias-label-tertiary)}',
      '.ofmm_act{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}',
      '.ofmm_nameBox{display:flex;align-items:center;gap:6px}',
      // 宽度按常见模型名长度（14~20 字符）定：够放下 MiMo V2.6 Flash，又不至于把
      // 一整行的权重抢过去；窄面板里可以缩到 120px。
      '.ofmm_nameInput{width:160px;min-width:120px;max-width:240px;padding:4px 9px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.ofmm_nameInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      // 禁用态必须一眼看出来是「灰的、不能改」（需求原话）
      '.ofmm_nameInput:disabled{color:var(--dsw-alias-label-tertiary);opacity:.55;cursor:not-allowed}',
      '.ofmm_nameReset{padding:3px 8px}',
      '.ofmm_tag{display:inline-flex;align-items:center;gap:5px;font-size:10px;padding:2px 6px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ofmm_tagSub{font-style:normal;opacity:.8}',
      '.ofmm_note{font-size:11.5px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ofmm_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin:0}',
      '.ofmm_state{padding:14px;border-radius:11px;border:1px dashed var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ofmm_err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
    ].join('')

    // ── 挂载 ────────────────────────────────────────────────────────────────
    /** 需要 cordis 服务：插槽注册表 + 本地化 + 远程 settings / llm 事件。 */
    const inject = ['slots', 'locale', 'remote', 'remote.settings']

    /**
     * 取翻译函数。
     *
     * 首选 DSH 自己的 locale 服务（字典注册进它，slot 渲染的文案随语言切换实时更新）；
     * 拿不到就退回到本文件里的字典按 html lang 猜一次 —— 界面不会因此变空白。
     */
    function makeT(ctx) {
      const locale = ctx.locale
      if (locale !== undefined && locale !== null && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(() => {
          try {
            return locale.register(NS, { zh: DICT.zh, en: DICT.en })
          } catch (error) {
            console.warn(SOURCE + ': locale.register failed', error)
            return undefined
          }
        }, 'ofm-model-manager: dictionaries')
        try {
          return locale.bind(NS)
        } catch (error) {
          console.warn(SOURCE + ': locale.bind failed', error)
        }
      }
      return key => {
        const table = DICT[guessLocale()] || DICT.zh
        return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key
      }
    }

    function apply(ctx) {
      pluginCtx = ctx
      const t = makeT(ctx)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', SOURCE)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'ofm-model-manager: styles')

      // 唯一落点：「设置 → 模型」页底部的面板（提供商行与「添加提供商」之后）。
      // 这是 list 席位，多个注册方按 id 共存，不会顶掉别人。
      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
        name: 'settings.models.footer',
        id: FOOTER_ID,
        order: 20,
        label: () => t('nav'),
      }, props => h(Panel, Object.assign({}, props, { t }))))

      // 宿主广播「模型拓扑变了」（本插件拨开关、或别的插件改了目录）→ 两边都重读。
      ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { void load() }), 'ofm-model-manager: catalog invalidations')

      // 别处改了同一份 settings（另一个标签页、手改 cordis.patch.yml）→ 收敛。
      //
      // 本插件自己写盘后宿主也会广播同一个 revision —— 那是**自己写的回声**，
      // 状态早就更新过了，再拉一次 describe 只会白跑一趟（还可能在打字期间插进
      // 一次重画）。用 lastWrittenRevision 认出来直接跳过；revision 对不上说明
      // 是别处的改动，照旧收敛。
      ctx.effect(() => ctx.remote.$on('settings/document-updated', (ns, revision) => {
        if (state.ns !== null && typeof ns === 'string' && ns !== state.ns) return
        if (revision !== undefined && revision === lastWrittenRevision) return
        void refreshSettings()
      }), 'ofm-model-manager: settings invalidations')

      void load()

      // 模块卸载（含 HMR 换版）时，把还挂着的防抖写盘处理掉。
      //
      // 防抖定时器是模块级单例，HMR 会用**新的**模块实例替换旧的：旧实例的定时器
      // 若不管，到点会拿旧实例的 state 去写盘（把用户刚敲的内容按旧快照写回去）。
      // 这里不 clearTimeout 就丢掉，而是**立刻落盘一次**：用户敲的字不能因为一次
      // 热重载就丢；落完再清干净，新实例接手。
      ctx.effect(() => () => {
        if (nameTimer !== undefined) {
          clearTimeout(nameTimer)
          nameTimer = undefined
          // 卸载途中不该因为一次写盘失败把异常抛到没人接的地方。
          Promise.resolve(flushNames()).catch(error => { console.error(SOURCE + ': pending name write failed', error) })
        }
      }, 'ofm-model-manager: pending name write')
    }

    exports.apply = apply
    exports.inject = inject
    // 离线测试台的接缝：不启动 DSH 也能直接咬这些纯函数。
    exports.DICT = DICT
    exports.fmt = fmt
    exports.pkey = pkey
    exports.derive = derive
    exports.groupRows = groupRows
    exports.matchModel = matchModel
    exports.normalizeKeys = normalizeKeys
    exports.normalizeNames = normalizeNames
    exports.customNameOf = customNameOf
    exports.customIsShared = customIsShared
    exports.effectiveNameOf = effectiveNameOf
    exports.legacyMirror = legacyMirror
    exports.hostApiVersion = hostApiVersion
    exports.CSS = CSS
    exports.Panel = Panel
    exports.Row = Row
    exports.Group = Group
    exports.namespaceId = namespaceId
    exports.apiBase = apiBase
    exports.setHidden = setHidden
    exports.writePrefs = writePrefs
    exports.load = load
    exports.NAME_MAX = NAME_MAX
    exports.NAME_DEBOUNCE_MS = NAME_DEBOUNCE_MS
    exports.PAGE_SIZE = PAGE_SIZE
    exports.SEP = SEP
    exports.queueName = queueName
    exports.flushNames = flushNames
    exports.toggleName = toggleName
    exports.commitName = commitName
    exports.resetName = resetName
    exports.snapshot = () => state
    exports.publish = publish
    exports.subscribe = subscribe
    // 页面级单例状态的复位接缝：真机上是「插件重新挂载」，离线验证台用来隔离用例。
    exports.__reset = () => {
      // 防抖定时器要真的清掉，不能只把变量置空：置空只是「忘了它」，它到点照样
      // 触发一次 flushNames()，把上一个挂载点的名称表写进下一个挂载点（离线验证台
      // 会看到用例之间互相污染；真机上热重载后也会冒一次莫名其妙的写盘）。
      if (nameTimer !== undefined) clearTimeout(nameTimer)
      state = initialState()
      nameTimer = undefined
      nameChain = Promise.resolve()
      loadInFlight = null
      loadQueued = false
      loadQueuedForce = false
      busyCount = 0
      lastWrittenRevision = undefined
    }








    return module.exports
  },
})
