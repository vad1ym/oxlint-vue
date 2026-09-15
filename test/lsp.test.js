import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const CLI = path.join(ROOT, 'dist', 'cli.js')
const PRESET = path.join(ROOT, 'test', 'fixtures', 'configs', 'antfu.oxlintrc.json')

/**
 * Minimal LSP client: enough of the protocol to open a document and collect the
 * diagnostics that come back.
 */
function createClient(cwd) {
  const proc = spawn('node', [CLI, '--lsp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  proc.stdout.on('data', d => { buf += d.toString() })

  const send = (msg) => {
    const body = JSON.stringify(msg)
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  const publishes = () => buf
    .split('Content-Length:')
    .filter(part => part.includes('publishDiagnostics'))
    .map((part) => {
      try {
        return JSON.parse(part.slice(part.indexOf('{')))
      } catch {
        return null
      }
    })
    .filter(Boolean)

  return {
    send,
    publishes,
    latestFor: uri => publishes().filter(p => p.params.uri === uri).pop(),
    kill: () => proc.kill(),
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Wait until `check()` returns something truthy, or give up.
 *
 * Fixed sleeps raced on Windows, where the child server takes noticeably
 * longer to come up: the assertion fired before any diagnostics arrived, and
 * the cleanup then raced the still-running process into EBUSY.
 */
async function waitFor(check, timeout = 20000, step = 100) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(step)
  }
}

/** `file://${dir}` is not a valid URI on Windows, where paths start C:\. */
const fileUri = p => pathToFileURL(p).href

async function withServer(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-lsp-'))
  const client = createClient(dir)
  try {
    await fs.copyFile(PRESET, path.join(dir, '.oxlintrc.json'))
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, 'utf8')
    }

    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: fileUri(dir),
        workspaceFolders: [{ uri: fileUri(dir), name: 'test' }],
        capabilities: { textDocument: { publishDiagnostics: {} } },
      },
    })
    await sleep(1500)
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    await sleep(600)

    return await fn(client, dir)
  } finally {
    // kill() only signals; on Windows the process keeps its handles on the
    // temp dir for a moment longer, and rm races it into EBUSY.
    client.kill()
    await sleep(200)
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

const BROKEN_VUE = `<template>
  <li v-for="i in list">{{ i }}</li>
</template>
<script setup>
const list = [1]
const dead = 2
</script>
`

test('publishes diagnostics for a .vue document', { timeout: 30000 }, async () => {
  await withServer({ 'A.vue': BROKEN_VUE }, async (client, dir) => {
    const uri = fileUri(path.join(dir, 'A.vue'))
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'vue', version: 1, text: BROKEN_VUE },
      },
    })
    const published = await waitFor(() => client.latestFor(uri))
    assert.ok(published, 'no publishDiagnostics arrived for the .vue uri')

    const codes = published.params.diagnostics.map(d => String(d.code))
    // One from the child server (script), one from our structural rules.
    assert.ok(
      codes.some(c => c.includes('no-unused-vars')),
      `script diagnostics missing: ${codes.join(', ')}`,
    )
    assert.ok(
      codes.some(c => c.includes('require-v-for-key')),
      `structural diagnostics missing: ${codes.join(', ')}`,
    )
  })
})

test('reports positions against the real .vue source', { timeout: 30000 }, async () => {
  await withServer({ 'B.vue': BROKEN_VUE }, async (client, dir) => {
    const uri = fileUri(path.join(dir, 'B.vue'))
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'vue', version: 1, text: BROKEN_VUE },
      },
    })
    const arrived = await waitFor(() => client.latestFor(uri))
    assert.ok(arrived, 'no publishDiagnostics arrived')
    const diags = arrived.params.diagnostics
    const unused = diags.find(d => String(d.code).includes('no-unused-vars'))
    assert.ok(unused)
    // `const dead = 2` is line 6 (1-based), so line 5 zero-based.
    assert.equal(unused.range.start.line, 5)

    const lines = BROKEN_VUE.split('\n')
    const text = lines[unused.range.start.line].slice(unused.range.start.character)
    assert.match(text, /^dead/, `range points at: ${text}`)
  })
})

