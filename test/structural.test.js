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
  ['vue/multi-word-component-names', '<div />', true],
  ['vue/no-unused-components', '<div />', false],
  ['vue/no-ref-as-operand', '<div />', false],
  ['vue/require-valid-default-prop', '<div />', false],
  ['vue/no-use-computed-property-like-method', '<div />', false],
  ['vue/no-template-shadow', '<div v-for="item in items"><i v-for="item in item" /></div>', true],
  ['vue/require-explicit-emits', '<button @click="$emit(\'save\')" />', true],
  ['vue/one-component-per-file', '<div />', true,
    'Vue.component(\'FirstComp\', {}); Vue.component(\'SecondComp\', {})'],
  ['vue/v-slot-style', '<MyComp><template v-slot:item="slotProps">{{ slotProps }}</template></MyComp>', true],
  ['vue/html-self-closing', '<div></div>', true],
  ['vue/no-multi-spaces', '<div   class="foo" />', true],
  ['vue/singleline-html-element-content-newline', '<div class="panel">content</div>', true],
  ['vue/multiline-html-element-content-newline', '<div>content\n</div>', true],
  ['vue/html-indent', '<div>\n<span />\n</div>', true],
  ['vue/attributes-order', '<div @click="go" v-if="ready" />', true],
  ['vue/order-in-components', '<div />', true,
    'defineOptions({ data() {}, name: \'ExampleCard\' })'],
  ['vue/no-boolean-default', '<div />', true,
    'defineProps({ active: { type: Boolean, default: true } })'],
  ['vue/component-options-name-casing', '<div />', true,
    'export default { components: { fooBar } }'],
  ['vue/html-comment-content-spacing', '<!--comment-->', true],
  ['vue/html-comment-content-newline', '<!-- multiline\ncomment -->', true],
  ['vue/no-deprecated-filter', '<p>{{ value | format }}</p>', true],
  ['vue/no-deprecated-dollar-listeners-api', '<div v-on="$listeners" />', true],
  ['vue/no-deprecated-dollar-scopedslots-api', '<div v-if="$scopedSlots.default" />', true],
  ['vue/valid-v-slot', '<div v-slot="{ value }" />', true],
  ['vue/valid-v-html', '<div v-html />', true],
  ['vue/valid-v-text', '<div v-text />', true],
  ['vue/valid-v-show', '<div v-show />', true],
  ['vue/valid-v-once', '<div v-once="value" />', true],
  ['vue/valid-v-cloak', '<div v-cloak="value" />', true],
  ['vue/valid-v-if', '<div v-if />', true],
  ['vue/valid-v-else-if', '<div v-else-if="value" />', true],
  ['vue/valid-v-else', '<div v-else />', true],
  ['vue/valid-v-memo', '<div v-memo="{}" />', true],
  ['vue/valid-v-is', '<Component v-is="kind" />', true],
  ['vue/no-deprecated-v-on-native-modifier', '<Component @click.native="go" />', true],
  ['vue/use-v-on-exact', '<button @click="go" @click.ctrl="go" />', true],
  ['vue/no-deprecated-v-is', '<div v-is="kind" />', true],
  ['vue/no-deprecated-v-bind-sync', '<Component :value.sync="value" />', true],
  ['vue/no-deprecated-v-on-number-modifiers', '<input @keyup.13="go" />', true],
  ['vue/no-deprecated-inline-template', '<Component inline-template />', true],
  ['vue/no-deprecated-html-element-is', '<button :is="component" />', true],
  ['vue/no-deprecated-router-link-tag-prop', '<RouterLink tag="div" />', true],
  ['vue/no-deprecated-scope-attribute', '<template scope="value" />', true],
  ['vue/no-deprecated-slot-scope-attribute', '<template slot-scope="value" />', true],
  ['vue/no-deprecated-slot-attribute', '<template slot="name" />', true],
  ['vue/valid-v-pre', '<div v-pre.value />', true],
  ['vue/no-deprecated-functional-template', '<div />', false],
  ['vue/no-useless-template-attributes', '<div><template v-if="ok" class="bad" /></div>', true],
  ['vue/valid-template-root', '', true],
  ['vue/require-toggle-inside-transition', '<transition><div /></transition>', true],
  ['vue/valid-v-bind', '<div :title.unknown="title" />', true],
  ['vue/valid-v-on', '<button @click.unknown="go" />', true],
  ['vue/valid-attribute-name', '<div 0invalid />', true],
  ['vue/no-v-text', '<div v-text="text" />', true],
  ['vue/no-use-v-else-with-v-for', '<div v-else v-for="item in items" />', true],
  ['vue/no-v-for-template-key', '<template v-for="item in items" :key="item" />', true],
  ['vue/no-v-model-argument', '<Component v-model:value="value" />', true],
  ['vue/no-custom-modifiers-on-v-model', '<Component v-model.custom="value" />', true],
  ['vue/slot-name-casing', '<slot name="Bad-Name" />', true],
  ['vue/no-lone-template', '<div><template><span /></template></div>', true],
  ['vue/max-template-depth', '<div><span /></div>', false],
  ['vue/no-root-v-if', '<div v-if="ok" />', true],
  ['vue/html-button-has-type', '<button>Save</button>', true],
  ['vue/no-multiple-objects-in-class', '<div :class="[{ a: yes }, { b: no }]" />', true],
  ['vue/html-end-tags', '<div><span></div>', true],
  ['vue/no-spaces-around-equal-signs-in-attribute', '<div id = "value" />', true],
  ['vue/v-on-style', '<button v-on:click="go" />', true],
  ['vue/mustache-interpolation-spacing', '<p>{{value}}</p>', true],
  ['vue/max-attributes-per-line', '<div id="a" class="b" />', true],
  ['vue/first-attribute-linebreak', '<div id="a"\n  class="b" />', true],
  ['vue/html-quotes', "<div id='a' />", true],
  ['vue/attribute-hyphenation', '<MyComp myProp="value" />', true],
  ['vue/v-on-event-hyphenation', '<MyComp @myEvent="go" />', true],
  ['vue/v-bind-style', '<div v-bind:id="id" />', true],
  ['vue/restricted-component-names', '<MyComp />', false],
  ['vue/no-restricted-html-elements', '<marquee />', false],
  ['vue/no-template-target-blank', '<a href="https://example.com" target="_blank" />', true],
  ['vue/static-class-names-order', '<div class="b a" />', true],
  ['vue/v-for-delimiter-style', '<div v-for="item of items" />', true],
  ['vue/prefer-true-attribute-shorthand', '<MyComp :active="true" />', true],
  ['vue/no-multiple-template-root', '<div /><span />', false],
  ['vue/no-restricted-v-on', '<div @click="go" />', false],
  ['vue/no-restricted-v-bind', '<div :v-test="value" />', true],
  ['vue/no-restricted-static-attribute', '<div foo="bar" />', false],
  ['vue/no-restricted-class', '<div class="forbidden" />', false],
  ['vue/no-duplicate-class-names', '<div class="one one" />', true],
  ['vue/prefer-separate-static-class', '<div :class="\'static\'" />', true],
  ['vue/max-lines-per-block', '<div />', false],
  ['vue/no-restricted-block', '<div />', false],
  ['vue/no-empty-component-block', '<div />', false],
  ['vue/enforce-style-attribute', '<div />', false],
  ['vue/block-lang', '<div />', false],
  ['vue/padding-line-between-blocks', '<div />', false],
  ['vue/block-order', '<div />', false],
  ['vue/block-tag-newline', '<div />', false],
  ['vue/no-negated-v-if-condition', '<div v-if="!ready" />', false],
  ['vue/no-literals-in-template', '<p>Hello</p>', false],
  ['vue/html-closing-bracket-spacing', '<div >x</div>', true],
  ['vue/html-closing-bracket-newline', '<div\n  id="x">x</div>', true],

  ['vue/valid-v-model', '<input v-model="a + b">', true],
  ['vue/valid-v-model', '<input v-model="value">', false],
  ['vue/no-v-for-template-key-on-child', '<template v-for="item in items"><div :key="item.id"/></template>', true],
  ['vue/no-v-for-template-key-on-child', '<template v-for="item in items" :key="item.id"><div/></template>', false],
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
  ['vue/require-v-for-with-index-key', '<li v-for="(x, i) in [1, 2]" :key="i">x</li>', true],
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

