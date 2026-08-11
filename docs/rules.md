# Template rules

The 18 rules `oxlint-vue` adds on top of oxlint. They walk the
`compiler-sfc` template AST, which the padding transform discards, and are
configured under `settings.vue.rules` -- a key oxlint ignores.

These walk the `compiler-sfc` template AST, which padding discards.

| Rule | Default |
|---|---|
| `vue/require-v-for-key` | error |
| `vue/valid-v-for` | error |
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
| `vue/no-static-inline-styles` | off |

oxlint validates its own `rules` map strictly and does not know these names,
so they live under `settings`, which it ignores:

```jsonc
{
  "extends": ["./node_modules/antfu-oxlint-vue/configs/antfu.oxlintrc.json"],
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

Measured against `@antfu/eslint-config@9.3.0` with `{ vue: true, typescript: true }`
— 578 active rules.

| antfu group | Rules | Here |
|---|---|---|
| core ESLint | 105 | **99** |
| `ts`, `unicorn`, `import` | 47 | **47** |
| `regexp` | 60 | **54** via oxlint `jsPlugins` |
| `style`, `perfectionist` | 69 | applied by `--format-code`, not checked |
| `vue/*` | 150 | **46** native + **18** own structural |
| `jsonc`, `yaml`, `toml`, `markdown` | 90 | out of scope |

**Not ported.** `eslint-plugin-vue` itself — the name `vue` is reserved for
oxlint's native plugin, so `jsPlugins` rejects it; hence 18 hand-written
structural rules instead of 252 loaded ones. Also 6 core rules
(`dot-notation`, `no-dupe-args`, `no-octal`, `no-octal-escape`,
`no-restricted-syntax`, `no-undef-init`), ~12 Vue 2 deprecations, most of
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
