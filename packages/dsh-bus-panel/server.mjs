#!/usr/bin/env node
/**
 * dsh-bus-panel · 本地群聊面板服务（零依赖，只用 node: 内置模块）
 *
 * 读的是 dsh-window-bus 插件的真身数据：
 *   <root>/groups/<群名>/meta.json
 *   <root>/groups/<群名>/messages/<id>.json
 *   <root>/groups/<群名>.archived-YYYYMMDD-HHmm/    解散后的归档，只读
 *
 * 接口（自己定的，够用就行）：
 *   GET  /api/groups                     群列表（活跃 + 归档），带 meta / 消息数 / 最后活跃时间 / 点名可用性
 *   GET  /api/messages?group=&limit=50   某群消息（新→旧）
 *   POST /api/messages  {group, text}          以「用户」身份往群里广播一条
 *   POST /api/messages  {group, text, to:[…]}  以建群者身份点名（照插件 bus_group_post 的落盘格式）
 *   GET  /                               单页 UI
 *
 * 点名为什么要用建群者身份：插件扫描器投递前会过 isTrustedSender —— from 必须是
 * windows.json 里已注册且 active 的名字、from_session 必须等于档案里的 session_id，
 * 否则 inbox 文件会被「留在原地等它注册」直到过期进 failed/。「用户」不是注册窗口，
 * 以它名义写的 inbox 文件一条都投不出去，所以点名只能以群 meta 里那个可信的建群者身份写，
 * 并且在写之前先按同样的三道关核一遍（见 creatorIdentity）。
 *
 * 安全：
 *   - 只监听 127.0.0.1
 *   - 群名白名单正则（中文/字母/数字/-/_，归档目录额外允许 .archived-<时间戳>），
 *     且必须来自 groups/ 下实际枚举到的目录，不接受任意拼接
 *   - 所有落盘路径 path.resolve 后必须仍在 groups/ 内
 *   - 写操作只允许活跃群；归档群 409
 *   - 本服务没有鉴权，靠 loopback 兜底（见 README「已知局限」）
 */

import { createServer } from 'node:http'
import { readdir, readFile, writeFile, appendFile, rename, unlink, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep, extname, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ── 配置 ────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')

const HOST = '127.0.0.1'
const PORT = Number(process.env.DSH_BUS_PANEL_PORT ?? 8767)

const DEFAULT_ROOT = join(homedir(), '.dsh', 'window-bus')
const ROOT = resolve((process.env.DSH_WINDOW_BUS_DIR ?? '').trim() || DEFAULT_ROOT)
const GROUPS_DIR = join(ROOT, 'groups')

/** 群名就是目录名：只放行中文、字母、数字、- 和 _（跟插件自己的限制取交集）。 */
const GROUP_ID_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,40}$/
/** 归档目录：<群名>.archived-YYYYMMDD-HHmm，撞名时插件会补 -2。 */
const ARCHIVED_ID_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,40}\.archived-\d{8}-\d{4}(?:-\d+)?$/

const MAX_BODY_BYTES = 256 * 1024
const MAX_TEXT_CHARS = 8000 // 跟总线单条 8KB 的闸门对齐
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

const SELF = { from: '用户', session: 'human' }

// ── 点名（mention）用的总线常量：全部照抄 dsh-window-bus/index.js ────────────

/** 窗口身份档案：点名时核发件人 + 查被点名成员的 session_id。只读。 */
const WINDOWS_FILE = join(ROOT, 'windows.json')
/** 投递审计：每次入队追加一行，跟插件 appendMessage 同一个文件、同一种行。 */
const MESSAGES_FILE = join(ROOT, 'messages.jsonl')
/** 信箱根：inbox/<收件人>/<压缩时间戳>-<消息id>.json。 */
const INBOX_DIR = join(ROOT, 'inbox')

