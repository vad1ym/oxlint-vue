import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@vue/compiler-sfc'
import { checkTemplate, structuralRuleNames } from '../dist/structural.js'

/** Run the structural checker over a template and return the rules that fired. */
function check(template, config, script = '') {
  const source = `<template>\n${template}\n</template>\n`
    + `<script setup>\n${script}\n</script>\n`
  const { descriptor } = parse(source, { filename: 'a.vue' })
  const found = checkTemplate(
    descriptor.template.ast, 'a.vue', source, config,
    descriptor.scriptSetup?.content,
  )
  return {
    rules: found.map(d => d.rule),
    diagnostics: found,
  }
}

/** Props-aware variant for rules that need defineProps context. */
function checkWithProps(template, script) {
  return check(template, undefined, script)
}

const CASES = [
  ['vue/require-v-for-key', '<li v-for="i in list">{{ i }}</li>', true],
  ['vue/require-v-for-key', '<li v-for="i in list" :key="i.id">x</li>', false],
  ['vue/no-v-html', '<div v-html="raw" />', true],
  ['vue/no-use-v-if-with-v-for', '<li v-for="i in l" v-if="i" :key="i">x</li>', true],
  ['vue/no-template-key', '<template key="a"><i>x</i></template>', true],
  ['vue/no-useless-mustaches', '<p>{{ \'text\' }}</p>', true],
  ['vue/no-useless-mustaches', '<p>{{ value }}</p>', false],
  ['vue/no-duplicate-attributes', '<div :id="a" :id="b" />', true],
  ['vue/no-duplicate-attributes', '<div class="a" :class="b" />', false],
  ['vue/require-component-is', '<component />', true],
  ['vue/require-component-is', '<component :is="c" />', false],
  ['vue/no-v-text-v-html-on-component', '<MyComp v-html="raw" />', true],
  ['vue/no-v-text-v-html-on-component', '<div v-html="raw" />', false],
  ['vue/valid-v-for', '<p v-for="bad">x</p>', true],
  ['vue/valid-v-for', '<p v-for="i in list" :key="i">x</p>', false],
  ['vue/no-useless-v-bind', '<input :type="\'text\'">', true],
  ['vue/no-useless-v-bind', '<input :type="kind">', false],
  ['vue/this-in-template', '<p>{{ this.foo }}</p>', true],
  ['vue/this-in-template', '<p>{{ foo }}</p>', false],
  ['vue/no-target-blank', '<a href="/x" target="_blank">x</a>', true],
  ['vue/no-target-blank', '<a href="/x" target="_blank" rel="noopener">x</a>', false],
  ['vue/require-v-for-with-index-key', '<li v-for="(x, i) in l" :key="i">x</li>', true],
  ['vue/require-v-for-with-index-key', '<li v-for="(x, i) in l" :key="x.id">x</li>', false],
  ['vue/no-static-inline-styles', '<div style="color:red" />', true],
  ['vue/no-dupe-v-else-if', '<i v-if="a">1</i><i v-else-if="a">2</i>', true],
  ['vue/no-dupe-v-else-if', '<i v-if="a">1</i><i v-else-if="b">2</i>', false],
  ['vue/no-textarea-mustache', '<textarea>{{ t }}</textarea>', true],
  ['vue/no-textarea-mustache', '<textarea v-model="t" />', false],
  ['vue/no-child-content', '<p v-html="h">child</p>', true],
  ['vue/no-child-content', '<p v-html="h" />', false],
  ['vue/no-mutating-props', '<button @click="x = 1" />', false],
]

for (const [rule, template, shouldFire] of CASES) {
  test(`${rule} ${shouldFire ? 'fires' : 'stays quiet'}: ${template}`, () => {
    const { rules } = check(template)
    assert.equal(
      rules.includes(rule),
      shouldFire,
      `got: ${rules.join(', ') || '(none)'}`,
    )
  })
}

test('this-in-template ignores DOM handler bindings', () => {
  // `:onerror="`this.src = ...`"` is a DOM handler string; its `this` is the
  // element at runtime, not the component instance.
  const { rules } = check('<img :onerror="`this.src = \'x\'`">')
  assert.ok(!rules.includes('vue/this-in-template'), rules.join(', '))
})

test('this-in-template ignores `this` inside a string literal', () => {
  const { rules } = check('<p>{{ label || "use this.value" }}</p>')
  assert.ok(!rules.includes('vue/this-in-template'), rules.join(', '))
})

test('rules can be turned off by config', () => {
  const template = '<div v-html="raw" />'
  assert.ok(check(template).rules.includes('vue/no-v-html'))
  assert.ok(!check(template, { 'vue/no-v-html': 'off' }).rules.includes('vue/no-v-html'))
})

test('rule severity can be raised by config', () => {
  const { diagnostics } = check(
    '<div v-html="raw" />',
    { 'vue/no-v-html': 'error' },
  )
  const d = diagnostics.find(x => x.rule === 'vue/no-v-html')
  assert.equal(d.severity, 'error')
})

test('config accepts numeric and array severities', () => {
  const template = '<div v-html="raw" />'
  assert.ok(!check(template, { 'vue/no-v-html': 0 }).rules.includes('vue/no-v-html'))
  const arr = check(template, { 'vue/no-v-html': ['error', {}] })
  assert.equal(
    arr.diagnostics.find(d => d.rule === 'vue/no-v-html').severity,
    'error',
  )
})

