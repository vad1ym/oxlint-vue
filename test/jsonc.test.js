import assert from 'node:assert/strict'
import test from 'node:test'
import { parseJsonc } from '../dist/jsonc.js'

test('parses plain JSON', () => {
  assert.deepEqual(parseJsonc('{"a":1}'), { a: 1 })
})

test('strips line and block comments', () => {
  const text = `{
  // a line comment
  "a": 1, /* inline */
  /* multi
     line */
  "b": 2
}`
  assert.deepEqual(parseJsonc(text), { a: 1, b: 2 })
})

test('allows trailing commas', () => {
  assert.deepEqual(parseJsonc('{"a":[1,2,],}'), { a: [1, 2] })
})

test('does not treat glob patterns as comments', () => {
  // Regression: the text between two ignorePatterns entries is `/**", "**/`,
  // which a naive block-comment sweep deletes -- silently merging the two
  // patterns into one and quietly disabling both.
  const text = '{"ignorePatterns":["**/generated/**","**/.nuxt/**"]}'
  assert.deepEqual(parseJsonc(text).ignorePatterns, [
    '**/generated/**',
    '**/.nuxt/**',
  ])
})

test('does not treat a URL inside a string as a comment', () => {
  const text = '{"url":"https://example.com/x","a":1}'
  assert.deepEqual(parseJsonc(text), { url: 'https://example.com/x', a: 1 })
})

test('handles escaped quotes inside strings', () => {
  const text = String.raw`{"a":"he said \"hi\" // not a comment","b":2}`
  const out = parseJsonc(text)
  assert.equal(out.a, 'he said "hi" // not a comment')
  assert.equal(out.b, 2)
})

test('handles a lone slash inside a string', () => {
  assert.deepEqual(parseJsonc('{"a":"a/b"}'), { a: 'a/b' })
})
