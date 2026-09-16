import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runOxlint } from '../dist/run.js'
import { preprocess } from '../dist/preprocess.js'

const cases = {
  assignment: ['<div @focus="isFocused = true" />', 'import {ref} from "vue"; const isFocused = ref(false);'],
  statements: ['<div @click="isFocused = true; save()" />', 'let isFocused = false; function save() {}'],
  numeric: ['<div v-for="index in 3" :key="index" />', ''],
  tuple: ['<div v-for="(brand, index) in list" :key="index" :brand="brand" />', 'const list = [];'],
  conditional: ['<component :is="row.done ? \'div\' : Chosen" v-for="row in rows" :key="row.id" />', 'import {Chosen} from "#components"; const rows = [];'],
  reversed: ['<component v-for="row in rows" :is="row.done ? \'div\' : Chosen" :key="row.id" />', 'import {Chosen} from "#components"; const rows = [];'],
  siblings: ['<i v-for="i in items" :key="i"/><i v-for="j in items" :key="j"/>', 'const items = [];'],
  nested: ['<div v-for="row in rows" :key="row.id"><i v-for="cell in row.cells" :key="cell" /></div>', 'const rows = [];'],
  css: ['<div />', 'const boxColor = "red";', '<style scoped>.box { color: v-bind(boxColor); }</style>'],
  cssQuoted: ['<div />', 'const theme = {color: "red"};', '<style>.box { color: v-bind("theme.color"); }</style>'],
  cssExpression: ['<div />', 'const first = 1; const second = 2;', '<style>.box { width: v-bind("Math.max(first, second) + \'px\'"); }</style>'],
}

async function lint(template, script, style = '', extra = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxlint-vue-usage-'))
  try {
    const filename = path.join(dir, 'Case.vue')
    const source = `<template>\n${template}\n</template>\n<script setup lang="ts">\n${script}\nconst unusedCanary = 1;\n</script>\n${style}\n`
    const pre = preprocess(source)
    assert.equal(pre.code.length, source.length)
    await fs.writeFile(filename, source)
    await fs.writeFile(path.join(dir, '.oxlintrc.json'), JSON.stringify({ plugins: [], categories: {}, globals: { defineProps: 'readonly' }, rules: { 'no-unused-vars': 'error' } }))
    return await runOxlint([filename], { cwd: dir, extraArgs: extra })
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

for (const [name, args] of Object.entries(cases)) {
  test(`template usages: ${name}, with a genuine unused control`, async () => {
    const diags = await lint(...args)
    const unused = diags.filter(d => d.rule.includes('no-unused-vars'))
    assert.equal(unused.length, 1, JSON.stringify(diags))
    assert.match(unused[0].message, /unusedCanary/)
    assert.ok(!diags.some(d => /parse|syntax/i.test(d.rule)), JSON.stringify(diags))
  })
}

test('usage accounting does not hide shadowed script and callback locals', async () => {
  const diags = await lint('<div @click="active = true; save()" :value="items.map(local => local)" />', `
let active = false;
const local = 1;
const items = [];
function save() { const active = 123; }
`)
  const unused = diags.filter(d => d.rule.includes('no-unused-vars'))
  assert.equal(unused.length, 3, JSON.stringify(diags))
  assert.ok(unused.some(d => d.message.includes("'local'")))
  assert.ok(unused.some(d => d.message.includes("'active'")))
})

test('synthetic component and directive references do not trigger no-undef', async () => {
  const diags = await lint('<ElForm ref="form" v-loading="loading">{{ $slots.default }} {{ missing }}</ElForm>', 'defineProps<{ loading: boolean }>();', '', ['-D', 'no-undef'])
  const undefinedNames = diags.filter(d => d.rule.includes('no-undef')).map(d => d.message)
  assert.equal(undefinedNames.length, 1, JSON.stringify(diags))
  assert.match(undefinedNames[0], /missing/)
})

test('compact slot syntax preserves its local scope', async () => {
  const diags = await lint('<ElTableColumn #="{ row }">{{ row.name }}</ElTableColumn>', '', '', ['-D', 'no-undef'])
  assert.ok(!diags.some(d => d.rule.includes('no-undef')), JSON.stringify(diags))
  assert.ok(!diags.some(d => d.rule === 'oxlint-vue/incomplete-template'), JSON.stringify(diags))
})

test('synthetic v-for callbacks do not trigger array-callback-return', async () => {
  const diags = await lint('<div v-for="item in items" :key="item">{{ item }}</div>', 'const items = []; [1].map(() => {});', '', ['-D', 'array-callback-return'])
  const callbacks = diags.filter(d => d.rule.includes('array-callback-return'))
  assert.equal(callbacks.length, 1, JSON.stringify(diags))
  assert.ok(callbacks[0].line > 3, JSON.stringify(callbacks))
})

test('v-for and slot bindings do not count as uses of same-named script variables', async () => {
  const diags = await lint('<div v-for="row in rows" :key="row" /><template #default="{ value }">{{value}}</template>', 'const rows = []; const row = 1; const value = 2;')
  const unused = diags.filter(d => d.rule.includes('no-unused-vars'))
  assert.ok(unused.some(d => d.message.includes("'row'")), JSON.stringify(diags))
  assert.ok(unused.some(d => d.message.includes("'value'")), JSON.stringify(diags))
})

test('CSS comments and property names do not mark variables used', async () => {
  const diags = await lint('<div />', 'const boxColor = "red"; const color = "blue"; const theme = {color: "red"};', '<style>/* v-bind(boxColor) */ .box { color: v-bind("theme.color"); }</style>')
  const unused = diags.filter(d => d.rule.includes('no-unused-vars'))
  assert.equal(unused.length, 3, JSON.stringify(diags))
  assert.ok(unused.some(d => d.message.includes("'boxColor'")))
  assert.ok(unused.some(d => d.message.includes("'color'")))
})

test('a complex expression before v-for retains rule diagnostics and positions', async () => {
  const diags = await lint('<component :is="row.done == true ? Chosen : Other" v-for="row in rows" :key="row.id" />', 'const rows = []; const Chosen = "div"; const Other = "span";', '', ['-D', 'eqeqeq'])
  const eq = diags.find(d => d.rule.includes('eqeqeq'))
  assert.ok(eq, JSON.stringify(diags))
  assert.equal(eq.line, 2)
  assert.equal(eq.column, '<component :is="row.done '.length + 1)
})
