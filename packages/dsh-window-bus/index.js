/**
 * dsh-window-bus v0.5 —— 临时群聊（在 v0.4 的「投递」上加了五个群工具）
 *
 * 十一个工具（v0.4 六个 + v0.5 五个）：
 *   bus_register(name, note?, session_id?, role?, generation?, handoff_from?)  窗口自报名（写 windows.json）
 *   bus_send(session_id, text, mode, hops)   快路径：当场 prompt，发送方等结果（v0.3 行为不变）
 *   bus_post(to, text, hops?, requires_ack?, mode?)  慢路径：只落盘进信箱，扫描器稍后投
 *   bus_ack(msg_id)                          回执：requires_ack 的消息，收件人点一下 processed
 *   bus_list(limit?)                         最近在动的会话清单（从磁盘读，含工作区、已注册名字）
 *   bus_audit(limit?)                        投递记录（messages.jsonl）
 *   bus_group_create(name, members[], note?) 建群，creator 记当前窗口，写 groups/<名>/meta.json
 *   bus_group_post(group, text, to?)         广播（省略 to）= 只落盘、零推送；点名（to=[名字]）= 推全文 + requires_ack
 *   bus_group_read(group, msg_id?, limit?)   不带 msg_id：摘要列表（默认 20 条，新→旧）；带：全文，并记 read_by
 *   bus_group_info(group)                    成员 / 消息总数 / 我未读几条 / 是否已解散
 *   bus_group_dissolve(group)                只有 creator 能解散 → groups/<名>.archived-YYYYMMDD-HHmm/
 *
 * v0.5 的三条硬规矩：
 *   1) 广播零推送 —— N 个窗口各跑一轮的一行通知也比正文贵；想读自己 bus_group_read 拉。
 *   2) 点名推全文，只给被点名的；非 creator 带 to 直接报错，不做审批流。
 *   3) 解散 = 目录改名归档，不删；归档里还能只读回看。
 *
 * 群消息不另开投递器：点名消息落进各收件人的 inbox，由 v0.4 的 scanOnce 同一个 tick 投递，
 * 前缀换成 `[群 · 群名 · hops=N · 来自 X · id=xxxx · MM-DD HH:mm]`，回执照旧用 bus_ack。
 *
 * 底层还是官方接口：ctx.sessionController.prompt({ requestId, sessionId, mode, content }, signal)
 *   mode 只有 'queue' | 'steer' 两个值；signal 必填（内部会 signal.throwIfAborted()）
 *   steer 不可用 → 自动退 queue（降级不算失败，也不退避）
 *   requestId 固定成 `bus-<msg.id>`（群消息按收件人给 `bus-group-<msg.id>-<收件人>`，防宿主全局去重把第二个收件人吞掉）
 *
 * 身份：windows.json 是唯一一份读改写文档，进程内串行 + 临时文件 rename 落盘。
 *   只有 registry.json（v0.3 遗产）时自动在内存里转换，第一次写入落成 windows.json，
 *   旧文件保留只读，回滚就是删掉 windows.json。
 *
 * 投递：一条消息一个文件，inbox/<收件人名>/ 落盘 → rename 到 work/<收件人名>/ 原子认领
 *   → prompt → archive/YYYY-MM-DD/。失败按 5s / 20s / 60s 退避重试 3 次后进 failed/。
 *   状态字段是给人看的账，文件在哪个目录才是锁。
 *
 * 投递确认（设计稿 §六 推荐的第 3 条）：delivered 只表示宿主收下了；
 *   requires_ack 的消息进 pending-ack/ 等 120 秒回执，bus_ack 点亮 processed，
 *   超时标 unconfirmed 并给发件人信箱发一条通知。读对方会话存档那套不做 —— 踩内部格式，
 *   降到手动诊断。
 *
 * 零外部 import（只用 node: 内建）：Node 的 ESM 解析从本文件真实路径向上找 node_modules，
 * @deepseek-ai/* 在家目录下找不到，静态 import 核心包会让插件加载即崩。
 *
 * 这一版明确不做：ACL / HMAC 签名、订阅扇出、Web UI、改 MAX_HOPS 与限流值，
 *   以及 v0.5 的 screenshots.json / 群内嵌套子群 / 广播的一行通知（广播就是零推送）。
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
/** 插件源码目录；总线数据跟它放一起，人眼好查。真实位置由 DSH_WINDOW_BUS_DIR 决定。 */
const BUS_DIR = process.env.DSH_WINDOW_BUS_DIR ?? join(homedir(), '大肥鱼的家', 'dsh-window-bus')
const MESSAGES = join(BUS_DIR, 'messages.jsonl')
const WINDOWS_FILE = join(BUS_DIR, 'windows.json')
/** v0.3 的身份档案，只读 + 自动迁移，永不删除（回滚就删 windows.json）。 */
const LEGACY_REGISTRY = join(BUS_DIR, 'registry.json')
const INBOX = join(BUS_DIR, 'inbox')
const WORK = join(BUS_DIR, 'work')
const PENDING_ACK = join(BUS_DIR, 'pending-ack')
const ARCHIVE = join(BUS_DIR, 'archive')
const FAILED = join(BUS_DIR, 'failed')
const TMP = join(BUS_DIR, 'tmp')
/** v0.5 临时群：groups/<群名>/{meta.json, messages/<id>.json}；解散 = 目录改名。 */
const GROUPS = join(BUS_DIR, 'groups')
const SESSIONS = join(DSH_HOME, 'sessions')

/** 同一个目标在窗口期内的投递上限（防刷屏）。和跳数是两道并行的闸，只管快路径。 */
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 3
const recent = new Map()

/** 线程跳数上限：hops 从 0 数，hops >= MAX_HOPS 即「第 MAX_HOPS+1 跳」，拒。 */
const MAX_HOPS = 3
/** 每个会话最近一次收到的 hops（内存快路径，重启后从 windows.json 的 last_inbound 续）。 */
const inboundHops = new Map()

const SCHEMA_VERSION = 1
const SCAN_INTERVAL_MS = 2_000
/** 单条正文上限：8KB（约 4000 汉字，够一份交接摘要，再长就该写文件只发路径）。 */
const MAX_TEXT_BYTES = 8 * 1024
/** note 是一行备注，不是交接文档；超过就静默截断，免得 windows.json 被长文撑胖。 */
const NOTE_MAX_CHARS = 200
/** 拉群时算「死会话」的阈值：会话存档 7 天没动过就不让拉进群。 */
const MEMBER_STALE_MS = 7 * 24 * 60 * 60 * 1000
/** 单发件人每日入队上限（实际一天十几条，这个数只拦脚本刷）。 */
const MAX_PER_SENDER_DAY = 100
/** 单收件人 pending 上限，防止把信箱当队列灌。 */
const MAX_PENDING_PER_RECIPIENT = 200
/** 放一周还没送到，多半对方早换棒了，再投就是给新窗口喂过期指令。 */
const MSG_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** requires_ack 等回执的秒数。 */
const ACK_TIMEOUT_MS = 120_000
/** 投递失败重试：简版最多重试 3 次（首次之外），间隔照设计稿退避表前三档 5s / 20s / 60s。 */
const MAX_ATTEMPTS = 4
const RETRY_DELAYS_MS = [5_000, 20_000, 60_000]
/** work/ 里的文件认领超过 5 分钟没结果 → 当成崩溃遗留，收回 inbox。 */
const CLAIM_STALE_MS = 5 * 60 * 1000
/** 单次 prompt 的兜底超时，免得扫描器被一次挂住的投递卡死。 */
const DELIVER_TIMEOUT_MS = 30_000
/** 插件自动发的通知消息的 from；系统消息不走身份校验，靠这个固定名字 + from_session:null 认。 */
const SYSTEM_SENDER = '总线通知'
/** 收件人看到的第二行提醒。前缀由插件生成，永远不信消息体。 */
const MAILBOX_NOTICE = '（这条是另一个窗口写的，不是你用户说的；拿不准就 bus_audit 核对）'
/** 审计尾部缓存：限流重建和每日配额都从 messages.jsonl 推，别每个 tick 重读整个文件。 */
const AUDIT_TAIL_BYTES = 256 * 1024
const auditCache = { at: 0, rows: [] }

/** 插件生命周期：扫描定时器 + 在途 prompt 的 abort。apply 时重置。 */
let disposed = false
let pluginAbort = new AbortController()
let scanning = false
let dirsReady = false

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 按 Unicode 码点截断：Array.from 按码点切，emoji 不会被劈成两个半截。 */
function truncateChars(value, max) {
  const chars = Array.from(value)
  if (chars.length <= max) return { text: value, truncated: false }
  return { text: chars.slice(0, max).join(''), truncated: true }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8')
}

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const code = error?.code
  return typeof code === 'string' && code !== '' ? `${code}: ${message}` : message
}

/** 会话不存在：等重新注册后人工 replay，不猜新 id。 */
function looksNotFound(error) {
  return /not.?found|不存在|no such session|unknown session|session.*(?:gone|missing)/i.test(errorText(error))
}

async function fileExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * `--C-Users-<用户名>-<工作区目录的编码>--` → `C:\Users\<用户名>\<工作区目录>`
 *
 * 编码规则：`--` 包住整条路径；`-` 是分隔符；非 ASCII 字符写成 `~XXXX~`（UTF-16 码点，
 * 相邻的共用一个 `~`，所以必须按 `~` 切、不能按固定长度匹配）。首段如果只有一个字母，
 * 那是盘符，补回冒号。
 */
