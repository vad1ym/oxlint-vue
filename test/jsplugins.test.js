import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runOxlint } from '../dist/run.js'
import { resolveBin } from '../dist/resolve.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const OXLINT = resolveBin('oxlint', ROOT, import.meta.url)
const REGEXP_PRESET = path.join(ROOT, 'test', 'fixtures', 'configs', 'regexp.oxlintrc.json')

/**
 * oxlint's `jsPlugins` loads real ESLint plugins, which is how the one genuine
 * gap against antfu -- eslint-plugin-regexp, absent from oxlint -- gets closed.
 *
 * IMPORTANT: oxlint resolves jsPlugins relative to the CONFIG FILE's directory,
 * not the cwd and not the linted file. So the config has to sit next to the
 * node_modules that holds the plugin -- here, the repo root. This is also why
 * the tool works at all: the runner copies sources into a temp tree but still
 * passes the project's own config by its original path.
 */
async function lintSource(source, rules) {
  const configPath = path.join(ROOT, `.oxxx-jsp-${process.pid}.json`)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-jsp-'))
  try {
    await fs.writeFile(
      configPath,
      JSON.stringify({ jsPlugins: ['eslint-plugin-regexp'], rules }),
      'utf8',
    )
    const file = path.join(dir, 'A.vue')
    await fs.writeFile(file, source, 'utf8')

    return await runOxlint([file], {
      cwd: dir,
      oxlintPath: OXLINT,
      extraArgs: ['-c', configPath],
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(configPath, { force: true })
  }
}

test('regexp rules fire inside <script setup>', async () => {
  const diags = await lintSource(
    `<template><div>{{ a }}</div></template>
<script setup>
const a = /[0-9]+/
</script>
`,
    { 'regexp/prefer-d': 'error' },
  )
  assert.ok(
    diags.some(d => String(d.rule).includes('prefer-d')),
    `got: ${diags.map(d => d.rule).join(', ') || '(none)'}`,
  )
})

test('regexp rules fire inside <template> expressions', async () => {
  // This is the interesting half: the regex only exists in the template, so it
  // reaches the plugin through the padded virtual file.
  const diags = await lintSource(
    `<template>
  <span>{{ /[0-9]+/.test(v) ? 'y' : 'n' }}</span>
</template>
<script setup>
const v = 'x'
</script>
`,
    { 'regexp/prefer-d': 'error' },
  )
  const hit = diags.find(d => String(d.rule).includes('prefer-d'))
  assert.ok(hit, `got: ${diags.map(d => d.rule).join(', ') || '(none)'}`)
  assert.equal(hit.line, 2, 'must point at the template line')
})

test('the regexp preset is valid and every rule exists', async () => {
  const { parseJsonc } = await import('../dist/jsonc.js')
  const preset = parseJsonc(await fs.readFile(REGEXP_PRESET, 'utf8'))

  const plugin = await import('eslint-plugin-regexp')
  const available = new Set(Object.keys(plugin.default?.rules ?? plugin.rules))

  const unknown = Object.keys(preset.rules)
    .map(r => r.replace(/^regexp\//, ''))
    .filter(r => !available.has(r))

  assert.deepEqual(unknown, [], `unknown rules: ${unknown.join(', ')}`)
  assert.ok(Object.keys(preset.rules).length > 40, 'preset should be substantial')
})

test('a bad regex in a template reports at the right position', async () => {
  const source = `<template>
  <i>{{ /[aa]/.test(v) }}</i>
</template>
<script setup>
const v = ''
</script>
`
  const diags = await lintSource(source, {
    'regexp/no-dupe-characters-character-class': 'error',
  })
  const hit = diags.find(d => String(d.rule).includes('no-dupe-characters'))
  assert.ok(hit, `got: ${diags.map(d => d.rule).join(', ') || '(none)'}`)

  const line = source.split('\n')[hit.line - 1]
  assert.match(
    line.slice(hit.column - 1),
    /^a/,
    `column ${hit.column} should land on the duplicate: ${line}`,
  )
})
