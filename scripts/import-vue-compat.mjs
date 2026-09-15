/** Import reviewed upstream RuleTester cases; requires Node 22.13+ only to regenerate.
 * Usage: node scripts/import-vue-compat.mjs /path/to/eslint-plugin-vue [rule-name...]
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
const selected = new Set(process.argv.slice(3).map(name => name.replace(/^vue\//u, '')))
const previous = selected.size
  ? JSON.parse(fs.readFileSync(new URL('../test/compat/upstream.json', import.meta.url), 'utf8'))
  : { cases: [], files: {} }
const selectedRules = new Set([...selected].map(name => `vue/${name}`))
const cases = selected.size ? previous.cases.filter(entry => !selectedRules.has(entry.rule)) : []
const selectedFiles = new Set([...selected].map(name => `tests/lib/rules/${name}.test.ts`))
const files = Object.fromEntries(Object.entries(previous.files).filter(([file]) => !selectedFiles.has(file)))
const skippedCases = {
  'no-deprecated-v-bind-sync/invalid/5':
    '@vue/compiler-sfc 3.5.41 crashes while parsing argumentless v-bind.sync with a value',
  'require-valid-default-prop/valid/20':
    'requires the upstream TypeScript project fixture and imported Props2 type information',
  'require-valid-default-prop/invalid/45':
    'requires the upstream TypeScript project fixture and imported Props2 type information',
}
const pendingSkippedCases = new Set(Object.keys(skippedCases).filter(id =>
  !selected.size || selected.has(id.slice(0, id.indexOf('/')))))
const vueParserStub = {}
const tsParserStub = {}
for (const fullRule of structuralRuleNames.filter(rule =>
  !selected.size || selected.has(rule.slice(4)))) {
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
    if (!['../../eslint-compat', `../../../lib/rules/${name}`, 'vue-eslint-parser',
      '@typescript-eslint/parser', '../../test-utils/typescript'].includes(node.source.value)) {
      if (node.source.value === 'eslint' && node.importKind === 'type') {
        source = source.slice(0, node.start) + source.slice(node.end)
        continue
      }
      throw new Error(`Review new import: ${node.source.value}`)
    }
    source = source.slice(0, node.start) + source.slice(node.end)
  }
  class RuleTester {
    constructor(config = {}) { this.config = config }
    run(rule, _implementation, tests) {
      for (const kind of ['valid', 'invalid']) {
        tests[kind].forEach((entry, index) => {
          const test = typeof entry === 'string' ? { code: entry } : entry
          const id = `${rule}/${kind}/${index + 1}`
          if (skippedCases[id]) {
            pendingSkippedCases.delete(id)
            return
          }
          const languageOptions = { ...this.config.languageOptions, ...test.languageOptions }
          languageOptions.parserKind = languageOptions.parser === vueParserStub ? 'vue'
            : languageOptions.parser === tsParserStub ? 'typescript' : 'espree'
          delete languageOptions.parser
          cases.push({
            id,
            rule: fullRule, code: test.code, options: test.options ?? [],
            filename: test.filename ?? 'test.js', languageOptions,
            settings: test.settings ?? {},
            expectedCount: kind === 'valid' ? 0 : typeof test.errors === 'number' ? test.errors : test.errors.length,
          })
        })
      }
    }
  }
  // No real require, filesystem, process or network exposed to test modules.
  new vm.Script(stripTypeScriptTypes(source), { filename: relative }).runInNewContext({
    RuleTester, rule: {}, vueEslintParser: vueParserStub, tsParser: tsParserStub,
    getTypeScriptFixtureTestOptions: () => ({ filename: 'typescript-fixture.vue',
      languageOptions: { parser: vueParserStub, ecmaVersion: 2020, sourceType: 'module',
        parserOptions: { parser: '@typescript-eslint/parser' } } }),
    require: { resolve(parserName) {
      if (parserName !== '@typescript-eslint/parser') throw new Error(`Review parser: ${parserName}`)
      return parserName
    } },
  }, { timeout: 10000 })
}
if (pendingSkippedCases.size) throw new Error(
  `Skipped upstream cases disappeared; review: ${[...pendingSkippedCases].join(', ')}`,
)
const target = new URL('../test/compat/upstream.json', import.meta.url)
fs.writeFileSync(target, JSON.stringify({
  repository: 'https://github.com/vuejs/eslint-plugin-vue', version: '10.11.0', files, skippedCases, cases,
}, null, 2) + '\n')
fs.copyFileSync(path.join(root, 'LICENSE'), new URL('../test/compat/LICENSE.upstream', import.meta.url))
console.log(`${selected.size ? 'Updated' : 'Imported'} ${cases.length} cases from ${Object.keys(files).length} rule suites`)
