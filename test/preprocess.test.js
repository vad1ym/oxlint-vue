import assert from 'node:assert/strict'
import test from 'node:test'
import { preprocess } from '../dist/preprocess.js'

/**
 * The padding invariant is the load-bearing assumption of the whole tool: if
 * length or line positions drift, every diagnostic silently points at the wrong
 * place. It is cheap to assert and catastrophic to lose, so it is checked on
 * every fixture.
 */
function assertInvariant(source, name) {
  const { code } = preprocess(source, `${name}.vue`)
  assert.equal(code.length, source.length, `${name}: length drift`)
  assert.equal(
    code.split('\n').length,
    source.split('\n').length,
    `${name}: line count drift`,
  )
  // Every newline must sit at exactly the same offset.
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      assert.equal(code[i], '\n', `${name}: newline moved at offset ${i}`)
    }
  }
  return code
}

const FIXTURES = {
  minimal: `<template><div>{{ msg }}</div></template>
<script setup>const msg = 'hi'</script>
`,
  vFor: `<template>
  <ul><li v-for="item in items" :key="item.id">{{ item.name }}</li></ul>
</template>
<script setup>const items = []</script>
`,
  nestedVFor: `<template>
  <div v-for="row in rows" :key="row.id">
    <span v-for="cell in row.cells" :key="cell.id">{{ cell.v }}</span>
  </div>
</template>
<script setup>const rows = []</script>
`,
  slot: `<template>
  <Table><template #row="{ item }">{{ item.name }}</template></Table>
</template>
<script setup>import Table from './T.vue'</script>
`,
  selfClosing: `<template><Foo v-for="a in list" :key="a" :bar="a.x" /></template>
<script setup>const list = []</script>
`,
  unicode: `<template><div :title="emoji">{{ '\u{1F600} 你好' }}</div></template>
<script setup>const emoji = '\u{1F680}'</script>
`,
  crlf: '<template>\r\n  <div>{{ a }}</div>\r\n</template>\r\n<script setup>\r\nconst a = 1\r\n</script>\r\n',
  noScript: `<template><div>{{ x }}</div></template>
`,
  emptyTemplate: `<template></template>
<script setup>const a = 1</script>
`,
  comments: `<template>
  <!-- a comment {{ notAnExpr }} -->
  <div>{{ real }}</div>
</template>
<script setup>const real = 1</script>
`,
  style: `<template><div class="a">{{ v }}</div></template>
<script setup>const v = 1</script>
<style scoped>.a { color: red }</style>
`,
}

for (const [name, source] of Object.entries(FIXTURES)) {
  test(`padding invariant: ${name}`, () => {
    assertInvariant(source, name)
  })
}

test('script setup content is preserved byte-for-byte at original offsets', () => {
  const source = FIXTURES.vFor
  const { code } = preprocess(source, 'a.vue')
  const marker = 'const items = []'
  const at = source.indexOf(marker)
  assert.ok(at > 0)
  assert.equal(code.slice(at, at + marker.length), marker)
})

test('template text and tags are blanked, expressions retained', () => {
  const { code } = preprocess(FIXTURES.minimal, 'a.vue')
  assert.ok(!code.includes('<div>'), 'tags must be padded out')
  assert.ok(code.includes('msg'), 'expression identifiers must survive')
})

