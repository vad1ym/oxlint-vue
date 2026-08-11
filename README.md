# oxlint-vue

[![npm](https://img.shields.io/npm/v/oxlint-vue?color=1a7f5a)](https://www.npmjs.com/package/oxlint-vue)
[![CI](https://github.com/vad1ym/oxlint-vue/actions/workflows/ci.yml/badge.svg)](https://github.com/vad1ym/oxlint-vue/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/oxlint-vue?color=1a7f5a)](./LICENSE)
[![node](https://img.shields.io/node/v/oxlint-vue?color=1a7f5a)](https://nodejs.org)

Lint and format `.vue` files with **oxlint** and **oxfmt** — the Rust
toolchain, at its speed.

> ### 👉 Looking for the antfu config?
>
> **[antfu-oxlint-vue](https://github.com/vad1ym/antfu-oxlint-vue)** is the
> [`@antfu/eslint-config`](https://github.com/antfu/eslint-config) style ported
> to oxlint and oxfmt — same rules, same formatting, no ESLint.
>
> ```bash
> npm i -D oxlint-vue antfu-oxlint-vue
> ```
>
> This package is the engine; that one is the style. They work together, and
> either works alone.

oxlint does not understand `<template>`: it reads `<script>` and disables
`no-unused-vars` there to avoid false positives. oxlint-vue closes that gap, so
the rules you already run on `.ts` apply to template expressions too.

**155 SFCs in ~0.33s.**

```
src/pages/OrderPage.vue
  3:7     error  <li> with 'v-for' must have a ':key'.   vue/require-v-for-key
  6:8     error  <script setup>` cannot contain ES module exports.  vue(no-export-in-script-setup)
  9:7     error  Variable 'dead' is declared but never used.  eslint(no-unused-vars)
```

## Install

```bash
npm install -D oxlint-vue
npx oxlint-vue init
npx oxlint-vue src --fix --format-code
```

`oxlint` and `oxfmt` come with it — one install is enough to lint and format.

For the antfu rule set, add the preset package:

```bash
npm install -D antfu-oxlint-vue eslint-plugin-regexp
npx oxlint-vue init          # detects both and wires them up
```

Without it you still get every template rule, on oxlint's default categories.
`init` never installs anything on your behalf; it configures what it finds.

Node 20.19+.

## Commands

```bash
oxlint-vue src                      # lint
oxlint-vue src --fix --format-code  # fix and format
oxlint-vue src --check-format       # CI gate, changes nothing
oxlint-vue src --watch              # re-lint on change
oxlint-vue --lsp                    # language server
oxlint-vue src -- -D correctness    # args after -- go to oxlint
```

| Flag | |
|---|---|
| `-f, --format` | `pretty` (default), `json`, `github`, `compact` |
| `--fix` | oxlint's auto-fixes, `<script>` only |
| `--format-code` | oxfmt: template, script and style |
| `--check-format` | non-zero exit if anything is unformatted |
| `-w, --watch` | re-lint on change, debounced |
| `--lsp` | language server over stdio |
| `--quiet` | errors only |
| `--max-warnings=<n>` | non-zero exit above n warnings |

Exit codes: `0` clean, `1` problems found, `2` tool error.

## How it works

A `.vue` file becomes a virtual `.ts` of **identical byte length**: `<script>`
stays byte for byte where it was, everything else becomes spaces (newlines
preserved), and template expressions stay at their original offsets wrapped in
valid syntax.

So **an offset in the virtual file is an offset in the `.vue`** — no source
maps, no diagnostic translation, no range arithmetic.

Scope is not modelled by hand. Directives are emitted as code that already
creates the binding, and oxlint's own analyser resolves it:

```js
// v-for="item in items"  ->  items.map(item => { … })
// v-slot="{ row }"       ->  (({ row }) => { … })
```

Three sources feed one report: the virtual file through oxlint (template
expressions and `<script>`), the real `.vue` through `oxlint --vue-plugin`
(SFC-aware rules), and a template AST walk (18 structural rules).

Because padding erases markup, references are re-emitted explicitly —
`<Icon />` as a component, `v-maska` as a directive, `ref="el"` as a binding.
On one real project this took `no-unused-vars` from **397 false positives down
to 10 real ones**.

## Rule coverage

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

## Structural rules

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

## Formatting

`--format-code` runs oxfmt, which handles `.vue` whole — template, script and
style. Padding is not involved: oxfmt reads the real file, so positions and
structure are its problem, not ours.

The style itself comes from [`antfu-oxlint-vue`](https://github.com/vad1ym/antfu-oxlint-vue),
which maps antfu's `style/*` and `perfectionist` rules onto oxfmt options. Without
that package oxfmt uses its own defaults — double quotes and semicolons.

oxfmt 0.63.0 has a bug: it applies `semi: false` to multi-statement inline
handlers, which Vue parses as a single expression, so the result no longer
parses. Those files are repaired rather than skipped, and every `.vue` is
re-parsed after formatting — if it parsed before and does not after, the
original is restored and reported. Across five real projects: **515 files
formatted, 0 broken.**

## Editor

```bash
oxlint-vue --lsp
```

Nothing extra to install — the server is the same package. It is a **superset,
not a replacement**: a real `oxlint --lsp` runs inside it, `.ts`/`.js` and
every protocol method pass through untouched, and `.vue` goes down as the
virtual file.

**Zed** — install the **Oxc** extension, then point it at the proxy:

```json
{
  "lsp": {
    "oxlint": {
      "binary": { "path": "npx", "arguments": ["oxlint-vue", "--lsp"] }
    }
  }
}
```

The Oxc extension is already bound to `Vue.js`, so no custom extension is
needed. Volar keeps working alongside it — types and navigation from Volar,
lint from here; the diagnostic codes do not overlap.

**Neovim:**

```lua
vim.lsp.config.oxlint-vue = {
  cmd = { 'npx', 'oxlint-vue', '--lsp' },
  filetypes = { 'vue', 'typescript', 'javascript' },
  root_markers = { '.oxlintrc.json', 'package.json' },
}
vim.lsp.enable('oxlint-vue')
```

**VS Code** — needs a thin `vscode-languageclient` wrapper; no extension yet.

## CI

```yaml
- run: npx oxlint-vue src --format=github --check-format --max-warnings=0
```

`--format=github` annotates the diff directly; `--check-format` fails the build
on unformatted files without touching them.

```json
{
  "lint-staged": { "*.vue": "oxlint-vue --fix --format-code" }
}
```

## Limitations

- No parity with `eslint-plugin-vue` — 18 structural rules, not hundreds. New
  ones go in `src/structural.ts`: an AST walk, ~20 lines each.
- `--fix` only touches `<script>`; markup is handled by `--format-code`.
- `no-undef` is not in the preset — a component tag may come from a Nuxt or
  unplugin auto-import that the file cannot see. It works inside template
  expressions: `oxlint-vue src -- -D no-undef`.
- No VS Code extension.

## Verified

- **4726 real `.vue` files**: the length and line-position invariant holds on
  100%, every virtual file parses.
- **132 tests**, including a full stdio LSP session and regressions found on
  that corpus — multi-line attributes, object literals in `:class`,
  `v-for="n in 5"`, destructuring, multi-statement handlers, CRLF, emoji.
- Five real projects (571 SFCs): 6–30 findings each, no noise.

```bash
pnpm test          # tests (needs a build first)
pnpm stress:self   # invariant against committed fixtures
pnpm smoke         # pack the tarball and install it
pnpm verify        # everything, from a clean build
```

The invariant is asserted automatically because it fails silently: if length or
line positions drift, every diagnostic quietly points somewhere else.

## Development

Written in TypeScript, compiled with `tsc` to `dist/`. Tests and scripts run
against the build, so `pnpm build` comes first.

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm stress ~/projects   # run the invariant over your own .vue corpus
pnpm verify              # build, typecheck, test, invariant, packaged tarball
```

Release: `pnpm release`, then `git push --follow-tags`. A `v*` tag publishes
with npm provenance.

## API

```js
import { preprocess, runOxlint } from 'oxlint-vue'

const { code } = preprocess(source, 'Comp.vue') // virtual .ts, same length
const diagnostics = await runOxlint(['src/Comp.vue'], { cwd })
```

## License

[MIT](./LICENSE)
