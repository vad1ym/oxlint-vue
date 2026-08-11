# oxlint-vue

[![npm](https://img.shields.io/npm/v/oxlint-vue?color=1a7f5a)](https://www.npmjs.com/package/oxlint-vue)
[![CI](https://github.com/vad1ym/oxlint-vue/actions/workflows/ci.yml/badge.svg)](https://github.com/vad1ym/oxlint-vue/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/oxlint-vue?color=1a7f5a)](./LICENSE)

**[oxlint](https://oxc.rs) and [oxfmt](https://oxc.rs), with `.vue` support.**

Same tools, same flags, same config — they just stop being blind to
`<template>`.

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

Plus 18 template rules oxlint has no equivalent for — `require-v-for-key`,
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

```bash
oxlint-vue --lsp
```

A proxy over `oxlint --lsp`: everything non-`.vue` passes through untouched.
[Setup for Zed, Neovim →](./docs/editor.md)

## How it works

A `.vue` becomes a virtual `.ts` of **identical byte length** — `<script>`
stays where it was, everything else becomes spaces, and template expressions
keep their original offsets. So an offset in the virtual file is an offset in
the `.vue`: no source maps, no diagnostic translation.

Scope is not modelled by hand. `v-for="item in items"` is emitted as
`items.map(item => {…})`, and oxlint's own analyser resolves the binding.

Verified on 4726 real `.vue` files: the invariant holds on every one, and
every virtual file parses. [Details →](./docs/internals.md)

## License

[MIT](./LICENSE)
