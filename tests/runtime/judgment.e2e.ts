/** Opt-in live TypeSafe smoke; no credential value is logged or persisted. */
import { expect, it } from 'vitest'
import { evaluateJudgment } from '../../src/runtime/judgment.ts'

it.skipIf(!process.env.TYPESAFE_API_KEY)('evaluates independent research questions against the real Jev API', async () => {
  const result = await evaluateJudgment({
    baseUrl: 'https://api.typesafe.ai', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY',
    timeoutMs: 30_000, maxInputBytes: 8192, maxResponseBytes: 8192, maxQuestions: 3,
  }, {
    state: 'The committee explicitly states: inflation remains elevated and is a major concern. Employment is not discussed.',
    questions: {
      inflation: { type: 'noul', instructions: 'Does the supplied statement explicitly express concern about inflation?' },
      topic: { type: 'choice', instructions: 'Which subject is explicitly discussed?',
        criteria: { inflation: 'Inflation', employment: 'Employment', neither: 'Neither subject' } },
      employment: { type: 'score', instructions: 'How explicitly is employment discussed?',
        criteria: ['Not discussed', 'Mentioned briefly', 'Discussed in detail'] },
    },
  }, new AbortController().signal, process.env.TYPESAFE_API_KEY)
  expect(result.model).toBeTruthy()
  expect(result.answers.inflation).toMatchObject({ type: 'noul' })
  expect(result.answers.topic).toMatchObject({ type: 'choice', choice: 'inflation' })
  expect(result.answers.employment).toMatchObject({ type: 'score' })
  expect(result.usage.input_tokens).toBeGreaterThan(0)
})