test('every rule reports a line and column', () => {
  const { diagnostics } = check(
    '<li v-for="i in l">{{ this.x }}</li>\n<div v-html="r" style="a:b" />',
  )
  assert.ok(diagnostics.length > 0)
  for (const d of diagnostics) {
    assert.ok(Number.isInteger(d.line) && d.line > 0, `bad line on ${d.rule}`)
    assert.ok(Number.isInteger(d.column) && d.column > 0, `bad col on ${d.rule}`)
  }
})

test('every exported rule name is covered by a test case', () => {
  const tested = new Set(CASES.map(([rule]) => rule))
  const missing = structuralRuleNames.filter(n => !tested.has(n))
  assert.deepEqual(missing, [], `untested rules: ${missing.join(', ')}`)
})

test('no-mutating-props detects assignment to a declared prop', () => {
  const { rules } = checkWithProps(
    '<button @click="title = \'x\'">go</button>',
    'const props = defineProps<{ title: string }>()',
  )
  assert.ok(rules.includes('vue/no-mutating-props'), rules.join(', '))
})

test('no-mutating-props detects compound assignment', () => {
  const { rules } = checkWithProps(
    '<input @input="count += 1">',
    'const props = defineProps<{ count: number }>()',
  )
  assert.ok(rules.includes('vue/no-mutating-props'), rules.join(', '))
})

test('no-mutating-props ignores non-prop locals', () => {
  const { rules } = checkWithProps(
    '<button @click="local = 1">go</button>',
    'const props = defineProps<{ title: string }>()',
  )
  assert.ok(!rules.includes('vue/no-mutating-props'), rules.join(', '))
})

test('no-mutating-props reads the runtime defineProps form', () => {
  const { rules } = checkWithProps(
    '<button @click="title = 1">go</button>',
    'const props = defineProps({ title: String })',
  )
  assert.ok(rules.includes('vue/no-mutating-props'), rules.join(', '))
})

test('no-mutating-props ignores a prop name inside a string', () => {
  const { rules } = checkWithProps(
    '<button @click="log(\'title = x\')">go</button>',
    'const props = defineProps<{ title: string }>()',
  )
  assert.ok(!rules.includes('vue/no-mutating-props'), rules.join(', '))
})

test('no-dupe-v-else-if spots a duplicate later in the chain', () => {
  const { rules } = check(
    '<i v-if="a">1</i><i v-else-if="b">2</i><i v-else-if="a">3</i>',
  )
  assert.ok(rules.includes('vue/no-dupe-v-else-if'), rules.join(', '))
})

test('no-dupe-v-else-if ignores whitespace differences only', () => {
  // `a&&b` and `a && b` are the same condition; both must be caught.
  const { rules } = check('<i v-if="a&&b">1</i><i v-else-if="a && b">2</i>')
  assert.ok(rules.includes('vue/no-dupe-v-else-if'), rules.join(', '))
})

test('no-dupe-v-else-if does not cross into an unrelated chain', () => {
  const { rules } = check(
    '<i v-if="a">1</i><b>break</b><i v-if="a">2</i>',
  )
  assert.ok(!rules.includes('vue/no-dupe-v-else-if'), rules.join(', '))
})

test('config extends chain is followed for structural rules', async () => {
  // oxlint resolves `extends` for its own rules, but never sees ours -- so the
  // chain has to be walked here or a preset's settings are silently lost.
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { runOxlint } = await import('../dist/run.js')

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-extends-'))
  try {
    await fs.writeFile(
      path.join(dir, 'base.json'),
      JSON.stringify({
        settings: { vue: { rules: { 'vue/no-v-html': 'off' } } },
      }),
    )
    await fs.writeFile(
      path.join(dir, '.oxlintrc.json'),
      JSON.stringify({ extends: ['./base.json'] }),
    )
    await fs.writeFile(
      path.join(dir, 'A.vue'),
      '<template><div v-html="r" /></template>\n<script setup>const r=1</script>\n',
    )

    const diags = await runOxlint([path.join(dir, 'A.vue')], { cwd: dir })
    assert.ok(
      !diags.some(d => d.rule === 'vue/no-v-html'),
      'rule disabled by the extended config must stay disabled',
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('local settings override the extended preset', async () => {
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const { runOxlint } = await import('../dist/run.js')

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-override-'))
  try {
    await fs.writeFile(
      path.join(dir, 'base.json'),
      JSON.stringify({
        settings: { vue: { rules: { 'vue/no-v-html': 'off' } } },
      }),
    )
    await fs.writeFile(
      path.join(dir, '.oxlintrc.json'),
      JSON.stringify({
        extends: ['./base.json'],
        settings: { vue: { rules: { 'vue/no-v-html': 'error' } } },
      }),
    )
    await fs.writeFile(
      path.join(dir, 'A.vue'),
      '<template><div v-html="r" /></template>\n<script setup>const r=1</script>\n',
    )

    const diags = await runOxlint([path.join(dir, 'A.vue')], { cwd: dir })
    const d = diags.find(x => x.rule === 'vue/no-v-html')
    assert.ok(d, 'locally re-enabled rule must fire')
    assert.equal(d.severity, 'error')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
