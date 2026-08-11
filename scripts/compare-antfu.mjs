/**
 * Side-by-side comparison against @antfu/eslint-config on the same files.
 *
 * Both tools are run over the same directory, diagnostics are normalised to a
 * bare rule name, and the result is grouped into: agreed / ESLint-only /
 * oxlint-vue-only. The point is not the totals -- the two presets differ in
 * strictness -- but which findings only one side can reach at all.
 *
 * Usage:
 *   node scripts/compare-antfu.mjs <dir-with-a-configured-project>
 *
 * The directory must already have both toolchains installed:
 *   npm i -D @antfu/eslint-config eslint oxlint-vue oxfmt eslint-plugin-regexp
 *   npx oxlint-vue init
 *   # plus an eslint.config.mjs exporting antfu({ vue: true, typescript: true })
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import process from 'node:process'

const execFileAsync = promisify(execFile)

const projectDir = process.argv[2]
if (!projectDir) {
  console.error('usage: node scripts/compare-antfu.mjs <project-dir> [target]')
  process.exit(2)
}
const target = process.argv[3] ?? 'src'

/** Both CLIs exit non-zero when they report problems, which is not an error. */
async function runJson(bin, args, cwd) {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (err) {
    if (typeof err.stdout === 'string' && err.stdout.trim()) return err.stdout
    throw err
  }
}

/** `vue/no-v-html`, `eslint(no-unused-vars)`, `unused-imports/no-unused-vars`
 *  all collapse to their bare rule name so the two naming schemes line up. */
function bareRule(rule) {
  return String(rule ?? '(parse error)')
    .replace(/^[^(]*\(/, '')
    .replace(/\)$/, '')
    .replace(/^.*\//, '')
}

const eslintOut = await runJson(
  'npx',
  ['eslint', target, '--format=json'],
  projectDir,
)
const oxxxOut = await runJson(
  'npx',
  ['oxlint-vue', target, '--format=json'],
  projectDir,
)

const eslintFindings = []
for (const file of JSON.parse(eslintOut)) {
  for (const m of file.messages) {
    eslintFindings.push({
      file: path.basename(file.filePath),
      line: m.line,
      rule: m.ruleId ?? '(parse error)',
      bare: bareRule(m.ruleId),
    })
  }
}

const oxxxFindings = JSON.parse(oxxxOut).map(d => ({
  file: path.basename(d.filename),
  line: d.line,
  rule: d.rule,
  bare: bareRule(d.rule),
}))

const group = (findings) => {
  const out = new Map()
  for (const f of findings) {
    if (!out.has(f.bare)) out.set(f.bare, [])
    out.get(f.bare).push(f)
  }
  return out
}

const E = group(eslintFindings)
const O = group(oxxxFindings)
const names = [...new Set([...E.keys(), ...O.keys()])].sort()

const pad = (s, n) => String(s).padEnd(n)
console.log(`${pad('rule', 42)}${pad('eslint', 8)}${pad('oxlint-vue', 10)}`)
console.log('-'.repeat(62))

const only = { eslint: [], oxxx: [] }
for (const name of names) {
  const e = E.get(name)?.length ?? 0
  const o = O.get(name)?.length ?? 0
  let mark = '='
  if (e && !o) { mark = 'eslint only'; only.eslint.push(name) }
  if (!e && o) { mark = 'oxlint-vue only'; only.oxxx.push(name) }
  console.log(`${pad(name, 42)}${pad(e, 8)}${pad(o, 10)}${mark}`)
}

console.log(`\ntotals: eslint ${eslintFindings.length}, oxlint-vue ${oxxxFindings.length}`)
console.log(`agreed on ${names.length - only.eslint.length - only.oxxx.length} rules`)
if (only.eslint.length) console.log(`eslint only:   ${only.eslint.join(', ')}`)
if (only.oxxx.length) console.log(`oxlint-vue only: ${only.oxxx.join(', ')}`)