const MAX_TEXT_BYTES = 8 * 1024 // 插件 MAX_TEXT_BYTES
const MAX_HOPS = 3 // 插件 MAX_HOPS
const MSG_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 插件 MSG_TTL_MS
const MAX_PER_SENDER_DAY = 100 // 插件 MAX_PER_SENDER_DAY
const MAX_PENDING_PER_RECIPIENT = 200 // 插件 MAX_PENDING_PER_RECIPIENT
/** 人在面板上起的头 = 0 跳（跟 bus_post 的「人直接开的话题 = 0」一致）。 */
const MENTION_HOPS = 0

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function firstLine(text, max) {
  const flat = textOf(text).replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** child 是不是 parent 里面（含自身），统一按 path.resolve 之后的串比。 */
function isInsideDir(parent, child) {
  const p = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(p)
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 跟插件 writeJsonAtomic 一致的落盘格式：2 空格缩进 + 结尾换行，先写 .tmp 再 rename。 */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

// ── 点名：身份 / 配额 / 信封 ────────────────────────────────────────────────

/** ISO → 本地 `YYYY-MM-DD`（配额按本地日子算，跟插件 localDate 一致）。 */
function localDate(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** `2026-11-01T08:56:27.909Z` → `20261101T085627Z`，信箱文件名前缀，跟插件 compactStamp 一模一样。 */
function compactStamp(date) {
  const iso = date.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
}

/** `session-1a2b3c4d-…` → `1a2b3c4d`；request_id 里用短 id 省地方。 */
function shortId(id) {
  const body = id.replace(/^session-?/i, '')
  return body === '' ? id : body.slice(0, 8)
}

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/** 读 windows.json；读不出来就当成空档案，别让整个面板 500。 */
async function readRegistry() {
  const registry = await readJson(WINDOWS_FILE)
  if (registry === null || typeof registry !== 'object') return { windows: {} }
  return registry
}

function windowEntry(registry, name) {
  const entry = registry?.windows?.[name]
  return entry !== null && typeof entry === 'object' ? entry : undefined
}

/** 这个名字现在能不能收投递：注册过、没标 inactive、session_id 不为空。 */
function activeSessionOf(registry, name) {
  const entry = windowEntry(registry, name)
  if (entry === undefined || entry.active === false) return ''
  return textOf(entry.session_id)
}

/** 成员名要当 inbox/ 下的目录名用：跟群名同一套底线，别让 meta 里手改坏的名字拼出路径。 */
const MEMBER_NAME_BAD = /[\\/:*?"<>|\u0000-\u001f]/
function isSafeMemberName(name) {
  return typeof name === 'string'
    && name !== ''
    && name === name.trim()
    && Array.from(name).length <= 60
    && !MEMBER_NAME_BAD.test(name)
    && !/^[.\s]|[.\s]$/.test(name)
}

function memberListOf(meta) {
  const members = Array.isArray(meta?.members) ? meta.members : []
  return members
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim())
}

/**
 * 点名要用哪个身份发：群 meta 里的建群者。
 * 三道关跟插件 isTrustedSender 完全一致，过不了就别写 —— 写了也只会被扫描器
 * 当成不可信发件人留在 inbox/ 里等过期（见文件头注释）。
 */
function creatorIdentity(entry, registry) {
  const meta = entry.meta ?? {}
  const creator = textOf(meta.creator).trim()
  const blocked = (reason) => ({ allowed: false, reason, name: creator, session_id: '' })

  if (entry.archived || meta.archived === true) return blocked('群已解散（归档只读），点名发不出去')
  if (creator === '') return blocked('这个群的 meta 没记建群者，插件不认这样的发件人')
  if (!isSafeMemberName(creator)) return blocked(`建群者名字「${creator}」不合法（像是手改坏的 meta）`)

  const window = windowEntry(registry, creator)
  if (window === undefined) return blocked(`建群者「${creator}」没在总线上注册（windows.json 里没有），插件不认这个发件人`)
  if (window.active === false) return blocked(`建群者「${creator}」是 inactive（退休）状态，要先重新 bus_register 点亮`)

  const sessionId = textOf(window.session_id)
  if (sessionId === '') return blocked(`建群者「${creator}」的档案里没有 session_id，投不出去`)

  const metaSession = textOf(meta.creator_session_id)
  if (metaSession !== '' && metaSession !== sessionId) {
    return blocked(`建群者「${creator}」的会话对不上（meta 里是 ${metaSession}，档案里是 ${sessionId}），会被当成伪造发件人`)
  }

  return { allowed: true, reason: '', name: creator, session_id: sessionId }
}

/** 能点名的人：成员里除了建群者，且名字安全；active 由前端标出来给人看。 */
function mentionCandidates(entry, registry) {
  const creator = textOf(entry.meta?.creator).trim()
  return memberListOf(entry.meta)
    .filter((name) => name !== creator && isSafeMemberName(name))
    .map((name) => ({ name, active: activeSessionOf(registry, name) !== '' }))
}

/** 审计行：跟插件 appendMessage 写进 messages.jsonl 的行同形；写不进去只记日志，别吞掉已经落盘的点名。 */
async function appendAudit(record) {
  try {
    await appendFile(MESSAGES_FILE, JSON.stringify(record) + '\n', 'utf8')
  } catch (error) {
    console.error('[dsh-bus-panel] 写审计失败（消息已经落盘）：', error?.message ?? error)
  }
}

/** 发件人今天已经入队几条（插件 senderCountToday 的口径：审计里 event=enqueued 且 from 对得上）。 */
async function senderCountToday(name) {
  let raw
  try {
    raw = await readFile(MESSAGES_FILE, 'utf8')
  } catch {
    return 0
  }
  const today = localDate(new Date().toISOString())
  const lines = raw.split('\n')
  let count = 0
  for (let index = Math.max(0, lines.length - 5000); index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '' || !line.includes('"enqueued"')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.event !== 'enqueued' || row.from !== name) continue
    if (localDate(textOf(row.at)) === today) count += 1
  }
  return count
}

/** 某个收件人信箱里挂着几条（插件 pendingCount 同口径）。 */
async function pendingCount(name) {
  try {
    const files = await readdir(join(INBOX_DIR, name))
    return files.filter((file) => file.endsWith('.json')).length
  } catch {
    return 0
  }
}

// ── 群与消息（只读侧） ──────────────────────────────────────────────────────

/**
 * 扫 groups/，返回实际存在的群目录。
 * 名字不合白名单的目录一律跳过 —— 这一步就是「白名单」本身：
 * 后面所有按群名拼路径的地方，都只认这里吐出来的 entry。
 */
async function scanGroupEntries() {
  let entries
  try {
    entries = await readdir(GROUPS_DIR, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }

  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    const archivedMatch = ARCHIVED_ID_RE.exec(id)
    const plain = GROUP_ID_RE.test(id)
    if (archivedMatch === null && !plain) continue

    const dir = join(GROUPS_DIR, id)
    if (!isInsideDir(GROUPS_DIR, resolve(dir))) continue

    const meta = (await readJson(join(dir, 'meta.json'))) ?? {}
    const archived = archivedMatch !== null || meta.archived === true
    const name = archivedMatch !== null ? archivedMatch[0].replace(/\.archived-.*$/, '') : (textOf(meta.name) || id)

    rows.push({ id, name, dir, archived, meta })
  }
  return rows
}

function newestFirst(a, b) {
  const left = textOf(a.created_at)
  const right = textOf(b.created_at)
  if (left === right) return textOf(a.id) < textOf(b.id) ? 1 : -1
  return left < right ? 1 : -1
}

/** 一个群的全部消息，新→旧；坏文件直接跳过，不让一条烂 json 拖垮整个面板。 */
async function readGroupMessages(dir) {
  const messagesDir = join(dir, 'messages')
  let files
  try {
    files = await readdir(messagesDir)
  } catch {
    return []
  }

  const rows = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const message = await readJson(join(messagesDir, file))
    if (message === null || textOf(message.id) === '') continue
    rows.push(message)
  }
  rows.sort(newestFirst)
  return rows
}

/** 群摘要：消息流已经在手上就传进来，别为了数条数再读一遍盘。 */
function summaryOf(entry, messages, registry) {
  const { meta } = entry
  const last = messages[0]
  const identity = creatorIdentity(entry, registry)

  return {
    id: entry.id,
    name: entry.name,
    archived: entry.archived,
    note: textOf(meta.note),
    creator: textOf(meta.creator),
    creator_session_id: textOf(meta.creator_session_id),
    created_at: textOf(meta.created_at),
    archived_at: textOf(meta.archived_at),
    members: Array.isArray(meta.members)
      ? meta.members.filter((member) => typeof member === 'string' && member.trim() !== '').map((member) => member.trim())
      : [],
    /** 点名入口的可用性：allowed=false 时 reason 就是 UI 上要显示的原因。 */
    mention: {
      allowed: identity.allowed,
      reason: identity.reason,
      as: identity.allowed ? identity.name : '',
      candidates: mentionCandidates(entry, registry)
    },
    messageCount: messages.length,
    lastMessageAt: last === undefined ? null : textOf(last.created_at),
    lastMessageFrom: last === undefined ? null : textOf(last.from),
    lastMessagePreview: last === undefined ? '' : firstLine(last.text, 60)
  }
}

/** 群列表：活跃在前、归档在后，各自按最后活跃时间倒序。 */
async function listGroups() {
  const registry = await readRegistry()
  const groups = await Promise.all(
    (await scanGroupEntries()).map(async (entry) => summaryOf(entry, await readGroupMessages(entry.dir), registry))
  )

  groups.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1
    const left = a.lastMessageAt ?? a.created_at
    const right = b.lastMessageAt ?? b.created_at
    if (left !== right) return left < right ? 1 : -1
    return a.name.localeCompare(b.name, 'zh')
  })
  return groups
}

