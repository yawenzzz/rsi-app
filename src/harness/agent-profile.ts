/** Project-owned profile declarations, assembled only into that project's child runtime. */
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import type { CognitivePlugin } from './cognition-types.ts'
import type { PluginArtifactLimits } from './cognitive-plugins.ts'
import { inspectPluginArtifact } from './cognitive-plugins.ts'

/** Locations owned by one registered project or long-lived Agent. */
export interface AgentProfilePaths {
  root: string
  plugins: string
  bundles: string
  profile: string
  workspace: string
  name: string
}

/** Exact profile declaration retained with an execution. */
export interface AgentProfileSnapshot {
  name: string
  directory: string
  bundles: string[]
  patch: string
  contentHash: string
}

const manifestSchema = z.object({
  name: z.string().min(1), private: z.literal(true),
  dependencies: z.record(z.string(), z.string()),
  dsh: z.object({ profile: z.object({ bundles: z.array(z.string().min(1)) }) }),
}).loose()

/**
 * Resolve configurable source directories inside one project.
 * @param root - Registered project directory.
 * @param name - Stable runtime profile name.
 * @param directories - Workspace-relative source and composition directories.
 * @returns absolute owned locations.
 */
export function agentProfilePaths(root: string, name: string,
  directories: { pluginDirectory: string; bundleDirectory: string; profileDirectory: string; workspaceDirectory: string },
): AgentProfilePaths {
  const canonical = realpathSync(root)
  return { root: canonical, name, plugins: join(canonical, directories.pluginDirectory),
    bundles: join(canonical, directories.bundleDirectory), profile: join(canonical, directories.profileDirectory),
    workspace: join(canonical, directories.workspaceDirectory) }
}

/**
 * Reject redirected project files before reading or writing a composition.
 * @param root - Owning directory.
 * @param path - Existing descendant, including its final component.
 */
export async function assertProfilePath(root: string, path: string): Promise<void> {
  const child = relative(root, path)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Agent profile path leaves its project')
  let current = root
  for (const part of child.split(sep)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Agent profile paths cannot contain symbolic links')
  }
}

/**
 * Initialize a project's editable composition without overwriting existing files.
 * @param paths - Owned project locations.
 * @param bundles - Initial runtime bundle layers.
 */
