import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { corpus, compareCase, classify, compareCorpus } from './compat/runner.js'
import { generatedCases } from './compat/generated.js'
import { canonicalFixtureContent, realCases } from './compat/real.js'
import { structuralRuleNames } from '../dist/structural.js'

const baseline = JSON.parse(fs.readFileSync(new URL('./compat/baseline.json', import.meta.url), 'utf8'))

test('fixture provenance canonicalizes Windows line endings', () => {
  assert.equal(canonicalFixtureContent('one\r\ntwo\r\n'), 'one\ntwo\n')
  assert.equal(canonicalFixtureContent('one\ntwo\n'), 'one\ntwo\n')
})

test('upstream compatibility: every difference must match the reviewed baseline', () => {
  const report = compareCorpus()
  assert.deepEqual(report.differences, baseline, 'Run pnpm compat --json and inspect regressions/resolved entries')
  assert.equal(report.cases, 2636, 'Review corpus changes explicitly; do not silently shrink the denominator')
})

test('every structural rule is mapped or explicitly identified as project-specific', () => {
  const locallyCovered = [
    'vue/block-lang', 'vue/block-order', 'vue/block-tag-newline',
    'vue/enforce-style-attribute', 'vue/html-closing-bracket-newline',
    'vue/html-closing-bracket-spacing', 'vue/html-indent', 'vue/no-empty-component-block',
    'vue/no-literals-in-template', 'vue/no-negated-v-if-condition',
    'vue/padding-line-between-blocks',
  ]
  assert.deepEqual(structuralRuleNames.toSorted(), [
    ...new Set(corpus.cases.map(c => c.rule)),
    ...locallyCovered,
    'vue/no-target-blank', 'vue/require-v-for-with-index-key',
  ].toSorted())
})

for (const rule of new Set(corpus.cases.map(c => c.rule))) {
  test(`reference controls and severities: ${rule}`, () => {
    const entries = corpus.cases.filter(c => c.rule === rule)
    assert.ok(entries.some(c => c.expectedCount === 0), 'Missing negative control')
    assert.ok(entries.some(c => c.expectedCount > 0), 'Missing positive control')
    for (const severity of [0, 1]) {
      // Check the complete imported case set even for rules with known gaps.
      for (const entry of entries) {
        const result = compareCase(entry, severity)
        if (severity === 0) assert.deepEqual(result, { expected: [], actual: [] }, entry.id)
        else {
          const errorResult = baseline[entry.id]
          if (!errorResult) assert.equal(classify(result), 'match', entry.id)
          else assert.deepEqual(result, {
            expected: errorResult.expected.map(d => ({ ...d, severity })),
            actual: errorResult.actual.map(d => ({ ...d, severity })),
          }, entry.id)
        }
      }
    }
  })
}

test('generated layouts, Unicode, CRLF and nested template scopes match ESLint', () => {
  const failures = []
  for (const entry of generatedCases) {
    const result = compareCase(entry)
    if (classify(result) !== 'match') failures.push({ id: entry.id, ...result })
  }
  assert.deepEqual(failures, [])
})


test('pinned Nuxt components match every common structural rule', () => {
  for (const entry of realCases) assert.equal(classify(compareCase(entry)), 'match', entry.id)
})