/**
 * 把请求里的 group 参数落到一个真实存在的群目录上。
 * 三道闸：类型/形状（正则）→ 枚举白名单 → resolve 后仍在 groups/ 内。
 */
async function resolveGroup(rawGroup) {
  const id = textOf(rawGroup).trim()
  if (id === '') throw new HttpError(400, '缺少 group 参数')
  if (id.length > 200) throw new HttpError(400, 'group 参数太长')
  if (!GROUP_ID_RE.test(id) && !ARCHIVED_ID_RE.test(id)) {
    throw new HttpError(400, '群名不合法：只允许中文、字母、数字、-、_（归档群另带 .archived-<时间戳>）')
  }

  const entries = await scanGroupEntries()

  // 先按目录名精确匹配（活跃群的目录名就是群名）；没命中再按逻辑群名去归档里找最新那份，
  // 跟插件 loadGroup 的读侧一致：解散后说群名也还能看。
  let hit = entries.find((entry) => entry.id === id)
  if (hit === undefined && GROUP_ID_RE.test(id)) {
    hit = entries
      .filter((entry) => entry.archived && entry.name === id)
      .sort((a, b) => (a.id < b.id ? 1 : -1))[0]
  }
  if (hit === undefined) throw new HttpError(404, `没有这个群：${id}`)

  const dir = resolve(hit.dir)
  if (!isInsideDir(GROUPS_DIR, dir)) throw new HttpError(400, '群路径越界')
  return hit
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

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

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new HttpError(413, `请求体超过 ${MAX_BODY_BYTES} 字节`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

async function parseRequestBody(req) {
  const raw = await readBody(req)
  const type = textOf(req.headers['content-type']).toLowerCase()

  if (raw.trim() === '') return {}

  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw))
  }
  // JSON 是主路；没写 content-type 的也当 JSON 试一把（curl -d 的常见情形已经走上面那条）。
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

