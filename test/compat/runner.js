import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Linter } from 'eslint'
import vue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import tsParser from '@typescript-eslint/parser'
import { parse } from '@vue/compiler-sfc'
import { checkTemplate, structuralRuleNames } from '../../dist/structural.js'

export const corpus = JSON.parse(fs.readFileSync(new URL('./upstream.json', import.meta.url), 'utf8'))
assert.equal(vue.meta.version, corpus.version, 'Review reference plugin upgrades with the corpus')
assert.equal(Linter.version, '10.10.0', 'Review ESLint upgrades with the corpus')
const linter = new Linter()
const disabled = Object.fromEntries(structuralRuleNames.map(name => [name, 'off']))
const sort = findings => findings.toSorted((a, b) => a.line - b.line || a.column - b.column || a.severity - b.severity)

export function compareCase(entry, severity = 2) {
  const { rule, code, options, languageOptions = {}, settings = {} } = entry
  const filename = entry.filename ?? 'case.vue'
  assert.ok(vue.rules[rule.slice(4)], `Unknown reference rule: ${rule}`)
  const { parserKind, ...eslintLanguageOptions } = languageOptions
  const parserOptions = { ...eslintLanguageOptions.parserOptions }
  if (parserOptions.parser === '@typescript-eslint/parser') parserOptions.parser = tsParser
  const parser = parserKind === 'espree' ? undefined : parserKind === 'typescript' ? tsParser : vueParser
  const messages = linter.verify(code, [{
    files: ['**/*.{js,ts,vue}'], plugins: { vue }, settings,
    languageOptions: { ...eslintLanguageOptions, ...(parser ? { parser } : {}), parserOptions },
    rules: { [rule]: [severity, ...options] },
  }], { filename })
  assert.deepEqual(messages.filter(m => !m.ruleId || m.fatal), [], `Reference failed: ${entry.id}`)
  const expected = sort(messages.map(m => ({ line: m.line, column: m.column, severity: m.severity })))
  // Validate the imported corpus against the actual reference engine, so a
  // broken config/ignored file cannot turn every negative control green.
  if (entry.expectedCount !== undefined && severity !== 0) {
    assert.equal(expected.length, entry.expectedCount, `Reference drift: ${entry.id}`)
  }
  const { descriptor } = parse(code, { filename })
  const localOptions = rule === 'vue/no-deprecated-filter'
    && languageOptions.parserOptions?.vueFeatures?.filter === false
    ? [{ filterSyntax: false }]
    : rule === 'vue/no-ref-as-operand' && languageOptions.globals?.ref
      ? [{ globalRef: true }]
    : options
  const actual = sort(checkTemplate(descriptor.template?.ast, filename, code,
    { ...disabled, [rule]: [severity, ...localOptions] }, (descriptor.scriptSetup ?? descriptor.script)?.content,
  ).map(d => ({ line: d.line, column: d.column, severity: d.severity === 'error' ? 2 : 1 })))
  return { expected, actual }
}

export function classify({ expected, actual }) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return 'match'
  if (expected.length > actual.length) return 'missed'
  if (expected.length < actual.length) return 'extra'
  return 'location'
}

export function compareCorpus(entries = corpus.cases) {
  const differences = {}
  const rules = {}
  for (const entry of entries) {
    const result = compareCase(entry)
    const category = classify(result)
    const row = rules[entry.rule] ??= { cases: 0, match: 0, missed: 0, extra: 0, location: 0 }
    row.cases++
    row[category]++
    if (category !== 'match') differences[entry.id] = { category, ...result }
  }
  const measured = new Set(entries.map(c => c.rule))
  return {
    reference: { eslint: Linter.version, vue: vue.meta.version },
    cases: entries.length, rules, differences,
    unmeasuredReferenceRules: Object.keys(vue.rules).map(name => `vue/${name}`).filter(name => !measured.has(name)).toSorted(),
    projectSpecificRules: structuralRuleNames.filter(name => !vue.rules[name.slice(4)]),
  }
}
