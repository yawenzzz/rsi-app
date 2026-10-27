/** Explicit, reversible project-profile import without reading or rewriting credentials and Session journals. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'

const root = fileURLToPath(new URL('..', import.meta.url))
const owner = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const LEGACY_AGENT = '@deepseek-ai/dsh-rsi-agent'
const identitySchema = z.strictObject({ id: z.string().regex(/^(?:a|w)-[a-f0-9-]{36}$/), createdAt: z.iso.datetime() })
const profileSchema = z.object({ name: z.string(), private: z.literal(true), dependencies: z.record(z.string(), z.string()),
  dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }).passthrough() }).passthrough() }).passthrough()
const packageSchema = z.object({ name: z.string(), version: z.string(), dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional() }).passthrough()
const digest = value => createHash('sha256').update(value).digest('hex')
const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Failure details contain paths and compatibility metadata, never source configuration or credentials. */
export class ProjectImportError extends Error {
  constructor(code, message, details = {}, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProjectImportError'
    this.code = code
    this.details = details
  }
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return false
  }
}

async function regularFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new ProjectImportError('UNSAFE_PATH', `Expected a regular file: ${path}`)
  return info
}

async function plainDirectory(path, optional = false) {
  let info
  try { info = await lstat(path) } catch (error) {
    if (optional && error.code === 'ENOENT') return
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ProjectImportError('UNSAFE_PATH', `Expected a real directory: ${path}`)
}

async function jsonFile(path) {
  let text
  try { text = utf8.decode(await readFile(path)); return { text, value: JSON.parse(text) } } catch (error) {
    throw new ProjectImportError('INVALID_JSON', `Cannot read JSON metadata: ${path}`, { path }, error)
  }
}

async function installedPackage(name, directory) {
  for (const search of createRequire(join(directory, 'package.json')).resolve.paths(name) ?? []) {
    const candidate = join(search, name)
    if (await exists(join(candidate, 'package.json'))) return realpath(candidate)
  }
  return undefined
}

function assertNoInlineSecrets(value) {
  if (Array.isArray(value)) { value.forEach(assertNoInlineSecrets); return }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/^(api_?key|authorization|password|secret|token)$/i.test(key) && child !== undefined) {
      throw new ProjectImportError('INLINE_SECRET', 'Move inline credentials out of the project profile before importing it')
    }
    if (key === 'headers' && child && Object.keys(child).length > 0) {
      throw new ProjectImportError('INLINE_SECRET', 'Move authentication headers out of the project profile before importing it')
    }
    if (/^baseurl$/i.test(key) && typeof child === 'string') {
      const url = new URL(child)
      if (url.username || url.password || url.search || url.hash) {
        throw new ProjectImportError('INLINE_SECRET', 'Project endpoints must not embed credentials or query parameters')
      }
    }
    assertNoInlineSecrets(child)
  }
}

function agentPatch(text) {
  const rows = yaml.load(text, { schema: entryListSchema })
  if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) {
    throw new ProjectImportError('INVALID_PATCH', 'The project patch must contain a YAML sequence of objects')
  }
  assertNoInlineSecrets(rows)
  if (rows.some(row => ['project-agent-tools', 'ui-rsi'].includes(row.id))) {
    throw new ProjectImportError('LEGACY_OVERRIDE', 'Adapt project-agent-tools/ui-rsi overrides to the standalone rsi-app configuration before importing')
  }
  const matching = rows.filter(row => row.id === 'rsi-app' && row.insert === undefined)
  if (matching.some(row => row.disabled !== undefined && row.disabled !== false || row.name !== undefined && row.name !== owner.name)) {
    throw new ProjectImportError('CONFLICTING_ROLE', 'The project patch disables rsi-app or assigns that entry to another module')
  }
  const current = matching.findLast(row => Object.hasOwn(row, 'config'))?.config ?? {}
  if (current === null || typeof current !== 'object' || Array.isArray(current) || Object.hasOwn(current, '__jsExpr')) {
    throw new ProjectImportError('CONFLICTING_ROLE', 'The rsi-app configuration must be a literal object before importing')
  }
  if (current.role === 'agent') return text
  rows.push({ id: 'rsi-app', config: { ...current, role: 'agent' } })
  return yaml.dump(rows, { schema: entryListSchema, lineWidth: -1, noRefs: true })
}

