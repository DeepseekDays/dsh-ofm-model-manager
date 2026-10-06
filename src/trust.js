/**
 * dsh-ofm-model-manager / src/trust.js
 * ============================================================================
 * 插件 HTTP 面的请求信任闸门。
 *
 * 本插件注册的是 /api/ofm-model-manager 前缀，比内核的 /api 更长，而 webServer
 * 是"最长前缀优先" —— 也就是说这条路由跑在 connection 服务自己的准入检查**之前**，
 * 不设闸门的话，任何能连到回环地址的调用方都能读到模型清单。这个模块把口子堵上。
 *
 * 两层，按顺序试：
 *   1. 组合里真的挂了 connection 服务时，用**它自己的准入判断**
 *      （内核给 /api 用的就是这一个），保证本插件不比应用本身更弱；
 *   2. 没有该服务时，用一份结构等价的复刻闸门：只认回环 Host、拒绝跨站 fetch、
 *      客户端给了 Origin/Referer 就要求它与 Host 同源。
 *
 * 与 dsh-our-free-model 的 src/trust.js 是同一套口径（同一份内核不变式），
 * 这里独立实现一份，避免跨插件 import。
 *
 * @module src/trust.js
 */

/** 同机调用方可以合法使用的回环主机名。 */
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

/**
 * 判断一个请求。返回要拒绝的 HTTP 状态码，或 undefined 表示放行。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {object|undefined} connection - 组合挂载了 connection 服务时传它
 * @returns {number|undefined}
 */
export function rejectionFor(req, connection) {
  if (connection && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req)
      if (admission && typeof admission === 'object' && 'rejection' in admission) return admission.rejection
      return undefined
    } catch {
      // connection 服务抛异常属于组合 bug：落到结构闸门，而不是对每个请求回 500。
    }
  }
  return structuralRejection(req)
}

/** 复刻闸门：DNS rebinding 防御（Host 必须是回环）+ 跨站 fetch 拒绝 + Origin/Referer 同源。 */
export function structuralRejection(req) {
  const host = authorityOf(req?.headers?.host, 'http')
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 403
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 403
  for (const header of ['origin', 'referer']) {
    const raw = req?.headers?.[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const authority = authorityOf(raw.trim())
    if (authority === null) return 403
    // web 服务在回环上说的是明文 http：声明 https（或别的协议）的 Origin 不是这个页面。
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) return 403
  }
  return undefined
}

/** 把 Host/Origin/Referer 拆成 {scheme, hostname, port}，端口缺省补上。 */
function authorityOf(value, defaultScheme) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `${defaultScheme ?? 'http'}://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}
