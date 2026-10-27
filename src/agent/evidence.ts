/** Evidence is read from native Session logs, never from a separate Harness execution record. */
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { SessionId as parseSessionId } from '@deepseek-ai/dsh-session/types'
import { installRpc, rpcMethod } from '../shared/rpc.ts'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

import type { AgentConversationEvidence } from '../harness/client.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Settled native conversation evidence from this project runtime only. */
    agentEvidence: AgentEvidence
  }
}

/** Project-process reader used by the management UI to retain execution evidence. */
export class AgentEvidence extends Service {
  static inject = ['sessionQuery', 'agents', 'connection']
  /** @param ctx - Project runtime's native Session services. */
  constructor(ctx: Context) {
    super(ctx, 'agentEvidence')
    installRpc(ctx, 'agentEvidence', { read: rpcMethod(z.strictObject({ sessionId: z.string().transform(parseSessionId) }),
      ({ sessionId }) => this.read(sessionId)) }, 1048576)
  }

  /**
   * Read one settled conversation turn from this process's own Session store.
   * @param sessionId - Native Session owned by this Agent runtime.
   * @returns actual final text and tool events for the last completed interval.
   */
  async read(sessionId: SessionId): Promise<AgentConversationEvidence> {
    if (this.ctx.agents.get(sessionId)?.status === 'running') throw new Error('Wait for the conversation to finish before retaining evidence')
    const session = await this.ctx.sessionQuery.readSession(sessionId)
    const last = session.events.findLast(event => event.type === 'turn/end')
    const start = session.events.findLast(event => event.type === 'turn/start')
    if (last?.type !== 'turn/end' || start !== undefined && start.seq > last.seq) throw new Error('The conversation has no completed turn')
    const events = session.events.filter(event => 'turn' in event.data && event.data.turn === last.data.turn)
    const message = events.findLast(event => event.type === 'assistant/message')
    const output = JSON.stringify({ finalResponse: message?.type === 'assistant/message'
      ? message.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') : '',
    toolEvents: events.filter(event => event.type === 'tool/call' || event.type === 'tool/result') })
    const system = session.events.filter(event => event.type === 'system/message' && event.seq <= last.seq)
      .flatMap(event => event.type === 'system/message' ? event.data.message.content : [])
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    const hashes = [...system.matchAll(/Agent composition digest: ([a-f0-9]{64})/g)]
    const compositionHash = hashes.at(-1)?.[1]
    if (compositionHash === undefined) throw new Error('Conversation does not identify a project composition')
    return { sessionId, turn: last.data.turn, success: last.data.reason.kind === 'completed', output, compositionHash }
  }
}
