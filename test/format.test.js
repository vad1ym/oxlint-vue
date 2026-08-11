import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatFiles, resolveOxfmtPath } from '../dist/format.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const PRESET = path.join(ROOT, 'test', 'fixtures', 'configs', 'antfu.oxfmtrc.json')

async function withProject(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxxfmt-test-'))
  try {
    await fs.copyFile(PRESET, path.join(dir, '.oxfmtrc.json'))
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, 'utf8')
    }
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const MESSY = `<template>
  <div    class="a"><span>{{  msg  }}</span></div>
</template>
<script setup lang="ts">
const   msg="hi"
</script>
`

test('write mode formats the file and reports it as changed', async () => {
  await withProject({ 'A.vue': MESSY }, async (dir) => {
    const file = path.join(dir, 'A.vue')
    const { changed, ok } = await formatFiles([file], { cwd: dir })
    assert.equal(ok, true)
    assert.deepEqual(changed, [file])

    const out = await fs.readFile(file, 'utf8')
    assert.match(out, /<div class="a">/, 'template must be formatted')
    assert.match(out, /\{\{ msg \}\}/, 'interpolation must be normalised')
  })
})

test('follows the antfu style: single quotes, no semicolons', async () => {
  // The formatter has to agree with the lint preset, or the two fight: the
  // linter asks for one thing and the formatter writes another.
  await withProject({ 'B.vue': MESSY }, async (dir) => {
    await formatFiles([path.join(dir, 'B.vue')], { cwd: dir })
    const out = await fs.readFile(path.join(dir, 'B.vue'), 'utf8')
    assert.match(out, /const msg = 'hi'/, 'single quotes, no semicolon')
    assert.ok(!/'hi';/.test(out), 'must not add semicolons')
  })
})

test('arrow parens and quoted props follow the preset', async () => {
  const source = `<template><div>{{ a }}</div></template>
<script setup>
const fn = (x) => x * 2
const obj = { "key": 1, other: 2 }
const a = fn(1)
</script>
`
  await withProject({ 'C.vue': source }, async (dir) => {
    await formatFiles([path.join(dir, 'C.vue')], { cwd: dir })
    const out = await fs.readFile(path.join(dir, 'C.vue'), 'utf8')
    assert.match(out, /const fn = x => x \* 2/, 'arrowParens: avoid')
    assert.match(out, /\{ key: 1, other: 2 \}/, 'quoteProps: consistent')
  })
})

test('check mode reports without writing', async () => {
  await withProject({ 'D.vue': MESSY }, async (dir) => {
    const file = path.join(dir, 'D.vue')
    const { changed, ok } = await formatFiles([file], { cwd: dir, mode: 'check' })
    assert.equal(ok, false)
    assert.deepEqual(changed, [file])
    assert.equal(
      await fs.readFile(file, 'utf8'),
      MESSY,
      'check mode must not modify the file',
    )
  })
})

test('an already formatted file is reported as unchanged', async () => {
  await withProject({ 'E.vue': MESSY }, async (dir) => {
    const file = path.join(dir, 'E.vue')
    await formatFiles([file], { cwd: dir })
    const second = await formatFiles([file], { cwd: dir })
    assert.deepEqual(second.changed, [], 'formatting must be idempotent')
    const check = await formatFiles([file], { cwd: dir, mode: 'check' })
    assert.equal(check.ok, true)
  })
})

test('formats template, script and style together', async () => {
  const source = `<template>
  <div   class="a">x</div>
</template>
<script setup>
const a=1
</script>
<style scoped>
.a{color:red}
</style>
`
  await withProject({ 'F.vue': source }, async (dir) => {
    await formatFiles([path.join(dir, 'F.vue')], { cwd: dir })
    const out = await fs.readFile(path.join(dir, 'F.vue'), 'utf8')
    assert.match(out, /<div class="a">x<\/div>/, 'template')
    assert.match(out, /const a = 1/, 'script')
    assert.match(out, /color: red;/, 'style')
  })
})

test('formatted output still parses as a valid SFC', async () => {
  const { parse } = await import('@vue/compiler-sfc')
  await withProject({ 'G.vue': MESSY }, async (dir) => {
    const file = path.join(dir, 'G.vue')
    await formatFiles([file], { cwd: dir })
    const { errors } = parse(await fs.readFile(file, 'utf8'), { filename: file })
    assert.deepEqual(errors, [])
  })
})

