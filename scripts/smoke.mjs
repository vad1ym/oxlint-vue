/**
 * Smoke test the packaged tarball.
 *
 * Everything else runs from the source tree, where every file is present by
 * definition. This packs the tarball, installs it into a scratch project, and
 * drives the published `bin` -- so a missing entry in `files`, a bad `exports`
 * path or a broken shebang fails here rather than for the first user.
 *
 * Usage: node scripts/smoke.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dirname, '..')

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...opts,
})

const step = msg => process.stdout.write(`• ${msg}\n`)

/**
 * Pack the preset package from the sibling checkout, if there is one. It is a
 * separate repository, so CI may not have it -- the scenario is skipped rather
 * than failed in that case.
 */
function packPreset() {
  const dir = path.resolve(ROOT, '..', 'antfu-oxlint-vue')
  if (!fs.existsSync(path.join(dir, 'package.json'))) return null
  const name = run('npm', ['pack', '--pack-destination', os.tmpdir()], { cwd: dir })
    .trim().split('\n').pop()
  return path.join(os.tmpdir(), name)
}
const fail = (msg) => {
  process.stderr.write(`\n✗ ${msg}\n`)
  process.exit(1)
}

step('packing tarball')
const packed = run('npm', ['pack', '--pack-destination', os.tmpdir()], { cwd: ROOT })
  .trim()
  .split('\n')
  .pop()
const tarball = path.join(os.tmpdir(), packed)
if (!fs.existsSync(tarball)) fail(`npm pack produced no tarball (${tarball})`)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxlint-vue-smoke-'))
let failed = false

try {
  step(`installing ${packed} into a scratch project`)
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, version: '0.0.0' }),
  )
  // oxlint and oxfmt are non-optional peers, so npm installs them from the
  // tarball alone -- which is exactly the claim this checks. Naming them here
  // would hide a regression in that.
  run('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: dir,
    stdio: 'ignore',
  })

  step('running `oxlint-vue init`')
  run('npx', ['oxlint-vue', 'init'], { cwd: dir })
  // Only the lint config: the formatter preset lives in antfu-oxlint-vue,
  // which this scenario deliberately does not install. `init` has to degrade
  // to a working bare config rather than fail or write a broken one.
  if (!fs.existsSync(path.join(dir, '.oxlintrc.json'))) {
    fail('init did not create .oxlintrc.json')
  }
  const bare = JSON.parse(fs.readFileSync(path.join(dir, '.oxlintrc.json'), 'utf8'))
  if (bare.extends) {
    fail(`init referenced a preset that is not installed: ${JSON.stringify(bare.extends)}`)
  }
  if (!bare.ignorePatterns?.includes('**/node_modules/**')) {
    // oxlint does not inherit ignorePatterns through `extends`, so init has to
    // write them; without this the first run walks node_modules.
    fail('init omitted ignorePatterns')
  }

  step('linting a real SFC through the packaged bin')
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'A.vue'), `<template>
  <li v-for="i in items">{{ i }}</li>
  <NuxtLink to="/x">go</NuxtLink>
</template>
<script setup lang="ts">
const items = [1]
let unusedThing = 2
</script>
`)

  let out = ''
  try {
    out = run('npx', ['oxlint-vue', 'src', '--format=compact'], { cwd: dir })
  } catch (err) {
    // Exit 1 is expected: the fixture has real problems.
    out = err.stdout ?? ''
  }

  // The three findings that prove the whole pipeline is wired: the structural
  // checker, the virtual-file pass, and template-aware unused detection.
  const expectations = [
    [/require-v-for-key/, 'structural rules did not run'],
    [/unusedThing/, 'script diagnostics did not run'],
  ]
  for (const [re, message] of expectations) {
    if (!re.test(out)) fail(`${message}\n--- output ---\n${out}`)
  }
  if (/NuxtLink/.test(out)) {
    fail(`auto-imported component reported as unused\n--- output ---\n${out}`)
  }

  step('running `--fix`')
  try {
    run('npx', ['oxlint-vue', 'src', '--fix'], { cwd: dir })
  } catch { /* exit 1 if findings remain, which is fine */ }
  if (!/<li v-for="i in items">/.test(fs.readFileSync(path.join(dir, 'src', 'A.vue'), 'utf8'))) {
    fail('--fix damaged the template')
  }

  // Second scenario: the preset package alongside. This is the combination the
  // README tells people to install, and the one where --fix and --format-code
  // have rules to act on -- a bare oxlint config enables neither prefer-const
  // nor any formatting.
  step('installing antfu-oxlint-vue and re-running init')
  const presetTarball = packPreset()
  if (presetTarball) {
    run('npm', ['install', '--no-audit', '--no-fund', presetTarball], {
      cwd: dir,
      stdio: 'ignore',
    })
    fs.rmSync(path.join(dir, '.oxlintrc.json'), { force: true })
    run('npx', ['oxlint-vue', 'init'], { cwd: dir })

    // With the preset present init writes JS configs that spread it: a plain
    // spread carries ignorePatterns across, which `extends` does not.
    const wired = fs.readFileSync(path.join(dir, 'oxlint.config.mjs'), 'utf8')
    if (!wired.includes('antfu-oxlint-vue/oxlintrc')) {
      fail(`init did not pick up the installed preset:\n${wired}`)
    }
    if (!fs.existsSync(path.join(dir, 'oxfmt.config.mjs'))) {
      fail('init did not write the formatter config')
    }

    step('running `--fix --format-code` with the preset')
    try {
      run('npx', ['oxlint-vue', 'src', '--fix', '--format-code'], { cwd: dir })
    } catch { /* exit 1 if findings remain, which is fine */ }
    const fixed = fs.readFileSync(path.join(dir, 'src', 'A.vue'), 'utf8')
    if (!/const unusedThing/.test(fixed)) {
      fail(`--fix did not rewrite let -> const\n--- file ---\n${fixed}`)
    }
    if (!/<li v-for="i in items">/.test(fixed)) {
      fail(`--format-code corrupted the template\n--- file ---\n${fixed}`)
    }
  } else {
    process.stdout.write('  (antfu-oxlint-vue not found next door, skipping)\n')
  }

  step('checking every export resolves from the installed package')
  // A wrong path in `exports` only surfaces once the package is installed.
  const pkgDir = path.join(dir, 'node_modules', 'oxlint-vue')
  const exported = JSON.parse(
    fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'),
  ).exports

  // An entry is either a bare path or a conditions object ({ types, import }),
  // and every path in it has to survive packing -- a missing `.d.ts` is just as
  // broken as a missing `.js`, only quieter.
  const targets = Object.values(exported).flatMap(entry =>
    typeof entry === 'string' ? [entry] : Object.values(entry),
  )
  for (const target of targets) {
    const file = path.join(pkgDir, target)
    if (!fs.existsSync(file)) fail(`export "${target}" is missing from the tarball`)
  }

  process.stdout.write('\n✓ packaged tarball works\n')
} catch (err) {
  failed = true
  process.stderr.write(`\n✗ smoke test threw: ${err.message}\n`)
  if (err.stdout) process.stderr.write(`stdout: ${err.stdout}\n`)
  if (err.stderr) process.stderr.write(`stderr: ${err.stderr}\n`)
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(tarball, { force: true })
}

process.exit(failed ? 1 : 0)
