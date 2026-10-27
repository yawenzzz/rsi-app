/** Materialize a project's declared capabilities for the installed runtime, without a Harness checkout. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile, lstat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { readAgentProfile, type AgentProfilePaths } from './agent-profile.ts'
import { inspectPluginArtifact, type PluginArtifactLimits, type PluginArtifactSource } from './cognitive-plugins.ts'
import { assembleProjectPackages } from './execution/project-packages.ts'

/** Immutable local capability assembly used by one running Agent. */
export interface RuntimeProfile {
  name: string
  home: string
  hash: string
  patch: string
  bundles: PluginArtifactSource[]
}

async function linkProjectProfile(paths: AgentProfilePaths, home: string): Promise<void> {
  const profile = join(home, 'profiles', paths.name)
  await mkdir(dirname(profile), { recursive: true })
  const existing = await lstat(profile).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    return undefined
  })
  if (existing?.isSymbolicLink()) {
    if (await realpath(profile) !== paths.profile) throw new Error('Agent runtime profile points at a different project')
    return
  }
  let backup: string | undefined
  if (existing !== undefined) {
    if (!existing.isDirectory()) throw new Error('Agent runtime profile must be a directory')
    const backups = join(paths.root, '.rsi', 'profile-backups')
    await mkdir(backups, { recursive: true, mode: 0o700 })
    backup = join(await mkdtemp(join(backups, 'generated-')), 'profile')
    await rename(profile, backup)
  }
  try { await symlink(paths.profile, profile, process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
    if (backup !== undefined) await rename(backup, profile)
    throw error
  }
}

/**
 * Snapshot local capabilities and expose the project's writable profile to its runtime.
 * @param paths - Project-owned source and profile locations.
 * @param builtins - Bundle names supplied by the application runtime.
 * @param providerPackages - External model packages supplied by the application.
 * @param limits - First-party source limits.
 * @param runtimeVersion - Installed platform release, recorded with the composition.
 * @returns one prepared runtime composition without starting code.
 */
export async function prepareRuntimeProfile(paths: AgentProfilePaths, builtins: string[],
  providerPackages: ReadonlyMap<string, string>, limits: PluginArtifactLimits, runtimeVersion: string): Promise<RuntimeProfile> {
  const { manifest, snapshot } = await readAgentProfile(paths)
  const artifacts: PluginArtifactSource[] = []
  const providers = new Map<string, string>()
  const external: { name: string; directory: string; version: string }[] = []
  for (const name of snapshot.bundles) {
    if (builtins.includes(name)) continue
    const spec = manifest.dependencies[name]
    if (spec === undefined) throw new Error(`Agent bundle ${name} must be declared in its profile dependencies`)
    const directory = spec.startsWith('file:') ? resolve(paths.profile, spec.slice(5)) : undefined
    const child = directory === undefined ? undefined : relative(paths.bundles, directory)
    if (directory !== undefined && child !== undefined && child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) {
      const source = await inspectPluginArtifact(paths.bundles, directory, limits, paths.plugins)
      if (source.name !== name) throw new Error(`Agent bundle ${name} does not match its package name`)
      artifacts.push(source)
      continue
    }
    let installed = join(paths.profile, 'node_modules', name)
    let raw: string
    try { raw = await readFile(join(installed, 'package.json'), 'utf8') } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      const provider = providerPackages.get(name)
      if (provider === undefined || directory !== resolve(provider)) throw new Error(`Install Agent bundle ${name} in its project profile before starting`)
      installed = provider
      raw = await readFile(join(installed, 'package.json'), 'utf8')
      providers.set(name, installed)
    }
    const metadata = z.object({ name: z.literal(name), version: z.string().min(1) }).parse(JSON.parse(raw))
    external.push({ ...metadata, directory: await realpath(installed) })
  }
  const hash = createHash('sha256').update(JSON.stringify({ profile: snapshot.contentHash, runtimeVersion, artifacts,
    external })).digest('hex')
  const cache = join(paths.root, '.rsi', 'cache')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const generation = join(cache, hash)
  let prepared: { bundles: PluginArtifactSource[]; packages: { name: string; directory: string }[] }
  const assemblySchema = z.object({
    bundles: z.array(z.object({ name: z.string(), version: z.string(), directory: z.string(), contentHash: z.string() })),
    packages: z.array(z.object({ name: z.string(), directory: z.string() })) })
  try {
    prepared = assemblySchema.parse(JSON.parse(await readFile(join(generation, 'assembly.json'), 'utf8')))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const staging = await mkdtemp(join(cache, '.prepare-'))
    const copied = await assembleProjectPackages({ root: paths.bundles, pluginRoot: paths.plugins, artifacts, ...limits }, join(staging, 'sources'))
    // The build moves once before publication; rewrite only the paths owned by this fresh directory.
    const move = (value: string) => value.replace(staging, generation)
    prepared = { bundles: copied.bundles.map(item => ({ ...item, directory: move(item.directory) })),
      packages: copied.packages.map(item => ({ ...item, directory: move(item.directory) })) }
    for (const pkg of copied.packages) {
      for (const dependency of copied.packages) {
        const link = join(pkg.directory, 'node_modules', dependency.name)
        try {
          if (!(await lstat(link)).isSymbolicLink()) continue
          await unlink(link)
          await symlink(move(dependency.directory), link, process.platform === 'win32' ? 'junction' : 'dir')
        } catch (failure) {
          if (!(failure instanceof Error && 'code' in failure && failure.code === 'ENOENT')) throw failure
        }
      }
    }
    await writeFile(join(staging, 'assembly.json'), JSON.stringify(prepared) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(staging, generation)
  }
  const home = join(paths.root, '.rsi', 'home')
  await linkProjectProfile(paths, home)
  const profile = paths.profile
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  for (const [name, directory] of [...prepared.packages.map(item => [item.name, item.directory] as const), ...providers]) {
    const link = join(profile, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    try {
      if (!(await lstat(link)).isSymbolicLink()) throw new Error(`Generated Agent dependency is not a link: ${name}`)
      await unlink(link)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    await symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const patch = join(generation, 'runtime.patch.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'hmr', disabled: true },
  ], null, 2) + '\n', { mode: 0o600 })
  return { name: paths.name, home, hash, patch, bundles: prepared.bundles }
}
