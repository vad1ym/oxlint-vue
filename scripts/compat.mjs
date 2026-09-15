import fs from 'node:fs'
import assert from 'node:assert/strict'
import { propCases } from '../test/compat/props.js'
import { compareCorpus, compareCase, classify } from '../test/compat/runner.js'
const report = compareCorpus()
report.propScopeRegressions = { cases: propCases.length, exact: 0, intentionalDifferences: {} }
for (const entry of propCases) {
  const result = compareCase(entry)
  if (entry.intentionalDifference) {
    assert.deepEqual(result.actual, [], entry.intentionalDifference)
    assert.equal(result.expected.length, 1, 'Review an upstream false-positive fix')
    report.propScopeRegressions.intentionalDifferences[entry.id] = { reason: entry.intentionalDifference, ...result }
  } else {
    assert.equal(classify(result), 'match', entry.id)
    report.propScopeRegressions.exact++
  }
}
for (const [rule, row] of Object.entries(report.rules)) {
  console.log(`${rule.padEnd(38)} ${String(row.match).padStart(3)}/${String(row.cases).padEnd(3)} exact; missed ${row.missed}, extra ${row.extra}, location ${row.location}`)
}
console.log(`\n${report.cases - Object.keys(report.differences).length}/${report.cases} exact cases (not overall plugin compatibility)`)
console.log(`${report.unmeasuredReferenceRules.length} reference rules unmeasured; ${report.projectSpecificRules.length} project-specific rules`)
console.log(`Prop scope regressions: ${report.propScopeRegressions.exact}/${report.propScopeRegressions.cases} exact, ${Object.keys(report.propScopeRegressions.intentionalDifferences).length} documented upstream false positives`)
if (process.argv.includes('--json')) fs.writeFileSync('compat-report.json', JSON.stringify(report, null, 2) + '\n')
if (process.argv.includes('--write-baseline')) {
  fs.writeFileSync(new URL('../test/compat/baseline.json', import.meta.url), JSON.stringify(report.differences, null, 2) + '\n')
} else {
  const baseline = JSON.parse(fs.readFileSync(new URL('../test/compat/baseline.json', import.meta.url), 'utf8'))
  if (JSON.stringify(baseline) !== JSON.stringify(report.differences)) {
    console.error('Compatibility changed: inspect compat-report.json; review both regressions and resolved baseline entries.')
    process.exitCode = 1
  }
}