function decodeWorkspace(dirName) {
  const body = dirName.replace(/^--/, '').replace(/--$/, '')
  const parts = body.split('-').map((part) => {
    if (!part.includes('~')) return part
    return part
      .split('~')
      .filter((chunk) => chunk !== '')
      .map((chunk) => {
        const code = parseInt(chunk, 16)
        return Number.isFinite(code) && /^[0-9A-Fa-f]+$/.test(chunk) ? String.fromCharCode(code) : chunk
      })
      .join('')
  })
  if (parts.length > 0 && /^[A-Za-z]$/.test(parts[0])) parts[0] = `${parts[0]}:`
  return parts.join('\\')
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`。 */
function localTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return typeof iso === 'string' ? iso : ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 本地 `YYYY-MM-DD`：archive 分日、每日配额都按本地日子算。 */
function localDate(input) {
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `2026-11-01T08:56:27.909Z` → `20261101T085627Z`，信箱文件名的前缀。 */
function compactStamp(date) {
  const iso = date.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
}

/** 当前会话 id：宿主把 agent 挂在工具执行上下文上（exec.agent.session.id）。拿不到返回 undefined。 */
function sessionIdOf(exec) {
  const candidates = [
    exec?.agent?.session?.id,
    exec?.agent?.sessionId,
    exec?.session?.id,
    exec?.sessionId
  ]
  for (const candidate of candidates) {
    const id = textOf(candidate)
    if (id !== '') return id
  }
  return undefined
}

/** `session-1a2b3c4d-...` → `1a2b3c4d`；总线前缀里用短 id 省地方。 */
function shortId(id) {
  const body = id.replace(/^session-?/i, '')
  return body === '' ? id : body.slice(0, 8)
}

/* ────────────────────────────── 审计（messages.jsonl） ────────────────────────────── */

async function appendMessage(record) {
  await mkdir(BUS_DIR, { recursive: true })
  await appendFile(MESSAGES, JSON.stringify(record) + '\n', 'utf8')
  // 刚写的行必须让下一次统计看见，否则同一 tick 里的限流会放水。
  auditCache.at = 0
}

/** 读 messages.jsonl 的尾部（最多 maxBytes），按行解析；坏行跳过。 */
async function readAuditTail(maxBytes = AUDIT_TAIL_BYTES) {
  const now = Date.now()
  if (auditCache.at !== 0 && now - auditCache.at < 1_000) return auditCache.rows
  let handle
  try {
    handle = await open(MESSAGES, 'r')
    const info = await handle.stat()
    const start = Math.max(0, info.size - maxBytes)
    const length = info.size - start
    if (length <= 0) {
      auditCache.at = now
      auditCache.rows = []
      return auditCache.rows
    }
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let body = buffer.toString('utf8')
    // 从文件中间截断时第一行可能是半截，丢掉。
    const firstBreak = body.indexOf('\n')
    if (start > 0 && firstBreak >= 0) body = body.slice(firstBreak + 1)
    const rows = []
    for (const line of body.split('\n')) {
      if (line === '') continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* 半截行 / 坏行：宁可少一条，也不做整文件重写去修格式 */
      }
    }
    auditCache.at = now
    auditCache.rows = rows
    return rows
  } catch {
    return []
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/** bus_audit 用：读全文件取最后 limit 行（v0.3 行为）。 */
async function readAudit(limit) {
  try {
    const text = await readFile(MESSAGES, 'utf8')
    const lines = text.trim().split('\n').filter((l) => l !== '')
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l) } catch { return { raw: l } }
    })
  } catch {
    return []
  }
}

/** 该收件人最近 60 秒被成功投递了几条（重启后也准：从审计重建）。 */
async function deliveredRecently(recipient) {
  const now = Date.now()
  const rows = await readAuditTail()
  let count = 0
  for (const row of rows) {
    if (row?.event !== 'delivered' || row.ok === false || row.to !== recipient) continue
    const at = Date.parse(row.at ?? '')
    if (Number.isFinite(at) && now - at < RATE_WINDOW_MS) count += 1
  }
  return count
}

/** 该发件人今天（本地日）已经入队了几条。 */
async function senderCountToday(sender) {
  const today = localDate(new Date())
  const rows = await readAuditTail()
  let count = 0
  for (const row of rows) {
    if (row?.event !== 'enqueued' || row.from !== sender) continue
    if (localDate(row.at) === today) count += 1
  }
  return count
}

/* ────────────────────────────── 目录与原子写 ────────────────────────────── */

async function ensureDirs() {
  if (dirsReady) return
  for (const dir of [BUS_DIR, INBOX, WORK, PENDING_ACK, ARCHIVE, FAILED, TMP, GROUPS]) {
    await mkdir(dir, { recursive: true })
  }
  dirsReady = true
}

/** 临时文件 + rename：读的人永远不会拿到半截 JSON。 */
async function writeJsonAtomic(target, value) {
  await mkdir(dirname(target), { recursive: true })
  await mkdir(TMP, { recursive: true })
  const tmp = join(TMP, `${randomUUID()}.json`)
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmp, target)
      return
    } catch (error) {
      const code = error?.code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        await unlink(tmp).catch(() => {})
        throw error
      }
      await sleep(30)
    }
  }
  await unlink(tmp).catch(() => {})
  throw new Error(`writeJsonAtomic: 覆盖 ${target} 连续失败（多半是杀软/索引器占着文件）`)
}

async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/* ────────────────────────────── windows.json（身份档案） ────────────────────────────── */

/**
 * 单条窗口档案规范化。同时吃 v0.3 的 `{session_id, note, updated_at}` 和 v0.4 的新字段：
 *   registry.json 的 updated_at 当 registered_at（首次报名时间），role 缺省 `未标注`
 *   （猜个「主窗」会让星型拓扑判断错，宁可空着等下次 bus_register 覆盖）。
 */
function normalizeWindow(entry) {
  const session = textOf(entry?.session_id)
  if (session === '') return undefined
  const registeredAt = textOf(entry?.registered_at) || textOf(entry?.updated_at) || localTime(new Date().toISOString())
  const lastSeen = textOf(entry?.last_seen) || registeredAt
  const role = entry?.role === '主窗' || entry?.role === '专业窗口' ? entry.role : '未标注'
  const normalized = {
    session_id: session,
    role,
    generation: Number.isInteger(entry?.generation) ? entry.generation : null,
    note: textOf(entry?.note),
    registered_at: registeredAt,
    last_seen: lastSeen,
    handoff_from: textOf(entry?.handoff_from) === '' ? null : textOf(entry.handoff_from),
    active: entry?.active === false ? false : true
  }
  const inbound = entry?.last_inbound
  if (inbound !== null && typeof inbound === 'object' && Number.isFinite(inbound.hops)) {
    normalized.last_inbound = {
      hops: Math.max(0, Math.trunc(inbound.hops)),
      msg_id: textOf(inbound.msg_id),
      at: textOf(inbound.at) || lastSeen
    }
  }
  return normalized
}

/**
 * 读身份档案：windows.json 优先；只有 registry.json 时在内存里转换（迁移）。
 * 文件不存在 / 坏掉都退回空表，绝不因为身份文件塌了就让插件加载失败。
 */
async function readWindows() {
  let raw
  try {
    raw = JSON.parse(await readFile(WINDOWS_FILE, 'utf8'))
  } catch {
    raw = undefined
  }
  if (raw !== null && raw !== undefined && typeof raw === 'object') {
    const version = raw.schema_version
    if (Number.isInteger(version) && version > SCHEMA_VERSION) {
      throw new Error(`windows.json 的 schema_version=${version} 比本插件认识的 ${SCHEMA_VERSION} 新，按只读处理、拒绝写入。要回滚就删掉 windows.json（v0.3 还能读 registry.json）。`)
    }
    const windows = {}
    for (const [name, entry] of Object.entries(raw.windows ?? {})) {
      const normalized = normalizeWindow(entry)
      if (normalized !== undefined) windows[name] = normalized
    }
    return { schema_version: SCHEMA_VERSION, updated_at: textOf(raw.updated_at) || undefined, windows }
  }
  // 迁移：v0.3 的 registry.json → 内存里的 v0.4 结构。第一次写入时落成 windows.json。
  try {
    const legacy = JSON.parse(await readFile(LEGACY_REGISTRY, 'utf8'))
    const windows = {}
    for (const [name, entry] of Object.entries(legacy?.windows ?? {})) {
      const normalized = normalizeWindow(entry)
      if (normalized !== undefined) windows[name] = normalized
    }
    return { schema_version: SCHEMA_VERSION, updated_at: textOf(legacy?.updated_at) || undefined, windows }
  } catch {
    return { schema_version: SCHEMA_VERSION, updated_at: undefined, windows: {} }
  }
}

/** windows.json 读-改-写串行化，防两个工具同时写互相覆盖（同一进程内）。 */
let windowsLock = Promise.resolve()
function withWindows(fn) {
  const run = windowsLock.then(fn, fn)
  windowsLock = run.then(() => undefined, () => undefined)
  return run
}

async function writeWindows(windows) {
  const updatedAt = localTime(new Date().toISOString())
  const payload = { schema_version: SCHEMA_VERSION, updated_at: updatedAt, windows }
  await writeJsonAtomic(WINDOWS_FILE, payload)
  return { updated_at: updatedAt, windows }
}

/** 一次读改写更新多个窗口条目。mutator 拿到的是可改的 windows 对象。 */
async function updateWindows(mutator) {
  return withWindows(async () => {
    const registry = await readWindows()
    mutator(registry.windows, registry)
    return writeWindows(registry.windows)
  })
}

/**
 * 身份双向索引：名字 → 会话 id，会话 id → 名字。
 * byName 收全部名字（包括退休的，v0.3 语义是「发了就发」）；
 * byId 只认 active 的，反查「当前是谁」时不该落到一个已退休的旧名上。
 */
function nameIndex(registry) {
  const byName = new Map()
  const byId = new Map()
  for (const [name, entry] of Object.entries(registry?.windows ?? {})) {
    const id = textOf(entry?.session_id)
    if (id === '') continue
    byName.set(name, id)
    if (entry.active !== false && !byId.has(id)) byId.set(id, name)
  }
  return { byName, byId }
}

/* ────────────────────────────── 信箱消息 ────────────────────────────── */

/** 把一条消息落进 inbox/<收件人>/。一条一个文件，没有可覆盖的共享对象。 */
async function enqueueMessage(fields) {
  await ensureDirs()
  // 群点名要跟群消息共用一个 id（回执前缀 / bus_group_read 对得上）；v0.4 的调用方不传，照旧随机。
  const id = textOf(fields.id) !== '' ? textOf(fields.id) : randomUUID()
  const createdAt = new Date().toISOString()
  const msg = {
    schema_version: SCHEMA_VERSION,
    id,
    from: fields.from,
    from_session: fields.from_session ?? null,
    to: fields.to,
    hops: fields.hops,
    text: fields.text,
    created_at: createdAt,
    status: 'pending',
    claimed_at: null,
    delivered_at: null,
    attempts: 0,
    expires_at: new Date(Date.now() + MSG_TTL_MS).toISOString(),
    requires_ack: fields.requires_ack === true,
    mode: fields.mode === 'steer' ? 'steer' : 'queue',
    error: null,
    // 签名这一阶段不做（§7③ 的 1、2 条留到后面），字段先占位，读的人不用猜。
    sig: null,
    // 退避重试的「最早可投时间」；设计稿 §4 没列，但没有它就没法跨重启记退避。
    next_attempt_at: null
  }
  if (fields.system === true) msg.system = true
  // v0.5：群点名的信封标记。不传 = 普通信箱消息，字段跟 v0.4 一模一样。
  if (textOf(fields.group) !== '') msg.group = textOf(fields.group)
  if (textOf(fields.request_id) !== '') msg.request_id = textOf(fields.request_id)
  const file = `${compactStamp(new Date())}-${id}.json`
  await writeJsonAtomic(join(INBOX, fields.to, file), msg)
  await appendMessage({
    at: createdAt,
    event: 'enqueued',
    msg_id: id,
    from: fields.from,
    to: fields.to,
    hops: fields.hops,
    mode: msg.mode,
    requires_ack: msg.requires_ack,
    ok: true,
    preview: fields.text.slice(0, 120)
  })
  return msg
}

async function pendingCount(name) {
  try {
    const files = await readdir(join(INBOX, name))
    return files.filter((f) => f.endsWith('.json')).length
  } catch {
    return 0
  }
}

/** 投递成功 / 处理完的归档：archive/YYYY-MM-DD/。 */
async function archiveMessage(msg, sourcePath) {
  const dir = join(ARCHIVE, localDate(new Date()))
  await mkdir(dir, { recursive: true })
  await writeJsonAtomic(join(dir, basename(sourcePath)), msg)
  await unlink(sourcePath).catch(() => {})
}

/** 验不过 / 过期 / 重试耗尽的归宿。 */
async function moveToFailed(msg, sourcePath) {
  await mkdir(FAILED, { recursive: true })
  await writeJsonAtomic(join(FAILED, basename(sourcePath)), msg)
  await unlink(sourcePath).catch(() => {})
}

/** 连 JSON 都读不出来的文件（或结构不对）：挪进 failed/，别在原地每 2 秒重试一遍。 */
async function failFile(sourcePath, msg, reason) {
  await mkdir(FAILED, { recursive: true })
  try {
    await rename(sourcePath, join(FAILED, basename(sourcePath)))
  } catch {
    /* 抢不到就算了，下个 tick 再说 */
  }
  await appendMessage({
    at: new Date().toISOString(),
    event: 'failed',
    msg_id: msg?.id ?? null,
    from: msg?.from ?? null,
    to: msg?.to ?? null,
    ok: false,
    error: reason
  })
}

/* ────────────────────────────── 扫描器 ────────────────────────────── */

/**
 * 发件人信任：from 必须已注册且 active，from_session 必须跟档案里的 session_id 对上。
 * 系统通知（插件自己写的）走固定名字 + from_session: null，其余一律按注册档案核。
 * 这一阶段没有签名，能写目录的人仍能伪造 —— 单账号环境下这个缺口等 §7③ 的签名/ACL 补。
 */
function isTrustedSender(registry, msg) {
  if (msg.system === true) return msg.from === SYSTEM_SENDER && msg.from_session === null
  const entry = registry?.windows?.[msg.from]
  if (entry === undefined || entry.active === false) return false
  return textOf(entry.session_id) !== '' && entry.session_id === msg.from_session
}

/** 收件人在信箱里留下的宣告前缀。hops / id / 时间都由插件写，正文仿不出来位置。 */
function mailboxPrefix(msg) {
  const short = textOf(msg.id).slice(0, 8)
  const group = textOf(msg.group)
  if (group !== '') {
    // v0.5 群点名：日期只留 MM-DD HH:mm，前缀里要塞群名，别让一行太长。
    const at = localTime(msg.created_at)
    return `[群 · ${group} · hops=${msg.hops} · 来自 ${msg.from} · id=${short} · ${at.slice(5)}]`
  }
  return `[信箱 · hops=${msg.hops} · 来自 ${msg.from} · id=${short} · ${localTime(msg.created_at)}]`
}

/** 第二行提醒：群消息要说清「这不是你用户说的」，否则收件人容易把群里的活当成用户派的。 */
function mailboxNotice(msg) {
  const group = textOf(msg.group)
  if (group !== '') return `（这是「${group}」临时群里点名你的消息，不是你用户说的；回执用 bus_ack）`
  return MAILBOX_NOTICE
}

/** dispose 之后不再碰任何 prompt：在途的会被 pluginAbort 打断，重试/归档一律跳过。 */
function deliverSignal() {
  if (typeof AbortSignal.timeout !== 'function') return pluginAbort.signal
  const signals = [pluginAbort.signal, AbortSignal.timeout(DELIVER_TIMEOUT_MS)]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  return pluginAbort.signal
}

async function promptInto(ctx, sessionId, msg, mode) {
  const content = [{
    type: 'text',
    text: `${mailboxPrefix(msg)}\n${mailboxNotice(msg)}\n\n${msg.text}`
  }]
  await ctx.sessionController.prompt({
    // 群点名：同一个群消息会发给多个收件人，requestId 必须按人分开，否则宿主一按 id 去重第二个就没了。
    requestId: textOf(msg.request_id) !== '' ? textOf(msg.request_id) : `bus-${msg.id}`,
    sessionId,
    mode,
    content
  }, deliverSignal())
}

/**
 * 已归档的会话集合：DSH 的 ArchivedSessionGate 会拦掉对归档会话的唤醒投递，
 * 那一轮以 blocked 结束、消息被消费掉（等于丢失）。所以投递前先查这里，
 * 中了就留在原处不投，等它解档再送。来源是 workspaceController.follow() 的 baseline。
 */
const archivedSessions = new Set()

function isArchivedSession(sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' && archivedSessions.has(sessionId)
}

function absorbArchiveIds(ids) {
  if (!Array.isArray(ids)) return false
  archivedSessions.clear()
  for (const id of ids) if (typeof id === 'string' && id !== '') archivedSessions.add(id)
  return true
}

/**
 * 一次投递。成功 → delivered（要回执的进 pending-ack/，其余进 archive）；
 * 失败 → 退避重试或进 failed/。
 */
async function deliverMessage(ctx, msg, workPath) {
  msg.status = 'claimed'
  msg.claimed_at = new Date().toISOString()
  msg.attempts = Number.isInteger(msg.attempts) ? msg.attempts : 0
  await writeJsonAtomic(workPath, msg)

  const registry = await readWindows()
  const targetId = textOf(registry.windows?.[msg.to]?.session_id)
  if (targetId === '') {
    // 收件人的会话 id 没了：不失败，留在原地等它重新注册（过期由扫描器兜）。
    await requeueMessage(msg, workPath, '收件人还查不到会话 id，等它注册', 0)
    return
  }

  if (isArchivedSession(targetId)) {
    // 归档会话跑不了模型步：投进去只会被闸门拦成 blocked，消息白丢。
    // 留在原地，等它解档后由扫描器自然重投。
    await appendMessage({
      at: new Date().toISOString(),
      event: 'held',
      msg_id: msg.id,
      from: msg.from,
      to: msg.to,
      hops: msg.hops,
      ok: false,
      reason: 'target-archived',
      preview: textOf(msg.text).slice(0, 120)
    })
    await requeueMessage(msg, workPath, '目标会话已归档，DSH 会拦掉唤醒；等它解档再投', 0)
    return
  }

  let mode = msg.mode === 'steer' ? 'steer' : 'queue'
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await promptInto(ctx, targetId, msg, mode)
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      // steer 不可用（或宿主这轮接不了实时注入）→ 当场改 queue，不算失败、不退避。
      if (mode === 'steer' && !disposed) {
        mode = 'queue'
        continue
      }
      break
    }
  }
  if (disposed) return
  if (lastError !== undefined) {
    await failOrRetry(msg, workPath, lastError)
    return
  }

  const deliveredAt = new Date().toISOString()
  msg.status = 'delivered'
  msg.delivered_at = deliveredAt
  msg.claimed_at = null
  msg.error = null
  msg.next_attempt_at = null
  await appendMessage({
    at: deliveredAt,
    event: 'delivered',
    msg_id: msg.id,
    from: msg.from,
    to: msg.to,
    hops: msg.hops,
    mode,
    requires_ack: msg.requires_ack === true,
    ok: true,
    preview: textOf(msg.text).slice(0, 120)
  })

  // 投递成功顺手刷 last_seen / last_inbound：收件人下次转发时以这一跳为基准 +1。
  const stamp = localTime(deliveredAt)
  await updateWindows((windows) => {
    const entry = windows[msg.to]
    if (entry === undefined) return
    entry.last_seen = stamp
    entry.last_inbound = { hops: msg.hops, msg_id: msg.id, at: stamp }
  }).catch(() => {})
  inboundHops.set(targetId, msg.hops)

  if (msg.requires_ack === true) {
    // 宿主收下了，等回执：进 pending-ack/ 计时，崩溃重启按 delivered_at 续算。
    await writeJsonAtomic(join(PENDING_ACK, msg.to, basename(workPath)), msg)
    await unlink(workPath).catch(() => {})
    return
  }
  await archiveMessage(msg, workPath)
}

/** 投递不成功：按退避表排下一次，超次数 / 过期 / 会话不存在就进 failed/。 */
async function failOrRetry(msg, workPath, error) {
  const nowIso = new Date().toISOString()
  msg.attempts = (Number.isInteger(msg.attempts) ? msg.attempts : 0) + 1
  msg.error = errorText(error).slice(0, 200)
  const expiresAt = Date.parse(msg.expires_at ?? '')
  const expired = Number.isFinite(expiresAt) && expiresAt < Date.now()
  if (expired || looksNotFound(error) || msg.attempts >= MAX_ATTEMPTS) {
    msg.status = 'failed'
    await moveToFailed(msg, workPath)
    await appendMessage({
      at: nowIso,
      event: 'failed',
      msg_id: msg.id,
      from: msg.from,
      to: msg.to,
      hops: msg.hops,
      attempts: msg.attempts,
      ok: false,
      error: expired ? `expired：${msg.error}` : msg.error
    })
    if (msg.requires_ack === true) {
      await notifySender(msg, expired ? '这条消息过期了，没投出去' : `投递失败（${msg.error}）`).catch(() => {})
    }
    return
  }
  const delay = RETRY_DELAYS_MS[Math.min(msg.attempts - 1, RETRY_DELAYS_MS.length - 1)]
  await requeueMessage(msg, workPath, msg.error, delay)
  await appendMessage({
    at: nowIso,
    event: 'retry',
    msg_id: msg.id,
    from: msg.from,
    to: msg.to,
    hops: msg.hops,
    attempts: msg.attempts,
    ok: false,
    error: `${msg.error}（${Math.round(delay / 1000)} 秒后重试）`
  })
}

/** 把 work/ 里的文件改回 pending 塞回 inbox/，带下次可投时间。 */
async function requeueMessage(msg, workPath, reason, delayMs) {
  msg.status = 'pending'
  msg.claimed_at = null
  msg.error = reason === '' ? msg.error ?? null : reason
  msg.next_attempt_at = delayMs > 0 ? new Date(Date.now() + delayMs).toISOString() : null
  const target = join(INBOX, textOf(msg.to), basename(workPath))
  await writeJsonAtomic(target, msg)
  await unlink(workPath).catch(() => {})
}

/**
 * 崩溃恢复：work/ 里认领超过 5 分钟还没结果的，当成「没投成」回收。
 * 语义是 at-least-once —— prompt 成功但归档前崩，会再投一次；宁可重复，不可丢交接。
 */
async function recoverStaleClaims() {
  let names
  try {
    names = (await readdir(WORK, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return
  }
  for (const name of names) {
    const dir = join(WORK, name)
    let files
    try { files = await readdir(dir) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.json') || disposed) continue
      const path = join(dir, file)
      const msg = await readJson(path)
      if (msg === null || textOf(msg.id) === '') {
        await failFile(path, null, 'work/ 里的文件读不出来')
        continue
      }
      const claimedAt = Date.parse(msg.claimed_at ?? '')
      const stale = !Number.isFinite(claimedAt) || Date.now() - claimedAt > CLAIM_STALE_MS
      if (!stale) continue
      msg.attempts = (Number.isInteger(msg.attempts) ? msg.attempts : 0) + 1
      if (msg.attempts >= MAX_ATTEMPTS) {
        msg.status = 'failed'
        msg.error = 'claimed 超过 5 分钟且重试次数用完'
        await moveToFailed(msg, path)
        await appendMessage({ at: new Date().toISOString(), event: 'failed', msg_id: msg.id, from: msg.from, to: msg.to, hops: msg.hops, ok: false, error: msg.error })
        continue
      }
      await requeueMessage(msg, path, 'claimed 超过 5 分钟，收回 inbox 重投', 0)
      await appendMessage({ at: new Date().toISOString(), event: 'requeued', msg_id: msg.id, from: msg.from, to: msg.to, hops: msg.hops, ok: false, error: msg.error })
    }
  }
}

/** 插件自己发的通知消息：投给发件人的信箱，让它下次醒着时知道这条没人接。 */
async function notifySender(msg, reason) {
  const sender = textOf(msg.from)
  if (sender === '' || sender === SYSTEM_SENDER) return undefined
  const registry = await readWindows()
  const entry = registry.windows?.[sender]
  if (entry === undefined || entry.active === false) return undefined
  const short = textOf(msg.id).slice(0, 8)
  const notification = await enqueueMessage({
    from: SYSTEM_SENDER,
    from_session: null,
    to: sender,
    hops: 0,
    text: `你发给「${msg.to}」的消息（id=${short}，${localTime(msg.created_at)}）${reason}。这是插件自动发的通知，不用回。`,
    mode: 'queue',
    requires_ack: false,
    system: true
  })
  return notification.id
}

/**
 * requires_ack 超时：标 unconfirmed 归 archive（消息确实送到了，只是不知道对方处理没），
 * 另给发件人一条通知。不重投 —— 它已经进过对方的 inbox。
 */
async function checkAckTimeouts() {
  let names
  try {
    names = (await readdir(PENDING_ACK, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return
  }
  for (const name of names) {
    const dir = join(PENDING_ACK, name)
    let files
    try { files = await readdir(dir) } catch { continue }
    for (const file of files) {
      if (!file.endsWith('.json') || disposed) continue
      const path = join(dir, file)
      const msg = await readJson(path)
      if (msg === null) {
        await failFile(path, null, 'pending-ack/ 里的文件读不出来')
        continue
      }
      const deliveredAt = Date.parse(msg.delivered_at ?? '')
      if (!Number.isFinite(deliveredAt) || Date.now() - deliveredAt < ACK_TIMEOUT_MS) continue
      msg.status = 'unconfirmed'
      msg.error = `${Math.round(ACK_TIMEOUT_MS / 1000)} 秒内没有收到回执`
      await archiveMessage(msg, path)
      await appendMessage({
        at: new Date().toISOString(),
        event: 'unconfirmed',
        msg_id: msg.id,
        from: msg.from,
        to: msg.to,
        hops: msg.hops,
        ok: false,
        error: msg.error
      })
      await notifySender(msg, `过了 ${Math.round(ACK_TIMEOUT_MS / 1000)} 秒还没收到回执`).catch(() => {})
    }
  }
}

/** 扫一个收件人的 inbox：验闸门 → 限流 → rename 认领 → 投递。 */
async function scanRecipient(ctx, name, registry) {
  const dir = join(INBOX, name)
  let files
  try {
    files = await readdir(dir)
  } catch {
    return
  }
  const targetId = textOf(registry.windows?.[name]?.session_id)
  for (const file of files) {
    if (disposed) return
    if (!file.endsWith('.json')) continue
    const inboxPath = join(dir, file)
    const msg = await readJson(inboxPath)
    if (msg === null || textOf(msg.id) === '') {
      await failFile(inboxPath, null, '信箱文件读不出来（坏 JSON）')
      continue
    }
    if (textOf(msg.to) !== name) {
      await failFile(inboxPath, msg, `消息的 to=${textOf(msg.to)} 跟目录 ${name} 对不上`)
      continue
    }
    const expiresAt = Date.parse(msg.expires_at ?? '')
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      msg.status = 'failed'
      msg.error = 'expired'
      await moveToFailed(msg, inboxPath)
      await appendMessage({ at: new Date().toISOString(), event: 'failed', msg_id: msg.id, from: msg.from, to: msg.to, hops: msg.hops, ok: false, error: 'expired' })
      if (msg.requires_ack === true) await notifySender(msg, '这条消息过期了，没投出去').catch(() => {})
      continue
    }
    if (!Number.isInteger(msg.hops) || msg.hops < 0) {
      await failFile(inboxPath, msg, `hops 不是非负整数：${String(msg.hops)}`)
      continue
    }
    // 投递时再查一次跳数：闸门放在最终执行点才算数（发件方可能跑着老版本）。
    if (msg.hops >= MAX_HOPS) {
      msg.status = 'failed'
      msg.error = `hops=${msg.hops} 已达上限 ${MAX_HOPS}`
      await moveToFailed(msg, inboxPath)
      await appendMessage({ at: new Date().toISOString(), event: 'failed', msg_id: msg.id, from: msg.from, to: msg.to, hops: msg.hops, ok: false, error: msg.error })
      if (msg.requires_ack === true) await notifySender(msg, `跳数超限（hops=${msg.hops}），没投`).catch(() => {})
      continue
    }
    // from 没注册 / inactive / from_session 对不上：留在原地，等它注册或过期。
    if (!isTrustedSender(registry, msg)) continue
    if (targetId === '') continue
    // 限流放投递侧：入队不花收件人 token，烧钱的是 prompt。
    if (await deliveredRecently(name) >= RATE_MAX) return
    const nextAt = Date.parse(msg.next_attempt_at ?? '')
    if (Number.isFinite(nextAt) && nextAt > Date.now()) continue
    await mkdir(join(WORK, name), { recursive: true })
    const workPath = join(WORK, name, file)
    try {
      await rename(inboxPath, workPath)
    } catch (error) {
      if (error?.code === 'ENOENT') continue // 被另一个扫描器抢了
      throw error
    }
    await deliverMessage(ctx, msg, workPath)
  }
}

/** 一个 tick：恢复崩溃遗留 → 回执超时 → 逐收件人扫 inbox。 */
async function scanOnce(ctx) {
  if (disposed || scanning) return
  scanning = true
  try {
    await ensureDirs()
    await recoverStaleClaims()
    await checkAckTimeouts()
    const registry = await readWindows()
    let names
    try {
      names = (await readdir(INBOX, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      names = []
    }
    for (const name of names) {
      if (disposed) break
      await scanRecipient(ctx, name, registry)
    }
  } catch {
    // 扫描器不向外抛：下个 tick 重来一次就是它的容错方式。
  } finally {
    scanning = false
  }
}

/** 入队后立刻踢一脚，把本地投递延迟压到毫秒级；轮询只兜底。 */
function kickScanner(ctx) {
  if (disposed) return
  setTimeout(() => {
    scanOnce(ctx).catch(() => {})
  }, 10).unref?.()
}

/**
 * 启动扫描器。定时器和在途 prompt 都挂在宿主的 dispose 钩子上，卸载时一起清 ——
 * 旧定时器还在跑就会双投。ctx.effect 是家里插件通用的接法（whale-widget / dsh-pet 同款）；
 * 老宿主没有它时退到 ctx.on('dispose')，再没有就只能跟着进程走，至少不会加载即崩。
 */
/** 订阅工作区归档集合；服务或接口不齐就直接返回，调用方兜住异常。 */
function startArchiveWatch(ctx) {
  const controller = ctx.workspaceController
  if (controller === undefined || typeof controller.follow !== 'function') return
  const abort = new AbortController()
  ctx.effect(() => {
    const run = async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const frame of controller.follow(abort.signal)) {
            if (abort.signal.aborted) break
            if (frame?.type === 'baseline') {
              absorbArchiveIds(frame.value?.archivedSessionIds)
            } else {
              const ids = frame?.value?.archivedSessionIds ?? frame?.archivedSessionIds
              if (Array.isArray(ids)) absorbArchiveIds(ids)
            }
          }
        } catch {
          if (abort.signal.aborted) break
        }
        if (abort.signal.aborted) break
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
    void run()
    return () => abort.abort()
  })
}


function startScanner(ctx) {
  const boot = async () => {
    try {
      await ensureDirs()
      // 旧 registry.json 自动迁移：windows.json 不存在时才落盘，之后只读旧文件。
      const registry = await readWindows()
      if (Object.keys(registry.windows).length > 0 && !(await fileExists(WINDOWS_FILE))) {
        await writeWindows(registry.windows)
      }
    } catch {
      // 迁移失败不挡扫描：工具调用时还会再试一次读。
    }
    await scanOnce(ctx).catch(() => {})
  }
  boot().catch(() => {})
  const timer = setInterval(() => {
    scanOnce(ctx).catch(() => {})
  }, SCAN_INTERVAL_MS)
  timer.unref?.()
  const stop = () => {
    disposed = true
    clearInterval(timer)
    pluginAbort.abort()
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => stop)
      return
    } catch {
      /* 老宿主没这个口子，往下退 */
    }
  }
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', stop)
    } catch {
      /* 最后兜底：定时器随进程退出，至少不是加载失败 */
    }
  }
}

/* ────────────────────────────── 会话清单 ────────────────────────────── */

async function listSessions(limit) {
  let workspaces
  try {
    workspaces = await readdir(SESSIONS, { withFileTypes: true })
  } catch {
    return []
  }
  const registry = await readWindows()
  const { byId } = nameIndex(registry)
  const rows = []
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    let sessions
    try {
      sessions = await readdir(join(SESSIONS, ws.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const file = join(SESSIONS, ws.name, s.name, 'session.v4.jsonl.zstd')
      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      const name = byId.get(s.name)
      rows.push({
        session_id: s.name,
        ...name === undefined ? {} : { name },
        workspace: decodeWorkspace(ws.name),
        last_active: localTime(info.mtime.toISOString()),
        size_kb: Math.round(info.size / 1024)
      })
    }
  }
  rows.sort((a, b) => (a.last_active < b.last_active ? 1 : -1))
  return rows.slice(0, limit)
}

/**
 * 批量查会话存档的 mtime：sessions/<工作区编码>/<session_id>/session.v4.jsonl.zstd。
 * 工作区目录名编码过，没法按 id 直接拼路径，只能遍历 sessions 下的每个工作区目录挨个试；
 * 找不到（会话被删）就不在返回的 Map 里。建群不频繁，一次遍历可以接受 —— 不缓存。
 */
async function sessionArchiveMtimes(sessionIds) {
  const found = new Map()
  const wanted = [...new Set(sessionIds.map((id) => textOf(id)).filter((id) => id !== '' && !id.includes('/') && !id.includes('\\')))]
  if (wanted.length === 0) return found
  let workspaces
  try {
    workspaces = await readdir(SESSIONS, { withFileTypes: true })
  } catch {
    return found
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    for (const id of wanted) {
      if (found.has(id)) continue
      // 2026-11-01 修：老会话（v3 格式）的存档叫 session.jsonl.zstd，新的是 session.v4.jsonl.zstd。
      // 只认 v4 会把 8 月那批全判成「存档不存在」，报错理由骗人（结果对，理由错）。
      for (const fileName of ['session.v4.jsonl.zstd', 'session.jsonl.zstd']) {
        try {
          const info = await stat(join(SESSIONS, ws.name, id, fileName))
          found.set(id, info.mtime)
          break
        } catch {
          /* 这个文件名没有，试下一个 */
        }
      }
    }
  }
  return found
}

/* ────────────────────────────── 临时群聊（v0.5） ────────────────────────────── */

/**
 * 群只干两件事：广播（只落盘、零推送）和点名（只推被点名的正文 + requires_ack）。
 * 目录 groups/<群名>/{meta.json, messages/<id>.json}；解散 = 目录改名归档，不删。
 * 群消息不另开投递器 —— 点名走 v0.4 的 inbox 管线，同一个 scanOnce tick 投。
 */

const GROUP_NAME_MAX = 40
/** 群名直接当目录名用，这些字符在 Windows 上不是名字就是分隔符。 */
const GROUP_NAME_BAD = /[\\/:*?"<>|\u0000-\u001f]/
const GROUP_NAME_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** 归档目录名靠这个后缀区分，群名里再带就分不清谁是谁了。 */
const ARCHIVED_SUFFIX = '.archived-'

/** 文件名 / 归档名用的本地时间戳：`20261031-1740`。 */
function groupStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** 群名不合规返回原因，合规返回 undefined。 */
function groupNameProblem(name) {
  if (name === '') return '群名不能为空'
  if (Array.from(name).length > GROUP_NAME_MAX) return `群名最多 ${GROUP_NAME_MAX} 个字（要当目录名用）`
  if (GROUP_NAME_BAD.test(name)) return '群名里不能有 \\ / : * ? " < > | 或控制字符（群名就是目录名）'
  if (/^[.\s]|[.\s]$/.test(name)) return '群名不能以空格或点开头/结尾'
  if (GROUP_NAME_RESERVED.test(name)) return `「${name}」是 Windows 保留设备名，换一个`
  if (name.toLowerCase().includes(ARCHIVED_SUFFIX)) return `群名里不能含「${ARCHIVED_SUFFIX}」（归档目录靠它区分）`
  return undefined
}

function groupDirOf(name) {
  return join(GROUPS, name)
}

function groupMessagesDirOf(dir) {
  return join(dir, 'messages')
}

/**
 * 进程内按 key 串行：两个窗口同一秒读同一条群消息时，read_by 的读改写别互相覆盖。
 * 跟 windowsLock 一个套路，只是按群/消息分 key。
 */
const groupLocks = new Map()
function withGroupLock(key, fn) {
  const prev = groupLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const next = run.then(() => undefined, () => undefined)
  groupLocks.set(key, next)
  next.then(() => {
    if (groupLocks.get(key) === next) groupLocks.delete(key)
  })
  return run
}

/** 解散后群在 groups/<名>.archived-<时间>/；同名的取最新那份。 */
async function findArchivedGroup(name) {
  let entries
  try {
    entries = await readdir(GROUPS, { withFileTypes: true })
  } catch {
    return undefined
  }
  const prefix = `${name}${ARCHIVED_SUFFIX}`.toLowerCase()
  const hits = entries
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
    .map((entry) => entry.name)
    .sort()
  return hits.length === 0 ? undefined : hits[hits.length - 1]
}

/**
 * 读一个群：活动目录优先，没有就找归档。读侧两个都认，写侧必须先看 archived。
 * 活动目录存在但 meta 坏了也继续去找归档 —— 宁可说「没有」，也别拿半截 meta 去发消息。
 */
async function loadGroup(name) {
  const meta = await readJson(join(groupDirOf(name), 'meta.json'))
  if (meta !== null && textOf(meta.name) !== '') {
    return { name, dir: groupDirOf(name), meta, archived: meta.archived === true, archivedAs: undefined }
  }
  const archivedAs = await findArchivedGroup(name)
  if (archivedAs === undefined) return undefined
  const dir = join(GROUPS, archivedAs)
  const archivedMeta = await readJson(join(dir, 'meta.json'))
  return {
    name,
    dir,
    meta: archivedMeta ?? { name, creator: '', members: [], created_at: '', note: '', archived: true },
    archived: true,
    archivedAs
  }
}

/** 群成员名数组：顺手挡住手改坏 meta 的情况。 */
function groupMembersOf(meta) {
  return Array.isArray(meta?.members) ? meta.members.filter((name) => textOf(name) !== '').map(textOf) : []
}

/** 一个群的全部消息，新→旧（同一毫秒里按 id 兜底，保证列表稳定）。 */
async function readGroupMessages(dir) {
  const messagesDir = groupMessagesDirOf(dir)
  let files
  try {
    files = await readdir(messagesDir)
  } catch {
    return []
  }
  const rows = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const msg = await readJson(join(messagesDir, file))
    if (msg === null || textOf(msg.id) === '') continue
    rows.push(msg)
  }
  rows.sort((a, b) => {
    const left = textOf(a.created_at)
    const right = textOf(b.created_at)
    if (left === right) return textOf(a.id) < textOf(b.id) ? 1 : -1
    return left < right ? 1 : -1
  })
  return rows
}

/** 按完整 id 或 8 位短 id 找一条群消息；短 id 撞车就报歧义，不瞎猜。 */
async function findGroupMessage(dir, input) {
  const messagesDir = groupMessagesDirOf(dir)
  let files
  try {
    files = await readdir(messagesDir)
  } catch {
    return undefined
  }
  const matches = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)
    if (id === input || id.startsWith(input)) matches.push(id)
  }
  if (matches.length === 0) return undefined
  if (matches.length > 1) return { ambiguous: matches }
  const msg = await readJson(join(messagesDir, `${matches[0]}.json`))
  return msg === null ? undefined : { msg }
}

/** 记一次已读：同一个名字只记一次，顺序按第一次读到。 */
async function markGroupRead(dir, id, reader) {
  const path = join(groupMessagesDirOf(dir), `${id}.json`)
  return withGroupLock(`group-msg:${path}`, async () => {
    const msg = await readJson(path)
    if (msg === null) return undefined
    const readBy = Array.isArray(msg.read_by) ? msg.read_by.filter((name) => typeof name === 'string') : []
    if (!readBy.includes(reader)) {
      readBy.push(reader)
      msg.read_by = readBy
      await writeJsonAtomic(path, msg)
    }
    return msg
  })
}

/** 摘要是给人扫的：正文只留前 80 个字，全文得再点一次（防一拉全塞进上下文）。 */
function groupPreview(text, max = 80) {
  const chars = Array.from(textOf(text))
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

/** 一条消息的摘要（bus_group_read 不带 msg_id 时用）。 */
function groupSummary(msg, reader) {
  const readBy = Array.isArray(msg.read_by) ? msg.read_by : []
  return {
    id: textOf(msg.id),
    from: textOf(msg.from),
    at: localTime(msg.created_at),
    kind: msg.kind === 'mention' ? 'mention' : 'broadcast',
    to: Array.isArray(msg.to) ? msg.to : [],
    preview: groupPreview(msg.text),
    read: readBy.includes(reader),
    requires_ack: msg.requires_ack === true
  }
}

/** 群里的「我是谁」：必须已注册且 active —— 跟 bus_post 同一个门槛。 */
async function groupActor(exec, tool) {
  const selfId = sessionIdOf(exec)
  if (selfId === undefined) {
    throw new Error(`${tool}: 拿不到当前会话 id（工具上下文里没有 agent.session.id），先确认窗口正常，或显式注册。`)
  }
  const registry = await readWindows()
  const selfName = nameIndex(registry).byId.get(selfId)
  if (selfName === undefined) {
    throw new Error(`${tool}: 你还没报名（当前会话没有对应的注册名）。先调一次 bus_register，群里只认注册名。`)
  }
  if (registry.windows?.[selfName]?.active === false) {
    throw new Error(`${tool}: 名字「${selfName}」是 inactive 状态，先重新 bus_register 点亮。`)
  }
  return { selfId, selfName, registry }
}

/** 建群者判定：名字对上（换棒后新窗口同名继承）或会话 id 对上（同一窗口换了名字）都算。 */
function isGroupCreator(meta, selfName, selfId) {
  if (textOf(meta?.creator) !== '' && meta.creator === selfName) return true
  return textOf(meta?.creator_session_id) !== '' && meta.creator_session_id === selfId
}

/** 我未读几条：自己写的不算未读（不然发完广播一看「你可能还有 5 条未读」很蠢）。 */
function groupUnread(rows, selfName) {
  return rows.filter((msg) => textOf(msg.from) !== selfName && !(Array.isArray(msg.read_by) ? msg.read_by : []).includes(selfName)).length
}

/** 当前窗口能不能进这个群：creator 或成员。不是成员连读都不给（群内信息不外流）。 */
function assertMember(meta, selfName, selfId, tool, groupName) {
  const members = groupMembersOf(meta)
  if (isGroupCreator(meta, selfName, selfId)) return members
  if (!members.includes(selfName)) {
    throw new Error(`${tool}: 你（${selfName}）不在群「${groupName}」里，看不了也发不了。要参与请让建群者（${textOf(meta?.creator) || '建群者'}）把你拉进去。`)
  }
  return members
}

/* ────────────────────────────── 工具 ────────────────────────────── */

function register(ctx, definition) {
  ctx.tools.register(definition)
}

/** 本跳是第几跳：显式 hops 优先；否则内存里的上一次 +1；再否则 windows.json 的 last_inbound +1。 */
function resolveHops(args, selfId, selfName, registry) {
  if (Number.isFinite(args.hops)) return Math.max(0, Math.trunc(args.hops))
  const inbound = selfId === undefined ? undefined : inboundHops.get(selfId)
  if (inbound !== undefined) return inbound + 1
  const last = registry?.windows?.[selfName]?.last_inbound?.hops
  return Number.isFinite(last) ? Math.max(0, Math.trunc(last)) + 1 : 0
}

/** 接收方看到的宣告行（快路径）。 */
function hopPrefix(hops, fromLabel) {
  return `[总线 · hops=${hops} · 来自 ${fromLabel}]`
}

const REGISTER_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', description: '给这个窗口起的名字，之后别的窗口 bus_send / bus_post 直接用它当 session_id 或收件人。同名重注册 = 覆盖会话 id（幂等，不会堆多条）。' },
    note: { type: 'string', description: '可选备注，比如「管文档的」「跑长任务的」，方便别人一眼挑人。' },
    session_id: { type: 'string', description: '可选。当前会话 id；不传时插件从工具上下文（exec.agent.session.id）自动取。拿不到才需要你手填。' },
    role: { type: 'string', enum: ['主窗', '专业窗口'], description: '可选。星型拓扑靠它判断「要不要经主窗」；不传时首次注册记「未标注」，之后不覆盖已有值。' },
    generation: { type: 'number', description: '可选。第几棒（换窗时 +1，不自动推断）。不传时保留旧值。' },
    handoff_from: { type: 'string', description: '可选。接的谁的活（上一棒的名字）。不传时保留旧值。' }
  }
}

const SEND_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['session_id', 'text'],
  properties: {
    session_id: { type: 'string', description: '目标会话：可以是注册名（先 bus_register 过的名字），也可以是原始 id（形如 session-xxxx，侧边栏会话右键菜单有「复制会话 ID」，或先用 bus_list 看）' },
    text: { type: 'string', description: '要投递给那个窗口的话。写清你是谁、要它做什么、什么时候回。' },
    mode: { type: 'string', enum: ['steer', 'queue'], description: 'steer ＝ 插到它下一个决策边界（正在跑也能收到）；queue ＝ 排队等这轮结束。默认 steer，失败自动退 queue。' },
    hops: { type: 'number', description: '可选。这条消息是第几跳（人直接开的话题 = 0）。不传时插件自动用「你上一条收到的 hops + 1」；总量上限 3 跳，超了会被拒。' },
    from: { type: 'string', description: '可选。发信方署名，覆盖自动推断的注册名/短 id。' }
  }
}

const POST_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['to', 'text'],
  properties: {
    to: { type: 'string', description: '收件人名字（bus_register 过的名字）。信箱按名字分目录，所以这里只认名字，不认原始 session id。' },
    text: { type: 'string', description: '正文，上限 8KB（约 4000 汉字）。超长就写文件只发路径 —— 插件不截断。' },
    hops: { type: 'number', description: '可选。这条消息是第几跳（人直接开的话题 = 0）。不传时插件自动用「你上一条收到的 hops + 1」；总量上限 3 跳，超了会被拒。' },
    requires_ack: { type: 'boolean', description: '可选。true 时收件人要 bus_ack 回执，120 秒没回执标 unconfirmed 并通知你。默认 false（回执要花对方一次 token）。' },
    mode: { type: 'string', enum: ['steer', 'queue'], description: '可选。首选投递方式，默认 queue；steer 失败自动退 queue，不算失败。' }
  }
}

const ACK_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['msg_id'],
  properties: {
    msg_id: { type: 'string', description: '要回执的消息 id：投递前缀里的 id=xxxxxxxx（8 位短 id）或完整 uuid 都行。' }
  }
}

const LIST_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'number', description: '最多列几条，默认 15' }
  }
}

const COMMON_RENDER_NOTE = '对方收下了不等于做完了，要结果得等它回话或自己查文件。'

export function apply(ctx) {
  disposed = false
  pluginAbort = new AbortController()
  scanning = false
  dirsReady = false
  startScanner(ctx)

  // 订阅工作区的归档集合：归档会话跑不了模型步（DSH 的 ArchivedSessionGate 会拦），
  // 投进去的消息会被消费掉。这里维护一份快照，投递前先查。
  // workspaceController 不在 inject 里，访问要兜住：拿不到就静默降级，照常投。
  if (typeof ctx.effect === 'function') {
    try {
      startArchiveWatch(ctx)
    } catch {
      /* 没有工作区服务：退化成「照常投」，跟以前一样 */
    }
  }

  register(ctx, {
    name: 'bus_register',
    description: [
      '给自己这个窗口在总线上报名：把「当前会话 id ↔ 名字」写进 windows.json（身份档案）。',
      '之后别的窗口 bus_send / bus_post 时直接填这个名字就行，不用手抄会话 ID。',
      '当前会话 id 由插件自动从工具上下文取（拿不到才需要显式传 session_id）。',
      '同名重注册是覆盖，不会堆多条；同一个会话换了新名字时，旧名字标记成 inactive 保留（审计里的 from 才查得到人）。',
      '可顺手填 role（主窗/专业窗口）、generation（第几棒）、handoff_from（接的谁的活）。'
    ].join(''),
    parameters: REGISTER_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          registered: { type: 'boolean' },
          name: { type: 'string' },
          session_id: { type: 'string' },
          updated_at: { type: 'string' },
          previous_session_id: { type: 'string' },
          role: { type: 'string' },
          generation: { type: 'number' },
          note_truncated: { type: 'boolean' },
          replaced_names: { type: 'array', items: { type: 'string' } }
        },
        required: ['registered', 'name', 'session_id', 'updated_at']
      },
      render: (_a, value) => [{
        type: 'text',
        text: [
          `已登记：${value.name} → ${value.session_id}（${value.updated_at}）`,
          value.role === undefined ? '' : ` · ${value.role}`,
          Number.isInteger(value.generation) ? ` · 第 ${value.generation} 棒` : '',
          value.previous_session_id === undefined ? '' : `（覆盖了旧 id ${value.previous_session_id}）`,
          value.replaced_names !== undefined && value.replaced_names.length > 0 ? `（顺手把同一会话的旧名字标成 inactive：${value.replaced_names.join('、')}）` : '',
          value.note_truncated === true ? `（note 超过 ${NOTE_MAX_CHARS} 字，已截断，只存前 ${NOTE_MAX_CHARS} 个字符。）` : '',
          '别的窗口现在可以 bus_send / bus_post 到这个名字了。'
        ].join('')
      }]
    },
    presentCall: (args) => ({ card: 'generic', title: '总线报名', kind: 'execute', rawInput: { name: args.name } }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const name = textOf(args.name)
      if (name === '') throw new Error('bus_register: name 不能为空')
      const explicit = textOf(args.session_id)
      const id = explicit === '' ? sessionIdOf(exec) : explicit
      if (id === undefined) {
        throw new Error('bus_register: 拿不到当前会话 id（工具上下文里没有 agent.session.id），请显式传 session_id —— 侧边栏会话右键菜单有「复制会话 ID」。')
      }
      const wantedRole = args.role === '主窗' || args.role === '专业窗口' ? args.role : undefined
      const wantedGeneration = Number.isInteger(args.generation) ? args.generation : undefined
      const wantedHandoff = textOf(args.handoff_from)
      const incomingNote = textOf(args.note)
      return withWindows(async () => {
        const registry = await readWindows()
        const windows = registry.windows
        const existing = windows[name]
        const previous = textOf(existing?.session_id)
        // 补丁：note 落盘前按码点截到 NOTE_MAX_CHARS，静默截断不报错（老数据也顺手收一下）。
        const requestedNote = incomingNote !== '' ? incomingNote : textOf(existing?.note)
        const clippedNote = truncateChars(requestedNote, NOTE_MAX_CHARS)
        const now = localTime(new Date().toISOString())
        const replaced = []
        for (const [other, entry] of Object.entries(windows)) {
          if (other === name) continue
          if (textOf(entry?.session_id) !== id) continue
          // v0.3 是直接删；这里只退休 —— 删了审计里的 from 就成孤儿。
          entry.active = false
          replaced.push(other)
        }
        const changedSession = previous !== '' && previous !== id
        const next = {
          session_id: id,
          role: wantedRole ?? (existing?.role === '主窗' || existing?.role === '专业窗口' ? existing.role : '未标注'),
          generation: wantedGeneration ?? (Number.isInteger(existing?.generation) ? existing.generation : null),
          note: clippedNote.text,
          registered_at: textOf(existing?.registered_at) !== '' ? existing.registered_at : now,
          last_seen: now,
          // 同名真换棒时旧 handoff_from 说的是上一棒的来历，推不出信息就不猜，清成 null。
          handoff_from: wantedHandoff !== '' ? wantedHandoff : (changedSession ? null : (textOf(existing?.handoff_from) !== '' ? existing.handoff_from : null)),
          active: true
        }
        if (existing?.last_inbound !== undefined) next.last_inbound = existing.last_inbound
        windows[name] = next
        const written = await writeWindows(windows)
        return {
          registered: true,
          name,
          session_id: id,
          updated_at: written.updated_at,
          ...previous === '' || previous === id ? {} : { previous_session_id: previous },
          role: next.role,
          ...Number.isInteger(next.generation) ? { generation: next.generation } : {},
          ...clippedNote.truncated ? { note_truncated: true } : {},
          replaced_names: replaced
        }
      })
    }
  })

  register(ctx, {
    name: 'bus_send',
    description: [
      '给另一个窗口（另一个 DSH 会话）投递一条消息。这是唯一能让平级窗口互相说话的工具。',
      'code_agent 只能指挥自己起的后台会话，管不了别的窗口。',
      '先 bus_list 找目标，再 bus_send。session_id 可填注册名或原始 id。mode 默认 steer（实时插话），失败自动退 queue。',
      '投过去的话对它来说是一条「用户消息」，它会当成用户在跟它说话 —— 所以写清「我是谁、从哪来」要么干脆当普通对话写。',
      '每条消息带跳数 hops（人直接开的话题 = 0，转发 +1），最多 3 跳；另有一分钟 3 条的限流。',
      '投递成功只代表它收下了，不代表它做完了。要离线也能收到、要留档，用 bus_post。'
    ].join(''),
    parameters: SEND_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean' },
          session_id: { type: 'string' },
          name: { type: 'string' },
          mode: { type: 'string' },
          hops: { type: 'number' },
          from: { type: 'string' },
          msg_id: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['accepted', 'session_id', 'mode', 'hops', 'from']
      },
      render: (_a, value) => {
        const target = value.name === undefined ? value.session_id : `${value.name}（${value.session_id}）`
        return [{
          type: 'text',
          text: `已投递到 ${target}（${value.mode} · hops=${value.hops} · 来自 ${value.from}）${value.note === undefined ? '' : `。${value.note}`}。${COMMON_RENDER_NOTE}`
        }]
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '向另一个窗口发消息', kind: 'execute', rawInput: { session_id: args.session_id, mode: args.mode ?? 'steer', hops: args.hops } }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const targetInput = textOf(args.session_id)
      const text = textOf(args.text)
      if (targetInput === '') throw new Error('bus_send: session_id 不能为空')
      if (text === '') throw new Error('bus_send: text 不能为空')

      const registry = await readWindows()
      const { byName, byId } = nameIndex(registry)
      const targetId = byName.get(targetInput) ?? targetInput
      const targetName = byName.has(targetInput) ? targetInput : byId.get(targetId)

      const selfId = sessionIdOf(exec)
      const selfName = selfId === undefined ? undefined : byId.get(selfId)
      const selfLabel = textOf(args.from) !== ''
        ? textOf(args.from)
        : (selfId === undefined ? '' : (selfName ?? shortId(selfId))) || '匿名窗口'
      const hops = resolveHops(args, selfId, selfName, registry)
      const msgId = randomUUID()

      if (hops >= MAX_HOPS) {
        await appendMessage({
          at: new Date().toISOString(),
          event: 'send',
          msg_id: msgId,
          from: selfLabel,
          to: targetId,
          to_name: targetName,
          mode: args.mode === 'queue' ? 'queue' : 'steer',
          hops,
          ok: false,
          error: `hops=${hops} 已经到上限 ${MAX_HOPS} 跳`
        })
        throw new Error(`bus_send: 拒发 —— 这条会变成第 ${hops + 1} 跳（hops=${hops}，上限 ${MAX_HOPS} 跳），链路该收了。把结论直接回给主窗或发起人，别再往别的窗口转。`)
      }

      const now = Date.now()
      const hits = (recent.get(targetId) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
      if (hits.length >= RATE_MAX) {
        throw new Error(`bus_send: 对 ${targetId} 一分钟内已经发了 ${hits.length} 条（上限 ${RATE_MAX} 条），先停一下 —— 防环。真要继续就等一会儿。`)
      }
      hits.push(now)
      recent.set(targetId, hits)

      if (isArchivedSession(targetId)) {
        await appendMessage({
          at: new Date().toISOString(),
          event: 'send',
          msg_id: msgId,
          from: selfLabel,
          to: targetId,
          to_name: targetName,
          mode: args.mode === 'queue' ? 'queue' : 'steer',
          hops,
          ok: false,
          error: 'target-archived'
        })
        const who = targetName === undefined ? targetId : targetName
        throw new Error(
          `bus_send: 收件人「${who}」的会话现在是**归档状态**。\n` +
          'DSH 的 ArchivedSessionGate 会拦掉对归档会话的唤醒投递 —— 那一轮以 blocked 结束、消息被消费掉，等于白丢，所以我先拦下来了。\n' +
          '两个办法：\n' +
          '① 先让它解档（侧边栏会话右键 → 取消归档），再用 bus_send；\n' +
          '② 改用 bus_post —— 那条会留在它的信箱里，等它解档后自动补送。'
        )
      }

      const wanted = args.mode === 'queue' ? 'queue' : 'steer'
      const signal = exec !== void 0 && exec.signal !== void 0 ? exec.signal : new AbortController().signal
      const content = [{ type: 'text', text: `${hopPrefix(hops, selfLabel)}\n${text}` }]
      const send = async (mode) => ctx.sessionController.prompt({
        requestId: `bus-${msgId}`,
        sessionId: targetId,
        mode,
        content
      }, signal)

      let used = wanted
      let note
      try {
        await send(wanted)
      } catch (error) {
        if (wanted !== 'steer') {
          await appendMessage({ at: new Date().toISOString(), event: 'send', msg_id: msgId, from: selfLabel, to: targetId, to_name: targetName, mode: wanted, hops, ok: false, error: errorText(error).slice(0, 200) })
          throw error
        }
        await send('queue')
        used = 'queue'
        note = 'steer 不可用（对方当前接不了实时注入），已改为排队投递'
      }

      const stamp = localTime(new Date().toISOString())
      await appendMessage({ at: new Date().toISOString(), event: 'send', msg_id: msgId, from: selfLabel, to: targetId, to_name: targetName, mode: used, hops, ok: true, preview: text.slice(0, 120) })
      // 对方下一次转发时以这一跳为基准 +1。内存是快路径，落盘那份负责跨重启。
      inboundHops.set(targetId, hops)
      await updateWindows((windows) => {
        if (targetName !== undefined && windows[targetName] !== undefined) {
          windows[targetName].last_seen = stamp
          windows[targetName].last_inbound = { hops, msg_id: msgId, at: stamp }
        }
        if (selfName !== undefined && windows[selfName] !== undefined) windows[selfName].last_seen = stamp
      }).catch(() => {})

      return {
        accepted: true,
        session_id: targetId,
        ...targetName === undefined ? {} : { name: targetName },
        mode: used,
        hops,
        from: selfLabel,
        msg_id: msgId,
        ...note === undefined ? {} : { note }
      }
    }
  })

  register(ctx, {
    name: 'bus_post',
    description: [
      '把一条消息投进对方的信箱（不立刻投递，插件自己每 2 秒扫一次信箱再送）。',
      '跟 bus_send 的区别：bus_send 是快路径（当场送、你等结果、正文留在你这一轮上下文里）；',
      'bus_post 只落一个文件就返回 msg_id，对方离线也能收到、重启也不丢，适合派活和长交接。',
      'to 只认 bus_register 过的名字（信箱按名字分目录）；没报名的窗口收不到。',
      '入队就做闸门：from 必须已注册且 active、正文 ≤ 8KB、单发件人每天 ≤ 100 条、单收件人 pending ≤ 200 —— 超了直接拒，不截断。',
      'requires_ack: true 时对方要 bus_ack 回执，120 秒没回执标 unconfirmed 并给你发一条通知。默认 false。'
    ].join(''),
    parameters: POST_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean' },
          msg_id: { type: 'string' },
          to: { type: 'string' },
          hops: { type: 'number' },
          mode: { type: 'string' },
          requires_ack: { type: 'boolean' },
          expires_at: { type: 'string' },
          pending: { type: 'number' }
        },
        required: ['accepted', 'msg_id', 'to', 'hops', 'requires_ack']
      },
      render: (_a, value) => [{
        type: 'text',
        text: `已入信箱：→ ${value.to}（hops=${value.hops} · id=${value.msg_id.slice(0, 8)}${value.requires_ack ? ' · 要回执' : ''}）。扫描器马上来取，通常 2 秒内送到；${value.pending} 条在前面排队。`
      }]
    },
    presentCall: (args) => ({ card: 'generic', title: '投进信箱', kind: 'execute', rawInput: { to: args.to, hops: args.hops, requires_ack: args.requires_ack } }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const toInput = textOf(args.to)
      const rawText = typeof args.text === 'string' ? args.text : ''
      const text = rawText.trim()
      if (toInput === '') throw new Error('bus_post: to 不能为空')
      if (text === '') throw new Error('bus_post: text 不能为空')
      const bytes = utf8Bytes(rawText)
      if (bytes > MAX_TEXT_BYTES) {
        throw new Error(`bus_post: 正文 ${bytes} 字节，超过上限 ${MAX_TEXT_BYTES} 字节（约 4000 汉字）。超长就写文件只发路径 —— 不截断。`)
      }

      const selfId = sessionIdOf(exec)
      if (selfId === undefined) {
        throw new Error('bus_post: 拿不到当前会话 id（工具上下文里没有 agent.session.id），没法确认发件人身份。')
      }

      const registry = await readWindows()
      const { byName, byId } = nameIndex(registry)
      const selfName = byId.get(selfId)
      if (selfName === undefined) {
        throw new Error('bus_post: 你还没报名（当前会话没有对应的注册名）。先调一次 bus_register，再发 —— 信箱只认注册过的发件人。')
      }
      if (registry.windows[selfName]?.active === false) {
        throw new Error(`bus_post: 名字「${selfName}」是 inactive 状态，先重新 bus_register 点亮。`)
      }

      const toName = byName.has(toInput) ? toInput : byId.get(toInput)
      if (toName === undefined) {
        throw new Error(`bus_post: 「${toInput}」不是已注册的窗口名。信箱按名字分目录，先确认对方 bus_register 过（传名字，不要传 session id）。`)
      }
      if (registry.windows[toName]?.active === false) {
        throw new Error(`bus_post: 「${toName}」已退休（active: false），不投。要么让对方重新报名，要么换个目标。`)
      }

      const hops = resolveHops(args, selfId, selfName, registry)
      if (hops >= MAX_HOPS) {
        throw new Error(`bus_post: 拒收 —— 这条会变成第 ${hops + 1} 跳（hops=${hops}，上限 ${MAX_HOPS} 跳）。把结论直接回给主窗或发起人，别再往别的窗口转。`)
      }

      const pending = await pendingCount(toName)
      if (pending >= MAX_PENDING_PER_RECIPIENT) {
        throw new Error(`bus_post: ${toName} 的信箱已经积压 ${pending} 条（上限 ${MAX_PENDING_PER_RECIPIENT}），先等它消化完 —— 再灌就是拿它的上下文当垃圾桶。`)
      }
      const sentToday = await senderCountToday(selfName)
      if (sentToday >= MAX_PER_SENDER_DAY) {
        throw new Error(`bus_post: 你今天已经入队 ${sentToday} 条（上限 ${MAX_PER_SENDER_DAY}），这个数只拦脚本刷，正常交接碰不到。`)
      }

      const msg = await enqueueMessage({
        from: selfName,
        from_session: selfId,
        to: toName,
        hops,
        text,
        mode: args.mode === 'steer' ? 'steer' : 'queue',
        requires_ack: args.requires_ack === true
      })
      await updateWindows((windows) => {
        const entry = windows[selfName]
        if (entry !== undefined) entry.last_seen = localTime(new Date().toISOString())
      }).catch(() => {})
      kickScanner(ctx)
      return {
        accepted: true,
        msg_id: msg.id,
        to: toName,
        hops,
        mode: msg.mode,
        requires_ack: msg.requires_ack,
        expires_at: msg.expires_at,
        pending: pending + 1
      }
    }
  })

  register(ctx, {
    name: 'bus_ack',
    description: [
      '给一条 requires_ack 的消息回执：把 pending-ack/ 里那条标成 processed 并归档。',
      'msg_id 填投递前缀里的 id=xxxxxxxx（8 位短 id）或完整 uuid 都行。',
      '只认发给自己这个窗口的消息（调用方没报名时不校验收件人，但仍按 id 找）。',
      '回执是幂等的：已经回执过 / 已经超时标 unconfirmed 的，返回 acked:false 并说明，不报错。'
    ].join(''),
    parameters: ACK_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          acked: { type: 'boolean' },
          msg_id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['acked', 'msg_id']
      },
      render: (_a, value) => [{
        type: 'text',
        text: value.acked
          ? `已回执：${value.msg_id.slice(0, 8)}（${value.from} → ${value.to}）标成 processed 并归档。`
          : `没回成：${value.note ?? '没找到这条待确认的消息'}`
      }]
    },
    presentCall: (args) => ({ card: 'generic', title: '回执一条信箱消息', kind: 'execute', rawInput: { msg_id: args.msg_id } }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const target = textOf(args.msg_id)
      if (target === '') throw new Error('bus_ack: msg_id 不能为空')
      const selfId = sessionIdOf(exec)
      const registry = await readWindows()
      const selfName = selfId === undefined ? undefined : nameIndex(registry).byId.get(selfId)
      let names
      try {
        names = (await readdir(PENDING_ACK, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
      } catch {
        names = []
      }
      for (const name of names) {
        if (selfName !== undefined && name !== selfName) continue
        const dir = join(PENDING_ACK, name)
        let files
        try { files = await readdir(dir) } catch { continue }
        for (const file of files) {
          if (!file.endsWith('.json') || !file.includes(target)) continue
          const path = join(dir, file)
          const msg = await readJson(path)
          if (msg === null) continue
          const id = textOf(msg.id)
          if (id !== target && !id.startsWith(target)) continue
          if (selfName !== undefined && textOf(msg.to) !== selfName) continue
          msg.status = 'processed'
          msg.processed_at = new Date().toISOString()
          await archiveMessage(msg, path)
          await appendMessage({
            at: msg.processed_at,
            event: 'processed',
            msg_id: msg.id,
            from: msg.from,
            to: msg.to,
            hops: msg.hops,
            ok: true
          })
          return { acked: true, msg_id: msg.id, from: msg.from, to: msg.to }
        }
      }
      return {
        acked: false,
        msg_id: target,
        note: '没找到待确认的这条（可能已经回执过、120 秒超时标成了 unconfirmed、或者它本来就没要求回执）。'
      }
    }
  })

  register(ctx, {
    name: 'bus_list',
    description: '列出最近在动的 DSH 会话（从磁盘读 sessions 目录），含 session_id、已注册名字、工作区、最后活动时间、存档大小。找投递目标用。只读。',
    parameters: LIST_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: { session_id: { type: 'string' }, name: { type: 'string' }, workspace: { type: 'string' }, last_active: { type: 'string' }, size_kb: { type: 'number' } },
              required: ['session_id', 'last_active']
            }
          }
        },
        required: ['count', 'sessions']
      },
      render: (_a, value) => [{
        type: 'text',
        text: value.sessions.length === 0
          ? '没读到任何会话。'
          : ['最近的会话：', ...value.sessions.map((s) => `· ${s.name === undefined ? s.session_id : `${s.name}（${s.session_id}）`}  |  ${s.last_active}  |  ${s.size_kb ?? 0} KB  |  ${s.workspace ?? ''}`)].join('\n')
      }]
    },
    presentCall: () => ({ card: 'generic', title: '列出会话', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 15
      const sessions = await listSessions(limit)
      return { count: sessions.length, sessions }
    }
  })

  register(ctx, {
    name: 'bus_audit',
    description: '看窗口总线的投递记录（messages.jsonl 的最后若干条），含跳数 hops 和发信方 from。只读。查「谁给谁发过什么」用它。',
    parameters: LIST_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        properties: { count: { type: 'number' }, entries: { type: 'array', items: { type: 'object' } } },
        required: ['count', 'entries']
      },
      render: (_a, value) => [{
        type: 'text',
        text: value.entries.length === 0
          ? '还没有投递记录。'
          : value.entries.map((e) => {
            const from = e.from === undefined ? '' : `[${e.from}] `
            const hops = e.hops === undefined ? 'hops=?' : `hops=${e.hops}`
            const body = e.ok === false ? ' ❌ ' + (e.error ?? '') : ' ' + (e.preview ?? '')
            return `· ${e.at ?? e.raw} ${from}→ ${e.to ?? '?'}（${e.mode ?? '?'} · ${hops}）${body}`
          }).join('\n')
      }]
    },
    presentCall: () => ({ card: 'generic', title: '看投递记录', kind: 'read' }),
    isConcurrencySafe: () => true,
    async execute(args) {
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 20
      const entries = await readAudit(limit)
      return { count: entries.length, entries }
    }
  })

  /* ────────────────────────── v0.5 · 临时群聊的五个工具 ────────────────────────── */

  register(ctx, {
    name: 'bus_group_create',
    description: [
      '拉一个临时群（任务做完就解散）：把几个已注册的窗口拉进来，creator 记当前这个窗口。',
      '成员必须是 windows.json 里已注册且 active 的名字（用注册名，不是 session id）；建群者自动算成员。',
      '重名报错。建群后：广播只落盘、不推送（谁想读自己 bus_group_read 拉），点名只有建群者能发。',
      '群文件别指望总线搬：把文件写到共享目录，群里发路径 —— 总线只搬文本。'
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'members'],
      properties: {
        name: { type: 'string', description: '群名（也是目录名）：不能含 \\ / : * ? " < > | 或控制字符，不超 40 字，不能是 Windows 保留设备名。' },
        members: { type: 'array', items: { type: 'string' }, description: '成员名字（bus_register 过的注册名）。建群者会自动加进去，重复的会去重。' },
        note: { type: 'string', description: '可选备注，比如「今天把接口对齐」；解散后归档里还看得到。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          created: { type: 'boolean' },
          name: { type: 'string' },
          creator: { type: 'string' },
          members: { type: 'array', items: { type: 'string' } },
          member_count: { type: 'number' },
          created_at: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['created', 'name', 'creator', 'members', 'member_count', 'created_at']
      },
      render: (_a, value) => [{
        type: 'text',
        text: `已建群「${value.name}」（${value.member_count} 人 · ${value.created_at}）：${value.members.join('、')}，建群者 ${value.creator}。广播只落盘、一条 prompt 都不发；点名只有建群者能发。`
      }]
    },
    presentCall: (args) => ({ card: 'generic', title: '拉一个临时群', kind: 'execute', rawInput: { name: args.name, members: args.members } }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const name = textOf(args.name)
      const problem = groupNameProblem(name)
      if (problem !== undefined) throw new Error(`bus_group_create: ${problem}`)
      if (!Array.isArray(args.members)) {
        throw new Error('bus_group_create: members 必须是名字数组（可以只填别人，建群者会自动加进去）。')
      }
      const note = textOf(args.note)
      const { selfId, selfName, registry } = await groupActor(exec, 'bus_group_create')

      const members = []
      const candidates = []
      for (const raw of args.members) {
        const member = textOf(raw)
        if (member === '' || members.includes(member)) continue
        const entry = registry.windows?.[member]
        if (entry === undefined) {
          throw new Error(`bus_group_create: 「${member}」没在总线上报过名（windows.json 里没有），先让它 bus_register。`)
        }
        if (entry.active === false) {
          throw new Error(`bus_group_create: 「${member}」是 inactive（退休）状态，拉不进群；让它重新 bus_register 点亮。`)
        }
        candidates.push({ member, sessionId: textOf(entry.session_id) })
        members.push(member)
      }
      // 补丁：active 只是注册那一刻写的快照，从不更新 —— 按会话存档 mtime 复核一次，
      // 免得把一个三个月没动过的死窗口拉进群，点名投过去石沉大海。
      const archiveTimes = await sessionArchiveMtimes(candidates.map((candidate) => candidate.sessionId))
      const alive = []
      for (const { member, sessionId } of candidates) {
        const mtime = archiveTimes.get(sessionId)
        if (mtime === undefined) {
          throw new Error(`bus_group_create: 「${member}」找不到这个窗口的会话存档，可能已经删了；换个活着的窗口。`)
        }
        if (Date.now() - mtime.getTime() > MEMBER_STALE_MS) {
          throw new Error(`bus_group_create: 「${member}」这个窗口 7 天没动过（最后活跃 ${mtime.getMonth() + 1} 月 ${mtime.getDate()} 日），像是死会话，换个活着的窗口，或者先把那个窗口叫醒再拉。`)
        }
        alive.push([member, mtime])
      }
      // 活着的顺手把 last_seen 刷成存档 mtime；active 不动 —— 那个字段的语义另说。
      if (alive.length > 0) {
        await updateWindows((windows) => {
          for (const [member, mtime] of alive) {
            const entry = windows[member]
            if (entry !== undefined) entry.last_seen = localTime(mtime.toISOString())
          }
        })
      }
      // 建群者自己也是成员，否则连自己拉起来的群都读不了。
      if (!members.includes(selfName)) members.unshift(selfName)

      return withGroupLock(`group-create:${name.toLowerCase()}`, async () => {
        // Windows 目录大小写不敏感：`Qun` 和 `qun` 是同一个目录，得按名字扫一遍判重。
        let entries = []
        try {
          entries = await readdir(GROUPS, { withFileTypes: true })
        } catch {
          entries = []
        }
        const clash = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === name.toLowerCase())
        if (clash !== undefined) {
          const clashMeta = await readJson(join(GROUPS, clash.name, 'meta.json'))
          if (clashMeta === null) {
            throw new Error(`bus_group_create: groups/${clash.name}/ 目录在、但没有 meta.json（多半是上次建群崩在半路）。确认是残留就手动删掉那个目录，再重新建群。`)
          }
          throw new Error(`bus_group_create: 已经有同名群「${clash.name}」了。换个群名，或者先 bus_group_info 看看它是不是已经解散。`)
        }
        const createdAt = new Date().toISOString()
        const meta = {
          schema_version: SCHEMA_VERSION,
          name,
          creator: selfName,
          creator_session_id: selfId,
          members,
          created_at: createdAt,
          note,
          archived: false
        }
        await ensureDirs()
        await mkdir(groupMessagesDirOf(groupDirOf(name)), { recursive: true })
        await writeJsonAtomic(join(groupDirOf(name), 'meta.json'), meta)
        return {
          created: true,
          name,
          creator: selfName,
          members,
          member_count: members.length,
          created_at: localTime(createdAt),
          note
        }
      })
    }
  })

  register(ctx, {
    name: 'bus_group_post',
    description: [
      '往临时群里发一条：不带 to = 广播，只把消息写进 groups/<群名>/messages/，一条 prompt 都不发（成员自己 bus_group_read 拉）；',
      '带 to=["名字"] = 点名，只推给被点名的窗口（正文 + requires_ack，收件人 bus_ack 回执），走跟信箱同一条投递管线。',
      '只有建群者能点名；其他成员带 to 直接报错（要派活请发广播，或请建群者代你点名），不做审批流。',
      '正文 ≤ 8KB，超了拒绝不截断；超长就写文件只发路径（总线只搬文本）。'
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['group', 'text'],
      properties: {
        group: { type: 'string', description: '群名（bus_group_create 时起的那个）。' },
        text: { type: 'string', description: '正文，上限 8KB（约 4000 汉字）。超长就写文件只发路径 —— 插件不截断。' },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: '可选。点名名单（成员名字）。不传 = 广播（零推送）；传了 = 只推给这些窗口，且只有建群者能传。'
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          posted: { type: 'boolean' },
          group: { type: 'string' },
          kind: { type: 'string' },
          msg_id: { type: 'string' },
          hops: { type: 'number' },
          to: { type: 'array', items: { type: 'string' } },
          pushed: { type: 'array', items: { type: 'string' } },
          requires_ack: { type: 'boolean' },
          at: { type: 'string' }
        },
        required: ['posted', 'group', 'kind', 'msg_id', 'hops', 'to', 'pushed', 'requires_ack']
      },
      render: (_a, value) => [{
        type: 'text',
        text: value.kind === 'mention'
          ? `已点名：群「${value.group}」→ ${value.to.join('、')}（hops=${value.hops} · id=${value.msg_id.slice(0, 8)} · 要回执）${value.pushed.length === 0 ? '。名单里只有你自己，所以没往外推。' : '。正文已经推进去，回执照旧 bus_ack。'}`
          : `已发广播到群「${value.group}」（id=${value.msg_id.slice(0, 8)} · hops=${value.hops}）。广播只落盘、一条 prompt 都不发 —— 成员自己 bus_group_read 拉。`
      }]
    },
    presentCall: (args) => ({ card: 'generic', title: '往群里发一条', kind: 'execute', rawInput: { group: args.group, to: args.to } }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const groupName = textOf(args.group)
      if (groupName === '') throw new Error('bus_group_post: group 不能为空')
      const rawText = typeof args.text === 'string' ? args.text : ''
      const text = rawText.trim()
      if (text === '') throw new Error('bus_group_post: text 不能为空')
      const bytes = utf8Bytes(rawText)
      if (bytes > MAX_TEXT_BYTES) {
        throw new Error(`bus_group_post: 正文 ${bytes} 字节，超过上限 ${MAX_TEXT_BYTES} 字节（约 4000 汉字）。超长就写文件只发路径 —— 不截断。`)
      }
      const wantsMention = args.to !== undefined && args.to !== null
      if (wantsMention && !Array.isArray(args.to)) {
        throw new Error('bus_group_post: to 必须是名字数组；要广播就别传 to。')
      }

      const loaded = await loadGroup(groupName)
      if (loaded === undefined) {
        throw new Error(`bus_group_post: 没有这个群「${groupName}」（groups/ 下找不到，也可能是打错字）。`)
      }
      if (loaded.archived) {
        throw new Error(`bus_group_post: 群「${groupName}」已经解散（归档成 ${loaded.archivedAs}），不能再发；要接着干就新建一个群。`)
      }
      const meta = loaded.meta
      const members = groupMembersOf(meta)
      const { selfId, selfName, registry } = await groupActor(exec, 'bus_group_post')
      const creator = isGroupCreator(meta, selfName, selfId)
      if (!creator && !members.includes(selfName)) {
        throw new Error(`bus_group_post: 你（${selfName}）不在群「${groupName}」里，不能发。`)
      }

      const mention = []
      if (wantsMention) {
        // 硬边界：点名能力只给建群者，别的成员用工具层直接拒，不走审批流。
        if (!creator) {
          throw new Error(`bus_group_post: 只有建群者（${textOf(meta.creator) || '建群者'}）能点名。要派活请发广播（不带 to），或请建群者代你点名。`)
        }
        for (const raw of args.to) {
          const member = textOf(raw)
          if (member === '' || mention.includes(member)) continue
          if (!members.includes(member)) {
            throw new Error(`bus_group_post: 「${member}」不是群「${groupName}」的成员，点不到。`)
          }
          const entry = registry.windows?.[member]
          if (entry === undefined || entry.active === false) {
            throw new Error(`bus_group_post: 「${member}」现在不在总线上（没注册或 inactive），点了也没人收。`)
          }
          mention.push(member)
        }
        if (mention.length === 0) throw new Error('bus_group_post: to 传了个空名单 —— 要广播就别传 to。')
      }

      const hops = resolveHops(args, selfId, selfName, registry)
      if (hops >= MAX_HOPS) {
        throw new Error(`bus_group_post: 拒发 —— 这条会变成第 ${hops + 1} 跳（hops=${hops}，上限 ${MAX_HOPS} 跳）。把结论直接回给主窗或发起人，别再往群里转。`)
      }

      // 点名点到自己也记在 to 里，但不用给自己发 prompt。
      const recipients = mention.filter((member) => member !== selfName)
      if (recipients.length > 0) {
        const sentToday = await senderCountToday(selfName)
        if (sentToday >= MAX_PER_SENDER_DAY) {
          throw new Error(`bus_group_post: 你今天已经入队 ${sentToday} 条（上限 ${MAX_PER_SENDER_DAY}），这个数只拦脚本刷，正常交接碰不到。`)
        }
        for (const recipient of recipients) {
          const pending = await pendingCount(recipient)
          if (pending >= MAX_PENDING_PER_RECIPIENT) {
            throw new Error(`bus_group_post: ${recipient} 的信箱已经积压 ${pending} 条（上限 ${MAX_PENDING_PER_RECIPIENT}），先等它消化完再点名 —— 广播不吃它的信箱。`)
          }
        }
      }

      const id = randomUUID()
      const createdAt = new Date().toISOString()
      const msg = {
        schema_version: SCHEMA_VERSION,
        id,
        group: groupName,
        kind: mention.length > 0 ? 'mention' : 'broadcast',
        from: selfName,
        from_session: selfId,
        to: mention,
        hops,
        text,
        created_at: createdAt,
        requires_ack: mention.length > 0,
        read_by: []
      }
      await ensureDirs()
      await mkdir(groupMessagesDirOf(groupDirOf(groupName)), { recursive: true })
      await writeJsonAtomic(join(groupMessagesDirOf(groupDirOf(groupName)), `${id}.json`), msg)

      // 广播到此为止：只落盘。不 enqueue、不 prompt、不 kickScanner —— 这就是「零推送」。
      if (recipients.length > 0) {
        for (const [index, recipient] of recipients.entries()) {
          const targetId = textOf(registry.windows?.[recipient]?.session_id)
          await enqueueMessage({
            id,
            group: groupName,
            // requestId 只用 ASCII：收件人短会话 id 兜底序号，别把中文名字塞进宿主认的 id 里。
            request_id: `bus-group-${id}-${targetId === '' ? index : shortId(targetId)}`,
            from: selfName,
            from_session: selfId,
            to: recipient,
            hops,
            text,
            mode: 'queue',
            requires_ack: true
          })
        }
        kickScanner(ctx)
      }

      await updateWindows((windows) => {
        const entry = windows[selfName]
        if (entry !== undefined) entry.last_seen = localTime(new Date().toISOString())
      }).catch(() => {})

      return {
        posted: true,
        group: groupName,
        kind: msg.kind,
        msg_id: id,
        hops,
        to: mention,
        pushed: recipients,
        requires_ack: msg.requires_ack,
        at: localTime(createdAt)
      }
    }
  })

  register(ctx, {
    name: 'bus_group_read',
    description: [
      '读临时群的消息。不带 msg_id：返回摘要列表（默认 20 条，新→旧，每条 id / 来自 / 时间 / 首 80 字 / 是否已读）——只给摘要，防一拉全塞进上下文。',
      '带 msg_id（完整 uuid 或投递前缀里的 8 位短 id）：返回那一条全文，并把当前窗口记进 read_by。',
      '看摘要不算已读；解散后的归档群也能只读回看（归档不再写 read_by）。'
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['group'],
      properties: {
        group: { type: 'string', description: '群名。' },
        msg_id: { type: 'string', description: '可选。要看全文的那条消息 id（完整或 8 位短 id）。不传就只拿摘要列表。' },
        limit: { type: 'number', description: '可选。摘要最多列几条，默认 20，最多 100。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          archived: { type: 'boolean' },
          archived_as: { type: 'string' },
          msg_id: { type: 'string' },
          from: { type: 'string' },
          at: { type: 'string' },
          kind: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          hops: { type: 'number' },
          text: { type: 'string' },
          requires_ack: { type: 'boolean' },
          read_by: { type: 'array', items: { type: 'string' } },
          marked_read: { type: 'boolean' },
          total: { type: 'number' },
          unread: { type: 'number' },
          shown: { type: 'number' },
          messages: { type: 'array', items: { type: 'object' } }
        },
        required: ['group', 'archived']
      },
      render: (_a, value) => {
        if (value.text !== undefined) {
          const who = value.to.length === 0 ? '全员（广播）' : value.to.join('、')
          return [{
            type: 'text',
            text: [
              `群「${value.group}」· ${value.from} · ${value.at} · id=${value.msg_id.slice(0, 8)} · hops=${value.hops} · → ${who}${value.requires_ack ? ' · 要回执' : ''}`,
              value.archived ? `（这个群已经解散，归档只读，没往 read_by 里记）` : (value.marked_read ? '（已把你记进 read_by）' : '（你之前读过这条）'),
              '',
              value.text,
              '',
              `read_by：${value.read_by.length === 0 ? '还没人读' : value.read_by.join('、')}`
            ].join('\n')
          }]
        }
        const lines = value.messages.map((msg) => [
          msg.read ? '●' : '○',
          msg.at,
          msg.from,
          msg.kind === 'mention' ? `[点名→${msg.to.join('、') || '?'}]` : '[广播]',
          msg.preview
        ].join(' '))
        return [{
          type: 'text',
          text: [
            `群「${value.group}」${value.archived ? '（已解散，归档只读）' : ''} · 共 ${value.total} 条 · 你未读 ${value.unread} 条 · 显示 ${value.shown} 条（新→旧）`,
            ...lines,
            '摘要只给前 80 字；要看全文：bus_group_read(group, msg_id)。看摘要不算已读。'
          ].join('\n')
        }]
      }
    },
    presentCall: (args) => ({ card: 'generic', title: '读群消息', kind: 'read', rawInput: { group: args.group, msg_id: args.msg_id } }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const groupName = textOf(args.group)
      if (groupName === '') throw new Error('bus_group_read: group 不能为空')
      const { selfId, selfName } = await groupActor(exec, 'bus_group_read')
      const loaded = await loadGroup(groupName)
      if (loaded === undefined) throw new Error(`bus_group_read: 没有这个群「${groupName}」。`)
      assertMember(loaded.meta, selfName, selfId, 'bus_group_read', groupName)

      const msgId = textOf(args.msg_id)
      if (msgId !== '') {
        const hit = await findGroupMessage(loaded.dir, msgId)
        if (hit === undefined) {
          throw new Error(`bus_group_read: 群「${groupName}」里找不到 id=${msgId} 的消息。先用不带 msg_id 的摘要列表看 id。`)
        }
        if (hit.ambiguous !== undefined) {
          throw new Error(`bus_group_read: 短 id ${msgId} 对上 ${hit.ambiguous.length} 条（${hit.ambiguous.map((id) => id.slice(0, 8)).join('、')}），把完整 id 传进来。`)
        }
        const before = Array.isArray(hit.msg.read_by) ? hit.msg.read_by : []
        const full = loaded.archived
          ? hit.msg
          : ((await markGroupRead(loaded.dir, textOf(hit.msg.id), selfName)) ?? hit.msg)
        const readBy = Array.isArray(full.read_by) ? full.read_by.filter((name) => typeof name === 'string') : []
        return {
          group: groupName,
          archived: loaded.archived,
          ...loaded.archivedAs === undefined ? {} : { archived_as: loaded.archivedAs },
          msg_id: textOf(full.id),
          from: textOf(full.from),
          at: localTime(full.created_at),
          kind: full.kind === 'mention' ? 'mention' : 'broadcast',
          to: Array.isArray(full.to) ? full.to : [],
          hops: Number.isInteger(full.hops) ? full.hops : 0,
          text: textOf(full.text),
          requires_ack: full.requires_ack === true,
          read_by: readBy,
          marked_read: !loaded.archived && !before.includes(selfName)
        }
      }

      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.trunc(args.limit))) : 20
      const rows = await readGroupMessages(loaded.dir)
      const messages = rows.slice(0, limit).map((msg) => groupSummary(msg, selfName))
      return {
        group: groupName,
        archived: loaded.archived,
        ...loaded.archivedAs === undefined ? {} : { archived_as: loaded.archivedAs },
        total: rows.length,
        unread: groupUnread(rows, selfName),
        shown: messages.length,
        messages
      }
    }
  })

  register(ctx, {
    name: 'bus_group_info',
    description: '看一个临时群的状态：成员（含 active / 谁是建群者）、消息总数、**我未读几条**、是否已解散（解散的给出归档目录名）。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['group'],
      properties: {
        group: { type: 'string', description: '群名。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          archived: { type: 'boolean' },
          archived_as: { type: 'string' },
          creator: { type: 'string' },
          is_creator: { type: 'boolean' },
          members: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, active: { type: 'boolean' }, creator: { type: 'boolean' } },
              required: ['name', 'active']
            }
          },
          member_count: { type: 'number' },
          message_count: { type: 'number' },
          unread: { type: 'number' },
          note: { type: 'string' },
          created_at: { type: 'string' },
          last_message_at: { type: 'string' }
        },
        required: ['group', 'archived', 'creator', 'members', 'member_count', 'message_count', 'unread']
      },
      render: (_a, value) => [{
        type: 'text',
        text: [
          `群「${value.group}」${value.archived ? `（已解散 · 归档 ${value.archived_as}）` : ''}：${value.member_count} 人 · ${value.message_count} 条消息 · 你未读 ${value.unread} 条`,
          `建群者：${value.creator}${value.is_creator ? '（就是你）' : ''} · 建于 ${value.created_at}`,
          `成员：${value.members.map((m) => `${m.name}${m.creator ? '（建群者）' : ''}${m.active ? '' : '（已退休）'}`).join('、') || '（空）'}`,
          value.note === '' ? '' : `备注：${value.note}`,
          value.last_message_at === '' ? '还没有消息。' : `最后一条：${value.last_message_at}`
        ].filter((line) => line !== '').join('\n')
      }]
    },
    presentCall: (args) => ({ card: 'generic', title: '看群状态', kind: 'read', rawInput: { group: args.group } }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const groupName = textOf(args.group)
      if (groupName === '') throw new Error('bus_group_info: group 不能为空')
      const { selfId, selfName } = await groupActor(exec, 'bus_group_info')
      const loaded = await loadGroup(groupName)
      if (loaded === undefined) throw new Error(`bus_group_info: 没有这个群「${groupName}」。`)
      const meta = loaded.meta
      assertMember(meta, selfName, selfId, 'bus_group_info', groupName)
      const members = groupMembersOf(meta)
      const rows = await readGroupMessages(loaded.dir)
      const registry = await readWindows()
      return {
        group: groupName,
        archived: loaded.archived,
        ...loaded.archivedAs === undefined ? {} : { archived_as: loaded.archivedAs },
        creator: textOf(meta.creator),
        is_creator: isGroupCreator(meta, selfName, selfId),
        members: members.map((name) => ({
          name,
          // 档案里查不到 = 不是 active 的窗口（可能换棒换了名字），不能当在线。
          active: registry.windows?.[name] !== undefined && registry.windows[name].active !== false,
          creator: name === meta.creator
        })),
        member_count: members.length,
        message_count: rows.length,
        unread: groupUnread(rows, selfName),
        note: textOf(meta.note),
        created_at: localTime(meta.created_at),
        last_message_at: rows.length === 0 ? '' : localTime(rows[0].created_at)
      }
    }
  })

  register(ctx, {
    name: 'bus_group_dissolve',
    description: [
      '解散一个临时群：只有建群者能做。目录改名归档成 groups/<群名>.archived-<YYYYMMDD-HHmm>/，不删 —— 消息都还在，之后还能只读回看。',
      '解散后不能再往这个群发消息；同名群可以重新建一个（旧的那个以归档目录的形式留着）。'
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['group'],
      properties: {
        group: { type: 'string', description: '要解散的群名。' }
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          dissolved: { type: 'boolean' },
          group: { type: 'string' },
          archived: { type: 'boolean' },
          archived_as: { type: 'string' },
          message_count: { type: 'number' },
          note: { type: 'string' }
        },
        required: ['dissolved', 'group', 'archived']
      },
      render: (_a, value) => [{
        type: 'text',
        text: value.dissolved
          ? `已解散群「${value.group}」→ 归档成 groups/${value.archived_as}（${value.message_count ?? 0} 条消息都在，不删）。`
          : `没解散：${value.note ?? `群「${value.group}」已经是归档状态（${value.archived_as ?? '?'}）。`}`
      }]
    },
    presentCall: (args) => ({ card: 'generic', title: '解散临时群', kind: 'execute', rawInput: { group: args.group } }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const groupName = textOf(args.group)
      if (groupName === '') throw new Error('bus_group_dissolve: group 不能为空')
      const { selfId, selfName } = await groupActor(exec, 'bus_group_dissolve')
      return withGroupLock(`group-dissolve:${groupName.toLowerCase()}`, async () => {
        const loaded = await loadGroup(groupName)
        if (loaded === undefined) throw new Error(`bus_group_dissolve: 没有这个群「${groupName}」。`)
        if (loaded.archived) {
          return {
            dissolved: false,
            group: groupName,
            archived: true,
            ...loaded.archivedAs === undefined ? {} : { archived_as: loaded.archivedAs },
            note: '这个群早就解散了（已经是归档状态），不用再解散一次。'
          }
        }
        if (!isGroupCreator(loaded.meta, selfName, selfId)) {
          throw new Error(`bus_group_dissolve: 只有建群者（${textOf(loaded.meta.creator) || '建群者'}）能解散群「${groupName}」。`)
        }
        const rows = await readGroupMessages(loaded.dir)
        const stamp = groupStamp()
        let archivedAs = `${groupName}${ARCHIVED_SUFFIX}${stamp}`
        // 同一分钟「解散 → 重建同名 → 再解散」才会撞名；撞了就加序号，别覆盖旧归档。
        for (let index = 2; await fileExists(join(GROUPS, archivedAs)); index += 1) {
          archivedAs = `${groupName}${ARCHIVED_SUFFIX}${stamp}-${index}`
        }
        // 先写 archived: true 再改名：归档目录里那份 meta 自己就说得清「我解散了」。
        const meta = { ...loaded.meta, archived: true, archived_at: new Date().toISOString() }
        await writeJsonAtomic(join(loaded.dir, 'meta.json'), meta)
        const target = join(GROUPS, archivedAs)
        let lastError
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await rename(loaded.dir, target)
            lastError = undefined
            break
          } catch (error) {
            lastError = error
            const code = error?.code
            if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
            await sleep(50)
          }
        }
        if (lastError !== undefined) {
          // 改名没成：把 meta 的 archived:true 撤回，别留下「目录还在、却说自己已解散」的半截状态。
          await writeJsonAtomic(join(loaded.dir, 'meta.json'), loaded.meta).catch(() => {})
          throw new Error(`bus_group_dissolve: 目录改名失败（${errorText(lastError)}）。群还在 groups/${groupName}，稍后重试一次。`)
        }
        return { dissolved: true, group: groupName, archived: true, archived_as: archivedAs, message_count: rows.length }
      })
    }
  })
}

export const name = 'window-bus'
export const inject = ['tools', 'sessionController']
export default { name, inject, apply }
