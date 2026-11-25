import { stripVTControlCharacters } from 'node:util'
import type { ChatTicket } from '../host/chat.ts'

export const clean = (value: unknown) =>
  stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
const states: Record<string, string> = {
  running: '执行中',
  queued: '等待执行',
  pending: '等待执行',
  paused: '已暂停',
  waiting: '等待后续输入',
  ready: '待评审',
  merged: '已合并',
  closed: '已关闭',
  completed: '已完成',
  failed: '失败',
  blocked: '受阻',
  dropped: '已结束',
  stopped: '已停止',
  progress: '处理中',
  idle: '空闲',
  interrupted: '已中断',
}
export function stateName(s: unknown) {
  return states[String(s)] ?? clean(s)
}
export function title(id: string, tickets: ChatTicket[]) {
  const target = tickets.find((t) => t.id === id)
  if (!target) return '工单 ' + clean(id).slice(0, 8)
  const duplicates = tickets.filter((t) => t.id !== id && t.title === target.title)
  if (!duplicates.length) return clean(target.title)
  let length = 6
  while (length < id.length && duplicates.some((t) => t.id.startsWith(id.slice(0, length)))) length++
  return clean(target.title) + ' · ' + id.slice(0, length)
}
export function readable(action: string, value: any): string {
  switch (action) {
    case 'status':
      return [
        clean(value.repo),
        ...value.tickets.map(
          (t: ChatTicket & { attention?: string }, i: number) =>
            i +
            1 +
            '. ' +
            title(t.id, value.tickets) +
            ' · ' +
            stateName(t.status) +
            (t.question?.text || t.attention ? '\n   待答：' + clean(t.question?.text || t.attention) : ''),
        ),
        ...value.faults.map(
          (f: { owner: string; message: string }) => '异常 · ' + clean(f.owner) + '：' + clean(f.message),
        ),
      ].join('\n')
    case 'say':
      return '已收到'
    case 'pause':
      return '已暂停'
    case 'resume':
      return '已提交继续请求'
    case 'clear-excerpts':
      return '已清理失败片段'
    case 'grant':
    case 'revoke':
      return clean(value.repository) + (value.remoteWrites ? ' · 已授权远端写入' : ' · 已撤销远端写入')
    case 'stop':
      return '后台正在停止'
    case 'show':
      return [
        clean(value.ticket.title),
        '工单 ' + clean(value.ticket.id),
        '来源消息 ' + clean(value.ticket.origin?.triggerId),
        '工作范围：' + clean(value.ticket.mandate.scope),
        '状态：' +
          stateName(
            value.ticket.ended?.outcome ??
              value.status ??
              value.ticket.assignments.at(-1)?.report?.state ??
              value.ticket.assignments.at(-1)?.state,
          ),
        value.ticket.attention ? '待答：' + clean(value.ticket.attention.question) : '',
        ...value.tests.map((r: any) => '测试 · ' + clean(r.command) + ' · ' + stateName(r.status)),
        ...value.pulls.map((r: any) => 'PR #' + r.number),
      ]
        .filter(Boolean)
        .join('\n')
    case 'trace':
      return [
        '消息 · ' + clean(value.trigger.text),
        '发送标识 ' + clean(value.trigger.id),
        ...(value.answerReceipt
          ? [
              '定向问题：' + clean(value.trigger.meta.question),
              '答复状态：' + stateName(value.answerReceipt.status),
            ]
          : []),
        ...value.decisions.map((d: any) => '路由决定 · ' + clean(d.kind)),
        ...value.tickets.map((t: any) => '相关工单 ' + clean(t.id) + ' · ' + clean(t.mandate.scope)),
        ...(value.disposition?.handbacks ?? []).map((b: any) => '交回原因 · ' + clean(b.reason)),
      ].join('\n')
    case 'reassess':
      return value.queued ? '已提交重新评估' : '消息已在评估中'
    case 'role-model':
      return '新会话模型 · ' + clean(value.newSessionModel)
    case 'track-pr':
      return '已跟踪 PR #' + Number(value.tracked)
    default:
      return '操作已完成'
  }
}
