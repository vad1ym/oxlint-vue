import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generatedCases } from './compat/generated.js'
import { realCases } from './compat/real.js'
import { compareCase } from './compat/runner.js'
import { runOxlint } from '../dist/run.js'
import { preprocess } from '../dist/preprocess.js'
import { structuralRuleNames } from '../dist/structural.js'

test('real oxlint pipeline matches the generated reference corpus and preserves source positions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-compat-'))
  try {
    const cases = [...generatedCases, ...realCases]
    const disabled = Object.fromEntries(structuralRuleNames.map(rule => [rule, 'off']))
    for (const key of new Set(cases.map(c => JSON.stringify([c.rule, c.options])))) {
      const [rule, options] = JSON.parse(key)
      const entries = cases.filter(c => JSON.stringify([c.rule, c.options]) === key)
      const files = []
      const expected = new Map()
      for (const [index, entry] of entries.entries()) {
        // Deliberately identical basenames, plus spaces and Unicode in paths.
        const filename = path.join(dir, `case ${index} тест`, 'Case.vue')
        await fs.mkdir(path.dirname(filename), { recursive: true })
        await fs.writeFile(filename, entry.code)
        files.push(filename)
        expected.set(filename, compareCase(entry).expected)
        const pre = preprocess(entry.code, filename)
        assert.equal(pre.code.length, entry.code.length, entry.id)
        for (let i = 0; i < entry.code.length; i++) {
          if ('\r\n'.includes(entry.code[i])) assert.equal(pre.code[i], entry.code[i], `${entry.id}:${i}`)
        }
      }
      await fs.writeFile(path.join(dir, '.oxlintrc.json'), JSON.stringify({
        plugins: [], categories: {}, rules: {},
        settings: { vue: { rules: { ...disabled, [rule]: ['error', ...options] } } },
      }))
      const findings = await runOxlint(files, { cwd: dir, extraArgs: ['-A', 'all'] })
      assert.deepEqual(findings.filter(d => /parse|parsing|syntax/i.test(d.rule)), [], rule)
      assert.ok(findings.every(d => expected.has(d.filename)), 'Unexpected diagnostic file')
      for (const filename of files) {
        const actual = findings.filter(d => d.filename === filename && d.rule === rule)
          .map(d => ({ line: d.line, column: d.column, severity: d.severity === 'error' ? 2 : 1 }))
          .toSorted((a, b) => a.line - b.line || a.column - b.column)
        assert.deepEqual(actual, expected.get(filename), `${rule}: ${filename}`)
      }
    }
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }
})