function hostAllowed(host) {
  if (host === undefined) return true
  const value = host.toLowerCase()
  return value === `127.0.0.1:${PORT}` || value === `localhost:${PORT}`
}

// ── 静态文件 ────────────────────────────────────────────────────────────────

async function serveStatic(res, urlPath, method) {
  let relative
  if (urlPath === '/' || urlPath === '/index.html') {
    relative = 'index.html'
  } else {
    try {
      relative = decodeURIComponent(urlPath.replace(/^\/+/, ''))
    } catch {
      throw new HttpError(400, 'URL 编码不合法')
    }
    // 只放行 public 下的「扁平」文件名：不许 ..、不许绝对路径、不许反斜杠、只认后缀白名单。
    if (!/^[A-Za-z0-9._-]+$/.test(relative) || relative.includes('..')) {
      throw new HttpError(404, '没有这个文件')
    }
    if (!Object.hasOwn(MIME, extname(relative).toLowerCase())) {
      throw new HttpError(404, '没有这个文件')
    }
  }

  const file = resolve(PUBLIC_DIR, relative)
  if (!isInsideDir(PUBLIC_DIR, file)) throw new HttpError(404, '没有这个文件')

  let content
  try {
    content = await readFile(file)
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, '没有这个文件')
    throw error
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  })
  res.end(method === 'HEAD' ? undefined : content)
}

