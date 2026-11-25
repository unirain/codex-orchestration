export type Role = 'main' | 'worker'
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const string = { type: 'string' }
const integer = { type: 'integer' }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }
}

export const roleTools: Record<Role, ToolSpec[]> = {
  main: [
    tool('orchestrator_read', 'Read current routing context from the host.', {}, []),
    tool('orchestrator_route', 'Route an explicit user request or ask for clarification. Explain the evidence.',
      { kind: { enum: ['accept', 'attach', 'stop', 'ignore', 'clarify'] }, reason: string, scope: string, title: string,
        ticketId: string, triggerId: string, question: string }, ['kind', 'reason']),
  ],
  worker: [
    tool('orchestrator_report', 'Report progress, outcome or a concrete question within the assigned mandate.',
      { state: { enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] }, summary: string, pr: integer, question: string }, ['state', 'summary']),
    tool('orchestrator_ack', 'Acknowledge an in-scope follow-up, optionally with an answer.',
      { triggerId: string, answer: string }, ['triggerId']),
    tool('orchestrator_trigger_handback', 'Return an out-of-scope user trigger unchanged to the host.',
      { triggerId: string, reason: string }, ['triggerId', 'reason']),
    tool('orchestrator_deliver', 'Request a host-authorized remote delivery step for this ticket.',
      { operation: { enum: ['push', 'create', 'update'] }, commit: string, pr: integer, title: string, body: string, draft: {type:'boolean'} }, ['operation']),
    tool('orchestrator_test', 'Start a supervised background test in this ticket workspace.',
      { command: string }, ['command']),
  ],
}
