/** Official SDK wire requests, bounded admission, typed answers, and contained provider failures. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateJudgment, judgmentInputSchema } from '../../src/runtime/judgment.ts'
import type { JevConfig, JudgmentRequest } from '../../src/runtime/judgment.ts'

const config: JevConfig = {
  baseUrl: 'https://typesafe.example.test', model: 'jev-1.13.0', apiKeyEnv: 'RSI_JEV_TEST_KEY',
  timeoutMs: 10_000, maxInputBytes: 4096, maxResponseBytes: 4096, maxQuestions: 8,
}
const questions: JudgmentRequest['questions'] = {
  concern: { type: 'noul', instructions: 'Does the current statement express concern about inflation?' },
  stance: { type: 'choice', instructions: 'How does current policy compare with previous policy?',
    criteria: { hawkish: 'Tighter', unchanged: 'No change', dovish: 'Easier', unknown: null } },
  employment: { type: 'score', instructions: 'How much attention does the statement give to employment?',
    criteria: ['None', 'Brief mention', 'Explicit concern'] },
}
const request = (): JudgmentRequest => ({ state: { current: '通胀仍然偏高。', previous: 'Inflation is elevated.' }, questions })
const response = () => ({
  model: 'jev-1.13.0',
  answers: {
    concern: { type: 'noul', noul: 0.9 },
    stance: { type: 'choice', choice: 'unchanged', confidence: 0.8,
      probabilities: { hawkish: 0.1, unchanged: 0.8, dovish: 0.05, unknown: 0.05 } },
    employment: { type: 'score', score: 0.3, confidence: 0.7,
      probabilities: { '0': 0.7, '1': 0.3, '2': 0 }, legend: { '0': 'None', '1': 'Brief mention', '2': 'Explicit concern' } },
  },
  usage: { input_tokens: 123, output_tokens: 0 },
})
const run = (options: Partial<JevConfig> = {}, signal = new AbortController().signal) =>
  evaluateJudgment({ ...config, ...options }, request(), signal, process.env[config.apiKeyEnv])
const upstream = (value: unknown = response()) => {
  vi.stubEnv(config.apiKeyEnv, 'test-secret')
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(value))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('Jev judgments', () => {
  it('sends all question types in one SDK request and preserves distributions, rubric and usage', async () => {
    const fetcher = upstream()
    const result = await run()
    expect(result).toMatchObject(response())
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.answers.concern).not.toHaveProperty('confidence')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://typesafe.example.test/v1/systemone')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-secret')
    if (typeof init?.body !== 'string') throw new Error('Expected an SDK JSON request body')
    expect(JSON.parse(init.body)).toEqual({ ...request(), model: config.model })
    expect(JSON.stringify(result)).not.toContain('test-secret')
    expect((await run()).inputHash).toBe(result.inputHash)
    vi.stubEnv(config.apiKeyEnv, 'rotated-secret')
    await run()
    expect(new Headers(fetcher.mock.calls.at(-1)![1]?.headers).get('authorization')).toBe('Bearer rotated-secret')
  })

  it('accepts exact UTF-8 byte limits and rejects oversized state or too many questions before transport', async () => {
    const fetcher = upstream()
    const bytes = Buffer.byteLength(JSON.stringify({ ...request(), model: config.model }))
    await expect(run({ maxInputBytes: bytes })).resolves.toMatchObject(response())
    fetcher.mockClear()
    await expect(run({ maxInputBytes: bytes - 1 })).rejects.toThrow('maxInputBytes')
    await expect(run({ maxQuestions: 2 })).rejects.toThrow('maxQuestions')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects missing credentials and already cancelled work without making requests', async () => {
    const fetcher = upstream()
    vi.stubEnv(config.apiKeyEnv, ' ')
    await expect(run()).rejects.toThrow('credential is missing')
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(run({}, controller.signal)).rejects.toThrow('caller stopped')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([401, 422, 429, 529])('returns HTTP %s without retrying or disclosing the provider body', async (status) => {
    const fetcher = upstream()
    fetcher.mockImplementation(async () => new Response('echoed test-secret', { status }))
    await expect(run()).rejects.toThrow(`Jev returned HTTP ${status}`)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('bounds the complete response body and cancels the upstream stream on overflow', async () => {
    const fetcher = upstream()
    const bytes = Buffer.byteLength(JSON.stringify(response()))
    await expect(run({ maxResponseBytes: bytes })).resolves.toMatchObject(response())
    await expect(run({ maxResponseBytes: bytes - 1 })).rejects.toThrow('Jev request failed')
    const cancelled = vi.fn()
    fetcher.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4097)) },
      cancel: cancelled,
    })))
    await expect(run()).rejects.toThrow('Jev request failed')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it('contains network, empty-body and JSON errors', async () => {
    const fetcher = upstream()
    for (const makeResponse of [
      () => { throw new Error('request included test-secret') },
      () => new Response(null),
    ]) {
      fetcher.mockImplementation(async () => makeResponse())
      await expect(run()).rejects.toThrow('Jev request failed')
    }
  })

  it('rejects an unparseable provider response without echoing its contents', async () => {
    const fetcher = upstream()
    fetcher.mockImplementation(async () => new Response('not-json test-secret'))
    await expect(run()).rejects.toThrow('Jev returned an invalid response')
  })

  it.each([
    null,
    { ...response(), usage: { input_tokens: -1, output_tokens: 0 } },
    { ...response(), answers: { ...response().answers, concern: { type: 'noul', noul: 2 } } },
  ])('rejects malformed provider data', async (value) => {
    upstream(value)
    await expect(run()).rejects.toThrow('invalid response')
  })

  it('rejects answers whose identities, types, options or score levels differ from the request', async () => {
    const fetcher = upstream()
    const values = [
      { ...response(), answers: {} },
      { ...response(), answers: { ...response().answers, concern: undefined, other: { type: 'noul', noul: 0.2 } } },
      { ...response(), answers: { ...response().answers, concern: response().answers.stance } },
      { ...response(), answers: { ...response().answers, stance: { ...response().answers.stance, choice: 'invented' } } },
      { ...response(), answers: { ...response().answers, stance: { ...response().answers.stance, probabilities: { unchanged: 1 } } } },
      { ...response(), answers: { ...response().answers, stance: { ...response().answers.stance,
        probabilities: { hawkish: 0, unchanged: 1, dovish: 0, invented: 0 } } } },
      { ...response(), answers: { ...response().answers, employment: { ...response().answers.employment, score: 9 } } },
      { ...response(), answers: { ...response().answers, employment: { ...response().answers.employment, probabilities: { '0': 1 } } } },
      { ...response(), answers: { ...response().answers, employment: { ...response().answers.employment, legend: { '0': 'None' } } } },
    ]
    for (const value of values) {
      fetcher.mockImplementation(async () => Response.json(value))
      await expect(run()).rejects.toThrow(/Jev answer|Jev returned unknown/)
    }
  })

  it('cancels an in-flight SDK request on caller abort', async () => {
    const fetcher = upstream()
    const entered = Promise.withResolvers<undefined>()
    fetcher.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      entered.resolve(undefined)
    }))
    const controller = new AbortController()
    const result = run({}, controller.signal)
    const rejected = expect(result).rejects.toThrow('caller stopped')
    await entered.promise
    controller.abort(new Error('caller stopped'))
    await rejected
  })

  it('enforces the total deadline while the HTTP request is pending', async () => {
    vi.useFakeTimers()
    const fetcher = upstream()
    const entered = Promise.withResolvers<undefined>()
    fetcher.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      entered.resolve(undefined)
    }))
    const result = run({ timeoutMs: 100 })
    const rejected = expect(result).rejects.toThrow('Jev request timed out')
    await entered.promise
    await vi.advanceTimersByTimeAsync(100)
    await rejected
  })
})

describe('model judgment inputs', () => {
  it('accepts structured instructions, explicit Noul criteria, and named evidence', () => {
    for (const criteria of [undefined, {}, { true: 'Explicitly stated' }, { false: 'Not stated' }, { true: null, false: null }]) {
      const input = { state: null, questions: { concern: { type: 'noul', instructions: { question: 'Does evidence.current mention inflation?' },
        ...(criteria === undefined ? {} : { criteria }) } }, evidence: { current: 'a'.repeat(64) } }
      expect(judgmentInputSchema.parse(input)).toEqual(input)
    }
    expect(judgmentInputSchema.parse(request())).toEqual(request())
  })

  it.each([
    { state: 'text', questions: {} },
    { state: 42, questions },
    { state: 'text', questions, model: 'agent-override' },
    { state: 'text', questions, evidence: { current: 'missing' } },
    { state: 'text', questions: { a: { type: 'noul', instructions: '' } } },
    { state: 'text', questions: { a: { type: 'choice', instructions: 'Pick', criteria: { only: 'One' } } } },
    { state: 'text', questions: { a: { type: 'score', instructions: 'Rate', criteria: ['one'] } } },
    { state: 'text', questions: { a: { type: 'score', instructions: 'Rate', criteria: Array.from({ length: 11 }, () => 'level') } } },
  ])('rejects ambiguous or unsupported tool input', (value) => {
    expect(() => judgmentInputSchema.parse(value)).toThrow()
  })
})
