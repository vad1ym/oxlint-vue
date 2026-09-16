import assert from 'node:assert/strict'
import test from 'node:test'

import { fmtConfig, lintConfig } from 'oxlint-vue/antfu'

test('antfu export provides configs for oxlint and oxfmt', () => {
  assert.ok(Object.keys(lintConfig.rules).length > 220)
  assert.equal(lintConfig.rules['accessor-pairs'][0], 'error')
  assert.equal(lintConfig.rules['unicorn/prefer-node-protocol'], 'error')
  assert.equal(lintConfig.rules['jsdoc/check-access'], 'warn')
  assert.equal(lintConfig.rules['regexp/prefer-d'], 'error')
  assert.equal(lintConfig.rules['vue/no-watch-after-await'], 'error')
  assert.ok(Object.keys(lintConfig.settings.vue.rules).length >= 28)
  assert.equal(lintConfig.settings.vue.rules['vue/no-v-model-argument'], 'off')
  assert.equal(lintConfig.settings.vue.rules['vue/no-custom-modifiers-on-v-model'], 'off')
  assert.equal(lintConfig.settings.vue.rules['vue/no-v-for-template-key'], 'off')
  assert.deepEqual(lintConfig.jsPlugins, ['eslint-plugin-regexp'])
  assert.ok(lintConfig.ignorePatterns.includes('**/node_modules/**'))

  const typescript = lintConfig.overrides.find(override => override.files.includes('**/*.ts'))
  const tests = lintConfig.overrides.find(override => override.files.some(file => file.includes('spec')))
  assert.ok(Object.keys(typescript.rules).length > 25)
  assert.equal(typescript.rules['typescript/consistent-type-imports'][0], 'error')
  assert.equal(tests.rules['vitest/no-identical-title'], 'error')
  assert.ok(!('no-unused-vars' in typescript.rules))

  const ruleNames = [
    ...Object.keys(lintConfig.rules),
    ...lintConfig.overrides.flatMap(override => Object.keys(override.rules)),
  ]
  assert.ok(!ruleNames.some(name => /^(?:antfu|e18e|perfectionist|style|test|ts|unused-imports)\//.test(name)))

  assert.equal(fmtConfig.singleQuote, true)
  assert.equal(fmtConfig.semi, false)
  assert.equal(fmtConfig.sortPackageJson, true)
  assert.equal(fmtConfig.embeddedLanguageFormatting, 'auto')
  assert.equal(fmtConfig.proseWrap, 'preserve')
  assert.ok(fmtConfig.ignorePatterns.includes('**/node_modules/**'))
})
