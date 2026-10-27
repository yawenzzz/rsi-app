/** Script only the external model; native conversation, schema assembly and tool execution stay real. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import schema from '@deepseek-ai/schemastery'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
export const name = 'project-test-provider'
export const inject = ['llm', 'settings']
export const Config = schema.object({ label: schema.string().default('fixture').volatile(), contextWindow: schema.number().min(1).default(272000).volatile() })
class Adapter extends LlmAdapter {
  constructor(config) { super(); this.config = config }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: this.config.contextWindow.get() } } }
  async listModels(provider) { return [await this.resolveModel(provider, 'project-model')] }
  async *stream(options) {
    const tools = (options.tools ?? []).filter(tool => tool.name.startsWith('project_capability_')).map(tool => tool.name)
    if (tools.length === 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Project conversation' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (tools.length !== 1) throw new Error(`Expected one project capability, received ${JSON.stringify(tools)}`)
    writeFileSync(join(process.cwd(), 'request-tools.json'), JSON.stringify(tools) + '\n')
    const user = options.messages.findLastIndex(message => message.role === 'user')
    const results = options.messages.slice(user + 1).filter(message => message.role === 'tool')
    for (const result of results) if (result.isError) throw new Error(JSON.stringify(result.content))
    if (results.length > 0) {
      const context = JSON.parse(results[0].content.filter(block => block.type === 'text').map(block => block.text).join(''))
      writeFileSync(join(process.cwd(), 'agent-context.json'), JSON.stringify(context) + '\n')
    }
    const calls = [
      { name: 'agent_context', arguments: '{}' },
      { name: 'write', arguments: JSON.stringify({ file_path: 'task-result.txt', content: 'Task deliverable\n' }) },
      { name: tools[0], arguments: '{}' },
    ]
    const call = calls[results.length]
    if (call !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`project-call-${results.length}`), ...call } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const result = results.at(-1)
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
export function apply(ctx, config) {
  ctx.effect(() => {
    writeFileSync(join(process.cwd(), 'runtime-process.json'), JSON.stringify({ pid: process.pid }) + '\n')
    return () => writeFileSync(join(process.cwd(), 'runtime-disposed.json'), JSON.stringify({ pid: process.pid }) + '\n')
  })
  ctx.effect(() => ctx.llm.registerAdapter(['project-test'], new Adapter(config)))
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
}
