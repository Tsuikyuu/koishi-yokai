import { fileURLToPath } from 'node:url'

import { ESLint } from 'eslint'
import { describe, expect, test } from 'vitest'

const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))
const SOURCE_PROBE = fileURLToPath(new URL('./packages/protocol/src/index.ts', import.meta.url))
const MODULE_SPECIFIER_RULE_IDS = new Set(['no-restricted-imports', 'no-restricted-syntax'])

const eslint = new ESLint({ cwd: REPOSITORY_ROOT })

const lintModuleSpecifiers = async (source) => {
  const [result] = await eslint.lintText(source, { filePath: SOURCE_PROBE })
  return result.messages.filter(
    (message) => message.ruleId !== null && MODULE_SPECIFIER_RULE_IDS.has(message.ruleId),
  )
}

describe('relative TypeScript module specifiers', () => {
  test.each([
    ['static import', "import './module.js'", 'no-restricted-imports'],
    [
      'type-only import',
      "import type { Value } from '../module.js'\nexport type Alias = Value",
      'no-restricted-imports',
    ],
    ['named re-export', "export { value } from './module.js'", 'no-restricted-imports'],
    ['star re-export', "export * from '../module.js'", 'no-restricted-imports'],
    ['query suffix', "import './module.js?worker'", 'no-restricted-imports'],
    ['dynamic import', "export const load = () => import('./module.js')", 'no-restricted-syntax'],
    [
      'template-literal dynamic import',
      'export const load = () => import(`./module.js`)',
      'no-restricted-syntax',
    ],
    ['import type', "export type Value = import('./module.js').Value", 'no-restricted-syntax'],
    [
      'import-equals',
      "import Value = require('./module.js')\nexport { Value }",
      'no-restricted-imports',
    ],
  ])('rejects a relative .js suffix in a %s', async (_name, source, ruleId) => {
    const messages = await lintModuleSpecifiers(source)

    expect(messages.map((message) => message.ruleId)).toEqual([ruleId])
  })

  test.each([
    ['extensionless relative imports', "import './module'\nexport * from '../module'"],
    ['bare package imports', "import 'package.js'\nexport * from '@scope/package/path.js'"],
    ['non-JavaScript assets', "import data from './data.json'\nvoid data"],
  ])('allows %s', async (_name, source) => {
    expect(await lintModuleSpecifiers(source)).toEqual([])
  })
})
