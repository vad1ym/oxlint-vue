import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fixFiles } from '../dist/fix.js'
import { resolveBin } from '../dist/resolve.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const OXLINT = resolveBin('oxlint', ROOT, import.meta.url)

async function withProject(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxxfix-test-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, 'utf8')
    }
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const CONFIG = JSON.stringify({ rules: { 'prefer-const': 'error' } })

test('fixes let -> const inside <script setup>', async () => {
  await withProject({
    '.oxlintrc.json': CONFIG,
    'A.vue': `<template>
  <div>{{ a }}</div>
</template>
<script setup>
let a = 1
</script>
`,
  }, async (dir) => {
    const fixed = await fixFiles([path.join(dir, 'A.vue')], {
      cwd: dir,
      oxlintPath: OXLINT,
    })
    assert.equal(fixed.length, 1)
    const out = await fs.readFile(path.join(dir, 'A.vue'), 'utf8')
    assert.match(out, /const a = 1/)
  })
})

test('never rewrites the template, style, or their whitespace', async () => {
  // The whole safety argument for --fix is that changes land only in script
  // lines. A template edit would mean the padding leaked into user source.
  const source = `<template>
  <li v-for="[k, v] in pairs" :key="k">{{ v }}</li>
  <div :class="{ on: flag }" @click="go(); stop()">{{ '🎉' }}</div>
</template>
<script setup>
let pairs = []
let flag = true
function go() {}
function stop() {}
</script>
<style scoped>.a { color: red }</style>
`
  await withProject({ '.oxlintrc.json': CONFIG, 'B.vue': source }, async (dir) => {
    await fixFiles([path.join(dir, 'B.vue')], { cwd: dir, oxlintPath: OXLINT })
    const out = await fs.readFile(path.join(dir, 'B.vue'), 'utf8')

    const before = source.split('\n')
    const after = out.split('\n')
    assert.equal(after.length, before.length, 'line count must not change')

    // Template (lines 1-4) and style (line 11) must be byte-identical.
    for (const i of [0, 1, 2, 3, 10]) {
      assert.equal(after[i], before[i], `line ${i + 1} was modified`)
    }
    assert.match(out, /const pairs = \[\]/)
    assert.match(out, /const flag = true/)
  })
})

test('leaves files alone when there is nothing to fix', async () => {
  const source = `<template><div>{{ a }}</div></template>
<script setup>
const a = 1
</script>
`
  await withProject({ '.oxlintrc.json': CONFIG, 'C.vue': source }, async (dir) => {
    const fixed = await fixFiles([path.join(dir, 'C.vue')], {
      cwd: dir,
      oxlintPath: OXLINT,
    })
    assert.deepEqual(fixed, [])
    assert.equal(await fs.readFile(path.join(dir, 'C.vue'), 'utf8'), source)
  })
})

test('skips a template-only SFC with no script block', async () => {
  const source = '<template><div>hello</div></template>\n'
  await withProject({ '.oxlintrc.json': CONFIG, 'D.vue': source }, async (dir) => {
    const fixed = await fixFiles([path.join(dir, 'D.vue')], {
      cwd: dir,
      oxlintPath: OXLINT,
    })
    assert.deepEqual(fixed, [])
    assert.equal(await fs.readFile(path.join(dir, 'D.vue'), 'utf8'), source)
  })
})

test('preserves CRLF line endings', async () => {
  const source = '<template>\r\n  <div>{{ a }}</div>\r\n</template>\r\n'
    + '<script setup>\r\nlet a = 1\r\n</script>\r\n'
  await withProject({ '.oxlintrc.json': CONFIG, 'E.vue': source }, async (dir) => {
    await fixFiles([path.join(dir, 'E.vue')], { cwd: dir, oxlintPath: OXLINT })
    const out = await fs.readFile(path.join(dir, 'E.vue'), 'utf8')
    assert.match(out, /const a = 1/)
    assert.ok(out.includes('</div>\r\n'), 'CRLF endings must survive')
  })
})