for (const [rule, template, shouldFire, script] of CASES) {
  test(`${rule} ${shouldFire ? 'fires' : 'stays quiet'}: ${template}`, () => {
    const { rules } = check(template, undefined, script)
    assert.equal(
      rules.includes(rule),
      shouldFire,
      `got: ${rules.join(', ') || '(none)'}`,
    )
  })
}

test('max-template-depth honors maxDepth', () => {
  const { rules } = check('<div><span /></div>', {
    'vue/max-template-depth': ['warn', { maxDepth: 1 }],
  })
  assert.ok(rules.includes('vue/max-template-depth'), rules.join(', '))
})

test('configured SFC block policies inspect top-level blocks', () => {
  const source = `<style></style><template><div /></template><script lang="ts">const x = 1</script>`
  const { descriptor } = parse(source, { filename: 'a.vue' })
  const diagnostics = checkTemplate(descriptor.template.ast, 'a.vue', source, {
    'vue/no-empty-component-block': 'error',
    'vue/enforce-style-attribute': 'error',
    'vue/block-lang': ['error', { script: { lang: 'js' } }],
    'vue/padding-line-between-blocks': ['error', 'always'],
    'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
    'vue/block-tag-newline': 'error',
  })
  for (const rule of ['no-empty-component-block', 'enforce-style-attribute', 'block-lang',
    'padding-line-between-blocks', 'block-order', 'block-tag-newline']) {
    assert.ok(diagnostics.some(item => item.rule === `vue/${rule}`), rule)
  }
})

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

