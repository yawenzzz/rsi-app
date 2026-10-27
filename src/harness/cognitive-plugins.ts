/** Registered cognitive bundle identities include their project-local plugin sources. */
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { AgentProfileSnapshot } from './agent-profile.ts'
import type { CognitivePlugin, CognitiveReference, CognitiveSnapshot, CognitiveTask } from './cognition-types.ts'
import { cognitivePosition, sameCognitiveUnit } from './cognition.ts'

/** Complete source limits shared by registration and execution admission. */
export interface PluginArtifactLimits { maxPluginBytes: number; maxPluginFiles: number }
/** Source identity retained by the owning Agent and its isolated executions. */
export interface PluginArtifactSource { name: string; version: string; directory: string; contentHash: string }
/** Exact registered bundles and profile used by one isolated Agent execution. */
export interface PluginExecution extends PluginArtifactLimits {
  root: string
  pluginRoot?: string
  artifacts: PluginArtifactSource[]
  profile?: AgentProfileSnapshot
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** One local package resolved from a bundle's declared dependency graph. */
export interface PluginSourcePackage { name: string; directory: string }

/**
 * Read a bundle and its local plugin dependencies without evaluating code.
 * @param root - Owning bundle directory.
 * @param directory - Absolute bundle directory below root.
 * @param limits - Bounds across the complete first-party dependency graph.
 * @param pluginRoot - Optional sibling directory for local plugin packages.
 * @returns exact source digest and package locations for isolated assembly.
 */
export async function inspectPluginSources(root: string, directory: string, limits: PluginArtifactLimits,
  pluginRoot?: string): Promise<{ source: PluginArtifactSource; packages: PluginSourcePackage[] }> {
  if (!isAbsolute(directory)) throw new Error('Bundle directory must be inside the workspace bundles directory')
  const roots = await Promise.all([root, ...pluginRoot === undefined ? [] : [pluginRoot]].map(async (path) => {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Workspace source directories cannot be symbolic links')
    return realpath(path)
  }))
  const canonicalRoot = await realpath(root)
  const canonicalDirectory = await realpath(directory)
  if (!contained(canonicalRoot, canonicalDirectory)) throw new Error('Bundle directory leaves the workspace bundles directory')
  const files = new Map<string, Buffer>()
  const packages = new Map<string, PluginSourcePackage>()
  const visited = new Set<string>()
  let bytes = 0
  let entries = 0
  const packageSchema = z.object({
    name: z.string().regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/), version: z.string().min(1), type: z.literal('module'),
    dependencies: z.record(z.string(), z.string()).optional(),
    dsh: z.object({ bundle: z.object({ patch: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }).optional() }).optional(),
  })
  const visit = async (path: string, expectedName?: string): Promise<z.infer<typeof packageSchema>> => {
    const sourceRoot = roots.find(value => contained(value, path))
    if (sourceRoot === undefined) throw new Error('Local plugin dependency leaves the owning project source directories')
    let ancestor = sourceRoot
    for (const part of relative(sourceRoot, path).split(sep)) {
      ancestor = join(ancestor, part)
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Plugin source paths cannot be symbolic links')
    }
    const contents = new Map<string, Buffer>()
    const walk = async (folder: string): Promise<void> => {
      for (const entry of (await readdir(folder)).sort()) {
        if (entry === 'node_modules' || entry === '.git') continue
        if (++entries > limits.maxPluginFiles) throw new Error('Plugin artifact exceeds configured entry limit')
        const filename = join(folder, entry)
        const stat = await lstat(filename)
        if (stat.isSymbolicLink()) throw new Error('Plugin source files cannot be symbolic links')
        if (stat.isDirectory()) { await walk(filename); continue }
        if (!stat.isFile()) throw new Error('Plugin artifacts must contain ordinary files')
        if (bytes + stat.size > limits.maxPluginBytes) throw new Error('Plugin artifact exceeds configured byte limits')
        const content = await readFile(filename)
        bytes += content.byteLength
        if (bytes > limits.maxPluginBytes) throw new Error('Plugin artifact exceeds configured byte limits')
        contents.set(relative(path, filename).split(sep).join('/'), content)
      }
    }
    await walk(path)
    const manifest = packageSchema.parse(JSON.parse(contents.get('package.json')?.toString('utf8') ?? 'null'))
    if (expectedName !== undefined && manifest.name !== expectedName) throw new Error('Local plugin dependency name does not match its package')
    const previous = packages.get(manifest.name)
    if (previous !== undefined && previous.directory !== path) throw new Error('Local plugin package names must be unique')
    packages.set(manifest.name, { name: manifest.name, directory: path })
    for (const [name, content] of contents) files.set(path === canonicalDirectory ? name : `${manifest.name}/${name}`, content)
    const patches = manifest.dsh?.bundle?.patch
    for (const patchName of patches === undefined ? [] : typeof patches === 'string' ? [patches] : patches) {
      const patch = resolve(path, patchName)
      if (!contained(path, patch) || !contents.has(relative(path, patch).split(sep).join('/'))) {
        throw new Error('Bundle patch must be a retained file inside its package')
      }
    }
    visited.add(path)
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!spec.startsWith('file:')) {
        if (spec.startsWith('link:') || spec.startsWith('workspace:')) throw new Error('Local plugin dependencies must use file: paths')
        continue
      }
      const dependency = resolve(path, spec.slice(5))
      if (visited.has(dependency)) {
        if (packages.get(name)?.directory !== dependency) throw new Error('Local plugin dependency name does not match its package')
        continue
      }
      await visit(dependency, name)
    }
    return manifest
  }
  for (let ancestor = resolve(directory); await realpath(ancestor) !== canonicalRoot; ancestor = dirname(ancestor)) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('Plugin source paths cannot be symbolic links')
    if (dirname(ancestor) === ancestor) throw new Error('Bundle directory leaves the workspace bundles directory')
  }
  const manifest = await visit(canonicalDirectory)
  if (manifest.dsh?.bundle === undefined) throw new Error('Registered package must declare dsh.bundle.patch')
  const hash = createHash('sha256')
  for (const [name, content] of [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    hash.update(JSON.stringify([name, content.byteLength])).update(content)
  }
  return { source: { name: manifest.name, version: manifest.version, directory: canonicalDirectory, contentHash: hash.digest('hex') },
    packages: [...packages.values()] }
}

