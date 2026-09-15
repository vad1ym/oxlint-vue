/** Import reviewed upstream RuleTester cases; requires Node 22.13+ only to regenerate.
 * Usage: node scripts/import-vue-compat.mjs /path/to/eslint-plugin-vue
 * CI uses the committed JSON and never downloads or executes upstream tests.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import { babelParse } from '@vue/compiler-sfc'
import { structuralRuleNames } from '../dist/structural.js'

const root = process.argv[2]
if (!root) throw new Error('Pass a reviewed eslint-plugin-vue v10.11.0 checkout')
const cases = []
const files = {}
for (const fullRule of structuralRuleNames) {
  const name = fullRule.slice(4)
  // These project-specific names are not upstream rules. Do not silently alias
  // them: require-v-for-with-index-key has different semantics altogether.
  if (['no-target-blank', 'require-v-for-with-index-key'].includes(name)) continue
  const relative = `tests/lib/rules/${name}.test.ts`
  let source = fs.readFileSync(path.join(root, relative), 'utf8')
  files[relative] = createHash('sha256').update(source).digest('hex')
  const ast = babelParse(source, { sourceType: 'module', plugins: ['typescript'] })
  for (const node of ast.program.body.toReversed()) {
    if (node.type !== 'ImportDeclaration') continue
    if (!['../../eslint-compat', `../../../lib/rules/${name}`, 'vue-eslint-parser'].includes(node.source.value)) {
      throw new Error(`Review new import: ${node.source.value}`)
    }
    source = source.slice(0, node.start) + source.slice(node.end)
  }
  class RuleTester {
    constructor(config) { this.config = config }
    run(rule, _implementation, tests) {
      for (const kind of ['valid', 'invalid']) {
        tests[kind].forEach((entry, index) => {
          const test = typeof entry === 'string' ? { code: entry } : entry
          const languageOptions = { ...this.config.languageOptions, ...test.languageOptions }
          delete languageOptions.parser
          cases.push({
            id: `${rule}/${kind}/${index + 1}`,
            rule: fullRule, code: test.code, options: test.options ?? [],
            filename: test.filename ?? 'test.vue', languageOptions,
            settings: test.settings ?? {},
            expectedCount: kind === 'valid' ? 0 : typeof test.errors === 'number' ? test.errors : test.errors.length,
          })
        })
      }
    }
  }
  // No real require, filesystem, process or network exposed to test modules.
  new vm.Script(stripTypeScriptTypes(source), { filename: relative }).runInNewContext({
    RuleTester, rule: {}, vueEslintParser: {},
    require: { resolve(parserName) {
      if (parserName !== '@typescript-eslint/parser') throw new Error(`Review parser: ${parserName}`)
      return parserName
    } },
  }, { timeout: 10000 })
}
const target = new URL('../test/compat/upstream.json', import.meta.url)
fs.writeFileSync(target, JSON.stringify({
  repository: 'https://github.com/vuejs/eslint-plugin-vue', version: '10.11.0', files, cases,
}, null, 2) + '\n')
fs.copyFileSync(path.join(root, 'LICENSE'), new URL('../test/compat/LICENSE.upstream', import.meta.url))
console.log(`Imported ${cases.length} cases from ${Object.keys(files).length} rule suites`)
