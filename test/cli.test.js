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
    await fs.writeFile(path.join(dir, 'src/CanaryFile.vue'), '<template><div /></template>\n<script setup>const unusedCanary = 1</script>\n')
    await fs.writeFile(path.join(dir, '.oxlintrc.json'), JSON.stringify(config))
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' })
    await fn(dir, run)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

const nativeExportDiagnostic = diagnostics =>
  diagnostics.find(d => d.rule.includes('no-export-in-script-setup'))

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
    await fs.writeFile(path.join(dir, 'src/ButtonFile.vue'), '<template><div v-html="html" /></template>\n<script setup>const html = ""</script>')
    await fs.writeFile(path.join(dir, 'chosen.json'), JSON.stringify({ ...config, ignorePatterns: ['src/CanaryFile.vue'], settings: { vue: { rules: { 'vue/no-v-html': 'off' } } } }))
    for (const args of [['-c', 'chosen.json'], ['--config=chosen.json'], ['--', '--config=chosen.json']]) {
      const result = run('src', ...args)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /1 file\(s\)/)
    }
  })
})

test('config and CLI severity govern native SFC rules', async () => {
  await fixture(async (dir, run) => {
    await fs.writeFile(
      path.join(dir, 'src/CanaryFile.vue'),
      '<script setup>export const exposed = 1</script>\n',
    )
    const rule = 'vue/no-export-in-script-setup'
    for (const [severity, expected] of [['off', undefined], ['warn', 'warning'], ['error', 'error']]) {
      await fs.writeFile(path.join(dir, '.oxlintrc.json'), JSON.stringify({ rules: { [rule]: severity } }))
      const result = run('src', '--format=json')
      const diagnostics = JSON.parse(result.stdout)
      assert.equal(
        nativeExportDiagnostic(diagnostics)?.severity,
        expected,
        `${severity}: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`,
      )
    }

    await fs.writeFile(path.join(dir, '.oxlintrc.json'), JSON.stringify({ rules: { [rule]: 'off' } }))
    let result = run('src', '--format=json', '--', '-W', rule)
    assert.equal(nativeExportDiagnostic(JSON.parse(result.stdout))?.severity, 'warning')
    result = run('src', '--format=json', '--', '-D', rule, '-A', rule)
    assert.ok(!nativeExportDiagnostic(JSON.parse(result.stdout)))
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
      await assert.rejects(runOxlint([path.join(dir, 'src/CanaryFile.vue')], { cwd: dir, oxlintPath: fake }))
    }
  })
})

test('same basenames retain their full identity through a symlinked root', async () => {
  await fixture(async dir => {
    const real = path.join(dir, 'real')
    const alias = path.join(dir, 'alias')
    await fs.mkdir(path.join(real, 'alpha'), { recursive: true })
    await fs.mkdir(path.join(real, 'beta'), { recursive: true })
    await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const map = new Map(['alpha', 'beta'].map(name => [path.join(real, name, 'index.vue.ts'), `/project/${name}/index.vue`]))
    for (const entries of [map, new Map([...map].toReversed())]) {
      for (const filename of ['beta/index.vue.ts', path.join(alias, 'beta/index.vue.ts')]) {
        const result = parseOxlintJson(JSON.stringify({ diagnostics: [{ filename, message: 'onlyInBeta' }] }), alias, entries, dir)
        assert.equal(result[0].filename, '/project/beta/index.vue')
      }
      assert.throws(() => parseOxlintJson('{"diagnostics":[{"filename":"index.vue.ts"}]}', alias, entries, dir), /cannot map/)
    }
  })
})

test('existing diagnostic paths match async realpath keys in the system temp directory', async () => {
  await fixture(async dir => {
    const map = new Map()
    for (const name of ['alpha', 'beta']) {
      const file = path.join(dir, name, 'index.vue.ts')
      await fs.mkdir(path.dirname(file))
      await fs.writeFile(file, 'const unused = 1')
      map.set(await fs.realpath(file), `/project/${name}/index.vue`)
    }
    // On Windows CI, tmpdir uses RUNNER~1 while async realpath expands it.
    for (const filename of ['beta/index.vue.ts', path.join(dir, 'beta/index.vue.ts')]) {
      const result = parseOxlintJson(JSON.stringify({ diagnostics: [{ filename }] }), dir, map, dir)
      assert.equal(result[0].filename, '/project/beta/index.vue')
    }
  })
})

test('a failed pass waits for the other engine process before returning', async () => {
  await fixture(async dir => {
    const fake = path.join(dir, 'fake.mjs')
    const marker = path.join(dir, 'native-finished')
    await fs.writeFile(fake, `
      import fs from 'node:fs'
      if (process.argv.at(-1) === '.') {
        console.log('broken')
      } else {
        setTimeout(() => {
          fs.writeFileSync('native-finished', '')
          console.log(JSON.stringify({ diagnostics: [] }))
        }, 500)
      }
    `)
    await assert.rejects(runOxlint([path.join(dir, 'src/CanaryFile.vue')], {
      cwd: dir,
      oxlintPath: fake,
    }), /invalid JSON/)
    await fs.access(marker)
  })
})

test('explicit relative config is also honored by the fix pass', async () => {
  await fixture(async (dir, run) => {
    await fs.writeFile(path.join(dir, 'src/CountFile.vue'), '<template>{{ count }}</template>\n<script setup>\nlet count = 1\n</script>\n')
    await fs.writeFile(path.join(dir, 'fix.json'), JSON.stringify({ rules: { 'prefer-const': 'error' } }))
    const result = run('src', '--fix', '--', '-c', 'fix.json')
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(await fs.readFile(path.join(dir, 'src/CountFile.vue'), 'utf8'), /const count = 1/)
  })
})

test('a zero-file engine result is not confused with a clean lint run', () => {
  assert.throws(() => parseOxlintJson('{"diagnostics":[],"number_of_files":0}', '/tmp', new Map([['/tmp/A.ts', '/project/A.vue']]), '/project'), /zero files/)
})

test('batched same-basename SFCs report the actual source file and line', async () => {
  await fixture(async (dir, run) => {
    await fs.mkdir(path.join(dir, 'alpha'))
    await fs.mkdir(path.join(dir, 'beta'))
    const clean = '<template>{{ ok }}</template>\n<script setup>\nconst ok = 1\n</script>\n'
    await fs.writeFile(path.join(dir, 'alpha/shared-file.vue'), clean)
    await fs.writeFile(path.join(dir, 'beta/shared-file.vue'), clean.replace('</script>', 'const onlyInBeta = 2\n</script>'))
    for (const targets of [['alpha', 'beta'], ['beta', 'alpha']]) {
      const result = run(...targets, '--format=json')
      assert.equal(result.status, 1, result.stderr)
      const diags = JSON.parse(result.stdout)
      assert.equal(diags.length, 1)
      assert.equal(await fs.realpath(diags[0].filename), await fs.realpath(path.join(dir, 'beta/shared-file.vue')))
      assert.equal(diags[0].line, 4)
      assert.equal(diags[0].column, 7)
    }
  })
})