/**
 * Compute the immutable identity of a local bundle and its first-party plugins.
 * @param root - Owning bundle directory.
 * @param directory - Bundle package below root.
 * @param limits - Complete first-party source limits.
 * @param pluginRoot - Optional sibling plugin source directory.
 * @returns exact package identity and content digest.
 */
export async function inspectPluginArtifact(root: string, directory: string, limits: PluginArtifactLimits,
  pluginRoot?: string): Promise<PluginArtifactSource> {
  return (await inspectPluginSources(root, directory, limits, pluginRoot)).source
}

/**
 * Verify source identities before and after an isolated execution.
 * @param execution - Registered sources and limits, or no additional plugins.
 * @returns after every plugin matches its registered content.
 */
export async function verifyPluginExecution(execution: PluginExecution | undefined): Promise<void> {
  if (execution === undefined) return
  for (const artifact of execution.artifacts) {
    const observed = await inspectPluginArtifact(execution.root, artifact.directory, execution, execution.pluginRoot)
    if (observed.contentHash !== artifact.contentHash || observed.name !== artifact.name || observed.version !== artifact.version) {
      throw new Error('Registered plugin source changed; create and register a new artifact')
    }
  }
}

/**
 * Require all selected methods to have registered plugin implementations.
 * @param units - Exact task selections.
 * @param plugins - Eligible artifacts, optionally filtered by live availability.
 * @returns the distinct artifacts covering these revisions; throws when coverage is missing.
 */
export function pluginsForUnits(units: CognitiveReference[], plugins: CognitivePlugin[]): CognitivePlugin[] {
  const selected = new Map<string, CognitivePlugin>()
  for (const unit of units) {
    const plugin = plugins.findLast(item => item.units.some(reference => sameCognitiveUnit(reference, unit)))
    if (plugin === undefined) throw new Error('Produce and activate a plugin for each revised cognitive capability before proceeding')
    selected.set(plugin.id, plugin)
  }
  return [...selected.values()]
}

/**
 * Resolve plugin implementations while leaving unchanged baseline capabilities reusable.
 * @param state - All registered implementation identities.
 * @param task - Selected cognitive revisions.
 * @param available - Registered sources, or only the sources currently active in Plugin Manager.
 * @returns implementations used by the selected revisions; revised capabilities require coverage.
 */
export function selectedPluginArtifacts(state: CognitiveSnapshot, task: CognitiveTask,
  available: CognitivePlugin[] = state.plugins): CognitivePlugin[] {
  const selected = available.filter(plugin => plugin.units.some(unit => task.units.some(reference => sameCognitiveUnit(reference, unit))))
  const required = task.units.filter(unit => unit.revision > 1
    || state.plugins.some(plugin => plugin.units.some(reference => reference.id === unit.id)))
  pluginsForUnits(required, selected)
  return selected
}

/**
 * Require human ratings of execution evidence for the exact plugin implementation.
 * @param state - Retained cognitive records.
 * @param task - Task entering Execute.
 * @returns after every selected revision has a reviewed plugin execution.
 */
export function requirePluginReviews(state: CognitiveSnapshot, task: CognitiveTask): void {
  const plugins = selectedPluginArtifacts(state, task)
  if (task.phase === 'repair' && plugins.length === 0) throw new Error('Register an improvement plugin before leaving Repair')
  for (const plugin of plugins) {
    for (const unit of task.units.filter(target => plugin.units.some(reference => sameCognitiveUnit(reference, target)))) {
      const position = cognitivePosition(state, task, unit)
      const assessment = state.assessments.find(item => item.id === position.assessmentId)
      const reviewed = assessment?.evidenceIds.some(id => state.evidence.some(evidence =>
        evidence.id === id && evidence.pluginIds?.includes(plugin.id)))
      if (!reviewed) throw new Error('Review execution evidence for the registered plugin before Execute')
    }
  }
}