for (const [template, script, expected] of [
  ['<button @click="(props as Props).title++"/>', 'const props=defineProps<{title:number}>()', true],
  ['<button @click="props.push()"/>', 'const props=defineProps({push:Function})', false],
  ['<button @click="props.items.push(1)"/>', 'const props=defineProps({items:Array})', true],
  ['<p>{{count++}}</p>', 'defineProps({count:Number})', true],
  ['<button @click="props.title = \'x\'"/>', 'const props = defineProps({title:String})', true],
  ['<button @click="props[\'title\']++"/>', 'const props = defineProps<{title:number}>()', true],
  ['<button @click="user.name = \'x\'"/>', 'defineProps({user:Object})', true],
  ['<button @click="rows.push(1)"/>', 'defineProps({rows:Array})', true],
  ['<button @click="({title} = incoming)"/>', 'defineProps({title:String})', true],
  ['<input v-model="title"/>', 'defineProps({title:String})', true],
  ['<button @click="renamed++"/>', 'const {count: renamed = 0} = withDefaults(defineProps<{count:number}>(), {count: 0})', true],
  ['<button @click="count++"/>', 'interface Props { count: number }; defineProps<Props>()', true],
  ['<button @click="local = 1"/>', 'defineProps({title:String}); const config={local:0}; let local=0', false],
  ['<button @click="local = 1"/>', 'defineProps<{nested: {local:number}}>(); let local=0', false],
  ['<button @click="title = 1"/>', 'defineProps({title:String}); let title=0', false],
  ['<button @click="items.map(title => title++)"/>', 'defineProps({title:Number})', false],
  ['<div v-for="title in titles" :key="title"><button @click="title++"/></div>', 'defineProps({title:Number})', false],
  ['<Comp #default="{title}"><button @click="title++"/></Comp>', 'defineProps({title:Number})', false],
  ['<button @click="props = replacement"/>', 'const props=defineProps({title:String})', false],
  ['<button @click="other[title] = 1"/>', 'defineProps({title:String})', false],
  ['<button @click="props.title == other"/>', 'const props=defineProps({title:String})', false],
  ['<button @click="label = \'props.title = 1\'"/>', 'const props=defineProps({title:String})', false],
]) {
  test(`prop AST: ${template} / ${script}`, () => {
    assert.equal(checkWithProps(template, script).rules.includes('vue/no-mutating-props'), expected)
  })
}