test('filters padding artefacts out of editor diagnostics', { timeout: 30000 }, async () => {
  // Every template expression is an unused expression statement by
  // construction. The CLI hides these with -A flags; the language server takes
  // none, so the proxy has to filter them or the editor is unusable.
const clean = `<template>
  <ul>
    <li
      v-for="i in list"
      :key="i"
    >
      {{ i }}
    </li>
  </ul>
</template>
<script setup>
const list = [1]
</script>
`
  await withServer({ 'CleanFile.vue': clean }, async (client, dir) => {
    const uri = fileUri(path.join(dir, 'CleanFile.vue'))
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'vue', version: 1, text: clean } },
    })
    const arrived = await waitFor(() => client.latestFor(uri))
    assert.ok(arrived, 'no publishDiagnostics arrived')
    const diags = arrived.params.diagnostics
    assert.deepEqual(
      diags.map(d => String(d.code)),
      [],
      'a clean SFC must produce no diagnostics',
    )
  })
})

test('updates diagnostics on edit and cleans up on close', { timeout: 30000 }, async () => {
  await withServer({ 'BrokenFile.vue': BROKEN_VUE }, async (client, dir) => {
    const uri = fileUri(path.join(dir, 'BrokenFile.vue'))
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'vue', version: 1, text: BROKEN_VUE },
      },
    })
    const first = await waitFor(
      () => { const p = client.latestFor(uri); return p?.params.diagnostics.length ? p : null },
    )
    assert.ok(first, 'no diagnostics for the broken file')

    const fixed = `<template>
  <ul>
    <li
      v-for="i in list"
      :key="i"
    >
      {{ i }}
    </li>
  </ul>
</template>
<script setup>
const list = [1]
</script>
`
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: fixed }],
      },
    })
    const cleared = await waitFor(
      () => { const p = client.latestFor(uri); return p?.params.diagnostics.length === 0 ? p : null },
    )
    assert.ok(cleared, 'fixing the source must clear the diagnostics')

    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri } },
    })
    await sleep(600)

    // The proxy writes a sibling .vue.ts because the child server lints from
    // disk; leaving those behind in someone's source tree is unacceptable.
    const leftovers = (await fs.readdir(dir)).filter(f => f.endsWith('.vue.ts'))
    assert.deepEqual(leftovers, [], 'virtual files must be removed on close')
  })
})

test('passes non-vue documents through untouched', { timeout: 30000 }, async () => {
  const ts = 'const unusedHere = 1\nexport const x = 2\n'
  await withServer({ 'E.ts': ts }, async (client, dir) => {
    const uri = fileUri(path.join(dir, 'E.ts'))
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'typescript', version: 1, text: ts } },
    })
    const published = await waitFor(() => client.latestFor(uri))
    assert.ok(published, 'the .ts uri must be answered unchanged')
    assert.ok(
      published.params.diagnostics.some(d => String(d.code).includes('no-unused-vars')),
      'plain TypeScript must still be linted',
    )
  })
})

