import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { preprocess } from '../dist/preprocess.js'
import { runOxlint } from '../dist/run.js'
import { resolveBin } from '../dist/resolve.js'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '..')
const OXLINT = resolveBin('oxlint', ROOT, import.meta.url)

/**
 * A virtual file that fails to parse silently disables every rule for that
 * SFC -- the worst failure mode, because the tool reports success. So we assert
 * the generated code actually parses.
 */
async function assertParses(source, name) {
  const { code } = preprocess(source, `${name}.vue`)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-parse-'))
  try {
    const file = path.join(dir, `${name}.ts`)
    await fs.writeFile(file, code)
    let out = ''
    try {
      const r = await execFileAsync(OXLINT, ['--format=json', '-A', 'all', file])
      out = r.stdout
    } catch (e) {
      out = e.stdout ?? ''
    }
    // Parse/syntax failures are reported even when all lint rules are allowed.
    assert.ok(
      !/Expected|Unexpected|Invalid|SyntaxError/i.test(out),
      `${name}: virtual file failed to parse:\n${out}\n--- code ---\n${code}`,
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const PARSE_CASES = {
  interpolation: `<template><div>{{ a + b }}</div></template>
<script setup>const a = 1, b = 2</script>
`,
  vForKeyed: `<template>
  <li v-for="item in items" :key="item.id">{{ item.name }}</li>
</template>
<script setup>const items = []</script>
`,
  vForNested: `<template>
  <div v-for="r in rows" :key="r.id"><i v-for="c in r.cells" :key="c">{{ c }}</i></div>
</template>
<script setup>const rows = []</script>
`,
  vForIndex: `<template>
  <li v-for="(item, i) in items" :key="i">{{ item }}{{ i }}</li>
</template>
<script setup>const items = []</script>
`,
  vOnHandlers: `<template>
  <button @click="go()" @keyup.enter="go()">{{ label }}</button>
</template>
<script setup>const label = 'x'; function go() {}</script>
`,
  vIfChain: `<template>
  <p v-if="a">{{ a }}</p><p v-else-if="b">{{ b }}</p><p v-else>none</p>
</template>
<script setup>const a = 1, b = 2</script>
`,
  vModel: `<template><input v-model="text"></template>
<script setup>import { ref } from 'vue'; const text = ref('')</script>
`,
  ternaryBinding: `<template><div :class="ok ? 'a' : 'b'">{{ ok }}</div></template>
<script setup>const ok = true</script>
`,
  objectBinding: `<template><div :style="{ color: c, width: w }" /></template>
<script setup>const c = 'red', w = '1px'</script>
`,
  selfClosing: `<template><Foo v-for="a in list" :key="a" :bar="a" /></template>
<script setup>const list = []</script>
`,
  tsScript: `<template><div>{{ user.name }}</div></template>
<script setup lang="ts">
interface User { name: string }
const user: User = { name: 'a' }
</script>
`,

  // --- regressions found by running against a ~4.7k-file real-world corpus ---

  // Multi-line attributes: writing a wrapper over the newline used to shift
  // every subsequent line number.
  multilineAttrs: `<template>
  <Button
    :icon="isDark ? 'sun' : 'moon'"
    :label="variant === 'icon' ? undefined : text"
    @click="toggle()"
  />
</template>
<script setup>
const isDark = true, variant = 'icon', text = 'x'
function toggle() {}
</script>
`,
  // Object literals at statement position parse as blocks unless parenthesised.
  objectLiteralClass: `<template>
  <div
    :class="{ 'border-red': !!error, disabled: isDisabled }"
    :style="{ width: \`\${w}px\` }"
  />
</template>
<script setup>const error = null, isDisabled = false, w = 1</script>
`,
  // `v-for="n in 5"` must not produce `5.map(...)`.
  numericVFor: `<template><i v-for="n in 5" :key="n">{{ n }}</i></template>
<script setup>const a = 1</script>
`,
  // Destructuring bindings are invalid as bare arrow parameters.
  destructuringVFor: `<template>
  <div v-for="[month, items] in grouped" :key="month">{{ items.length }}</div>
</template>
<script setup>const grouped = []</script>
`,
  // Vue allows a statement list in a handler; it cannot be parenthesised.
  multiStatementHandler: `<template>
  <button @click="push({ name: 'a' }); close()">go</button>
</template>
<script setup>function push() {}; function close() {}</script>
`,
  // Slot destructuring with renaming.
  slotRename: `<template>
  <Table><template #default="{ row: item }">{{ item.id }}</template></Table>
</template>
<script setup>import Table from './T.vue'</script>
`,
}

for (const [name, source] of Object.entries(PARSE_CASES)) {
  test(`virtual file parses: ${name}`, async () => {
    await assertParses(source, name)
  })
}

test('end-to-end: template-only usage does not report unused vars', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-e2e-'))
  try {
    const vue = path.join(dir, 'Comp.vue')
    await fs.writeFile(vue, `<template>
  <div>{{ usedOnlyInTemplate }}</div>
</template>
<script setup>
const usedOnlyInTemplate = 1
const neverUsed = 2
</script>
`)
    const diags = await runOxlint([vue], {
      cwd: dir,
      oxlintPath: OXLINT,
      extraArgs: ['-D', 'no-unused-vars'],
    })

    const unused = diags.filter(d => String(d.rule).includes('no-unused-vars'))
    const names = unused.map(d => d.message)

    assert.ok(
      !names.some(m => m.includes('usedOnlyInTemplate')),
      `template-only binding must not be reported unused, got: ${names.join('; ')}`,
    )
    assert.ok(
      names.some(m => m.includes('neverUsed')),
      `genuinely unused binding must be reported, got: ${names.join('; ')}`,
    )
    // Diagnostics must be rebound to the original .vue path.
    assert.ok(diags.every(d => d.filename.endsWith('.vue')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('end-to-end: diagnostic offsets land on the right source text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-pos-'))
  try {
    const vue = path.join(dir, 'Pos.vue')
    const source = `<template>
  <div>{{ a == b }}</div>
</template>
<script setup>
const a = 1, b = 2
</script>
`
    await fs.writeFile(vue, source)
    const diags = await runOxlint([vue], {
      cwd: dir,
      oxlintPath: OXLINT,
      extraArgs: ['-D', 'eqeqeq'],
    })
    const eq = diags.find(d => String(d.rule).includes('eqeqeq'))
    assert.ok(eq, 'eqeqeq must fire inside the template')

    const lines = source.split('\n')
    const text = lines[eq.line - 1].slice(eq.column - 1, eq.column + 1)
    assert.equal(text, '==', `expected to point at '==', pointed at '${text}'`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('structural rules fire with correct positions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-struct-'))
  try {
    const vue = path.join(dir, 'S.vue')
    await fs.writeFile(vue, `<template>
  <li v-for="i in list">{{ i }}</li>
  <div v-html="raw" />
</template>
<script setup>
const list = []
const raw = ''
</script>
`)
    const diags = await runOxlint([vue], { cwd: dir, oxlintPath: OXLINT })
    const rules = diags.map(d => d.rule)
    assert.ok(rules.includes('vue/require-v-for-key'), 'missing key rule')
    assert.ok(rules.includes('vue/no-v-html'), 'missing v-html rule')

    const key = diags.find(d => d.rule === 'vue/require-v-for-key')
    assert.equal(key.line, 2, 'v-for key diagnostic on the wrong line')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
