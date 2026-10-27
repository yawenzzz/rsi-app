/** Refuse source-checkout dependencies or vendored DSH code in this application. */
import { readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    if (/^(workspace:|link:|file:)/.test(spec)) throw new Error(`${section}.${name} depends on a local checkout`)
    if (name.startsWith('@deepseek-ai/dsh-rsi-')) throw new Error(`Unpublished fork package ${name}`)
  }
}
const forbidden = [/\/Users\/[^\s'"]+\/pm-rsi/, /(?:from\s*|import\s*|require\s*\()\s*['"]@deepseek-ai\/dsh-rsi-/,
  /__DSH_STORAGE_NAMESPACE__/, /__DSH_WORKSPACE_ROUTING__/, /uiWorkspace\.registerProvider/]
for (const folder of ['src', 'scripts', 'bundles', 'dist']) {
  for (const name of await readdir(join(root, folder), { recursive: true })) {
    if (!/\.(?:[cm]?[jt]sx?|ya?ml|json)$/.test(name)) continue
    if (folder === 'scripts' && name === 'check-standalone.mjs') continue
    const content = await readFile(join(root, folder, name), 'utf8')
    if (forbidden.some(pattern => pattern.test(content))) throw new Error(`Fork-only dependency in ${folder}/${name}`)
  }
}
const installed = JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
const location = await realpath(join(root, 'node_modules/@deepseek-ai/dsh'))
if (!location.startsWith(await realpath(join(root, 'node_modules')))) throw new Error('DSH resolves outside the independent installation')
if (installed.version !== manifest.engines.dsh) throw new Error('Installed DSH differs from the tested runtime')
console.log(`Standalone check passed: official DSH ${installed.version}, no fork dependencies.`)
