import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { preprocess } from '../dist/preprocess.js'
import { runOxlint, readVueSettings } from '../dist/run.js'

const TEMPLATE = '<i :title="item.x" v-for="item in longItems" :key="item.id" />'
const SOURCE = `<template>\n${TEMPLATE}\n</template>\n<script setup>const longItems = [];</script>\n`
const CLI = path.resolve('dist/cli.js')
async function withProject(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxlint-coverage-'))
  try {
    await fs.writeFile(path.join(dir, 'CoverageCase.vue'), SOURCE)
    await fs.writeFile(path.join(dir, '.oxlintrc.json'), JSON.stringify({
      plugins: [], categories: {}, rules: {},
      settings: { vue: { rules: { 'vue/max-attributes-per-line': 'off' } } },
    }))
    await fn(dir)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test('deferred expressions have source ranges and an explicit coverage reason', () => {
  const result = preprocess(SOURCE)
  assert.equal(result.code.length, SOURCE.length)
  const gap = result.coverageGaps.find(g => g.kind === 'expression')
  assert.ok(gap, JSON.stringify(result.coverageGaps))
  assert.equal(SOURCE.slice(gap.offset, gap.end), 'item.x')
  assert.match(gap.message, /full syntax/)
})

test('scope and dynamic argument omissions are recorded', () => {
  const scoped = preprocess(SOURCE.replace('item in longItems', 'item\n in longItems'))
  assert.ok(scoped.coverageGaps.some(g => g.kind === 'scope'))
  const dynamic = preprocess('<template><input :[name]="value"/></template><script setup>const name="x", value=1</script>')
  assert.ok(dynamic.coverageGaps.some(g => /Dynamic directive arguments/.test(g.message)))
  assert.equal(preprocess('<template>{{ value }}</template><script setup>const value=1</script>').coverageGaps.length, 0)
})

test('coverage gaps warn by default and fail strict CLI runs', async () => {
  await withProject(async dir => {
    for (const strict of [false, true]) {
      const result = spawnSync(process.execPath, [CLI, 'CoverageCase.vue', '--format=json', ...(strict ? ['--strict-templates'] : [])], { cwd: dir, encoding: 'utf8' })
      assert.equal(result.status, strict ? 1 : 0, result.stderr + result.stdout)
      const gap = JSON.parse(result.stdout).find(d => d.rule === 'oxlint-vue/incomplete-template')
      assert.ok(gap)
      assert.equal(gap.severity, strict ? 'error' : 'warning')
      assert.equal(gap.line, 2)
      assert.equal(gap.column, TEMPLATE.indexOf('item.x') + 1)
    }
  })
})

test('strict settings inherit without being reset by an unrelated parent', async () => {
  await withProject(async dir => {
    await fs.writeFile(path.join(dir, 'strict.json'), '{"settings":{"vue":{"strictTemplates":true}}}')
    await fs.writeFile(path.join(dir, 'style.json'), '{"rules":{}}')
    await fs.writeFile(path.join(dir, '.oxlintrc.json'), '{"extends":["./strict.json","./style.json"]}')
    assert.equal((await readVueSettings(path.join(dir, '.oxlintrc.json'))).strictTemplates, true)
    let diags = await runOxlint(['CoverageCase.vue'], { cwd: dir })
    assert.ok(diags.some(d => d.rule === 'oxlint-vue/incomplete-template' && d.severity === 'error'))
    diags = await runOxlint(['CoverageCase.vue'], { cwd: dir, strictTemplates: false })
    assert.ok(diags.some(d => d.rule === 'oxlint-vue/incomplete-template' && d.severity === 'warning'))
  })
})

test('SFC parse failures are located errors, including in otherwise blank templates', async () => {
  await withProject(async dir => {
    for (const body of ['<div><span></div>', '<div>{{ value + }}</div>']) {
      await fs.writeFile(path.join(dir, 'CoverageCase.vue'), `<template>\n${body}\n</template><script setup>const value=1</script>`)
      const result = spawnSync(process.execPath, [CLI, 'CoverageCase.vue', '--format=json'], { cwd: dir, encoding: 'utf8' })
      assert.equal(result.status, 1, result.stderr)
      const error = JSON.parse(result.stdout).find(d => d.rule === 'vue/no-parsing-error')
      assert.ok(error, result.stdout)
      assert.equal(error.severity, 'error')
      assert.equal(error.line, 2)
      assert.ok(error.column > 1)
    }
  })
})

test('coverage positions survive Unicode before the omitted expression', async () => {
  await withProject(async dir => {
    const source = SOURCE.replace('<i ', '😀<i ')
    await fs.writeFile(path.join(dir, 'CoverageCase.vue'), source)
    const diags = await runOxlint(['CoverageCase.vue'], { cwd: dir, strictTemplates: true })
    const gap = diags.find(d => d.rule === 'oxlint-vue/incomplete-template')
    assert.ok(gap)
    assert.ok(Buffer.from(source).subarray(gap.offset).toString().startsWith('item.x'))
    assert.ok(source.split('\n')[gap.line - 1].slice(gap.column - 1).startsWith('item.x'))
  })
})