test('v-for emits a real binding construct', () => {
  const { code } = preprocess(FIXTURES.vFor, 'a.vue')
  assert.match(code, /items\.map\(item=>\{/)
  assert.ok(code.includes('})'), 'scope must be closed')
})

test('nested v-for keeps both bindings', () => {
  const { code } = preprocess(FIXTURES.nestedVFor, 'a.vue')
  // Non-identifier sources are parenthesised, so match either form.
  assert.match(code, /rows\.map\(row=>\{/)
  assert.match(code, /\(?row\.cells\)?\.map\(cell=>\{/)
})

test('non-identifier v-for source is parenthesised', () => {
  // `v-for="i in 5"` must not become `5.map(...)`, which is a malformed number.
  const { code } = preprocess(
    `<template><i v-for="n in 5" :key="n">{{ n }}</i></template>
<script setup>const a = 1</script>
`,
    'a.vue',
  )
  assert.ok(!/[^)\w]5\.map/.test(code), `bare numeric receiver in: ${code}`)
})

test('destructuring v-for binding is parenthesised', () => {
  const { code } = preprocess(
    `<template><i v-for="[k, v] in pairs" :key="k">{{ v }}</i></template>
<script setup>const pairs = []</script>
`,
    'a.vue',
  )
  assert.match(code, /pairs\.map\(\(\[k, v\]\)=>\{/)
})

test('component tags count as uses of their binding', () => {
  // The single largest source of false positives: a component imported and used
  // only in the template would otherwise look unused.
  const { code } = preprocess(
    `<template>
  <Icon name="x" />
  <v-select :items="list" />
  <MultiLine
    :a="list"
  />
</template>
<script setup>
import { Icon } from '@iconify/vue'
import VSelect from './VSelect.vue'
import MultiLine from './MultiLine.vue'
const list = []
</script>
`,
    'a.vue',
  )
  assert.match(code, /\bIcon\b/, 'PascalCase tag')
  assert.match(code, /\bVSelect\b/, 'kebab-case tag must resolve to PascalCase')
  assert.match(code, /\bMultiLine\b/, 'tag at end of line')
})

test('component reference does not collide with a static ref', () => {
  // Regression: `typeof VForm` used to run into the emitted `formRef`,
  // producing the identifier `VFormformRef`.
  const { code } = preprocess(
    `<template><VForm ref="formRef" :x="v" /></template>
<script setup>const v = 1</script>
`,
    'a.vue',
  )
  assert.ok(!/VFormformRef/.test(code), `identifiers ran together: ${code}`)
  assert.match(code, /\bVForm\b/)
  assert.match(code, /\bformRef\b/)
})

test('nested component tags do not overwrite each other', () => {
  // Regression: children are emitted before their parent, so the outer tag's
  // search for room used to run over the inner tag (`typeof Etypeof Delete`).
  const { code } = preprocess(
    `<template><ElIcon><Delete /></ElIcon></template>
<script setup>const a = 1</script>
`,
    'a.vue',
  )
  assert.ok(!/typeof E?typeof/.test(code), `tags overlapped: ${code}`)
  assert.match(code, /\bElIcon\b/)
  assert.match(code, /\bDelete\b/)
})

test('component references use typeof so auto-imports are not undefined', () => {
  // A component may be auto-imported (Nuxt, unplugin-vue-components) and thus
  // invisible in the file. `typeof X` marks it used without asserting it
  // exists, so no-undef stays quiet while no-unused-vars still works.
  const { code } = preprocess(
    `<template><NuxtLink to="/x">go</NuxtLink></template>
<script setup>const a = 1</script>
`,
    'a.vue',
  )
  assert.match(code, /typeof NuxtLink/)
})

test('plain HTML tags do not emit references', () => {
  const { code } = preprocess(
    `<template><div><span>{{ a }}</span></div></template>
<script setup>const a = 1</script>
`,
    'a.vue',
  )
  assert.ok(!/\bdiv\b/.test(code), 'html tags must stay padded out')
  assert.ok(!/\bspan\b/.test(code), 'html tags must stay padded out')
})

test('custom directives count as uses, built-ins do not', () => {
  const { code } = preprocess(
    `<template><input v-maska="mask" v-if="ok"></template>
<script setup>
import { vMaska } from 'maska/vue'
const mask = '#', ok = true
</script>
`,
    'a.vue',
  )
  assert.match(code, /\bvMaska\b/, 'custom directive must reference its binding')
  assert.ok(!/\bvIf\b/.test(code), 'built-in directives have no binding')
})

test('static ref="name" counts as a use', () => {
  const { code } = preprocess(
    `<template><div ref="emblaRef" /></template>
<script setup>const [emblaRef] = f()</script>
`,
    'a.vue',
  )
  assert.match(code, /\bemblaRef\b/)
})

test('multi-statement handlers are not parenthesised', () => {
  const source = `<template><button @click="a(); b()">x</button></template>
<script setup>function a() {}; function b() {}</script>
`
  const { code } = preprocess(source, 'a.vue')
  assert.ok(
    !/;\(a\(\); b\(\)\);/.test(code),
    `statement list must not be wrapped in parens: ${code}`,
  )
  assert.ok(code.includes('a(); b()'), 'handler statements must survive')
})

test('CRLF line endings survive unchanged', () => {
  const source = FIXTURES.crlf
  const { code } = preprocess(source, 'a.vue')
  assert.equal(code.length, source.length)
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\r') assert.equal(code[i], '\r', `CR moved at ${i}`)
  }
})

test('file without a script block still yields a valid virtual file', () => {
  const { code, hasScript } = preprocess(FIXTURES.noScript, 'a.vue')
  assert.equal(hasScript, false)
  assert.equal(code.length, FIXTURES.noScript.length)
})

test('comment contents are not treated as expressions', () => {
  const { code } = preprocess(FIXTURES.comments, 'a.vue')
  assert.ok(!code.includes('notAnExpr'), 'comment text must be padded out')
  assert.ok(code.includes('real'), 'real interpolation must survive')
})

test('style block is padded out entirely', () => {
  const { code } = preprocess(FIXTURES.style, 'a.vue')
  assert.ok(!code.includes('color: red'), 'CSS must not reach the linter')
})
