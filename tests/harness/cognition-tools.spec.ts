/** Model memory reads are bounded, preserve Unicode and never expose human grading. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { fromPartial } from '@total-typescript/shoehorn'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installCognitiveTools } from '../../src/harness/cognition-tools.ts'
import { initialCognition } from '../../src/harness/cognition.ts'

async function fixture(content = 'Evidence') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const state = initialCognition()
  state.evidence.push(fromPartial({ id: 'evidence', content, contentHash: 'f'.repeat(64) }))
  const update = vi.fn(async () => state)
  installCognitiveTools(ctx, { snapshot: async () => state, update }, 512)
  const signal = new AbortController().signal
  const invoke = (name: string, args: unknown) => ctx.tools.get(name)!.execute(args, fromPartial<ToolRunContext>({ signal }))
  return { ctx, update, signal, invoke }
}

it('reads Unicode evidence in bounded contiguous pages without changing the source', async () => {
  const text = '👩🏽‍💻\n"evidence"'.repeat(80)
  const f = await fixture(text)
  let offset: number | null = 0
  let reconstructed = ''
  while (offset !== null) {
    const response = await f.invoke('agent_cognition', { evidence_id: 'evidence', offset }) as { result: string }
    expect(Buffer.byteLength(response.result)).toBeLessThanOrEqual(512)
    const page = JSON.parse(response.result) as { content: string; nextOffset: number | null }
    reconstructed += page.content
    offset = page.nextOffset
  }
  expect(reconstructed).toBe(text)
  expect(f.update).not.toHaveBeenCalled()
  expect(f.ctx.tools.get('agent_cognition_review')).toBeUndefined()
})

it('rejects mixed mutation reads, unknown records and a single over-budget grapheme', async () => {
  const f = await fixture('a' + '\u0301'.repeat(1000))
  await expect(f.invoke('agent_cognition', { evidence_id: 'evidence', command_json: '{}' })).rejects.toThrow('mutation')
  await expect(f.invoke('agent_cognition', { evidence_id: 'missing' })).rejects.toThrow('does not exist')
  await expect(f.invoke('agent_cognition', { evidence_id: 'evidence', offset: 2 })).rejects.toThrow('offset')
  await expect(f.invoke('agent_cognition', { evidence_id: 'evidence' })).rejects.toThrow('response allowance')
  await expect(f.invoke('agent_cognition', { command_json: '{"action":"review","revision":0}' })).rejects.toThrow()
})
