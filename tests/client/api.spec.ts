/** Project HTTP operations retain their native gateway envelope and validate returned records. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentWorkspaceId } from '../../src/harness/types.ts'
import { conversationUrl, createRsiApi, requestedProject, resolvePageConfiguration } from '../../src/client/api.ts'

const id = brandString<AgentWorkspaceId>('a-11111111-2222-4333-8444-555555555555')
const project = { id, name: 'Research', path: '/projects/research', workspacePath: '/projects/research/workspace',
  createdAt: '2026-10-26T00:00:00.000Z', lastOpenedAt: '2026-10-26T00:00:00.000Z',
  status: 'ready', profile: `agent-${id}`, bundleCount: 3, error: null }

it('uses Host bootstrap identity at an independent origin without fork globals', () => {
  const config = resolvePageConfiguration({ projectId: id })
  expect(config).toMatchObject({ projectId: id, managementPath: 'api/' })
  expect(resolvePageConfiguration(undefined).projectId).toBeNull()
  expect(() => resolvePageConfiguration({ projectId: '../other' })).toThrow()
})

it('navigates to returned native project origins and refuses script or credential URLs', () => {
  expect(conversationUrl('http://127.0.0.1:42000/?token=launch-token', 'http://127.0.0.1:3080/'))
    .toBe('http://127.0.0.1:42000/?token=launch-token')
  expect(() => conversationUrl('javascript:alert(1)', 'http://127.0.0.1:3080/')).toThrow('Unsupported')
  expect(() => conversationUrl('https://user:password@example.com/', 'http://127.0.0.1:3080/')).toThrow('Unsupported')
})

it('reads a manager workflow link as selection only and rejects malformed project identities', () => {
  expect(requestedProject(`http://127.0.0.1:3080/?rsiProject=${id}`)).toBe(id)
  expect(requestedProject('http://127.0.0.1:3080/')).toBeNull()
  expect(() => requestedProject('http://127.0.0.1:3080/?rsiProject=../../secret')).toThrow()
})

it('addresses the current origin with the official named-argument HTTP envelope', async () => {
  const calls: { address: string; body: unknown; credentials: RequestCredentials | undefined }[] = []
  const fetcher: typeof fetch = async (address, init) => {
    calls.push({ address: String(address), body: JSON.parse(String(init?.body)), credentials: init?.credentials })
    return Response.json({ result: { ok: true, value: { workspaceId: id, profile: `agent-${id}`,
      url: 'http://127.0.0.1:42000/?token=launch-token', compositionHash: 'a'.repeat(64) } } })
  }
  const api = createRsiApi(resolvePageConfiguration({ projectId: id }), 'http://127.0.0.1:42000/',
    new AbortController().signal, fetcher)
  expect((await api.openWorkspace(id)).workspaceId).toBe(id)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ address: 'http://127.0.0.1:42000/api/agentWorkspaces/openWorkspace', credentials: 'same-origin',
    body: { type: 'client-request', method: 'agentWorkspaces/openWorkspace', payload: { args: { id } } } })
})

it('retains the complete project identity and rejects incomplete remote catalogs', async () => {
  let current: unknown = { catalogPollIntervalMs: 3000, workspaces: [project] }
  const fetcher: typeof fetch = async () => Response.json({ result: { ok: true, value: current } })
  const api = createRsiApi(resolvePageConfiguration(undefined), 'http://127.0.0.1:3080/', new AbortController().signal, fetcher)
  expect((await api.workspaces()).workspaces).toEqual([project])
  current = { workspaces: [{ name: 'Broken' }] }
  await expect(api.workspaces()).rejects.toThrow()
})

it('preserves server rejection details without treating failed operations as successful records', async () => {
  const fetcher: typeof fetch = async () => Response.json({ result: { ok: false, error: { message: 'Stop active conversations before restarting this Agent' } } })
  const api = createRsiApi(resolvePageConfiguration(undefined), 'http://127.0.0.1:3080/', new AbortController().signal, fetcher)
  await expect(api.stopWorkspace(id)).rejects.toThrow('Stop active conversations')
})
