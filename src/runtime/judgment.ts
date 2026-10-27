/** TypeSafe judgments over explicit research state; inference never grants trading authority. */
import { createHash } from 'node:crypto'
import { APIError, TypeSafeClient } from '@typesafe-ai/sdk'
import type { EntryType, Question, Questions } from '@typesafe-ai/sdk'
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SourceEvidenceId } from './data/evidence.ts'

/** Deployment-owned Jev endpoint, credential reference, and bounded request allowances. */
export interface JevConfig {
  /** TypeSafe API root; requests use its /v1/systemone endpoint. */
  baseUrl: string
  /** Explicit model version or provider alias, retained with each result. */
  model: string
  /** Credential reference resolved afresh for each call; never a secret value. */
  apiKeyEnv: string
  /** Complete operation deadline, including HTTP body consumption. */
  timeoutMs: number
  /** Maximum UTF-8 bytes for the complete state, questions, and model request. */
  maxInputBytes: number
  /** Maximum bytes for the complete provider response, before JSON parsing. */
  maxResponseBytes: number
  /** Maximum independent questions in one request. */
  maxQuestions: number
}

const entry: z.ZodType<EntryType> = z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json()), z.null()])
const instructions = z.union([z.string().trim().min(1), z.record(z.string(), z.json()), z.array(z.json())])
const identifier = z.string().min(1)
const question = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('noul'), instructions,
    criteria: z.strictObject({ true: entry.optional(), false: entry.optional() }).optional() }),
  z.strictObject({ type: z.literal('choice'), instructions,
    criteria: z.record(identifier, entry).refine(value => Object.keys(value).length >= 2 && Object.keys(value).length <= 255,
      'Choice requires 2 to 255 options') }),
  z.strictObject({ type: z.literal('score'), instructions,
    criteria: z.tuple([entry, entry], entry).refine(value => value.length <= 10, 'Score permits at most 10 levels') }),
])

/** Model input validation; named evidence references are resolved by the RSI host. */
export const judgmentInputSchema = z.strictObject({
  state: entry,
  questions: z.record(identifier, question).refine(value => Object.keys(value).length > 0, 'At least one question is required')
    .transform((value): Questions => Object.fromEntries<Question>(Object.entries(value).map(([id, item]): [string, Question] => {
      if (item.type !== 'noul') return [id, item]
      return [id, { type: item.type, instructions: item.instructions, ...(item.criteria === undefined ? {} : {
        criteria: {
          ...(item.criteria.true === undefined ? {} : { true: item.criteria.true }),
          ...(item.criteria.false === undefined ? {} : { false: item.criteria.false }),
        },
      }) }]
    }))),
  evidence: z.record(identifier, z.string().regex(/^[a-f0-9]{64}$/).transform(brandString<SourceEvidenceId>)).optional(),
})

const probability = z.number().min(0).max(1)
const probabilities = z.record(identifier, probability)
const answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: probability }),
  z.object({ type: z.literal('choice'), choice: identifier, confidence: probability, probabilities }),
  z.object({ type: z.literal('score'), score: z.number().nonnegative(),
    confidence: probability, probabilities, legend: z.record(identifier, entry) }),
])
const responseSchema = z.object({
  model: z.string().min(1), answers: z.record(identifier, answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
})

/** Exact state and questions admitted to the provider, without credentials or endpoint overrides. */
export interface JudgmentRequest {
  state: EntryType
  questions: Questions
}

/** Validated provider answers and content identity of the exact submitted request. */
export type JudgmentResponse = z.infer<typeof responseSchema> & { inputHash: Branded<'RsiJudgmentInputHash'> }

/** Provider operation consumed by the RSI tool; cancellation covers the entire request. */
export type JudgmentProvider = (request: JudgmentRequest, signal: AbortSignal) => Promise<JudgmentResponse>

/**
 * Evaluate narrow questions using the official SDK without retries or provider-error body disclosure.
 * @param config - Resolved deployment limits and environment credential reference.
 * @param request - Host-admitted state and questions.
 * @param signal - Caller and runtime cancellation.
 * @param credential - Secret resolved by the host credential provider; absent values reject.
 * @returns complete validated answers, token usage, resolved model, and submitted input hash.
 */
export async function evaluateJudgment(
  config: JevConfig, request: JudgmentRequest, signal: AbortSignal, credential: string | undefined,
): Promise<JudgmentResponse> {
  signal.throwIfAborted()
  const body = JSON.stringify({ ...request, model: config.model })
  if (Buffer.byteLength(body) > config.maxInputBytes) throw new Error('Jev request exceeds maxInputBytes; use fewer or shorter sources')
  if (Object.keys(request.questions).length > config.maxQuestions) throw new Error('Jev request exceeds maxQuestions')
  const apiKey = credential?.trim()
  if (!apiKey) throw new Error('Jev credential is missing; configure the API key in Settings > Jev')
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('Jev request timed out')) }, config.timeoutMs)
  const combined = AbortSignal.any([signal, controller.signal])
  try {
    const client = new TypeSafeClient({
      apiKey, baseURL: config.baseUrl, defaultModel: config.model,
      timeout: config.timeoutMs, retry: { maxRetries: 0 }, logLevel: 'off',
      fetch: async (url, init) => {
        const response = await fetch(url, { ...init, redirect: 'error' })
        if (!response.ok) {
          await response.body?.cancel()
          // Provider error bodies may echo credentials or submitted evidence.
          return new Response(null, { status: response.status })
        }
        if (response.body === null) throw new Error('Jev response has no body')
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          while (true) {
            combined.throwIfAborted()
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > config.maxResponseBytes) throw new Error('Jev response exceeds maxResponseBytes')
            chunks.push(chunk.value)
          }
        } finally {
          await reader.cancel()
          reader.releaseLock()
        }
        return new Response(Buffer.concat(chunks, size), { status: response.status })
      },
    })
    let value: unknown
    try {
      value = await client.systemOne({ ...request, model: config.model }, { signal: combined })
    } catch (error) {
      combined.throwIfAborted()
      if (error instanceof APIError) throw new Error(`Jev returned HTTP ${error.status}; check server credentials, quota, and request limits`)
      throw new Error('Jev request failed; check connectivity, response size, and provider availability')
    }
    combined.throwIfAborted()
    const parsed = responseSchema.safeParse(value)
    if (!parsed.success) throw new Error('Jev returned an invalid response')
    const response = parsed.data
    if (Object.keys(response.answers).length !== Object.keys(request.questions).length) throw new Error('Jev answer IDs do not match the questions')
    for (const [id, expected] of Object.entries(request.questions)) {
      const actual = response.answers[id]
      if (actual?.type !== expected.type) throw new Error('Jev answer type does not match its question')
      if (actual.type === 'choice' && expected.type === 'choice') {
        if (!Object.hasOwn(expected.criteria, actual.choice)
          || !sameKeys(actual.probabilities, expected.criteria)) throw new Error('Jev returned unknown or missing choices')
      }
      if (actual.type === 'score' && expected.type === 'score') {
        const levels = Object.fromEntries(expected.criteria.map((description, index) => [String(index), description]))
        if (actual.score > expected.criteria.length - 1 || !sameKeys(actual.probabilities, levels)
          || !sameKeys(actual.legend, levels)) throw new Error('Jev returned unknown or missing score levels')
      }
    }
    return { ...response, inputHash: brandString<Branded<'RsiJudgmentInputHash'>>(createHash('sha256').update(body).digest('hex')) }
  } finally {
    clearTimeout(timer)
  }
}

function sameKeys(left: object, right: object): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key))
}
