/** Published package identity and its installed location, independent of a source checkout. */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

export const RSI_PACKAGE = '@yawenzzz/dsh-rsi'
export const rsiPackageDirectory = dirname(createRequire(import.meta.url).resolve(`${RSI_PACKAGE}/package.json`))
