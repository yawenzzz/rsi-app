/** Build only RSI-owned source; official DSH modules remain external. */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { Script } from 'node:vm'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await rm(join(root, 'dist'), { recursive: true, force: true })
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
await build({
  absWorkingDir: root,
  entryPoints: { index: 'dist/types/index.js', 'harness/index': 'dist/types/harness/index.js',
    'runtime/index': 'dist/types/runtime/index.js', 'agent/index': 'dist/types/agent/index.js' },
  outdir: 'dist', entryNames: '[dir]/[name]', chunkNames: 'chunks/[name]-[hash]',
  platform: 'node', target: 'node24', format: 'esm', bundle: true, splitting: true,
  packages: 'external', sourcemap: false,
})

const styles = new Map()
const platform = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives']
const client = await build({
  absWorkingDir: root, entryPoints: ['dist/types/client/index.js'], platform: 'browser', target: 'es2022',
  format: 'cjs', bundle: true, write: false, external: platform, sourcemap: false,
  plugins: [{ name: 'rsi-css-modules', setup(builder) {
    builder.onResolve({ filter: /\.module\.css$/ }, args => {
      const emitted = resolve(args.resolveDir, args.path)
      return { path: join(root, 'src', relative(join(root, 'dist/types'), emitted)), namespace: 'rsi-css' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'rsi-css' }, async args => {
      const result = transform({ filename: relative(root, args.path), code: await readFile(args.path),
        cssModules: { pattern: 'rsi_[name]_[local]_[hash]' }, minify: true })
      styles.set(args.path, result.code.toString())
      return { contents: `export default ${JSON.stringify(Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name])))}`, loader: 'js' }
    })
  } }],
})
const css = [...styles.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join('\n')
const factory = `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{
const rsiExports=(()=>{
const module={exports:{}};const exports=module.exports;
${client.outputFiles[0].text}
return module.exports;
})();
return {...rsiExports,apply(ctx,...args){ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin=${JSON.stringify(manifest.name)};style.textContent=${JSON.stringify(css)};const script=document.querySelector('script[nonce]');if(script)style.nonce=script.nonce;document.head.append(style);return()=>style.remove()});return rsiExports.apply(ctx,...args)}};
}});\n`
new Script(factory, { filename: 'dist/client.js' })
await mkdir(dirname(join(root, 'dist/client.js')), { recursive: true })
await writeFile(join(root, 'dist/client.js'), factory)
console.log(`Built ${manifest.name}@${manifest.version} with ${styles.size} RSI stylesheets.`)
