import { Container, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import type { ChatEvent, ChatTicket } from '../host/chat.ts'
import { clean, title } from './presentation.ts'

type Message = Pick<ChatEvent, 'kind' | 'ticket' | 'text'>

/** The gutter belongs to the renderer, so pasted text and soft wraps stay inside the same turn. */
function bodyWithGutter(text: string, marker: string): Component {
  const body = new Text(clean(text), 0, 0)
  return {
    invalidate: () => body.invalidate(),
    render(width) {
      if (width <= 2) return body.render(width)
      return body.render(width - 2).map((row) => marker + row)
    },
  }
}

export function messageBlock(
  event: Message,
  tickets: ChatTicket[],
  color = !process.env.NO_COLOR,
): Container {
  const block = new Container()
  const paint = (s: string, style: string) => (color ? '\x1b[' + style + 'm' + s + '\x1b[0m' : s)
  const name = event.ticket ? title(event.ticket, tickets).replace(/\s+/g, ' ').trim() : 'Main'
  const header = (s: string) => block.addChild(new Text(s, 0, 0))
  const assistant = (speaker = name) => {
    header(paint('● AI', '1;32') + ' · ' + speaker)
    block.addChild(bodyWithGutter(event.text, '  '))
  }
  if (event.kind === 'user') {
    header(paint('❯ 你', '1;36') + (event.ticket ? ' → ' + name : ''))
    block.addChild(bodyWithGutter(event.text, paint('│ ', '36')))
  } else if (event.kind === 'accepted') {
    header(paint('↳ 系统', '2') + ' · 已接单 · ' + name)
    const originalTitle = tickets.find((t) => t.id === event.ticket)?.title
    if (event.text && event.text !== originalTitle && event.text !== '已接单：' + originalTitle)
      assistant('Main')
  } else if (event.kind === 'notice') {
    header(paint('↳ 系统', '2') + ' · ' + clean(event.text))
  } else {
    assistant()
  }
  block.addChild(new Spacer(1))
  return block
}