// ── 路由 ────────────────────────────────────────────────────────────────────

async function handleGroups(res) {
  const groups = await listGroups()
  sendJson(res, 200, { ok: true, root: ROOT, count: groups.length, groups })
}

async function handleMessages(req, res, url) {
  const group = await resolveGroup(url.searchParams.get('group'))

  const requested = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT) : DEFAULT_LIMIT

  const all = await readGroupMessages(group.dir)
  const meta = summaryOf(group, all, await readRegistry())

  sendJson(res, 200, {
    ok: true,
    group: { ...meta, note: textOf(group.meta.note) },
    total: all.length,
    limit,
    messages: all.slice(0, limit)
  })
}

async function handlePostMessage(req, res) {
  const body = await parseRequestBody(req)
  const group = await resolveGroup(body.group)

  if (group.archived || group.meta.archived === true) {
    throw new HttpError(409, `群「${group.name}」已经解散，归档只读，不能再发`)
  }

  const rawText = textOf(body.text)
  const text = rawText.replace(/\r\n/g, '\n').trim()
  if (text === '') throw new HttpError(400, 'text 不能为空')
  if (Array.from(text).length > MAX_TEXT_CHARS) {
    throw new HttpError(413, `text 太长：上限 ${MAX_TEXT_CHARS} 字`)
  }

  // 带 to = 点名，不带 = 老规矩的广播。
  if (body.to === undefined || body.to === null) return postBroadcast(res, group, text)
  if (!Array.isArray(body.to)) throw new HttpError(400, 'to 必须是名字数组；要广播就别传 to')
  return postMention(res, group, rawText, text, body.to)
}

/** 广播：只落盘、零推送（原样保留）。 */
async function postBroadcast(res, group, text) {
  const message = {
    schema_version: 1,
    id: randomUUID(),
    from: SELF.from,
    from_session: SELF.session,
    to: null,
    hops: 0,
    text,
    created_at: new Date().toISOString(),
    status: 'delivered',
    requires_ack: false,
    read_by: [SELF.from],
    group: group.name,
    kind: 'broadcast'
  }

  const messagesDir = join(group.dir, 'messages')
  const file = join(messagesDir, `${message.id}.json`)
  if (!isInsideDir(GROUPS_DIR, resolve(file))) throw new HttpError(400, '落盘路径越界')

  await mkdir(messagesDir, { recursive: true })
  await writeJsonAtomic(file, message)

  console.log(`[dsh-bus-panel] 用户 → 群「${group.name}」：${firstLine(text, 40)}`)
  sendJson(res, 200, { ok: true, kind: 'broadcast', message, file: `groups/${group.id}/messages/${message.id}.json` })
}

