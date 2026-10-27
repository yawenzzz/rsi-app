/** Persistent project identities without an implicit default Agent or executable baseline. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AgentWorkspace, AgentWorkspaceCreateRequest, AgentWorkspaceId } from './types.ts'

/** Project identity parsed at disk and API boundaries. */
export const workspaceIdSchema = z.string().regex(/^(?:a|w)-[a-f0-9-]{36}$/).transform(brandString<AgentWorkspaceId>)
const identitySchema = z.strictObject({ id: workspaceIdSchema, createdAt: z.iso.datetime() })
const recordSchema = identitySchema.extend({ name: z.string().trim().min(1).max(128),
  path: z.string().refine(isAbsolute), lastOpenedAt: z.iso.datetime() })
const catalogSchema = z.strictObject({ format: z.literal(1), workspaces: z.array(recordSchema) })

/**
 * Resolve a project path through its existing ancestors without creating files.
 * @param input - Absolute project directory.
 * @returns canonical project path.
 */
export async function canonicalWorkspacePath(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error('Project path must be absolute')
  const path = resolve(input)
  if (path === parse(path).root) throw new Error('Choose a project directory, not a filesystem root')
  const suffix: string[] = []
  let ancestor = path
  for (;;) {
    try {
      const canonical = await realpath(ancestor)
      if (!(await stat(canonical)).isDirectory()) throw new Error('Project path must be a directory')
      return join(canonical, ...suffix)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      suffix.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
}

function contains(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

/** Directory catalog serialized through the existing atomic-file writer lock. */
export class AgentCatalog {
  /**
   * @param path - Application-owned catalog file.
   * @param capacity - Maximum registered Agents.
   */
  constructor(private readonly path: string, private readonly capacity: number) {}

  /**
   * Read the application catalog without activating projects.
   * @returns validated registered projects, without starting their runtimes.
   */
  async list(): Promise<AgentWorkspace[]> {
    let content: string
    try { content = await readFile(this.path, 'utf8') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    return catalogSchema.parse(JSON.parse(content)).workspaces
  }

  /**
   * Resolve an explicitly selected project; missing ids never fall back to another Agent.
   * @param id - Registered Agent identity.
   * @returns its directory and display metadata.
   */
  async get(id: AgentWorkspaceId): Promise<AgentWorkspace> {
    const record = (await this.list()).find(item => item.id === id)
    if (record === undefined) throw new Error('Agent workspace is not registered')
    if (await canonicalWorkspacePath(record.path) !== record.path) throw new Error('Agent directory resolves to a different path')
    let identity: z.infer<typeof identitySchema>
    try {
      identity = identitySchema.parse(JSON.parse(await readFile(join(record.path, '.rsi', 'identity.json'), 'utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      throw new Error('Agent identity is missing. Restore .rsi or migrate the existing .poly-rsi directory before opening this project.')
    }
    if (identity.id !== record.id) throw new Error('Agent identity does not match its catalog registration')
    return record
  }

  /**
   * Register identity and prepare its profile before publishing the project.
   * @param input - Human-selected project directory and name.
   * @param prepare - Profile initialization; never clones or builds the runtime.
   * @returns committed Agent registration.
   */
  async create(input: AgentWorkspaceCreateRequest, prepare: (record: AgentWorkspace) => Promise<void>): Promise<AgentWorkspace> {
    const request = z.strictObject({ name: z.string().trim().min(1).max(128), path: z.string() }).parse(input)
    const path = await canonicalWorkspacePath(request.path)
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const records = await this.list()
      if (records.length >= this.capacity) throw new Error('Agent workspace capacity reached')
      for (const record of records) {
        if (contains(record.path, path) || contains(path, record.path)) throw new Error(`Project directory overlaps ${record.name}`)
      }
      try {
        await lstat(join(path, '.poly-rsi'))
        throw new Error('This project has earlier RSI data. Migrate .poly-rsi to .rsi before registering it; existing tasks must be preserved.')
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      await mkdir(path, { recursive: true })
      await mkdir(join(path, '.rsi'), { recursive: true, mode: 0o700 })
      if ((await lstat(join(path, '.rsi'))).isSymbolicLink()) throw new Error('Agent state directory cannot be a symbolic link')
      try { await writeFile(join(path, '.rsi', '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      const marker = join(path, '.rsi', 'identity.json')
      let identity: z.infer<typeof identitySchema>
      try { identity = identitySchema.parse(JSON.parse(await readFile(marker, 'utf8'))) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        identity = { id: brandString<AgentWorkspaceId>(`a-${randomUUID()}`), createdAt: new Date().toISOString() }
        await writeFile(marker, JSON.stringify(identity) + '\n', { flag: 'wx', mode: 0o600 })
      }
      if (records.some(record => record.id === identity.id)) throw new Error('Agent identity is already registered at another directory')
      const record: AgentWorkspace = { ...identity, name: request.name, path, lastOpenedAt: new Date().toISOString() }
      await prepare(record)
      await writeFileAtomic(this.path, JSON.stringify({ format: 1, workspaces: [...records, record] }, null, 2) + '\n', { mode: 0o600 })
      return record
    })
  }
}
