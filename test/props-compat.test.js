import assert from 'node:assert/strict'
import test from 'node:test'
import { compareCase } from './compat/runner.js'
import { propCases } from './compat/props.js'

for (const entry of propCases) {
  test(entry.id, () => {
    const result = compareCase(entry)
    if (entry.intentionalDifference) {
      assert.deepEqual(result.actual, [], entry.intentionalDifference)
      assert.equal(result.expected.length, 1, 'Review the exception when upstream fixes its false positive')
    } else assert.deepEqual(result.actual, result.expected)
  })
}
