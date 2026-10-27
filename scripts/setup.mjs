/** Install the built RSI package into an independent official DSH Web profile. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { values } = parseArgs({ options: { home: { type: 'string' }, profile: { type: 'string', default: 'rsi' }, tarball: { type: 'string' } } })
const home = resolve(values.home ?? join(homedir(), '.rsi-standalone'))
const profile = values.profile
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profile)) throw new Error('Choose a simple profile name')
const dshPackage = require.resolve('@deepseek-ai/dsh/package.json')
const dsh = JSON.parse(await readFile(dshPackage, 'utf8'))
const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).engines.dsh
if (dsh.version !== expected) throw new Error(`Expected official DSH ${expected}, received ${dsh.version}`)
const binary = resolve(dirname(dshPackage), dsh.bin.dsh)
const profileDirectory = join(home, 'profiles', profile)
const env = { ...process.env, DSH_HOME: home }
let initialized = true
try { await access(join(profileDirectory, 'package.json')) } catch (error) {
  if (error.code !== 'ENOENT') throw error
  initialized = false
}
if (!initialized) execFileSync(process.execPath, [binary, '--profile', profile, '--from-default-profile', 'web', '--dump-config'],
  { cwd: root, env, stdio: ['inherit', 'ignore', 'inherit'] })
await mkdir(join(root, '.artifacts'), { recursive: true })
const packedTarball = values.tarball === undefined
  ? join(root, '.artifacts', JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', '.artifacts'],
    { cwd: root, encoding: 'utf8' }))[0].filename)
  : resolve(values.tarball)
// A changed development build can retain its npm version; give each archive a distinct install spec.
const digest = createHash('sha256').update(await readFile(packedTarball)).digest('hex').slice(0, 16)
const tarball = join(root, '.artifacts', basename(packedTarball).replace(/\.tgz$/, '') + `-${digest}.tgz`)
if (tarball !== packedTarball) await copyFile(packedTarball, tarball)
// This profile installs public packages; the user's global npm configuration is unchanged.
await writeFile(join(profileDirectory, '.npmrc'), 'registry=https://registry.npmjs.org/\n@deepseek-ai:registry=https://registry.npmjs.org/\n', { mode: 0o600 })
execFileSync(process.execPath, [binary, 'plugin', '--profile', profile, 'add', tarball, '--ignore-scripts'], { cwd: root, env, stdio: 'inherit' })
if (values.tarball === undefined) {
  const name = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name
  const current = await readFile(join(root, 'dist/client.js'))
  const installed = await readFile(join(profileDirectory, 'node_modules', name, 'dist/client.js'))
  if (!current.equals(installed)) throw new Error('The installed RSI client differs from this build; restart setup with a new package version')
}
console.log(`RSI installed in ${profileDirectory}. Start with: npm start -- --home ${JSON.stringify(home)} --profile ${profile}`)