test('repairs multi-statement handlers instead of giving up', async () => {
  // oxfmt 0.63.0 strips the semicolons from `@focus="a = true; b = false"`
  // when splitting it across lines, which Vue cannot parse. Rather than
  // skipping the file, the separators are put back.
  const source = `<template>
  <input @focus="a = true; b = false">
  <button @click="x(); y()">m</button>
</template>
<script setup>
let a = 1
let b = 2
function x() {}
function y() {}
</script>
`
  await withProject({ 'R.vue': source }, async (dir) => {
    const file = path.join(dir, 'R.vue')
    const { changed, reverted } = await formatFiles([file], { cwd: dir })

    assert.deepEqual(reverted, [], 'the file must not need rolling back')
    assert.deepEqual(changed, [file])

    const out = await fs.readFile(file, 'utf8')
    const { parse } = await import('@vue/compiler-sfc')
    assert.deepEqual(
      parse(out, { filename: file }).errors,
      [],
      `repaired file must parse:\n${out}`,
    )
    assert.match(out, /a = true;/, 'separator must be restored')
    assert.match(out, /x\(\);/, 'separator must be restored')
    // The rest of the formatting must still have been applied: the repair
    // touches directive values only, never the script block.
    assert.match(out, /<input\n/, 'attributes must still be wrapped')
    assert.match(out, /function x\(\) \{\}/, 'script formatting must survive')
  })
})

test('check mode does not demand re-formatting a repaired file', async () => {
  // oxfmt keeps reporting the repaired file as "different" because it wants to
  // strip the semicolons again. Left unfiltered that fails CI forever, with no
  // command the user could run to satisfy it.
  const source = `<template>
  <input @focus="a = true; b = false">
</template>
<script setup>
let a = 1
let b = 2
</script>
`
  await withProject({ 'S.vue': source }, async (dir) => {
    const file = path.join(dir, 'S.vue')
    await formatFiles([file], { cwd: dir })
    const check = await formatFiles([file], { cwd: dir, mode: 'check' })
    assert.deepEqual(check.changed, [], 'repaired file must count as formatted')
    assert.equal(check.ok, true)
  })
})

test('restoreDirectiveSemicolons leaves wrapped expressions alone', async () => {
  const { restoreDirectiveSemicolons } = await import('../dist/format.js')
  // A single expression wrapped over lines must not gain separators.
  const wrapped = `<template>
  <div
    :class="
      first
      && second
    "
  />
</template>
`
  assert.equal(restoreDirectiveSemicolons(wrapped), wrapped)
})

test('never writes out a .vue that stopped parsing', async () => {
  // The repair handles the one failure mode we know about. Whatever else may
  // break a file in future, the invariant has to hold: a .vue that parsed
  // before formatting still parses afterwards.
  const { parse } = await import('@vue/compiler-sfc')
  const sources = {
    'H1.vue': '<template>\n  <input @focus="a = true; b = false">\n</template>\n'
      + '<script setup>\nlet a = 1\nlet b = 2\n</script>\n',
    'H2.vue': '<template>\n  <b @click="p(); q(); r()">x</b>\n</template>\n'
      + '<script setup>\nfunction p() {}\nfunction q() {}\nfunction r() {}\n</script>\n',
    'H3.vue': '<template>\n  <div :class="[a, b]">{{ a }}</div>\n</template>\n'
      + '<script setup>\nconst a = 1\nconst b = 2\n</script>\n',
  }

  await withProject(sources, async (dir) => {
    const files = Object.keys(sources).map(n => path.join(dir, n))
    await formatFiles(files, { cwd: dir })

    for (const f of files) {
      const out = await fs.readFile(f, 'utf8')
      assert.deepEqual(
        parse(out, { filename: f }).errors,
        [],
        `${path.basename(f)} must still parse:\n${out}`,
      )
    }
  })
})

test('a file that already fails to parse is not reverted', async () => {
  // Only a regression matters: if the input was already broken, formatting it
  // is not what broke it, so there is nothing to roll back to.
  const source = `<template><div v-for="}{">x</div></template>\n`
  await withProject({ 'I.vue': source }, async (dir) => {
    const file = path.join(dir, 'I.vue')
    const { reverted } = await formatFiles([file], { cwd: dir })
    assert.deepEqual(reverted, [])
  })
})

test('an empty file list is a no-op', async () => {
  const { changed, ok } = await formatFiles([], { cwd: ROOT })
  assert.deepEqual(changed, [])
  assert.equal(ok, true)
})

test('resolveOxfmtPath finds the bundled binary', () => {
  const p = resolveOxfmtPath(ROOT)
  assert.ok(p.endsWith('oxfmt'), p)
})
