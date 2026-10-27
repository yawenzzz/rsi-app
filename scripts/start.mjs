/** Forward application startup to the pinned, published DSH CLI. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const take = (flag, fallback) => {
  const index = args.indexOf(flag)
  if (index < 0) return fallback
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  args.splice(index, 2)
  return value
}
const home = resolve(take('--home', join(homedir(), '.rsi-standalone')))
const profile = take('--profile', 'rsi')
const require = createRequire(import.meta.url)
const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const child = spawn(process.execPath, [resolve(dirname(manifestPath), manifest.bin.dsh), '--profile', profile, ...args],
  { env: { ...process.env, DSH_HOME: home }, stdio: 'inherit' })
const interrupt = () => { if (child.exitCode === null) child.kill('SIGINT') }
const terminate = () => { if (child.exitCode === null) child.kill('SIGTERM') }
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1)
})
