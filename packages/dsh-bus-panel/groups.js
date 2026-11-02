/**
 * dsh-bus-panel · 群数据层（零依赖，只用 node: 内置模块）
 *
 * 数据源（跟 dsh-window-bus 插件共用，只读 + 追加）：
 *   <root>/groups/<群名>/meta.json
 *   <root>/groups/<群名>/messages/<id>.json
 *   <root>/groups/<群名>.archived-YYYYMMDD-HHmm/   解散后的归档，只读
 *
 * 这一层是从同目录 server.mjs 复制抽取的纯数据逻辑，不碰 HTTP、不监听端口。
 * server.mjs / 8767 面板保持原样，继续能跑；后续可以让 server.mjs 改成引用本文件。
 *
 * 硬规矩：
 *   - 群名只认 groups/ 下实际枚举到的目录，不接受任意拼接
 *   - 所有落盘路径 resolve 后必须仍在 GROUPS_DIR 内
 *   - 广播只新建 groups/<群>/messages/<uuid>.json，不改 meta.json / windows.json /
 *     messages.jsonl / 已有消息的 read_by
 *   - 归档群只读，appendBroadcast / appendMention 直接 409
 *   - 点名（appendMention）会往 inbox/<成员>/ 写信封，等于叫醒一个真窗口：
 *     身份、成员、配额全部照 dsh-window-bus/index.js 的 bus_group_post 核一遍再写
 */

import { appendFile, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 数据根目录：DSH_BUS_ROOT（测试专用）> DSH_WINDOW_BUS_DIR（跟 dsh-window-bus 同款）> 家目录。
 * 测试必须指到 %TEMP% 的副本：appendMention 会写 inbox/，真目录等于叫醒真窗口。
 */
export const ROOT = resolve(
  (process.env.DSH_BUS_ROOT ?? '').trim()
    || (process.env.DSH_WINDOW_BUS_DIR ?? '').trim()
    || join(homedir(), '大肥鱼的家', 'dsh-window-bus')
)
export const GROUPS_DIR = join(ROOT, 'groups')

/** 点名要用的三处总线文件：身份档案、投递审计、信箱根。只读 windows.json。 */
export const WINDOWS_FILE = join(ROOT, 'windows.json')
export const MESSAGES_FILE = join(ROOT, 'messages.jsonl')
export const INBOX_DIR = join(ROOT, 'inbox')

/** 未读游标文件；不跟总线数据放一起，避免被误当成消息。 */
export const STATE_FILE = resolve(
  (process.env.DSH_BUS_PANEL_STATE ?? '').trim()
    || join(HERE, 'panel-state.json')
)

/** 群名就是目录名：只放行中文、字母、数字、- 和 _（跟插件自己的限制取交集）。 */
const GROUP_ID_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,40}$/
/** 归档目录：<群名>.archived-YYYYMMDD-HHmm，撞名时插件会补 -2。 */
const ARCHIVED_ID_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,40}\.archived-\d{8}-\d{4}(?:-\d+)?$/

const MAX_TEXT_CHARS = 8000 // 跟总线单条 8KB 的闸门对齐
const DEFAULT_LIMIT = 50 // 只给 getGroupView 的调用方参考，实际截断在 HTTP 层
const MAX_LIMIT = 500

// ── 点名用的总线常量：全部照抄 dsh-window-bus/index.js ──────────────────────
const MAX_TEXT_BYTES = 8 * 1024 // 插件 MAX_TEXT_BYTES
const MAX_HOPS = 3 // 插件 MAX_HOPS
const MSG_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 插件 MSG_TTL_MS
const MAX_PER_SENDER_DAY = 100 // 插件 MAX_PER_SENDER_DAY
const MAX_PENDING_PER_RECIPIENT = 200 // 插件 MAX_PENDING_PER_RECIPIENT
/** 人在面板上起的头 = 0 跳（跟 bus_post「人直接开的话题 = 0」一致）。 */
const MENTION_HOPS = 0

const SELF = { from: '用户', session: 'human' }

/** 数据层错误：status 跟 HTTP 语义对齐，宿主半直接映射。 */
export class BusPanelError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'BusPanelError'
    this.status = status
  }
}

function textOf(value) {
  return typeof value === 'string' ? value : ''
}

function firstLine(text, max) {
  const flat = textOf(text).replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
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

function memberListOf(meta) {
  const members = Array.isArray(meta?.members) ? meta.members : []
  return members
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim())
}

