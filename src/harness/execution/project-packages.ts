/** Private source snapshots and dependency links for one Agent execution. */
import { cp, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { inspectPluginSources, verifyPluginExecution, type PluginExecution, type PluginArtifactSource } from '../cognitive-plugins.ts'

/**
 * Copy registered first-party sources into the run, preserving local dependency paths.
 * @param execution - Captured bundle graph and source bounds.
 * @param directory - Fresh run-owned source directory.
 * @returns bundle and package locations used only by this execution.
 */
export async function assembleProjectPackages(execution: PluginExecution, directory: string): Promise<{
  bundles: PluginArtifactSource[]
  packages: { name: string; directory: string }[]
}> {
  await verifyPluginExecution(execution)
  const bundleRoot = await realpath(execution.root)
  const pluginRoot = execution.pluginRoot === undefined ? undefined : await realpath(execution.pluginRoot)
  let root = bundleRoot
  if (pluginRoot !== undefined) {
    for (;;) {
      const child = relative(root, pluginRoot)
      if (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)) break
      root = dirname(root)
    }
  }
  const packages = new Map<string, { original: string; directory: string }>()
  for (const artifact of execution.artifacts) {
    const inspected = await inspectPluginSources(execution.root, artifact.directory, execution, execution.pluginRoot)
    for (const pkg of inspected.packages) {
      const previous = packages.get(pkg.name)
      if (previous !== undefined && previous.original !== pkg.directory) throw new Error('Agent profile selects conflicting local package implementations')
      if (previous !== undefined) continue
      const target = join(directory, relative(root, pkg.directory))
      await cp(pkg.directory, target, { recursive: true, dereference: false,
        filter: source => !['node_modules', '.git'].includes(basename(source)) })
      packages.set(pkg.name, { original: pkg.directory, directory: await realpath(target) })
    }
  }
  const manifestSchema = z.object({ dependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional() })
  for (const pkg of packages.values()) {
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(pkg.original, 'package.json'), 'utf8')))
    for (const name of Object.keys({ ...manifest.peerDependencies, ...manifest.dependencies })) {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error('Invalid plugin dependency package name')
      let source = packages.get(name)?.directory
      if (source === undefined) {
        try { source = await realpath(join(pkg.original, 'node_modules', name)) } catch (error) {
          // Runtime-supplied peer packages resolve through the CLI's installation scope.
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          continue
        }
      }
      const target = join(pkg.directory, 'node_modules', name)
      await mkdir(dirname(target), { recursive: true })
      await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    }
  }
  const bundles = execution.artifacts.map((artifact) => {
    const pkg = packages.get(artifact.name)
    if (pkg === undefined) throw new Error('Registered bundle is missing from the execution package graph')
    return { ...artifact, directory: pkg.directory }
  })
  const snapshot: PluginExecution = { ...execution, root: join(directory, relative(root, bundleRoot)), artifacts: bundles,
    ...pluginRoot === undefined ? {} : { pluginRoot: join(directory, relative(root, pluginRoot)) } }
  if (snapshot.pluginRoot !== undefined) await mkdir(snapshot.pluginRoot, { recursive: true })
  if (bundles.length) await verifyPluginExecution(snapshot)
  // Reject copied symlinks even if a source changed between inspection and copying.
  for (const pkg of packages.values()) if ((await lstat(pkg.directory)).isSymbolicLink()) throw new Error('Copied plugin package is a symbolic link')
  return { bundles, packages: [...packages].map(([name, pkg]) => ({ name, directory: pkg.directory })) }
}
