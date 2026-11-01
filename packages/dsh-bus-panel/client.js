/**
 * dsh-bus-panel · 浏览器半（手写 CJS bundle，不 build）
 *
 * 加载方式：window.__ModuleLoader__.load({ id:'dsh-bus-panel', factory })
 * 只依赖平台内置的 react；不打包 React。
 *
 * 注册：
 *   main            key = 'bus-panel'   （中间主区域，替换会话显示）
 *   sidebar.panellist id = 'bus-panel'  （左侧栏顶部导航行）
 *
 * 未读：宿主 /groups 已经按 panel-state.json 的 seen 游标算好 unread，
 * 这里只负责显示和“点开群 → POST /seen”。
 */

window.__ModuleLoader__.load({
  id: 'dsh-bus-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    const STYLE_ID = 'dsh-bus-panel-style'
    const PANEL_ID = 'bus-panel'
    const PANEL_LABEL = '群聊'
    const REQUEST_HEADER = { 'x-bus-panel-request': '1' }

    let currentCtx = null

    const CSS = `
      .bp-root{height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;color:inherit;background:transparent;padding-top:var(--dsh-frame-top-clearance,0px);--bp-border:color-mix(in srgb,currentColor 14%,transparent);--bp-muted:color-mix(in srgb,currentColor 55%,transparent);--bp-hover:color-mix(in srgb,currentColor 7%,transparent);--bp-accent:var(--dsw-alias-state-business-primary,#4d6bfe);--bp-danger:var(--dsw-alias-state-error-primary,#d33);--bp-radius:var(--dsw-radius-md,8px)}
      .bp-root *{box-sizing:border-box}
      .bp-root button,.bp-root textarea{font:inherit}
      .bp-header{flex:none;min-height:56px;display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid var(--bp-border)}
      .bp-title{min-width:0;display:flex;flex-direction:column;gap:2px}
      .bp-title-main{font-size:16px;font-weight:600;line-height:20px}
      .bp-title-sub{font-size:12px;color:var(--bp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46vw}
      .bp-actions{margin-left:auto;display:flex;gap:8px;flex:none}
      .bp-btn{appearance:none;border:1px solid var(--bp-border);background:transparent;color:inherit;border-radius:var(--bp-radius);padding:6px 10px;cursor:pointer;font-size:13px;line-height:18px;white-space:nowrap}
      .bp-btn:hover{background:var(--bp-hover)}
      .bp-btn:disabled{opacity:.45;cursor:default}
      .bp-btn-primary{background:var(--bp-accent);border-color:transparent;color:#fff}
      .bp-btn-primary:hover{background:var(--bp-accent);filter:brightness(1.05)}
      .bp-body{flex:1;min-height:0;display:flex}
      .bp-groups{width:280px;flex:none;overflow:auto;padding:8px;border-right:1px solid var(--bp-border)}
      .bp-group{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;border-radius:var(--bp-radius);padding:9px 10px;cursor:pointer;margin:0 0 2px}
      .bp-group:hover{background:var(--bp-hover)}
      .bp-group-active{background:var(--bp-hover)}
      .bp-group-top{display:flex;align-items:center;gap:8px}
      .bp-group-name{font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
      .bp-unread{flex:none;min-width:18px;height:18px;line-height:18px;padding:0 6px;border-radius:9px;background:var(--bp-accent);color:#fff;font-size:11px;font-weight:600;text-align:center}
      .bp-group-meta{font-size:11px;color:var(--bp-muted);margin-top:3px;display:flex;gap:6px;flex-wrap:wrap}
      .bp-group-preview{font-size:12px;color:var(--bp-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bp-main{flex:1;min-width:0;display:flex;flex-direction:column}
      .bp-messages{flex:1;min-height:0;overflow:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px}
      .bp-msg{max-width:78%;align-self:flex-start}
      .bp-msg-own{align-self:flex-end}
      .bp-msg-mention{padding-left:10px;border-left:3px solid color-mix(in srgb,var(--bp-accent) 60%,transparent)}
      .bp-msg-mention .bp-msg-text{border:1px solid color-mix(in srgb,var(--bp-accent) 28%,transparent)}
      .bp-msg-meta{font-size:11px;color:var(--bp-muted);display:flex;gap:8px;align-items:center;margin:0 4px 3px}
      .bp-msg-from{font-weight:600;color:inherit}
      .bp-msg-text{background:var(--bp-hover);border-radius:10px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.5}
      .bp-msg-own .bp-msg-text{background:color-mix(in srgb,var(--bp-accent) 16%,transparent);border:1px solid color-mix(in srgb,var(--bp-accent) 30%,transparent)}
      .bp-tag{font-size:10px;padding:0 4px;border:1px solid var(--bp-border);border-radius:4px}
      .bp-tag-mention{border-color:color-mix(in srgb,var(--bp-accent) 50%,transparent);color:color-mix(in srgb,var(--bp-accent) 85%,currentColor)}
      .bp-msg-to{font-size:11px;color:var(--bp-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34vw}
      .bp-composer-wrap{flex:none;border-top:1px solid var(--bp-border)}
      .bp-modes{display:flex;gap:6px;align-items:center;padding:8px 16px 0;min-height:26px}
      .bp-mode{appearance:none;border:1px solid var(--bp-border);background:transparent;color:inherit;border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
      .bp-mode:hover{background:var(--bp-hover)}
      .bp-mode-active{background:color-mix(in srgb,var(--bp-accent) 16%,transparent);border-color:color-mix(in srgb,var(--bp-accent) 42%,transparent);font-weight:600}
      .bp-mode:disabled{opacity:.45;cursor:default}
      .bp-mode-note{font-size:11px;color:var(--bp-muted);margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bp-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 16px 0}
      .bp-chip{appearance:none;border:1px solid var(--bp-border);background:transparent;color:inherit;border-radius:999px;padding:2px 9px;font-size:12px;line-height:18px;cursor:pointer}
      .bp-chip:hover{background:var(--bp-hover)}
      .bp-chip-on{background:color-mix(in srgb,var(--bp-accent) 18%,transparent);border-color:color-mix(in srgb,var(--bp-accent) 45%,transparent);font-weight:600}
      .bp-chip-off{opacity:.42;text-decoration:line-through}
      .bp-chip-off:hover{background:transparent}
      .bp-chip-count{font-size:11px;color:var(--bp-muted);margin-left:2px}
      .bp-composer{flex:none;padding:10px 16px;display:flex;gap:8px;align-items:flex-end}
      .bp-input{flex:1;min-width:0;min-height:42px;max-height:140px;resize:vertical;background:transparent;color:inherit;border:1px solid var(--bp-border);border-radius:var(--bp-radius);padding:8px 10px;font-size:13px;line-height:1.45;outline:none}
      .bp-input:focus{border-color:var(--bp-accent)}
      .bp-input:disabled{opacity:.6}
      .bp-send{flex:none}
      .bp-notice{flex:none;padding:8px 16px;font-size:12px;color:var(--bp-muted);border-top:1px solid var(--bp-border)}
      .bp-error{color:var(--bp-danger)}
      .bp-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--bp-muted);font-size:13px;padding:24px;text-align:center}
      .bp-loading{padding:16px;color:var(--bp-muted);font-size:12px}
      @media (max-width:820px){.bp-groups{width:210px}}
      @media (max-width:620px){.bp-body{flex-direction:column}.bp-groups{width:auto;max-height:36%;border-right:0;border-bottom:1px solid var(--bp-border)}}
    `

    function ensureStyle() {
      if (typeof document === 'undefined') return
      let element = document.getElementById(STYLE_ID)
      if (element === null) {
        element = document.createElement('style')
        element.id = STYLE_ID
        document.head.appendChild(element)
      }
      element.textContent = CSS
    }

    async function request(path, options = {}) {
      const method = (options.method ?? 'GET').toUpperCase()
      const headers = { ...(options.headers ?? {}) }
      if (method === 'POST') Object.assign(headers, REQUEST_HEADER)
      if (options.body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(path, {
        method,
        headers,
        body: options.body,
        credentials: 'same-origin',
        cache: 'no-store'
      })
      const text = await response.text()
      let data = {}
      if (text !== '') {
        try { data = JSON.parse(text) } catch { data = {} }
      }
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`)
      }
      return data
    }

    const store = {
      state: { groups: [], loading: true, error: null },
      listeners: new Set(),
      timer: null,
      inFlight: false,
      subscribe(listener) {
        store.listeners.add(listener)
        if (store.listeners.size === 1) store.start()
        return () => {
          store.listeners.delete(listener)
          if (store.listeners.size === 0) store.stop()
        }
      },
      getSnapshot() {
        return store.state
      },
      set(next) {
        store.state = next
        for (const listener of store.listeners) listener()
      },
      onVisible() {
        if (!document.hidden) void store.load()
      },
      start() {
        if (store.timer !== null) return
        void store.load()
        store.timer = setInterval(() => {
          if (!document.hidden) void store.load()
        }, 5000)
        document.addEventListener('visibilitychange', store.onVisible)
      },
      stop() {
        if (store.timer !== null) {
          clearInterval(store.timer)
          store.timer = null
        }
        document.removeEventListener('visibilitychange', store.onVisible)
      },
      async load() {
        if (store.inFlight) return
        store.inFlight = true
        try {
          const data = await request('/bus-panel/api/groups')
          store.set({
            groups: Array.isArray(data.groups) ? data.groups : [],
            loading: false,
            error: null
          })
        } catch (error) {
          store.set({
            ...store.state,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          })
        } finally {
          store.inFlight = false
        }
      },
      reload() {
        return store.load()
      }
    }

    function useBusStore() {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })
    }

    function unreadOf(groups) {
      return groups.reduce((sum, group) => {
        if (group.archived) return sum
        return sum + (Number.isFinite(Number(group.unread)) ? Math.max(0, Number(group.unread)) : 0)
      }, 0)
    }

    function BusIcon(props) {
      const snapshot = useBusStore()
      const total = unreadOf(snapshot.groups)
      const size = Number(props.size) || 18
      const badge = total > 99 ? '99+' : String(total)
      return h('span', {
        style: {
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          flex: 'none',
          opacity: props.active ? 1 : 0.9
        }
      },
        h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
          h('path', { d: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' })
        ),
        total > 0 && h('span', {
          style: {
            position: 'absolute',
            top: -5,
            right: -7,
            minWidth: 15,
            height: 15,
            padding: '0 4px',
            borderRadius: 8,
            background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            color: '#fff',
            fontSize: 9,
            fontWeight: 600,
            lineHeight: '15px',
            textAlign: 'center',
            boxSizing: 'border-box',
            fontFamily: 'inherit',
            pointerEvents: 'none'
          }
        }, badge)
      )
    }

    function BusPanel() {
      const snapshot = useBusStore()
      const groups = snapshot.groups
      const [activeId, setActiveId] = React.useState(null)
      const [messages, setMessages] = React.useState([])
      const [msgLoading, setMsgLoading] = React.useState(false)
      const [msgError, setMsgError] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [sendError, setSendError] = React.useState(null)
      const [mode, setMode] = React.useState('broadcast')
      const [selected, setSelected] = React.useState([])
      const [sendNotice, setSendNotice] = React.useState(null)

      const listRef = React.useRef(null)
      const stickRef = React.useRef(true)
      const activeIdRef = React.useRef(null)
      const markedRef = React.useRef(-1)

      const active = React.useMemo(
        () => groups.find((group) => group.id === activeId) ?? null,
        [groups, activeId]
      )

      // 点名入口的可用性全由宿主算：archived / 建群者身份不可信时 allowed=false + reason。
      const mentionInfo = active?.mention ?? null
      const canMention = active !== null && !active.archived && mentionInfo?.allowed === true
      const candidates = Array.isArray(mentionInfo?.candidates) ? mentionInfo.candidates : []
      const mentionBlockedReason = active?.archived
        ? '群已解散，归档只读'
        : (mentionInfo === null
          // 旧宿主还没重启时 /groups 不带 mention 字段；说清楚原因，别让人以为群坏了。
          ? '宿主还没重启，点名接口未加载（重启 DSH 后可用）'
          : (mentionInfo.reason || '建群者身份不可信，点名发不出去'))

      React.useEffect(() => {
        if (activeId !== null && !groups.some((group) => group.id === activeId)) {
          setActiveId(null)
        }
      }, [groups, activeId])

      const loadMessages = React.useCallback(async (id, initial) => {
        if (initial) setMsgLoading(true)
        try {
          const data = await request(`/bus-panel/api/messages?group=${encodeURIComponent(id)}&limit=100`)
          if (activeIdRef.current !== id) return
          setMessages(Array.isArray(data.messages) ? data.messages : [])
          setMsgError(null)
          const count = Number(data.group?.messageCount) || 0
          if (count !== markedRef.current) {
            try {
              await request('/bus-panel/api/seen', {
                method: 'POST',
                body: JSON.stringify({ group: id, count })
              })
              if (activeIdRef.current !== id) return
              markedRef.current = count
              void store.reload()
            } catch {
              // 游标写失败不影响看消息；下次轮询再试。
            }
          }
        } catch (error) {
          if (activeIdRef.current === id) {
            setMsgError(error instanceof Error ? error.message : String(error))
          }
        } finally {
          if (initial) setMsgLoading(false)
        }
      }, [])

      React.useEffect(() => {
        if (activeId === null) {
          activeIdRef.current = null
          setMessages([])
          setMsgError(null)
          return undefined
        }

        activeIdRef.current = activeId
        markedRef.current = -1
        stickRef.current = true
        setMessages([])
        setMsgError(null)
        void loadMessages(activeId, true)

        const timer = setInterval(() => {
          if (!document.hidden) void loadMessages(activeId, false)
        }, 4000)

        return () => {
          clearInterval(timer)
          if (activeIdRef.current === activeId) activeIdRef.current = null
        }
      }, [activeId, loadMessages])

      React.useEffect(() => {
        const element = listRef.current
        if (element !== null && stickRef.current) element.scrollTop = element.scrollHeight
      }, [messages])

      const closePanel = () => {
        currentCtx?.layout?.selectPanel?.(null)
      }

      const selectGroup = (group) => {
        if (group.id === activeId) return
        setActiveId(group.id)
        setDraft('')
        setSendError(null)
        setSendNotice(null)
        setMode('broadcast')
        setSelected([])
        stickRef.current = true
      }

      const switchMode = (next) => {
        if (next === 'mention' && !canMention) {
          setSendNotice(`点名不可用：${mentionBlockedReason}`)
          return
        }
        setMode(next)
        setSendError(null)
        setSendNotice(null)
        if (next !== 'mention') setSelected([])
      }

      const toggleMember = (member) => {
        if (member.active !== true || !canMention) return
        setSelected((previous) => previous.includes(member.name)
          ? previous.filter((name) => name !== member.name)
          : [...previous, member.name])
        setSendNotice(null)
      }

      const send = async () => {
        if (active === null || active.archived || sending) return
        const text = draft.replace(/\r\n/g, '\n').trim()
        if (text === '') return
        const isMention = mode === 'mention'
        if (isMention) {
          if (!canMention) {
            setSendNotice(`点名不可用：${mentionBlockedReason}`)
            return
          }
          if (selected.length === 0) {
            setSendNotice('点名还没选人：先在下面的成员里选一个，或者切回「广播」')
            return
          }
        }
        setSending(true)
        setSendError(null)
        setSendNotice(null)
        try {
          await request(isMention ? '/bus-panel/api/mention' : '/bus-panel/api/messages', {
            method: 'POST',
            body: JSON.stringify(isMention
              ? { group: active.id, text, to: selected }
              : { group: active.id, text })
          })
          setDraft('')
          if (isMention) setSelected([])
          await loadMessages(active.id, false)
          void store.reload()
        } catch (error) {
          setSendError(error instanceof Error ? error.message : String(error))
        } finally {
          setSending(false)
        }
      }

      const onComposerKeyDown = (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return
        if (event.nativeEvent?.isComposing === true) return
        event.preventDefault()
        void send()
      }

      const onMessagesScroll = () => {
        const element = listRef.current
        if (element === null) return
        stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      }

      const groupItems = []
      if (snapshot.loading && groups.length === 0) {
        groupItems.push(h('div', { key: 'loading', className: 'bp-loading' }, '读取群列表…'))
      } else if (groups.length === 0) {
        groupItems.push(h('div', { key: 'empty', className: 'bp-loading' }, '总线里还没有群'))
      } else {
        for (const group of groups) {
          const unread = Number(group.unread) || 0
          groupItems.push(h('button', {
            key: group.id,
            type: 'button',
            className: `bp-group${group.id === activeId ? ' bp-group-active' : ''}`,
            onClick: () => selectGroup(group),
            title: group.note || group.name
          },
            h('div', { className: 'bp-group-top' },
              h('span', { className: 'bp-group-name' }, group.name || group.id),
              unread > 0 && h('span', { className: 'bp-unread' }, unread > 99 ? '99+' : String(unread))
            ),
            h('div', { className: 'bp-group-meta' },
              h('span', {}, group.archived ? '已解散' : `${Array.isArray(group.members) ? group.members.length : 0} 人`),
              group.lastMessageAt && h('span', {}, formatTime(group.lastMessageAt))
            ),
            group.lastMessagePreview && h('div', { className: 'bp-group-preview' },
              `${group.lastMessageFrom || ''}${group.lastMessageFrom ? '：' : ''}${group.lastMessagePreview}`
            )
          ))
        }
      }

      const ordered = messages.slice().reverse()
      const messageItems = ordered.map((message, index) => {
        const own = message.from === '用户'
        const isMention = message.kind === 'mention'
        const toNames = Array.isArray(message.to)
          ? message.to.filter((name) => typeof name === 'string' && name !== '')
          : []
        return h('div', {
          key: `${message.id || 'msg'}-${index}`,
          className: `bp-msg${own ? ' bp-msg-own' : ''}${isMention ? ' bp-msg-mention' : ''}`
        },
          h('div', { className: 'bp-msg-meta' },
            h('span', { className: 'bp-msg-from' }, message.from || '未知'),
            h('span', {}, formatTime(message.created_at)),
            isMention && h('span', { className: 'bp-tag bp-tag-mention' }, '点名'),
            message.requires_ack === true && h('span', { className: 'bp-tag' }, '需回执'),
            toNames.length > 0 && h('span', {
              className: 'bp-msg-to',
              title: `点名：${toNames.join('、')}`
            }, `@${toNames.join('、')}`)
          ),
          h('div', { className: 'bp-msg-text' }, message.text || '')
        )
      })

      let mainContent
      if (active === null) {
        mainContent = h('div', { className: 'bp-empty' }, groups.length === 0 ? '总线里还没有群' : '从左侧选一个群')
      } else {
        mainContent = h(React.Fragment, null,
          h('div', {
            className: 'bp-messages',
            ref: listRef,
            onScroll: onMessagesScroll
          },
            msgLoading && messages.length === 0
              ? h('div', { className: 'bp-empty' }, '加载消息…')
              : messageItems.length === 0
                ? h('div', { className: 'bp-empty' }, '这个群还没有消息')
                : messageItems
          ),
          msgError && h('div', { className: 'bp-notice bp-error' }, `消息读取失败：${msgError}`),
          sendError && h('div', { className: 'bp-notice bp-error' }, `发送失败：${sendError}`),
          sendNotice && h('div', { className: 'bp-notice bp-error' }, sendNotice),
          active.archived
            ? h('div', { className: 'bp-notice' }, '群已解散，归档只读 —— 广播和点名都发不出去')
            : h('div', { className: 'bp-composer-wrap' },
              h('div', { className: 'bp-modes' },
                h('button', {
                  type: 'button',
                  className: `bp-mode${mode === 'broadcast' ? ' bp-mode-active' : ''}`,
                  disabled: sending,
                  title: '广播：只落盘，不推送',
                  onClick: () => switchMode('broadcast')
                }, '广播'),
                h('button', {
                  type: 'button',
                  className: `bp-mode${mode === 'mention' ? ' bp-mode-active' : ''}`,
                  disabled: sending || !canMention,
                  title: canMention
                    ? `点名：把你选中的成员推进对方窗口（要回执）`
                    : `点名不可用：${mentionBlockedReason}`,
                  onClick: () => switchMode('mention')
                }, '点名'),
                h('span', { className: 'bp-mode-note' },
                  mode === 'mention'
                    ? `已选 ${selected.length} 人 · 以建群者 ${mentionInfo?.as || ''} 身份发送`
                    : (canMention
                      ? `点名会推送并叫醒对方窗口 · 以建群者 ${mentionInfo?.as || ''} 身份发送`
                      : `点名不可用：${mentionBlockedReason}`))
              ),
              mode === 'mention' && canMention && h('div', { className: 'bp-chips' },
                candidates.length === 0
                  ? h('span', { className: 'bp-chip-count' }, '这个群除了建群者没有别的成员')
                  : candidates.map((member) => {
                    const on = selected.includes(member.name)
                    return h('button', {
                      key: member.name,
                      type: 'button',
                      className: `bp-chip${on ? ' bp-chip-on' : ''}${member.active === true ? '' : ' bp-chip-off'}`,
                      disabled: sending || member.active !== true,
                      title: member.active === true
                        ? `点名 ${member.name}（推送并要回执）`
                        : '这个窗口现在不在总线上（没注册或 inactive），点了也收不到',
                      onClick: () => toggleMember(member)
                    }, `${on ? '✓ ' : ''}${member.name}`)
                  }),
                h('span', { className: 'bp-chip-count' }, `已选 ${selected.length} 人`)
              ),
              h('div', { className: 'bp-composer' },
                h('textarea', {
                  className: 'bp-input',
                  value: draft,
                  rows: 2,
                  placeholder: mode === 'mention'
                    ? '写点名正文…（Enter 发送，Shift+Enter 换行）'
                    : '发广播给群里所有窗口…（Enter 发送，Shift+Enter 换行）',
                  disabled: sending,
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: onComposerKeyDown
                }),
                h('button', {
                  type: 'button',
                  className: 'bp-btn bp-btn-primary bp-send',
                  disabled: sending || draft.trim() === '',
                  onClick: () => void send()
                }, sending
                  ? '发送中…'
                  : mode === 'mention'
                    ? `点名发送${selected.length > 0 ? `（${selected.length}）` : ''}`
                    : '发送广播')
              )
            )
        )
      }

      return h('div', { className: 'bp-root' },
        h('div', { className: 'bp-header' },
          h('div', { className: 'bp-title' },
            h('div', { className: 'bp-title-main' }, PANEL_LABEL),
            h('div', {
              className: 'bp-title-sub',
              title: active?.note || ''
            }, active === null
              ? '窗口总线临时群 · 只读浏览 + 广播 / 点名'
              : `${active.name}${active.archived ? ' · 已解散' : ''}${active.note ? ` · ${active.note}` : ''}`)
          ),
          h('div', { className: 'bp-actions' },
            h('button', {
              type: 'button',
              className: 'bp-btn',
              onClick: () => void store.reload()
            }, '刷新'),
            h('button', {
              type: 'button',
              className: 'bp-btn bp-btn-primary',
              onClick: closePanel
            }, '返回会话')
          )
        ),
        snapshot.error && h('div', { className: 'bp-notice bp-error' },
          `群列表读取失败：${snapshot.error}`,
          h('button', {
            type: 'button',
            className: 'bp-btn',
            style: { marginLeft: 8 },
            onClick: () => void store.reload()
          }, '重试')
        ),
        h('div', { className: 'bp-body' },
          h('div', { className: 'bp-groups' }, groupItems),
          h('div', { className: 'bp-main' }, mainContent)
        )
      )
    }

    const inject = ['slots', 'layout']

    function apply(ctx) {
      currentCtx = ctx
      ctx.effect(() => {
        ensureStyle()
        return () => {
          const element = document.getElementById(STYLE_ID)
          if (element !== null) element.remove()
        }
      }, 'bus-panel: styles')

      // 先注册面板，再注册入口：侧边栏点击时会检查 main 注册表里有没有这个 key。
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID, inject: () => ({}) },
        BusPanel
      ))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: PANEL_LABEL },
        BusIcon
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
