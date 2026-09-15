# oxlint-vue

[![npm](https://img.shields.io/npm/v/oxlint-vue?color=1a7f5a)](https://www.npmjs.com/package/oxlint-vue)
[![CI](https://github.com/vad1ym/oxlint-vue/actions/workflows/ci.yml/badge.svg)](https://github.com/vad1ym/oxlint-vue/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/oxlint-vue?color=1a7f5a)](./LICENSE)

**[oxlint](https://oxc.rs) and [oxfmt](https://oxc.rs), with `.vue` support.**

A drop-in replacement: it lints and formats your `.ts` and `.js` exactly as
oxlint does, and additionally understands `.vue` — same flags, same config.

```bash
npm install -D oxlint-vue
npx oxlint-vue src              # lint
npx oxlint-vue src --fix --format-code
```

`oxlint` and `oxfmt` come with it. Everything after `--` goes to oxlint
verbatim, so [its documentation](https://oxc.rs/docs/guide/usage/linter.html)
is the reference for rules and config:

```bash
npx oxlint-vue src -- -D correctness -D suspicious
```

Select a lint config with `-c ./config.json`, `--config ./config.json`, or
`--config=./config.json`. Config paths, including those passed after `--`,
resolve relative to your working directory. The selected config also controls
Vue rules and file exclusions.

Exit codes: `0` clean, `1` findings, `2` tool/configuration error. An empty input
fails by default; use `--allow-empty` for an intentionally empty target directory.

Template expressions that cannot be fully checked produce
`oxlint-vue/incomplete-template` warnings. Use `--strict-templates` in CI to make
these errors, or set `settings.vue.strictTemplates: true` in your lint config
for both CLI and editor diagnostics. SFC parsing errors always fail the check.

Run `npx oxlint-vue --help` for the flags. Node 20.19+.

> **Want a rule set to go with it?**
> [antfu-oxlint-vue](https://github.com/vad1ym/antfu-oxlint-vue) is the
> [`@antfu/eslint-config`](https://github.com/antfu/eslint-config) style,
> ported to this toolchain.

## What it adds

Plain oxlint reads `<script>` but not `<template>`, and disables
`no-unused-vars` there to avoid false positives. So a component used only in
the template looks unused, and nothing inside `{{ }}` is checked at all.

Here every rule you already run on `.ts` reaches template expressions too:

```vue
<em>{{ /[0-9]+/.test(v) }}</em>   <!-- regexp/prefer-d -->
<p>{{ arr.sort() }}</p>           <!-- unicorn/no-array-sort -->
<p>{{ a == b }}</p>               <!-- eqeqeq -->
```

Plus 25 template rules oxlint has no equivalent for — `require-v-for-key`,
`no-mutating-props`, `no-dupe-v-else-if` and the rest. They are configured
under `settings.vue.rules`, a key oxlint ignores:

```jsonc
{
  "settings": {
    "vue": { "rules": { "vue/no-v-html": "off" } }
  }
}
```

Severities are oxlint's: `"off"` / `"warn"` / `"error"`, `0` / `1` / `2`.
[Full rule list →](./docs/rules.md)

`--format-code` runs oxfmt, which handles `.vue` whole. It also repairs a bug
in oxfmt 0.63.0 that otherwise leaves multi-statement inline handlers
unparseable, and never writes out a file that stopped parsing.

## Editor

Diagnostics in Zed, Neovim and anything else that speaks LSP.
[Setup →](./docs/editor.md)

## How it works

A `.vue` becomes a virtual `.ts` of **identical byte length** — `<script>`
stays where it was, everything else becomes spaces, and template expressions
keep their original offsets. So an offset in the virtual file is an offset in
the `.vue`: no source maps, no diagnostic translation.

Loop scopes use real JavaScript: `v-for="item in items"` is emitted as
`items.map(item => {…})`, and oxlint's analyser resolves the binding. Vue AST
usage tracking also accounts for template assignments and CSS `v-bind()` in
`no-unused-vars`.

Verified on 4726 real `.vue` files: the invariant holds on every one, and
every virtual file parses. [Details →](./docs/internals.md)

## Compatibility regression tests

`pnpm compat --json` compares 2725 cases from eslint-plugin-vue 10.11.0 against
our 112 common structural rules. CI checks the reviewed differences and also
runs generated scope/layout cases and pinned Nuxt fixtures through real oxlint.
Eleven additional rules have local unit/generated coverage and are marked partial
until their complete upstream suites are imported.
See [the compatibility report and limitations](docs/compatibility.md).

Full rule coverage and implementation priorities: [Vue rule inventory](docs/rules-matrix.md).

## License

[MIT](./LICENSE)
