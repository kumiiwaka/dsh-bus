/**
 * dsh-bus-panel · 宿主半（Cordis 插件）
 *
 * 只做两件事：
 *   1. 把 groups.js 的数据层挂到 DSH 的 webServer 上：/bus-panel/api/*
 *   2. 给浏览器半一个同源、只读 + 追加的接口；不碰 DSH 核心，不监听额外端口
 *
 * 路由：
 *   GET  /bus-panel/api/groups
 *   GET  /bus-panel/api/messages?group=&limit=50
 *   POST /bus-panel/api/messages   { group, text }           广播（零推送）
 *   POST /bus-panel/api/mention    { group, text, to: [...] } 点名（写 inbox，会叫醒窗口）
 *   POST /bus-panel/api/seen       { group, count }   （未读游标，辅路）
 *
 * 写请求必须带 x-bus-panel-request: 1；再加 Host/Origin 同源检查，挡住跨站 CSRF。
 */

import {
  BusPanelError,
  ROOT,
  appendBroadcast,
  appendMention,
  getGroupView,
  limits,
  createGroup,
  dissolveGroup,
  listGroups,
  listWindows,
  markGroupSeen,
  readPanelState,
  setLastGroup
} from './groups.js'

export const name = 'dsh-bus-panel'
export const inject = ['webServer']

const ROUTE = '/bus-panel'
const MAX_BODY_BYTES = 256 * 1024

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new BusPanelError(413, `请求体超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function parseBody(req) {
  const raw = await readBody(req)
  if (raw.trim() === '') return {}
  const type = textOf(req.headers['content-type']).toLowerCase()
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw))
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new BusPanelError(400, '请求体不是合法 JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BusPanelError(400, '请求体必须是 JSON 对象')
  }
  return value
}

/** 同源检查：Host 必须是本机这个端口；有 Origin 时必须跟 Host 完全对上。 */
function sameOrigin(req, port) {
  const host = textOf(req.headers.host).toLowerCase()
  if (host === '') return true
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  const origin = textOf(req.headers.origin).toLowerCase()
  if (origin === '') return true
  return origin === `http://${host}` || origin === `https://${host}`
}

function requireWriteHeader(req) {
  if (req.headers['x-bus-panel-request'] !== '1') {
    throw new BusPanelError(403, '写请求缺少 x-bus-panel-request: 1 头')
  }
}

function parseLimit(raw) {
  const requested = Number(raw ?? limits.DEFAULT_LIMIT)
  return Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1), limits.MAX_LIMIT)
    : limits.DEFAULT_LIMIT
}

async function dispatch(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith(`${ROUTE}/`)) {
    return sendJson(res, 404, { ok: false, error: '没有这个接口' })
  }
  if (!sameOrigin(req, ctx.webServer.port)) {
    return sendJson(res, 403, { ok: false, error: '只接受同源的本机请求' })
  }

  const path = url.pathname.slice(ROUTE.length)
  const method = textOf(req.method).toUpperCase() || 'GET'

  try {
    if (path === '/api/groups' && method === 'GET') {
      const groups = await listGroups()
      const state = await readPanelState()
      return sendJson(res, 200, {
        ok: true,
        root: ROOT,
        count: groups.length,
        groups,
        lastGroup: state.lastGroup ?? null
      })
    }

    if (path === '/api/windows' && method === 'GET') {
      return sendJson(res, 200, { ok: true, windows: await listWindows() })
    }

    if (path === '/api/create' && method === 'POST') {
      requireWriteHeader(req)
      const body = await parseBody(req)
      const created = await createGroup(body.name, body.members, body.note)
      ctx.logger?.info?.(`[bus-panel] 新建群「${created.name}」（建群者 ${created.creator}）`)
      return sendJson(res, 200, { ok: true, group: created })
    }

    if (path === '/api/dissolve' && method === 'POST') {
      requireWriteHeader(req)
      const body = await parseBody(req)
      const done = await dissolveGroup(body.group)
      ctx.logger?.info?.(`[bus-panel] 解散群「${done.from}」→ ${done.id}`)
      return sendJson(res, 200, { ok: true, id: done.id, from: done.from })
    }

    if (path === '/api/messages' && method === 'GET') {
      const view = await getGroupView(url.searchParams.get('group'))
      const limit = parseLimit(url.searchParams.get('limit'))
      return sendJson(res, 200, {
        ok: true,
        group: view.group,
        total: view.messages.length,
        limit,
        messages: view.messages.slice(0, limit)
      })
    }

    if (path === '/api/messages' && method === 'POST') {
      requireWriteHeader(req)
      const body = await parseBody(req)
      const result = await appendBroadcast(body.group, body.text)
      ctx.logger?.info?.(`[bus-panel] 面板广播 → 群「${result.group.name}」`)
      return sendJson(res, 200, {
        ok: true,
        kind: 'broadcast',
        message: result.message,
        file: result.file
      })
    }

    if (path === '/api/mention' && method === 'POST') {
      requireWriteHeader(req)
      const body = await parseBody(req)
      const result = await appendMention(body.group, body.text, body.to)
      ctx.logger?.info?.(
        `[bus-panel] 点名 · 群「${result.group.name}」· 建群者 ${result.as} → ${result.to.join('、')}`
      )
      return sendJson(res, 200, {
        ok: true,
        kind: 'mention',
        message: result.message,
        file: result.file,
        as: result.as,
        to: result.to,
        delivered: result.delivered,
        deliveredCount: result.deliveredCount,
        files: result.files
      })
    }

    if (path === '/api/seen' && method === 'POST') {
      requireWriteHeader(req)
      const body = await parseBody(req)
      if (!Number.isFinite(Number(body.count)) || Number(body.count) < 0) {
        throw new BusPanelError(400, 'count 必须是非负数字')
      }
      const saved = await markGroupSeen(body.group, body.count)
      const view = await getGroupView(saved.id)
      return sendJson(res, 200, {
        ok: true,
        group: saved.id,
        seenCount: view.group.seenCount,
        unread: view.group.unread
      })
    }

    if (path === '/api/active' && method === 'POST') {
      requireWriteHeader(req)
      const body = await parseBody(req)
      const saved = await setLastGroup(body.group)
      return sendJson(res, 200, { ok: true, lastGroup: saved.id })
    }

    if (path === '/api/groups' || path === '/api/messages' || path === '/api/mention' || path === '/api/seen' || path === '/api/active' || path === '/api/windows' || path === '/api/create' || path === '/api/dissolve') {
      return sendJson(res, 405, { ok: false, error: `不支持 ${method} ${path}` })
    }
    return sendJson(res, 404, { ok: false, error: '没有这个接口' })
  } catch (error) {
    const status = error instanceof BusPanelError ? error.status : 500
    if (status >= 500) {
      ctx.logger?.warn?.(`[bus-panel] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, status, {
      ok: false,
      error: status >= 500 ? '宿主内部错误，见 DSH 日志' : (error instanceof Error ? error.message : String(error))
    })
  }
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        dispatch(ctx, req, res).catch((error) => {
          ctx.logger?.warn?.(`[bus-panel] 路由未捕获错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: '宿主内部错误' })
          else res.destroy()
        })
      }
    }),
    'bus-panel: /bus-panel routes'
  )
}