/**
 * 点名：一条群消息 + 每个被点名的人一封 inbox 信封（requires_ack）。
 * 落盘格式、字段名、文件名、request_id、审计行全部照抄插件 bus_group_post + enqueueMessage，
 * 唯一区别是发件身份：插件里是「当前窗口」，面板里是「这个群的建群者」（见文件头）。
 */
async function postMention(res, group, rawText, text, rawToList) {
  const bytes = utf8Bytes(rawText)
  if (bytes > MAX_TEXT_BYTES) {
    throw new HttpError(413, `正文 ${bytes} 字节，超过上限 ${MAX_TEXT_BYTES} 字节（约 4000 汉字）。超长就写文件只发路径 —— 面板不截断。`)
  }

  const registry = await readRegistry()
  const identity = creatorIdentity(group, registry)
  if (!identity.allowed) throw new HttpError(403, `点名发不出去：${identity.reason}`)

  const members = memberListOf(group.meta)
  const mention = []
  for (const raw of rawToList) {
    const name = textOf(raw).trim()
    if (name === '' || mention.includes(name)) continue
    if (!isSafeMemberName(name)) throw new HttpError(400, `成员名不合法：${name}`)
    if (!members.includes(name)) throw new HttpError(400, `「${name}」不是群「${group.name}」的成员，点不到`)
    if (activeSessionOf(registry, name) === '') {
      throw new HttpError(409, `「${name}」现在不在总线上（没注册或 inactive），点了也没人收`)
    }
    mention.push(name)
  }
  if (mention.length === 0) throw new HttpError(400, 'to 传了个空名单 —— 要广播就别传 to')

  // 点到建群者自己不用推（插件同款过滤），但群消息里照记。
  const recipients = mention.filter((name) => name !== identity.name)
  if (recipients.length > 0) {
    const sentToday = await senderCountToday(identity.name)
    if (sentToday >= MAX_PER_SENDER_DAY) {
      throw new HttpError(429, `建群者「${identity.name}」今天已经入队 ${sentToday} 条（上限 ${MAX_PER_SENDER_DAY}），先歇一会儿`)
    }
    for (const recipient of recipients) {
      const pending = await pendingCount(recipient)
      if (pending >= MAX_PENDING_PER_RECIPIENT) {
        throw new HttpError(429, `${recipient} 的信箱已经积压 ${pending} 条（上限 ${MAX_PENDING_PER_RECIPIENT}），先等它消化完再点名`)
      }
    }
  }

  const id = randomUUID()
  const createdAt = new Date().toISOString()

  // 群消息：字段跟插件 bus_group_post 写出来的那条一模一样（没有 status 字段）。
  const message = {
    schema_version: 1,
    id,
    group: group.name,
    kind: 'mention',
    from: identity.name,
    from_session: identity.session_id,
    to: mention,
    hops: MENTION_HOPS,
    text,
    created_at: createdAt,
    requires_ack: true,
    read_by: []
  }

  const messagesDir = join(group.dir, 'messages')
  const messageFile = join(messagesDir, `${id}.json`)
  if (!isInsideDir(GROUPS_DIR, resolve(messageFile))) throw new HttpError(400, '落盘路径越界')
  await mkdir(messagesDir, { recursive: true })
  await writeJsonAtomic(messageFile, message)

  // 信箱信封：跟插件 enqueueMessage 同一个目录、同一个文件名规则、同一套字段。
  const stamp = compactStamp(new Date(createdAt))
  const inboxFiles = []
  const pushed = []
  for (const [index, recipient] of recipients.entries()) {
    const session = activeSessionOf(registry, recipient)
    const envelope = {
      schema_version: 1,
      id,
      from: identity.name,
      from_session: identity.session_id,
      to: recipient,
      hops: MENTION_HOPS,
      text,
      created_at: createdAt,
      status: 'pending',
      claimed_at: null,
      delivered_at: null,
      attempts: 0,
      expires_at: new Date(Date.parse(createdAt) + MSG_TTL_MS).toISOString(),
      requires_ack: true,
      mode: 'queue',
      error: null,
      sig: null,
      next_attempt_at: null,
      group: group.name,
      // request_id 只用 ASCII：会话短 id 兜底序号，跟插件 bus_group_post 同款。
      request_id: `bus-group-${id}-${session === '' ? index : shortId(session)}`
    }

    const dir = join(INBOX_DIR, recipient)
    const file = join(dir, `${stamp}-${id}.json`)
    if (!isInsideDir(INBOX_DIR, resolve(dir)) || !isInsideDir(INBOX_DIR, resolve(file))) {
      throw new HttpError(400, '信箱落盘路径越界')
    }
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(file, envelope)

    await appendAudit({
      at: createdAt,
      event: 'enqueued',
      msg_id: id,
      from: identity.name,
      to: recipient,
      hops: MENTION_HOPS,
      mode: 'queue',
      requires_ack: true,
      ok: true,
      preview: text.slice(0, 120)
    })
    pushed.push(recipient)
    inboxFiles.push(`inbox/${recipient}/${stamp}-${id}.json`)
  }

  console.log(
    `[dsh-bus-panel] 点名 · 群「${group.name}」· 建群者 ${identity.name} → ${mention.join('、')}`
      + `（推 ${pushed.length} 人）：${firstLine(text, 40)}`
  )
  sendJson(res, 200, {
    ok: true,
    kind: 'mention',
    message,
    as: identity.name,
    to: mention,
    pushed,
    requires_ack: true,
    files: inboxFiles,
    file: `groups/${group.id}/messages/${id}.json`
  })
}