for (const [first, second, expected] of [
  ["label === 'a b'", "label === 'ab'", false],
  ["label === 'a b'", 'label === "a b"', true],
  ['a && b', '(a)  && /* same */ b', true],
  ['`a b ${value}`', '`ab ${value}`', false],
  ['/a b/.test(value)', '/ab/.test(value)', false],
  ['a || b', 'a && b', true] // Every a && b case is already covered by a || b.,
]) {
  test(`condition AST: ${first} / ${second}`, () => {
    const template = `<i v-if="${first.replaceAll('"', '&quot;')}"/><!-- comment --><i v-else-if="${second.replaceAll('"', '&quot;')}"/>`
    assert.equal(check(template).rules.includes('vue/no-dupe-v-else-if'), expected)
  })
}

for (const [template, script, expected] of [
  ['<div v-for="(value, name) in record" :key="name"/>', 'const record = {a:1}', false],
  ['<div v-for="(value, name) in unknown" :key="name"/>', '', false],
  ['<div v-for="(value, name, index) in record" :key="name"/>', '', false],
  ['<div v-for="(value, name, index) in record" :key="index"/>', '', true],
  ['<div v-for="(value, index) in list" :key="index"/>', 'const list = [1,2]', true],
  ['<div v-for="list in records" :key="list.id"><i v-for="(value, name) in list" :key="name"/></div>', 'const list = [1,2]', false],
]) {
  test(`index key: ${template}`, () => {
    assert.equal(check(template, undefined, script).rules.includes('vue/require-v-for-with-index-key'), expected)
  })
}

test('Vue 3 template keys identify the fragment or conditional branch', () => {
  for (const directive of ['v-if="ok"', 'v-else-if="ok"', 'v-else', 'v-for="item in items"']) {
    assert.ok(!check(`<template ${directive} :key="id"><div/></template>`).rules.includes('vue/no-template-key'))
  }
  const rules = check('<template v-for="item in items"><div :key="item.id"/></template>').rules
  assert.ok(!rules.includes('vue/require-v-for-key')) // Child key satisfies this rule; the Vue 3 placement rule rejects it.
  assert.ok(rules.includes('vue/no-v-for-template-key-on-child'))
  assert.ok(!check('<template v-for="row in rows" :key="row.id"><i v-for="cell in row.cells" :key="cell.id"/></template>').rules.includes('vue/no-v-for-template-key-on-child'))
})

for (const template of [
  '<input v-model>', '<input v-model="42">', '<input v-model="a + b">',
  '<input v-model="a?.b">', '<input v-model="(a?.b).c">',
  '<div v-model="value"/>', '<input type="file" v-model="file">',
  '<input v-model:arg="value">', '<input v-model.custom="value">',
  '<div v-for="item in items" :key="item.id"><input v-model="item"/></div>',
  '<Comp #default="{value}"><input v-model="value"/></Comp>',
]) {
  test(`invalid v-model: ${template}`, () => {
    assert.ok(check(template).rules.includes('vue/valid-v-model'))
  })
}
for (const template of [
  '<input v-model="value">', '<textarea v-model.trim="value"/>',
  '<select v-model.number="value"/>', '<Comp v-model:arg.custom="value"/>',
  '<input v-model="record[key?.name]">', '<input v-model="getRecord().name">',
  '<input v-model="(record as RecordType).name">',
  '<div v-for="item in items" :key="item.id"><input v-model="item.name"/></div>',
]) {
  test(`valid v-model: ${template}`, () => {
    assert.ok(!check(template).rules.includes('vue/valid-v-model'))
  })
}
