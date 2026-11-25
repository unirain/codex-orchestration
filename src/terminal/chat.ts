import { HostRejection } from '../host/server.ts'
import { randomUUID } from 'node:crypto'
import {
  Container,
  Editor,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  matchesKey,
} from '@earendil-works/pi-tui'
import type { ChatView, ChatEvent, ChatTicket, Question } from '../host/chat.ts'
import { clean, readable, stateName, title } from './presentation.ts'
import { messageBlock } from './message.ts'
import { viewCursor } from './cursor.ts'

type Request = (action: string, body?: Record<string, unknown>) => Promise<any>
type Selection = { ticket: ChatTicket; question: Question }
const accent = (s: string) => '\x1b[36m' + s + '\x1b[39m'
const dim = (s: string) => '\x1b[2m' + s + '\x1b[22m'
const theme = {
  selectedPrefix: accent,
  selectedText: accent,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
}

export async function terminalChat(request: Request, dir: string, repo: string) {
  const tui = new TuiMainScreen(new ProcessTerminal(), true)
  const transcript = new Container(),
    panel = new Text('', 0, 0),
    label = new Text('', 0, 0),
    body = new Container(),
    footer = new Text('', 0, 0)
  const makeEditor = () => new Editor(tui, { borderColor: accent, selectList: theme })
  const normal = makeEditor(),
    answer = makeEditor()
  for (const component of [transcript, panel, label, body, footer]) tui.addChild(component)
  let view: ChatView | undefined,
    legacy = false,
    connected = false,
    finished = false,
    refreshing = false,
    busy = false
  let selection: Selection | undefined,
    list: SelectList | undefined,
    notice = '',
    cursor = 0,
    initialized = false
  let lastAnswer: string | undefined
  let checkpoint: ReturnType<typeof viewCursor> | undefined
  let uncertain: { action: 'answer' | 'say'; params: Record<string, unknown>; draft: string } | undefined
  let beforeDisconnect = false,
    lastTrigger = '',
    connectionError = '',
    historyUpper: number | undefined
  const closed = Promise.withResolvers<void>()
  function line(s: string) {
    message({ kind: 'notice', text: s }, [])
  }
  function message(row: Pick<ChatEvent, 'kind' | 'ticket' | 'text'>, tickets: ChatTicket[]) {
    transcript.addChild(messageBlock(row, tickets))
    tui.requestRender()
  }
  function editor() {
    return selection ? answer : normal
  }
  function focus() {
    body.clear()
    body.addChild(list ?? editor())
    tui.setFocus(list ?? editor())
    draw()
  }
  function draw() {
    const tickets = view?.tickets ?? [],
      pending = tickets.filter((t) => t.question || t.attention)
    panel.setText(
      pending.length
        ? '\n' +
            pending
              .map((t) => 'AI 待答 · ' + title(t.id, tickets) + '\n' + clean(t.question?.text ?? t.attention))
              .join('\n')
        : '',
    )
    label.setText(
      list
        ? '选择待答问题 · ↑↓ 选择，Enter 确认，Esc 返回'
        : selection
          ? (selection.question.mode === 'continue'
              ? '回复并继续'
              : selection.ticket.pauseCause
                ? '仅保存答复'
                : '发送答复') +
            ' · ' +
            title(selection.ticket.id, tickets)
          : '❯ 你 · 输入消息',
    )
    const hint =
      list || selection
        ? 'Esc 返回草稿'
        : pending.length
          ? 'Ctrl+R 选择问题 · /status'
          : '/status 查看任务 · /help'
    footer.setText(
      [
        clean(repo),
        connected ? '已连接' : connectionError ? '连接中断' : '连接中',
        '待答 ' + pending.length,
        legacy ? '兼容模式：旧宿主' : null,
        hint,
        connectionError || notice,
      ]
        .filter(Boolean)
        .join('  ·  '),
    )
    tui.requestRender()
  }
  function currentQuestion(s: Selection) {
    return view?.tickets.find((t) => t.id === s.ticket.id)?.question
  }
  function choose() {
    if (busy || uncertain || selection) return
    const pending = view?.tickets.filter((t) => t.question) ?? []
    if (!pending.length) {
      notice = legacy ? '旧宿主不支持定向答复' : '当前没有待答问题'
      draw()
      return
    }
    list = new SelectList(
      pending.map((t) => ({
        value: t.id,
        label: title(t.id, view!.tickets),
        description: clean(t.question!.text),
      })),
      6,
      theme,
    )
    list.onCancel = () => {
      list = undefined
      focus()
    }
    list.onSelect = (item) => {
      const t = pending.find((t) => t.id === item.value)!
      list = undefined
      selection = { ticket: t, question: t.question! }
      answer.setText('')
      notice = ''
      focus()
    }
    focus()
  }
  function accepted() {
    editor().setText('')
    selection = undefined
    uncertain = undefined
    notice = '已收到'
    focus()
  }
  async function poll() {
    if (refreshing || finished) return
    refreshing = true
    try {
      let snapshot: ChatView
      try {
        snapshot = await request('chat-view')
        legacy = false
      } catch (e) {
        if (
          !(e instanceof HostRejection) ||
          !['Unknown Ticket', 'Unknown operation', 'Unknown command'].includes(e.message)
        )
          throw e
        const status = await request('status')
        legacy = true
        snapshot = {
          repo,
          tickets: status.tickets,
          version: 1,
          latest: 0,
          stream: 'legacy',
          faults: status.faults,
        }
      }
      if (finished) return
      const streamChanged = view?.stream !== snapshot.stream
      view = snapshot
      let boundary = 0
      if (!initialized || beforeDisconnect || streamChanged) {
        checkpoint = viewCursor(dir, snapshot.stream)
        const previous = checkpoint.read()
        cursor =
          previous !== undefined && (legacy || previous <= snapshot.latest)
            ? previous
            : legacy
              ? 0
              : Math.max(0, snapshot.latest - 8)
        boundary = legacy ? 0 : snapshot.latest
        historyUpper = cursor
        if (previous !== undefined || legacy || boundary > 0)
          line(
            previous === undefined
              ? '最近历史'
              : legacy || cursor < boundary
                ? '离线期间的进展'
                : '已接回当前对话',
          )
        initialized = true
        beforeDisconnect = false
      }
      for (;;) {
        const rows: ChatEvent[] = await request(legacy ? 'events' : 'chat-events', { after: cursor })
        if (finished) return
        for (const row of rows) {
          if (row.seq <= cursor) continue
          message(row, snapshot.tickets)
          cursor = row.seq
          if (row.kind === 'user') lastTrigger = row.id
        }
        if (rows.length) checkpoint!.save(cursor)
        else if (!legacy && boundary === 0 && cursor === 0) checkpoint!.save(0)
        if (rows.length < 100) break
      }
      if (uncertain && !legacy && !busy) {
        const item = uncertain
        const r = await request('submission', { id: item.params.id })
        if (r && uncertain === item) {
          const original = editor().getExpandedText() === item.draft
          if (original) accepted()
          else uncertain = undefined
          lastAnswer = r.ticket
          notice =
            r.status === 'paused'
              ? '答复已保存，仍暂停'
              : r.status === 'queued'
                ? '答复已保存，等待执行'
                : '已收到'
        }
      }
      connected = true
      connectionError = ''
      if (!busy && !uncertain && lastAnswer && notice.startsWith('答复已保存')) {
        const ticket = snapshot.tickets.find((t) => t.id === lastAnswer)
        if (ticket)
          notice = '答复已保存，' + (ticket.status === 'paused' ? '仍暂停' : stateName(ticket.status))
      }
      if (selection && !busy && !uncertain) {
        const q = currentQuestion(selection)
        if (q?.id !== selection.question.id) notice = '问题已过期，草稿已保留'
        else {
          selection.question = q
          selection.ticket = snapshot.tickets.find((t) => t.id === selection!.ticket.id)!
        }
      }
    } catch (e) {
      if (connected) beforeDisconnect = true
      connected = false
      connectionError = clean((e as Error).message)
    } finally {
      refreshing = false
      if (!finished) draw()
    }
  }
  function identify(s: string): ChatTicket {
    const tickets = view?.tickets ?? []
    const exact = tickets.find((t) => t.id === s)
    if (exact) return exact
    const index = Number(s) - 1
    if (/^\d+$/.test(s) && tickets[index]) return tickets[index]
    const matched = tickets.filter((t) => t.title === s || t.id.startsWith(s))
    if (matched.length === 1) return matched[0]
    throw Error('请用 /status 查看工单，并使用序号或唯一名称')
  }
  async function submit() {
    if (busy || list || finished) return
    const target = editor(),
      draft = target.getExpandedText()
    if (!draft.trim() && !uncertain) return
    busy = true
    try {
      if (!selection && draft.startsWith('/') && !uncertain) {
        const [cmd, ...parts] = draft.trim().split(/\s+/),
          arg = parts.join(' ')
        if (cmd === '/exit') {
          closed.resolve()
          return
        }
        if (cmd === '/reply') {
          normal.setText('')
          busy = false
          choose()
          return
        }
        if (cmd === '/status') line(readable('status', view ?? (await request('status'))))
        else if (cmd === '/help')
          line(
            '/status　任务与待答问题\n/reply　选择问题（Ctrl+R 保留正在写的草稿）\n/history　查看历史\n/show、/pause、/resume、/clear-excerpts　加任务序号或名称\n/trace　加发送标识\n/exit　离开聊天',
          )
        else if (cmd === '/history') {
          const end = historyUpper ?? cursor
          if (!end) line('已经到达历史起点')
          else {
            const after = Math.max(0, end - 100)
            const rows: ChatEvent[] = await request(legacy ? 'events' : 'chat-events', { after })
            line('更早的历史')
            for (const r of rows) if (r.seq <= end) message(r, view?.tickets ?? [])
            historyUpper = after
          }
        } else if (cmd === '/trace')
          line(readable('trace', await request('trace', { trigger: arg || lastTrigger })))
        else if (['/show', '/pause', '/resume', '/clear-excerpts'].includes(cmd)) {
          const t = identify(arg),
            value = await request(cmd.slice(1), { ticket: t.id })
          line(
            title(t.id, view!.tickets) +
              '\n' +
              readable(cmd.slice(1), cmd === '/show' ? { ...value, status: t.status } : value),
          )
        } else if (cmd !== '/status' && cmd !== '/help') throw Error('未知命令，输入 /help 查看')
        if (target.getExpandedText() === draft) target.setText('')
        return
      }
      if (selection && !uncertain && currentQuestion(selection)?.id !== selection.question.id)
        throw Error('问题已过期，答复草稿已保留')
      const submittedDraft = uncertain?.draft ?? draft
      const action = uncertain?.action ?? (selection ? 'answer' : 'say')
      const params = uncertain?.params ?? {
        id: randomUUID(),
        text: draft,
        ...(selection
          ? {
              ticket: selection.ticket.id,
              question: selection.question.id,
              mode: selection.question.mode,
              repo,
            }
          : {}),
      }
      let result
      try {
        result = await request(action, params)
      } catch (e) {
        if (!(e instanceof HostRejection)) uncertain = { action, params, draft: submittedDraft }
        else uncertain = undefined
        throw e
      }
      if (target.getExpandedText() === submittedDraft) accepted()
      else uncertain = undefined
      lastAnswer = result.ticket
      notice =
        result.status === 'paused'
          ? '答复已保存，仍暂停'
          : result.status === 'queued'
            ? '答复已保存，等待执行'
            : '已收到'
      if (legacy) message({ kind: 'user', text: draft }, view?.tickets ?? [])
    } catch (e) {
      notice = (uncertain ? '发送结果待确认，Enter 重试原提交 · ' : '') + clean((e as Error).message)
    } finally {
      busy = false
      draw()
      void poll()
    }
  }
  for (const ed of [normal, answer])
    ed.onSubmit = (text) => {
      ed.setText(text)
      void submit()
    }
  tui.addInputListener((data) => {
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) {
      closed.resolve()
      return { consume: true }
    }
    if (busy && (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+r') || matchesKey(data, 'enter')))
      return { consume: true }
    if (matchesKey(data, 'escape') && (selection || list) && !uncertain) {
      selection = undefined
      list = undefined
      notice = ''
      focus()
      return { consume: true }
    }
    if (!list && matchesKey(data, 'ctrl+r')) {
      choose()
      return { consume: true }
    }
    if (!list && (data === '\n' || matchesKey(data, 'ctrl+j') || matchesKey(data, 'shift+enter')))
      return undefined
    if (!list && matchesKey(data, 'enter')) {
      void submit()
      return { consume: true }
    }
    return undefined
  })
  focus()
  tui.start()
  const timer = setInterval(() => void poll(), 750)
  try {
    await poll()
    await closed.promise
  } finally {
    finished = true
    clearInterval(timer)
    tui.stop()
  }
}
