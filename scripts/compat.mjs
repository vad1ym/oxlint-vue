import fs from 'node:fs'
import { compareCorpus } from '../test/compat/runner.js'
const report = compareCorpus()
for (const [rule, row] of Object.entries(report.rules)) {
  console.log(`${rule.padEnd(38)} ${String(row.match).padStart(3)}/${String(row.cases).padEnd(3)} exact; missed ${row.missed}, extra ${row.extra}, location ${row.location}`)
}
console.log(`\n${report.cases - Object.keys(report.differences).length}/${report.cases} exact cases (not overall plugin compatibility)`)
console.log(`${report.unmeasuredReferenceRules.length} reference rules unmeasured; ${report.projectSpecificRules.length} project-specific rules`)
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
