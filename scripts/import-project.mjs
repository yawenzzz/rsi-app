/** Explicit CLI entry for importing one stopped legacy RSI project. */
import { parseArgs } from 'node:util'
import { applyProjectImport, inspectProjectImport, ProjectImportError } from './migration-lib.mjs'

const usage = 'Usage: node scripts/import-project.mjs --project <directory> [--home <standalone-home>] [--profile rsi] [--apply] [--json]'

try {
  const { values } = parseArgs({ options: { project: { type: 'string' }, home: { type: 'string' },
    profile: { type: 'string', default: 'rsi' }, apply: { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false } } })
  if (values.help) console.log(usage)
  else {
    const input = { project: values.project, home: values.home, profile: values.profile }
    const result = values.apply ? await applyProjectImport(input) : await inspectProjectImport(input)
    if (values.json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`${result.mode}: ${result.project}`)
      console.log(`Official DSH ${result.runtimeVersion}; ${result.target.name}@${result.target.version}`)
      console.log(result.compatible ? 'Preflight passed.' : 'Preflight blocked:')
      for (const problem of result.problems) console.log(`- ${problem.code}: ${problem.name ?? problem.message ?? problem.path}`)
      if (result.backup) console.log(`Profile backup: ${result.backup}`)
      if (result.mode === 'dry-run') console.log('No files changed. Use --apply only after reviewing this report and closing the old RSI application.')
      console.log(result.nextStep)
    }
    if (!result.compatible) process.exitCode = 2
  }
} catch (error) {
  if (process.argv.includes('--json') && error instanceof ProjectImportError) {
    console.error(JSON.stringify({ code: error.code, message: error.message, ...error.details }, null, 2))
  } else console.error(`${error instanceof ProjectImportError ? `${error.code}: ` : ''}${error.message}\n${usage}`)
  process.exitCode = 1
}