async function handle(req, res) {
  if (!hostAllowed(req.headers.host)) throw new HttpError(403, 'Host 不认：本服务只给 127.0.0.1 / localhost 用')

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  const pathname = url.pathname

  if (pathname === '/api/groups') {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '只接受 GET')
    return handleGroups(res)
  }

  if (pathname === '/api/messages') {
    if (req.method === 'GET' || req.method === 'HEAD') return handleMessages(req, res, url)
    if (req.method === 'POST') return handlePostMessage(req, res)
    throw new HttpError(405, '只接受 GET / POST')
  }

  if (pathname.startsWith('/api/')) throw new HttpError(404, '没有这个接口')

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '只接受 GET')

  if (pathname === '/favicon.ico') {
    res.writeHead(204).end()
    return
  }

  return serveStatic(res, pathname, req.method)
}

// ── 启动 ────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500
    if (status === 500) console.error('[dsh-bus-panel] 未预期错误：', error)
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: error?.message ?? '服务器内部错误' })
    } else {
      res.end()
    }
  })
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[dsh-bus-panel] 端口 ${PORT} 被占了：换一个端口再起，DSH_BUS_PANEL_PORT=xxxx`)
  } else {
    console.error('[dsh-bus-panel] 启动失败：', error)
  }
  process.exitCode = 1
})

server.listen(PORT, HOST, () => {
  console.log(`[dsh-bus-panel] 数据目录: ${ROOT}`)
  console.log(`[dsh-bus-panel] 群目录  : ${GROUPS_DIR}`)
  console.log(`[dsh-bus-panel] 已监听  : http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[dsh-bus-panel] 收到 ${signal}，关服务`)
    server.close(() => process.exit(0))
    // 有 keep-alive 连接挂着时别无限等
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
