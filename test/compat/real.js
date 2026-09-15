import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { corpus } from './runner.js'

const root = new URL('../fixtures/nuxt/', import.meta.url)
const manifest = JSON.parse(fs.readFileSync(new URL('provenance.json', root), 'utf8'))
export const realCases = Object.entries(manifest.files).flatMap(([name, provenance]) => {
  const code = fs.readFileSync(new URL(name, root), 'utf8')
  assert.equal(createHash('sha256').update(code).digest('hex'), provenance.sha256, `Modified upstream fixture: ${name}`)
  return [...new Set(corpus.cases.map(c => c.rule))].map(rule => ({
    id: `nuxt/${name}/${rule}`, rule, code, options: [],
    languageOptions: { ecmaVersion: 'latest', parserOptions: { parser: '@typescript-eslint/parser' } },
  }))
})