async function inspectPackages(names, manifest, profile, target, runtimeVersion) {
  const visited = new Set()
  const packages = []
  const problems = []
  const visit = async (name, directory, selected = false) => {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) throw new ProjectImportError('INVALID_PACKAGE_NAME', 'A selected package name is invalid')
    const canonical = await realpath(directory)
    if (visited.has(canonical)) return
    visited.add(canonical)
    const { value } = await jsonFile(join(canonical, 'package.json'))
    const pkg = packageSchema.parse(value)
    if (pkg.name !== name) throw new ProjectImportError('PACKAGE_NAME_MISMATCH', `Package ${name} resolves to ${pkg.name}`, { name, directory: canonical })
    const issue = evaluatePluginCompatibility(pkg, {}, runtimeVersion)
    packages.push({ name, version: pkg.version, directory: canonical, compatible: issue === undefined })
    if (issue !== undefined) problems.push({ code: 'INCOMPATIBLE_PLUGIN', ...issue })
    if (selected && !pkg.dsh?.bundle?.patch) problems.push({ code: 'NOT_A_BUNDLE', name, directory: canonical })
    const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies }
    for (const [dependency, spec] of Object.entries(dependencies)) {
      // Official runtime packages are supplied by the pinned CLI; each plugin's declared compatibility was checked above.
      if (dependency === '@deepseek-ai/dsh' || dependency.startsWith('@deepseek-ai/dsh-') || dependency.startsWith('@deepseek-ai/cordis')) continue
      let child
      if (typeof spec === 'string' && /^(file:|link:)/.test(spec)) child = resolve(canonical, spec.slice(spec.indexOf(':') + 1))
      else child = await installedPackage(dependency, canonical)
      if (child === undefined || !await exists(join(child, 'package.json'))) {
        if (!Object.hasOwn(pkg.optionalDependencies ?? {}, dependency)) problems.push({ code: 'MISSING_DEPENDENCY', name: dependency, requiredBy: name })
        continue
      }
      await visit(dependency, child)
    }
  }
  const require = createRequire(import.meta.url)
  const installation = dirname(require.resolve('@deepseek-ai/dsh/package.json'))
  for (const name of names) {
    if (name === owner.name) { await visit(name, target.directory, true); continue }
    const spec = manifest.dependencies[name]
    const directory = typeof spec === 'string' && /^(file:|link:)/.test(spec)
      ? resolve(profile, spec.slice(spec.indexOf(':') + 1))
      : await installedPackage(name, profile) ?? await installedPackage(name, installation)
    if (directory === undefined || !await exists(join(directory, 'package.json'))) {
      problems.push({ code: 'MISSING_BUNDLE', name })
      continue
    }
    await visit(name, directory, true)
  }
  return { packages, problems }
}

async function planImport(input, ownLease = false) {
  if (typeof input.project !== 'string' || input.project.trim() === '') throw new ProjectImportError('PROJECT_REQUIRED', 'Provide --project with an existing RSI project directory')
  const project = await realpath(resolve(input.project))
  if (project === parse(project).root) throw new ProjectImportError('UNSAFE_PATH', 'Choose a project directory, not a filesystem root')
  const home = resolve(input.home ?? join(homedir(), '.rsi-standalone'))
  const profileName = input.profile ?? 'rsi'
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profileName)) throw new ProjectImportError('INVALID_PROFILE', 'Choose a simple application profile name')
  const mainProfile = join(home, 'profiles', profileName)
  const main = (await jsonFile(join(mainProfile, 'package.json'))).value
  if (!main.dependencies?.[owner.name] || !main.dsh?.profile?.bundles?.includes(owner.name)) {
    throw new ProjectImportError('SETUP_REQUIRED', `Install ${owner.name} in the target application profile first`, { home, profile: profileName })
  }
  const directory = await realpath(join(mainProfile, 'node_modules', owner.name))
  const targetManifest = packageSchema.parse((await jsonFile(join(directory, 'package.json'))).value)
  if (targetManifest.name !== owner.name) throw new ProjectImportError('SETUP_REQUIRED', 'The target profile resolves a different RSI package')
  const target = { name: targetManifest.name, version: targetManifest.version, directory }
  const profile = join(project, 'profile')
  const state = join(project, '.rsi', 'state')
  for (const path of [join(project, '.rsi'), profile]) await plainDirectory(path)
  await plainDirectory(state, true)
  const identityPath = join(project, '.rsi', 'identity.json')
  await regularFile(identityPath)
  const identity = await jsonFile(identityPath)
  const record = identitySchema.parse(identity.value)
  const manifestPath = join(profile, 'package.json')
  const patchPath = join(profile, 'cordis.patch.yml')
  const manifestInfo = await regularFile(manifestPath)
  const patchInfo = await regularFile(patchPath)
  const source = await jsonFile(manifestPath)
  const manifest = profileSchema.parse(source.value)
  if (manifest.name !== `agent-${record.id}`) throw new ProjectImportError('PROFILE_IDENTITY_MISMATCH', 'The source profile name does not match .rsi/identity.json')
  const selected = manifest.dsh.profile.bundles
  if (!selected.includes(LEGACY_AGENT) && !selected.includes(owner.name)) {
    throw new ProjectImportError('UNSUPPORTED_PROFILE', 'The project does not select a legacy or standalone RSI Agent bundle')
  }
  const next = structuredClone(manifest)
  next.dsh.profile.bundles = [...new Set(selected.map(name => name === LEGACY_AGENT ? owner.name : name))]
  delete next.dependencies[LEGACY_AGENT]
  next.dependencies[owner.name] = `file:${directory}`
  const patchBefore = utf8.decode(await readFile(patchPath))
  const patchAfter = agentPatch(patchBefore)
  const manifestAfter = JSON.stringify(next, null, 2) + '\n'
  const runtimeVersion = getDshRuntimeVersion()
  const inspected = await inspectPackages(next.dsh.profile.bundles, next, profile, target, runtimeVersion)
  const writer = join(state, 'writer')
  if (await exists(writer)) await regularFile(writer)
  if (!ownLease && await exists(`${writer}.lock`)) inspected.problems.push({ code: 'PROJECT_IN_USE', path: writer,
    message: 'Close the RSI application owning this project before importing; this tool never removes an existing writer lease' })
  const changed = source.text !== manifestAfter || patchBefore !== patchAfter
  const report = { mode: 'dry-run', project, home, profile: profileName, agentId: record.id, runtimeVersion, target,
    changed, compatible: inspected.problems.length === 0, packages: inspected.packages, problems: inspected.problems,
    changes: changed ? ['profile/package.json', 'profile/cordis.patch.yml'] : [],
    nextStep: `Open the standalone RSI application for this home and add the existing directory ${project}; the tool does not alter the project catalog.` }
  return { report, input: { project, home, profile: profileName }, writer, identityHash: digest(identity.text),
    files: [{ path: manifestPath, before: source.text, after: manifestAfter, mode: manifestInfo.mode & 0o777 },
      { path: patchPath, before: patchBefore, after: patchAfter, mode: patchInfo.mode & 0o777 }] }
}