test('a JS config reaches the child server', async () => {
  // oxlint discovers `.oxlintrc.json` by itself but not `oxlint.config.mjs`,
  // and publishes empty diagnostics until it is sent its configuration --
  // so a JS-config project used to light up in the CLI and stay silent in
  // the editor.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxxx-lsp-js-'))
  const client = createClient(dir)
  try {
    await fs.writeFile(
      path.join(dir, 'oxlint.config.mjs'),
      "export default { rules: { 'eqeqeq': 'error' } }\n",
      'utf8',
    )
    const file = path.join(dir, 'a.ts')
    await fs.writeFile(file, 'export const bad = (1 as any) == 2\n', 'utf8')

    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: fileUri(dir),
        workspaceFolders: [{ uri: fileUri(dir), name: 'test' }],
        capabilities: { textDocument: { publishDiagnostics: {} } },
      },
    })
    await sleep(1500)
    client.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    await sleep(600)

    const uri = fileUri(file)
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId: 'typescript',
          version: 1,
          text: await fs.readFile(file, 'utf8'),
        },
      },
    })

    const published = await waitFor(() => {
      const latest = client.latestFor(uri)
      return latest?.params.diagnostics.length ? latest : null
    })
    assert.ok(published, 'no diagnostics arrived for a project configured in JS')
    assert.ok(
      published.params.diagnostics.some(d => String(d.code).includes('eqeqeq')),
      `expected the config's eqeqeq rule to fire, got ${JSON.stringify(published.params.diagnostics.map(d => d.code))}`,
    )
  } finally {
    client.kill()
    await sleep(200)
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('Vue usages suppress only the matching script declaration in the editor', { timeout: 30000 }, async () => {
  const source = `<template><div @click="active = true; save()" /></template>
<script setup>
let active = false
const boxColor = 'red'
function save() { const active = 123 }
const unusedCanary = 1
</script>
<style>.box { color: v-bind(boxColor); }</style>
`
  await withServer({ 'Usage.vue': source }, async (client, dir) => {
    const uri = fileUri(path.join(dir, 'Usage.vue'))
    client.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId: 'vue', version: 1, text: source },
    } })
    const published = await waitFor(() => client.latestFor(uri))
    assert.ok(published)
    const unused = published.params.diagnostics.filter(d => String(d.code).includes('no-unused-vars'))
    assert.equal(unused.length, 2, JSON.stringify(unused))
    assert.ok(unused.some(d => d.message.includes('unusedCanary')))
    assert.ok(unused.some(d => d.message.includes('active') && d.range.start.line === 4))
  })
})

test('editor reports inherited strict coverage gaps and SFC parse errors', { timeout: 30000 }, async () => {
  const incomplete = `<template>\n<i :title="item.x" v-for="item in longItems" :key="item.id" />\n</template>\n<script setup>const longItems=[]</script>`
  const invalid = '<template>\n<div><span></div>\n</template>\n<script setup>const unused=1</script>'
  await withServer({
    'Partial.vue': incomplete,
    'Invalid.vue': invalid,
    'base.json': JSON.stringify({ settings: { vue: { strictTemplates: true } } }),
    '.oxlintrc.json': JSON.stringify({ extends: ['./base.json'] }),
  }, async (client, dir) => {
    for (const [name, text, code] of [
      ['Partial.vue', incomplete, 'oxlint-vue/incomplete-template'],
      ['Invalid.vue', invalid, 'vue/no-parsing-error'],
    ]) {
      const uri = fileUri(path.join(dir, name))
      client.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
        textDocument: { uri, languageId: 'vue', version: 1, text },
      } })
      const diagnostic = await waitFor(() => client.latestFor(uri)?.params.diagnostics.find(d => d.code === code))
      assert.ok(diagnostic, `missing ${code}`)
      assert.equal(diagnostic.severity, 1)
      assert.equal(diagnostic.range.start.line, 1)
    }
  })
})

test('editor reports script-only prop mutations and clears them after repair', { timeout: 30000 }, async () => {
  const source = '<script setup>\nconst props = defineProps({value:Number})\nprops.value++\n</script>'
  await withServer({ 'Props.vue': source }, async (client, dir) => {
    const uri = fileUri(path.join(dir, 'Props.vue'))
    client.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId: 'vue', version: 1, text: source },
    } })
    const found = await waitFor(() => client.latestFor(uri)?.params.diagnostics.find(d => d.code === 'vue/no-mutating-props'))
    assert.ok(found)
    assert.deepEqual(found.range.start, { line: 2, character: 0 })
    const before = client.publishes().length
    client.send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: source.replace('props.value++', 'console.log(props.value)') }],
    } })
    const cleared = await waitFor(() => {
      if (client.publishes().length <= before) return false
      return !client.latestFor(uri)?.params.diagnostics.some(d => d.code === 'vue/no-mutating-props')
    })
    assert.ok(cleared, 'stale prop mutation remains after the edit')
  })
})
