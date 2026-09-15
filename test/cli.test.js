import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseOxlintJson, runOxlint } from '../dist/run.js'

const cli = path.resolve('dist/cli.js')
const config = { plugins: [], categories: {}, rules: { 'no-unused-vars': 'error' } }
async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxlint-vue-cli-'))
  try {
    await fs.mkdir(path.join(dir, 'src'))
    await fs.writeFile(path.join(dir, 'src/A.vue'), '<template><div /></template>\n<script setup>const unusedCanary = 1</script>\n')
    await fs.writeFile(path.join(dir, '.oxlintrc.json'), JSON.stringify(config))
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' })
    await fn(dir, run)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

test('all config spellings preserve a known diagnostic and exit status', async () => {
  await fixture(async (dir, run) => {
    for (const args of [[], ['-c', '.oxlintrc.json'], ['--config', '.oxlintrc.json'], ['--config=.oxlintrc.json'], ['--', '-c', '.oxlintrc.json'], ['--', '--config=.oxlintrc.json'], ['--', '-c', path.join(dir, '.oxlintrc.json')]]) {
      const result = run('src', ...args)
      assert.equal(result.status, 1, JSON.stringify(args) + result.stderr)
      assert.match(result.stdout, /unusedCanary/)
    }
  })
})

test('invalid config, missing arguments and unknown flags are tool errors', async () => {
  await fixture(async (dir, run) => {
    await fs.writeFile(path.join(dir, 'broken.json'), '{broken')
    for (const args of [['-c'], ['--config='], ['--', '-c'], ['-c', 'missing.json'], ['--', '-c', 'missing.json'], ['-c', 'broken.json'], ['--bogus']]) {
      assert.equal(run('src', ...args).status, 2, JSON.stringify(args))
    }
    assert.equal(run('missing-directory').status, 2)
    await fs.mkdir(path.join(dir, 'empty'))
    assert.equal(run('empty').status, 2)
    assert.equal(run('empty', '--allow-empty').status, 0)
  })
})

test('explicit config governs structural rules and file collection too', async () => {
  await fixture(async (dir, run) => {
    await fs.writeFile(path.join(dir, 'src/B.vue'), '<template><div v-html="html" /></template>\n<script setup>const html = ""</script>')
    await fs.writeFile(path.join(dir, 'chosen.json'), JSON.stringify({ ...config, ignorePatterns: ['src/A.vue'], settings: { vue: { rules: { 'vue/no-v-html': 'off' } } } }))
    for (const args of [['-c', 'chosen.json'], ['--config=chosen.json'], ['--', '--config=chosen.json']]) {
      const result = run('src', ...args)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /1 file\(s\)/)
    }
  })
})

test('engine protocol failures cannot become a clean result', async () => {
  for (const output of ['', 'not json', '{}', 'null', '{"diagnostics":{}}']) {
    assert.throws(() => parseOxlintJson(output, '/tmp', new Map(), '/tmp'))
  }
  await fixture(async dir => {
    const fake = path.join(dir, 'fake.mjs')
    for (const body of ['console.log("broken");process.exit(1)', 'console.log(JSON.stringify({diagnostics:[]}));process.exit(1)', 'console.log(JSON.stringify({diagnostics:[]}));process.exit(2)']) {
      await fs.writeFile(fake, body)
      await assert.rejects(runOxlint([path.join(dir, 'src/A.vue')], { cwd: dir, oxlintPath: fake }))
    }
  })
})

test('explicit relative config is also honored by the fix pass', async () => {
  await fixture(async (dir, run) => {
    await fs.writeFile(path.join(dir, 'src/A.vue'), '<template>{{ count }}</template>\n<script setup>\nlet count = 1\n</script>\n')
    await fs.writeFile(path.join(dir, 'fix.json'), JSON.stringify({ rules: { 'prefer-const': 'error' } }))
    const result = run('src', '--fix', '--', '-c', 'fix.json')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(await fs.readFile(path.join(dir, 'src/A.vue'), 'utf8'), /const count = 1/)
  })
})

test('a zero-file engine result is not confused with a clean lint run', () => {
  assert.throws(() => parseOxlintJson('{"diagnostics":[],"number_of_files":0}', '/tmp', new Map([['/tmp/A.ts', '/project/A.vue']]), '/project'), /zero files/)
})
