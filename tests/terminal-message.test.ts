import assert from 'node:assert/strict'
import test from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import { visibleWidth } from '@earendil-works/pi-tui'
import { messageBlock } from '../src/terminal/message.ts'

const tickets = [{ id: 'abc', title: '跟进提醒', status: 'waiting' }]
test('user, AI and system roles remain explicit in monochrome; all wrapped user lines retain their gutter', () => {
  const user = messageBlock(
    { kind: 'user', ticket: 'abc', text: '第一行中文。\n第二行很长的中文，换行后仍是同一位用户。' },
    tickets,
    false,
  )
  const rows = user.render(20).map((s) => s.trimEnd())
  assert.equal(rows[0], '❯ 你 → 跟进提醒')
  assert.ok(rows.length > 4)
  assert.ok(rows.slice(1, -1).every((row) => row.startsWith('│ ')))
  assert.ok(rows.every((row) => !row.includes('\x1b') && visibleWidth(row) <= 20))
  const ai = messageBlock({ kind: 'reply', ticket: 'abc', text: '请确认。' }, tickets)
  assert.deepEqual(
    ai.render(24).map((s) => stripVTControlCharacters(s).trimEnd()),
    ['● AI · 跟进提醒', '  请确认。', ''],
  )
  assert.equal(
    messageBlock({ kind: 'reply', text: '请说明目标' }, [], false).render(30)[0].trim(),
    '● AI · Main',
  )
  assert.equal(
    messageBlock({ kind: 'notice', text: '工单已结束' }, [], false).render(30)[0].trim(),
    '↳ 系统 · 工单已结束',
  )
})
test('acceptance is a system receipt; a distinct authored acknowledgement is identified as Main', () => {
  const render = (text: string) =>
    messageBlock({ kind: 'accepted', ticket: 'abc', text }, tickets, false)
      .render(45)
      .map((s) => s.trimEnd())
  assert.deepEqual(render('已接单：跟进提醒'), ['↳ 系统 · 已接单 · 跟进提醒', ''])
  assert.deepEqual(render('我会核对触发条件。'), [
    '↳ 系统 · 已接单 · 跟进提醒',
    '● AI · Main',
    '  我会核对触发条件。',
    '',
  ])
})