export async function initializeAgentProfile(paths: AgentProfilePaths, bundles: string[]): Promise<void> {
  for (const directory of [paths.plugins, paths.bundles, paths.profile]) await initializeDirectory(paths.root, directory)
  await prepareAgentWorkspace(paths)
  const files = {
    'package.json': JSON.stringify({ name: paths.name, private: true, dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + '\n',
    'cordis.patch.yml': '[]\n',
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(paths.profile, name)
    try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      await assertProfilePath(paths.root, path)
    }
  }
  await readAgentProfile(paths)
}

async function initializeDirectory(root: string, directory: string): Promise<void> {
  // Validate each ancestor before mkdir can follow a project-local symlink.
  let current = root
  for (const part of relative(root, directory).split(sep)) {
    current = join(current, part)
    try { await mkdir(current) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    await assertProfilePath(root, current)
    if (!(await lstat(current)).isDirectory()) throw new Error('Agent directories must be directories')
  }
}

/**
 * Create the task directory for new and existing Agents without moving their files.
 * @param paths - Owned project locations.
 * @returns the absolute working directory, with symbolic links rejected.
 */
export async function prepareAgentWorkspace(paths: AgentProfilePaths): Promise<string> {
  await initializeDirectory(paths.root, paths.workspace)
  return paths.workspace
}

/**
 * Read the source declaration; its digest covers ordered layers and the complete user patch.
 * @param paths - Owning project locations.
 * @returns validated declaration and exact bytes for the next child runtime.
 */
export async function readAgentProfile(paths: AgentProfilePaths): Promise<{
  manifest: z.infer<typeof manifestSchema>
  snapshot: AgentProfileSnapshot
}> {
  for (const name of ['package.json', 'cordis.patch.yml']) await assertProfilePath(paths.root, join(paths.profile, name))
  const raw = await readFile(join(paths.profile, 'package.json'), 'utf8')
  const manifest = manifestSchema.parse(JSON.parse(raw))
  if (manifest.name !== paths.name) throw new Error('Agent profile identity does not match its owning project')
  const bundles = manifest.dsh.profile.bundles
  if (new Set(bundles).size !== bundles.length) throw new Error('Agent profile contains duplicate bundle layers')
  const patch = await readFile(join(paths.profile, 'cordis.patch.yml'), 'utf8')
  const snapshot: AgentProfileSnapshot = { name: paths.name, directory: paths.profile, bundles, patch,
    contentHash: createHash('sha256').update(JSON.stringify([raw, patch])).digest('hex') }
  return { manifest, snapshot }
}

/**
 * Reject edits to the captured profile before or during an execution.
 * @param snapshot - Exact source declaration captured for that execution.
 */
export async function verifyAgentProfile(snapshot: AgentProfileSnapshot | undefined): Promise<void> {
  if (snapshot === undefined) return
  const files: string[] = []
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const path = join(snapshot.directory, name)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Agent profile files cannot be symbolic links')
    files.push(await readFile(path, 'utf8'))
  }
  if (createHash('sha256').update(JSON.stringify(files)).digest('hex') !== snapshot.contentHash) {
    throw new Error('Agent profile changed during execution; run again with the current composition')
  }
}

/**
 * Select an already registered local bundle without loading it into the application Host.
 * @param paths - Owning project locations.
 * @param artifact - Exact registered bundle.
 * @param enabled - Whether subsequent project executions include the bundle.
 * @param limits - Source verification bounds.
 * @param assertWritable - Recheck writer ownership and execution exclusion at the commit point.
 * @returns the committed profile declaration.
 */
export async function selectAgentBundle(paths: AgentProfilePaths, artifact: CognitivePlugin, enabled: boolean,
  limits: PluginArtifactLimits, assertWritable: () => void): Promise<AgentProfileSnapshot> {
  await assertProfilePath(paths.root, join(paths.profile, 'package.json'))
  return withFileLock(join(paths.profile, 'package.json'), async () => {
    if (enabled) {
      const source = await inspectPluginArtifact(paths.bundles, artifact.directory, limits, paths.plugins)
      if (source.contentHash !== artifact.contentHash) throw new Error('Registered bundle source changed; register a new revision')
    }
    const { manifest } = await readAgentProfile(paths)
    const names = enabled ? [...manifest.dsh.profile.bundles] : manifest.dsh.profile.bundles.filter(name => name !== artifact.name)
    if (enabled) {
      if (!names.includes(artifact.name)) names.push(artifact.name)
      manifest.dependencies[artifact.name] = `file:${relative(paths.profile, artifact.directory).split(sep).join('/')}`
    }
    manifest.dsh.profile.bundles = names
    assertWritable()
    await writeFileAtomic(join(paths.profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    return (await readAgentProfile(paths)).snapshot
  })
}

/**
 * Require each non-runtime layer to name a registered bundle owned by this project.
 * @param paths - Owning project locations.
 * @param runtimeBundles - Trusted deployment layers.
 * @param registered - This project's retained bundle identities.
 * @returns selected registrations in the profile's declared order, plus its exact declaration.
 */
export async function resolveAgentProfile(paths: AgentProfilePaths, runtimeBundles: string[], registered: CognitivePlugin[]): Promise<{
  snapshot: AgentProfileSnapshot
  artifacts: CognitivePlugin[]
}> {
  const { manifest, snapshot } = await readAgentProfile(paths)
  const artifacts: CognitivePlugin[] = []
  for (const name of snapshot.bundles) {
    if (runtimeBundles.includes(name)) {
      if (manifest.dependencies[name] !== undefined) throw new Error('Local bundles cannot replace deployment runtime packages')
      continue
    }
    const artifact = registered.find(item => item.name === name)
    const spec = manifest.dependencies[name]
    if (artifact === undefined || spec === undefined || !spec.startsWith('file:')) {
      throw new Error(`Agent profile bundle ${name} must reference a registered local bundle`)
    }
    const directory = resolve(paths.profile, spec.slice(5))
    await assertProfilePath(paths.root, directory)
    if (await realpath(directory) !== artifact.directory) throw new Error(`Agent profile bundle ${name} belongs to a different source`)
    artifacts.push(artifact)
  }
  return { snapshot, artifacts }
}
