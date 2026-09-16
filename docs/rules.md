# Template rules

The 25 rules `oxlint-vue` adds on top of oxlint. They walk the
`compiler-sfc` template AST, which the padding transform discards, and are
configured under `settings.vue.rules` -- a key oxlint ignores.

The built-in `lintConfig` from `oxlint-vue/antfu` enables the adapted Antfu
selection of these rules. Their names and oxlint's native `vue/*` rules never
overlap.

| Rule | Default |
|---|---|
| `vue/valid-v-html` | error |
| `vue/valid-v-text` | error |
| `vue/valid-v-show` | error |
| `vue/valid-v-once` | error |
| `vue/valid-v-cloak` | error |
| `vue/require-v-for-key` | error |
| `vue/valid-v-for` | error |
| `vue/valid-v-model` | error |
| `vue/no-v-for-template-key-on-child` | error |
| `vue/no-use-v-if-with-v-for` | error |
| `vue/no-template-key` | error |
| `vue/no-duplicate-attributes` | error |
| `vue/require-component-is` | error |
| `vue/no-v-text-v-html-on-component` | error |
| `vue/no-target-blank` | error |
| `vue/this-in-template` | error |
| `vue/no-dupe-v-else-if` | error |
| `vue/no-mutating-props` | error |
| `vue/no-textarea-mustache` | error |
| `vue/no-child-content` | error |
| `vue/no-v-html` | warn |
| `vue/no-useless-mustaches` | warn |
| `vue/no-useless-v-bind` | warn |
| `vue/require-v-for-with-index-key` | warn |
| `vue/no-static-inline-styles` | warn |

oxlint validates its own `rules` map strictly and does not know these names,
so they live under `settings`, which it ignores:

```js
import { lintConfig } from 'oxlint-vue/antfu'

export default {
  ...lintConfig,
  settings: {
    ...lintConfig.settings,
    vue: {
      ...lintConfig.settings.vue,
      rules: {
        ...lintConfig.settings.vue.rules,
        'vue/no-v-html': 'off',
      },
    },
  },
}
```

Without the preset, configure the same nesting directly:

```jsonc
{
  "settings": {
    "vue": {
      "rules": { "vue/no-v-html": "off" }
    }
  }
}
```

Same severities as oxlint: `"off"`/`"warn"`/`"error"`, `0`/`1`/`2`,
`["warn", …]`. `ignorePatterns` and the `extends` chain are honoured.

## Coverage against antfu

The built-in config is ported from `@antfu/eslint-config@9.5.1` with Vue and
TypeScript enabled. Compatible rules retain Antfu's severity and options.

| Antfu group | Ported here |
|---|---:|
| core JavaScript | **99** oxlint rules |
| TypeScript | **28** file-scoped oxlint rules; core rules stay TS-aware |
| Node, JSDoc, imports, Unicorn | **35** oxlint rules |
| RegExp | **60** plugin rules plus 7 core overrides |
| tests | **7** file-scoped oxlint rules |
| Vue | **36** native plus **25** template rules |
| stylistic, perfectionist | applied by oxfmt |
| JSON/JSONC/JSON5, YAML, TOML, Markdown, HTML, CSS | formatted by oxfmt |

**Not ported.** `eslint-plugin-vue` itself — the name `vue` is reserved for
oxlint's native plugin, so `jsPlugins` rejects it; hence 25 hand-written
structural rules instead of 253 loaded ones. Also 6 core rules
(`dot-notation`, `no-dupe-args`, `no-octal`, `no-octal-escape`,
`no-restricted-syntax`, `no-undef-init`), ESLint-only plugin rules, type-aware
rules, ~12 Vue 2 deprecations, most of
`vue/valid-*`, API-style rules (`v-bind-style`, casing), type-aware template
rules, and cross-block checks.

**What ESLint cannot do here.** `eslint-plugin-vue` hand-ported ~10 core rules
for `<template>`; everything else never reaches template expressions:

```vue
<em>{{ /[0-9]+/.test(v) }}</em>   <!-- regexp/prefer-d      — oxlint-vue only -->
<p>{{ arr.sort() }}</p>           <!-- unicorn/no-array-sort — oxlint-vue only -->
<p>{{ obj?.a! }}</p>              <!-- ts/no-non-null-…      — oxlint-vue only -->
```

Nothing is ported here: after padding the expression is ordinary JS, so all 849
oxlint rules plus plugins apply. Run `pnpm compare <project>` to reproduce.

## Semantic checks

`vue/no-mutating-props` resolves top-level `defineProps` declarations, including
runtime props, inline/local types, `withDefaults` and destructured aliases. In
script and template expressions it checks assignments, updates, deletion and
common array mutations, plus template `v-model` and `.sync` writes. Options API
props, setup parameters, destructuring, optional calls, `Object.assign` and
component-instance aliases are also checked. Loop, slot and callback locals do not inherit prop
identity. Imported type members and arbitrary aliases are not type-resolved.

`vue/no-dupe-v-else-if` compares expression ASTs. Whitespace and comments outside
literals do not matter; string, template-literal and regexp contents do. Template
comments may separate branches without breaking the conditional chain.


`vue/valid-v-model` validates assignment targets, optional receivers, supported
native elements, native arguments/modifiers, file inputs, and writes directly to
loop/slot aliases. Component arguments and custom modifiers remain valid, as do
writes to properties of loop items.

Keys on Vue 3 `<template v-for>` belong to the template fragment. Conditional
`<template>` branches may also have keys. `vue/require-v-for-with-index-key` warns
about the third iteration alias, or the second alias when the source is a known
array, range or string. A direct `const items = [...]` initializer is recognized;
unknown sources and object property names are not presumed to be array indices.


## Behavioral compatibility

Rule-name coverage above does not establish equivalent behavior. The
[differential compatibility suite](compatibility.md) measures start positions,
severities and individual findings against pinned eslint-plugin-vue tests.

Implemented options include `allowUsingIterationVar` (`no-use-v-if-with-v-for`),
`allowEmptyAlias` (`valid-v-for`), `allowCoexistClass`/`allowCoexistStyle`
(`no-duplicate-attributes`), `ignorePattern` (`no-v-html`),
`ignoreIncludesComment`/`ignoreStringEscape` (the two literal rules),
`allow`/`ignoreElementNamespaces` (`no-v-text-v-html-on-component`), `allowBinding`
(`no-static-inline-styles`), `additionalDirectives` (`no-child-content`),
`shallowOnly` (`no-mutating-props`) and `always`/`never`
(`this-in-template`). These options go after the severity in a rule array.

`require-v-for-key` checks native elements and fragment children; `valid-v-for`
checks custom-component keys and that keys reference iteration variables.
`no-v-for-template-key-on-child` checks misplaced iteration keys, allowing
independent keys and separately controlled child branches. Duplicate condition
checks also recognize branches covered by earlier AND/OR combinations.
