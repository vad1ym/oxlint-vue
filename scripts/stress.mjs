/**
 * Corpus stress harness.
 *
 * Two properties are checked over a large body of real SFCs:
 *   1. the padding invariant (length + every newline offset), and
 *   2. that each generated virtual file actually parses.
 *
 * (2) matters as much as (1): a virtual file with a syntax error produces no
 * diagnostics at all, so the tool would report a clean run while silently
 * linting nothing.
 *
 * Usage: node scripts/stress.mjs <dir> [dir...]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { preprocess } from '../dist/preprocess.js'
import { resolveBin } from '../dist/resolve.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const OXLINT = resolveBin('oxlint', ROOT, import.meta.url)

const roots = process.argv.slice(2)
if (!roots.length) {
  console.error('usage: node scripts/stress.mjs <dir> [dir...]')
  process.exit(2)
}

/** Walk for .vue files without shelling out, so paths need no escaping. */
function findVue(dir, acc = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) findVue(full, acc)
    else if (e.isFile() && e.name.endsWith('.vue')) acc.push(full)
  }
  return acc
}

const files = roots.flatMap(r => (
  fs.statSync(r).isDirectory() ? findVue(r) : [r]
))

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxxx-stress-'))
const failures = { invariant: [], threw: [] }
const virtualToSource = new Map()
let ok = 0

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  let code
  try {
    ({ code } = preprocess(src, f))
  } catch (e) {
    failures.threw.push(`${f}: ${e.message}`)
    continue
  }

  let bad = null
  if (code.length !== src.length) bad = 'length'
  else if (code.split('\n').length !== src.split('\n').length) bad = 'line count'
  else {
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n' && code[i] !== '\n') { bad = `newline@${i}`; break }
    }
  }
  if (bad) { failures.invariant.push(`${f} (${bad})`); continue }

  ok++
  const virt = path.join(outDir, `${ok}_${path.basename(f)}.ts`)
  fs.writeFileSync(virt, code)
  virtualToSource.set(path.basename(virt), f)
}

// All rules off: anything reported now is a parse/syntax failure.
let raw = ''
try {
  raw = execFileSync(OXLINT, ['--format=json', '-A', 'all', outDir], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (e) {
  raw = e.stdout ?? ''
}

let syntax = []
try {
  syntax = (JSON.parse(raw).diagnostics ?? []).map(d => ({
    file: virtualToSource.get(path.basename(d.filename)) ?? d.filename,
    message: d.message,
    span: d.labels?.[0]?.span,
  }))
} catch {
  console.error('could not parse oxlint output:', raw.slice(0, 400))
}

console.log(`corpus:            ${files.length} files`)
console.log(`invariant holds:   ${ok}`)
console.log(`invariant broken:  ${failures.invariant.length}`)
console.log(`preprocess threw:  ${failures.threw.length}`)
console.log(`syntax errors:     ${syntax.length}`)

for (const f of failures.invariant.slice(0, 10)) console.log('  INVARIANT', f)
for (const f of failures.threw.slice(0, 10)) console.log('  THREW', f)
for (const s of syntax.slice(0, 10)) {
  console.log(`  SYNTAX ${s.file}: ${s.message}`)
}

fs.rmSync(outDir, { recursive: true, force: true })

const failed = failures.invariant.length + failures.threw.length + syntax.length
process.exit(failed === 0 ? 0 : 1)