/** Inspect the migration without creating directories, taking locks, or writing project data. */
export async function inspectProjectImport(input) { return (await planImport(input)).report }

async function defaultAcquireLease(options) {
  let acquireWriterLease
  try { ({ acquireWriterLease } = await import('../dist/types/runtime/writer-lease.js')) } catch (error) {
    throw new ProjectImportError('BUILD_REQUIRED', 'Build RSI before applying an import: npm run build', {}, error)
  }
  return acquireWriterLease(options, () => {})
}

/** Apply one validated migration under project and profile locks; a failed replacement restores both original files. */
export async function applyProjectImport(input, hooks = {}) {
  const original = await planImport(input)
  if (!original.report.compatible) throw new ProjectImportError('PRECHECK_FAILED', 'Project import preflight failed; no profile files were changed', { report: original.report })
  if (!original.report.changed) return { ...original.report, mode: 'unchanged', backup: null }
  const acquireLease = hooks.acquireLease ?? defaultAcquireLease
  const writeAtomic = hooks.writeAtomic ?? writeFileAtomic
  const lease = await acquireLease({ path: original.writer, staleMs: 30000, updateMs: 10000 })
  try {
    return await withFileLock(original.files[0].path, async () => {
      lease.assertHeld()
      const current = await planImport(original.input, true)
      if (!current.report.compatible) throw new ProjectImportError('PRECHECK_FAILED', 'Project compatibility changed before import', { report: current.report })
      if (current.identityHash !== original.identityHash || current.files.some((file, index) => file.before !== original.files[index].before)) {
        throw new ProjectImportError('SOURCE_CHANGED', 'Project identity or profile changed after preflight; inspect it again')
      }
      const backups = join(current.report.project, '.rsi', 'import-backups')
      await plainDirectory(backups, true)
      await mkdir(backups, { recursive: true, mode: 0o700 })
      const backup = await mkdtemp(join(backups, 'profile-'))
      for (const file of current.files) await writeFile(join(backup, file.path.endsWith('package.json') ? 'package.json' : 'cordis.patch.yml'),
        file.before, { flag: 'wx', mode: 0o600 })
      await writeFile(join(backup, 'import.json'), JSON.stringify({ format: 1, agentId: current.report.agentId,
        target: current.report.target, runtimeVersion: current.report.runtimeVersion,
        files: current.files.map(file => ({ name: file.path.endsWith('package.json') ? 'package.json' : 'cordis.patch.yml', sha256: digest(file.before) })) }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
      try {
        for (const file of current.files) { lease.assertHeld(); await writeAtomic(file.path, file.after, { mode: 0o600 }) }
        lease.assertHeld()
      } catch (error) {
        try { lease.assertHeld() } catch (leaseError) {
          throw new ProjectImportError('LEASE_LOST', 'Writer ownership was lost; profile state may be partial. Close all owners before restoring the retained backup',
            { backup }, new AggregateError([error, leaseError]))
        }
        const restored = await Promise.allSettled(current.files.map(file => {
          lease.assertHeld()
          return writeAtomic(file.path, file.before, { mode: file.mode })
        }))
        const failures = restored.filter(result => result.status === 'rejected')
        if (failures.length > 0) throw new ProjectImportError('ROLLBACK_FAILED', 'Import failed and rollback was incomplete; restore the retained profile backup before starting the Agent',
          { backup }, new AggregateError([error, ...failures.map(result => result.reason)]))
        throw new ProjectImportError('IMPORT_ROLLED_BACK', 'Import failed; both original profile files were restored', { backup }, error)
      }
      return { ...current.report, mode: 'applied', backup }
    })
  } finally { await lease.release() }
}
