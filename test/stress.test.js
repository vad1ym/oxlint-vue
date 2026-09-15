import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('stress rejects an empty corpus instead of reporting a clean run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-empty-stress-'))
  try {
    const result = spawnSync(process.execPath, ['scripts/stress.mjs', dir], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /contains no Vue files/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