// ── 点名：身份 / 候选 / 配额 / 审计（照 server.mjs 与插件同款口径） ──────────

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
  const body = textOf(id).replace(/^session-?/i, '')
  return body === '' ? textOf(id) : body.slice(0, 8)
}

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/** 成员名要当 inbox/ 下的目录名用：跟群名同一套底线，别让手改坏的 meta 拼出路径。 */
const MEMBER_NAME_BAD = /[\\/:*?"<>|\u0000-\u001f]/
function isSafeMemberName(name) {
  return typeof name === 'string'
    && name !== ''
    && name === name.trim()
    && Array.from(name).length <= 60
    && !MEMBER_NAME_BAD.test(name)
    && !/^[.\s]|[.\s]$/.test(name)
}

/** 读 windows.json；读不出来就当空档案，别让面板 500。 */
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

/**
 * 点名要用哪个身份发：群 meta 里的建群者。
 * 三道关跟插件 isTrustedSender 完全一致，过不了就别写 —— 写了也只会被扫描器
 * 当成不可信发件人留在 inbox/ 里等过期。
 */
export function creatorIdentity(entry, registry) {
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
export function mentionCandidates(entry, registry) {
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
    console.warn('[dsh-bus-panel] 写审计失败（消息已经落盘）：', error?.message ?? error)
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
    const name = archivedMatch !== null
      ? archivedMatch[0].replace(/\.archived-.*$/, '')
      : (textOf(meta.name) || id)

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
export async function readGroupMessages(target) {
  const dir = typeof target === 'string' ? target : target?.dir
  if (typeof dir !== 'string' || dir === '') {
    throw new BusPanelError(400, 'readGroupMessages: 缺少群目录')
  }
  const resolvedDir = resolve(dir)
  if (!isInsideDir(GROUPS_DIR, resolvedDir)) {
    throw new BusPanelError(400, '群路径越界')
  }

  const messagesDir = join(resolvedDir, 'messages')
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
    members: memberListOf(meta),
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

function withSeen(group, state) {
  const raw = Number(state?.seen?.[group.id])
  const seen = Number.isFinite(raw)
    ? Math.max(0, Math.min(Math.trunc(raw), group.messageCount))
    : 0
  return { ...group, seenCount: seen, unread: group.messageCount - seen }
}

/** 读未读游标；坏文件/坏字段都当空档案，别让角标把整个面板拖挂。 */
export async function readPanelState() {
  const raw = await readJson(STATE_FILE)
  const state = { version: 1, seen: Object.create(null), updated_at: null, lastGroup: null }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return state
  if (raw.seen !== null && typeof raw.seen === 'object' && !Array.isArray(raw.seen)) {
    for (const [key, value] of Object.entries(raw.seen)) {
      const count = Number(value)
      if (typeof key === 'string' && key !== '' && Number.isFinite(count) && count >= 0) {
        state.seen[key] = Math.trunc(count)
      }
    }
  }
  if (typeof raw.updated_at === 'string') state.updated_at = raw.updated_at
  if (typeof raw.lastGroup === 'string' && raw.lastGroup !== '') state.lastGroup = raw.lastGroup
  return state
}

/**
 * 把某个群的已读游标设到 count（消息数）。只写 panel-state.json，不写群消息的 read_by。
 * @returns {{ id: string, seenCount: number }}
 */
export async function markGroupSeen(rawGroup, count) {
  const entry = await resolveGroupDir(rawGroup)
  const value = Number(count)
  if (!Number.isFinite(value) || value < 0) {
    throw new BusPanelError(400, 'count 必须是非负数字')
  }

  const state = await readPanelState()
  state.seen[entry.id] = Math.trunc(value)
  state.updated_at = new Date().toISOString()
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeJsonAtomic(STATE_FILE, state)
  return { id: entry.id, seenCount: state.seen[entry.id] }
}

/**
 * 记下「面板最后打开的那个群」—— 下次开面板自动回到这儿。
 * 群必须真实存在；传进来的群找不到就把记录清空，别在档案里留一个指不到的 id。
 * @returns {{ id: string | null }}
 */
export async function setLastGroup(rawGroup) {
  const state = await readPanelState()
  let id = null
  try {
    id = (await resolveGroupDir(rawGroup)).id
  } catch (error) {
    if (!(error instanceof BusPanelError)) throw error
    id = null
  }
  state.lastGroup = id
  state.updated_at = new Date().toISOString()
  await mkdir(dirname(STATE_FILE), { recursive: true })
  await writeJsonAtomic(STATE_FILE, state)
  return { id }
}

/**
 * 把请求里的 group 参数落到一个真实存在的群目录上。
 * 三道闸：类型/形状（正则）→ 枚举白名单 → resolve 后仍在 groups/ 内。
 */
export async function resolveGroupDir(rawGroup) {
  const id = textOf(rawGroup).trim()
  if (id === '') throw new BusPanelError(400, '缺少 group 参数')
  if (id.length > 200) throw new BusPanelError(400, 'group 参数太长')
  if (!GROUP_ID_RE.test(id) && !ARCHIVED_ID_RE.test(id)) {
    throw new BusPanelError(400, '群名不合法：只允许中文、字母、数字、-、_（归档群另带 .archived-<时间戳>）')
  }

  const entries = await scanGroupEntries()

  // 先按目录名精确匹配（活跃群的目录名就是群名）；没命中再按逻辑群名去归档里找最新那份，
  // 跟插件 loadGroup 的读侧一致：解散后说群名也还能看。
  let hit = entries.find((entry) => entry.id === id)
  if (hit === undefined) {
    // meta.name 跟目录名不一致的活跃群，按逻辑名兜底一次。
    hit = entries.find((entry) => !entry.archived && entry.name === id)
  }
  if (hit === undefined && GROUP_ID_RE.test(id)) {
    hit = entries
      .filter((entry) => entry.archived && entry.name === id)
      .sort((a, b) => (a.id < b.id ? 1 : -1))[0]
  }
  if (hit === undefined) throw new BusPanelError(404, `没有这个群：${id}`)

  const dir = resolve(hit.dir)
  if (!isInsideDir(GROUPS_DIR, dir)) throw new BusPanelError(400, '群路径越界')
  return { ...hit, dir }
}

/** 建群时可以拉的人：windows.json 里的窗口（面板前端用来做多选）。 */
export async function listWindows() {
  const registry = await readRegistry()
  const windows = registry?.windows ?? {}
  const rows = []
  for (const [name, entry] of Object.entries(windows)) {
    if (entry === null || typeof entry !== 'object') continue
    if (!isSafeMemberName(name)) continue
    rows.push({
      name,
      role: textOf(entry.role),
      active: entry.active !== false,
      online: activeSessionOf(registry, name) !== ''
    })
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : 1))
  return rows
}

/** 归档目录用的本地时间戳：YYYYMMDD-HHmm（跟插件的命名一致）。 */
function archiveStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/**
 * 建群时挑一个「建群者」：插件认的发件人必须是 windows.json 里 active、有 session_id 的窗口，
 * 面板自己不是窗口，所以这里替它挑 —— 优先主窗，其次最近活跃的那个。
 */
function pickCreator(registry) {
  const windows = registry?.windows ?? {}
  const pool = []
  for (const [name, entry] of Object.entries(windows)) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.active === false) continue
    if (!isSafeMemberName(name)) continue
    const sessionId = textOf(entry.session_id)
    if (sessionId === '') continue
    pool.push({ name, sessionId, role: textOf(entry.role), lastSeen: textOf(entry.last_seen) })
  }
  if (pool.length === 0) return null
  const mains = pool.filter((item) => item.role === '主窗')
  const finalists = mains.length > 0 ? mains : pool
  finalists.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
  return finalists[0]
}

/**
 * 面板里新建一个临时群。creator 由宿主代挑（见 pickCreator），成员只收真实注册过的名字。
 * @returns {{ id: string, name: string, creator: string, members: string[], note: string }}
 */
export async function createGroup(rawName, rawMembers, rawNote) {
  const name = textOf(rawName).trim()
  if (name === '') throw new BusPanelError(400, '群名不能为空')
  if (!GROUP_ID_RE.test(name)) {
    throw new BusPanelError(400, '群名不合法：只允许中文、字母、数字、-、_，最长 40 个字')
  }

  const taken = (await scanGroupEntries()).some((entry) => entry.name === name)
  if (taken) throw new BusPanelError(409, `已经有同名群「${name}」了（含已解散的），换个名字`)

  const registry = await readRegistry()
  const creator = pickCreator(registry)
  if (creator === null) {
    throw new BusPanelError(400, '总线上没有可用的窗口（都退休了）。先让一个窗口 bus_register，再来建群')
  }

  const members = [creator.name]
  for (const raw of Array.isArray(rawMembers) ? rawMembers : []) {
    const member = textOf(raw).trim()
    if (member === '' || members.includes(member)) continue
    if (!isSafeMemberName(member)) continue
    if (activeSessionOf(registry, member) === '') {
      throw new BusPanelError(400, `「${member}」没在总线上报名（windows.json 里没有），拉不进群`)
    }
    members.push(member)
  }

  const note = textOf(rawNote).trim().slice(0, 120)
  const meta = {
    schema_version: 1,
    name,
    creator: creator.name,
    creator_session_id: creator.sessionId,
    members,
    created_at: new Date().toISOString(),
    note,
    archived: false
  }

  const dir = resolve(join(GROUPS_DIR, name))
  if (!isInsideDir(GROUPS_DIR, dir)) throw new BusPanelError(400, '群路径越界')
  await mkdir(join(dir, 'messages'), { recursive: true })
  await writeJsonAtomic(join(dir, 'meta.json'), meta)

  return { id: name, name, creator: creator.name, members, note }
}

/**
 * 解散群：只有身份可信的建群者能解散（跟插件 bus_group_dissolve 同规矩）。
 * 只是把目录改名归档，消息一条不删，可以手动改回来。
 * @returns {{ id: string, from: string }}
 */
export async function dissolveGroup(rawGroup) {
  const entry = await resolveGroupDir(rawGroup)
  if (entry.archived) throw new BusPanelError(409, '这个群已经解散过了（归档只读）')

  const registry = await readRegistry()
  const identity = creatorIdentity(entry, registry)
  if (!identity.allowed) {
    throw new BusPanelError(403, `只有建群者能解散：${identity.reason}`)
  }

  let target = resolve(join(GROUPS_DIR, `${entry.name}.archived-${archiveStamp()}`))
  let attempt = 1
  while (true) {
    try {
      await readdir(target)
    } catch {
      break
    }
    attempt += 1
    target = resolve(join(GROUPS_DIR, `${entry.name}.archived-${archiveStamp()}-${attempt}`))
    if (attempt > 20) throw new BusPanelError(409, '归档目录撞名太多次，先清理一下 groups/')
  }
  if (!isInsideDir(GROUPS_DIR, target)) throw new BusPanelError(400, '归档路径越界')

  await rename(entry.dir, target)
  const meta = { ...(entry.meta ?? {}), archived: true, archived_at: new Date().toISOString() }
  await writeJsonAtomic(join(target, 'meta.json'), meta)

  return { id: `${entry.name}.archived-${archiveStamp()}`, from: entry.name }
}

/** 群列表：活跃在前、归档在后，各自按最后活跃时间倒序；带 seenCount/unread。 */
export async function listGroups() {
  const state = await readPanelState()
  const registry = await readRegistry()
  const groups = await Promise.all(
    (await scanGroupEntries()).map(async (entry) => {
      const messages = await readGroupMessages(entry.dir)
      return withSeen(summaryOf(entry, messages, registry), state)
    })
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

/** 单个群的摘要 + 完整消息（新→旧）。HTTP 层用它拼 /api/messages 的响应。 */
export async function getGroupView(rawGroup) {
  const entry = await resolveGroupDir(rawGroup)
  const messages = await readGroupMessages(entry.dir)
  const state = await readPanelState()
  const registry = await readRegistry()
  return { group: withSeen(summaryOf(entry, messages, registry), state), messages }
}

/** 广播：只新建消息文件，零推送、零审计行、不改任何已有文件。 */
export async function appendBroadcast(rawGroup, rawText) {
  const group = await resolveGroupDir(rawGroup)
  if (group.archived || group.meta?.archived === true) {
    throw new BusPanelError(409, `群「${group.name}」已经解散，归档只读，不能再发`)
  }

  const text = textOf(rawText).replace(/\r\n/g, '\n').trim()
  if (text === '') throw new BusPanelError(400, 'text 不能为空')
  if (Array.from(text).length > MAX_TEXT_CHARS) {
    throw new BusPanelError(413, `text 太长：上限 ${MAX_TEXT_CHARS} 字`)
  }

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
  if (!isInsideDir(GROUPS_DIR, resolve(file))) {
    throw new BusPanelError(400, '落盘路径越界')
  }

  await mkdir(messagesDir, { recursive: true })
  await writeJsonAtomic(file, message)
  return {
    message,
    file: `groups/${group.id}/messages/${message.id}.json`,
    group: { id: group.id, name: group.name, archived: false }
  }
}

export const limits = { DEFAULT_LIMIT, MAX_LIMIT, MAX_TEXT_CHARS }

/**
 * 点名：一条群消息 + 每个被点名的人一封 inbox 信封（requires_ack）。
 * 落盘格式、字段名、文件名、request_id、审计行全部照抄插件 bus_group_post + enqueueMessage，
 * 发件身份是「这个群的建群者」（插件里是当前窗口）。
 *
 * 这一步会叫醒真窗口：身份/成员/配额全部核完才写盘，任何一关不过就整体不写。
 * @param {string} rawGroup 群目录名（或归档群的逻辑名）
 * @param {string} rawText 正文
 * @param {string[]} rawToList 被点名的成员名
 */
export async function appendMention(rawGroup, rawText, rawToList) {
  const group = await resolveGroupDir(rawGroup)
  if (group.archived || group.meta?.archived === true) {
    throw new BusPanelError(409, `群「${group.name}」已经解散，归档只读，不能再发`)
  }

  const text = textOf(rawText).replace(/\r\n/g, '\n').trim()
  if (text === '') throw new BusPanelError(400, 'text 不能为空')
  const bytes = utf8Bytes(text)
  if (bytes > MAX_TEXT_BYTES) {
    throw new BusPanelError(413, `正文 ${bytes} 字节，超过上限 ${MAX_TEXT_BYTES} 字节（约 4000 汉字）。超长就写文件只发路径 —— 面板不截断。`)
  }

  if (!Array.isArray(rawToList)) {
    throw new BusPanelError(400, 'to 必须是名字数组；要广播就别走点名')
  }

  const registry = await readRegistry()
  const identity = creatorIdentity(group, registry)
  if (!identity.allowed) {
    throw new BusPanelError(403, `点名发不出去：${identity.reason}`)
  }

  const members = memberListOf(group.meta)
  const to = []
  for (const raw of rawToList) {
    const name = textOf(raw).trim()
    if (name === '' || to.includes(name)) continue
    if (!isSafeMemberName(name)) throw new BusPanelError(400, `成员名不合法：${name}`)
    if (name === identity.name) {
      throw new BusPanelError(400, `不能点自己（${identity.name} 是发件人）—— 想让人看见就发广播`)
    }
    if (!members.includes(name)) throw new BusPanelError(400, `「${name}」不是群「${group.name}」的成员，点不到`)
    if (activeSessionOf(registry, name) === '') {
      throw new BusPanelError(409, `「${name}」现在不在总线上（没注册或 inactive），点了也没人收`)
    }
    to.push(name)
  }
  if (to.length === 0) throw new BusPanelError(400, 'to 传了个空名单 —— 要广播就别点名')

  // 配额跟插件 bus_group_post 同口径，写盘之前一次性核完。
  const sentToday = await senderCountToday(identity.name)
  if (sentToday >= MAX_PER_SENDER_DAY) {
    throw new BusPanelError(429, `建群者「${identity.name}」今天已经入队 ${sentToday} 条（上限 ${MAX_PER_SENDER_DAY}），先歇一会儿`)
  }
  for (const recipient of to) {
    const pending = await pendingCount(recipient)
    if (pending >= MAX_PENDING_PER_RECIPIENT) {
      throw new BusPanelError(429, `${recipient} 的信箱已经积压 ${pending} 条（上限 ${MAX_PENDING_PER_RECIPIENT}），先等它消化完再点名`)
    }
  }

  const id = randomUUID()
  const createdAt = new Date().toISOString()

  // 群消息：点名是「已经投出去」的状态；to 里记全部被点名的人。
  const message = {
    schema_version: 1,
    id,
    from: identity.name,
    from_session: identity.session_id,
    to,
    hops: MENTION_HOPS,
    text,
    created_at: createdAt,
    status: 'delivered',
    requires_ack: true,
    read_by: [],
    group: group.name,
    kind: 'mention'
  }

  const messagesDir = join(group.dir, 'messages')
  const messageFile = join(messagesDir, `${id}.json`)
  if (!isInsideDir(GROUPS_DIR, resolve(messageFile))) {
    throw new BusPanelError(400, '落盘路径越界')
  }
  await mkdir(messagesDir, { recursive: true })
  await writeJsonAtomic(messageFile, message)

  // 信箱信封：跟插件 enqueueMessage 同一个目录、同一个文件名规则、同一套字段。
  const stamp = compactStamp(new Date(createdAt))
  const files = []
  for (const [index, recipient] of to.entries()) {
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
      throw new BusPanelError(400, '信箱落盘路径越界')
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
    files.push(`inbox/${recipient}/${stamp}-${id}.json`)
  }

  return {
    message,
    file: `groups/${group.id}/messages/${message.id}.json`,
    group: { id: group.id, name: group.name, archived: false },
    as: identity.name,
    to,
    delivered: to,
    deliveredCount: to.length,
    files
  }
}
