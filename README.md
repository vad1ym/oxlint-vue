# oxlint-vue

[![npm](https://img.shields.io/npm/v/oxlint-vue?color=1a7f5a)](https://www.npmjs.com/package/oxlint-vue)
[![CI](https://github.com/vad1ym/oxlint-vue/actions/workflows/ci.yml/badge.svg)](https://github.com/vad1ym/oxlint-vue/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/oxlint-vue?color=1a7f5a)](./LICENSE)

`oxlint-vue` adds Vue Single-File Component support to
[oxlint](https://oxc.rs) and [oxfmt](https://oxc.rs). It checks normal
JavaScript and TypeScript through oxlint, and also lints `<template>`
expressions and Vue-specific structure in `.vue` files.

The goal is **1:1 behavioral compatibility with every rule exported by
[`eslint-plugin-vue`](https://eslint.vuejs.org/)**: the same rule names,
configuration, diagnostics, fixes and suggestions.

## Quick start

`oxlint-vue` is a drop-in replacement for `oxlint` in Vue projects. Install it
alongside oxlint and replace the command in your package script:

```sh
pnpm add -D oxlint oxlint-vue
```

```json
{
  "scripts": {
    "lint": "oxlint-vue ."
  }
}
```

Your existing oxlint config continues to apply. JavaScript and TypeScript are
passed through to oxlint, while `.vue` files gain SFC and template checks.

### Antfu config

The built-in presets are a static port of `@antfu/eslint-config` 9.5.1, so no
separate preset package is required. `lintConfig` enables every compatible
JavaScript, TypeScript, import, Node, JSDoc, Unicorn, RegExp, test and Vue rule.
`fmtConfig` carries the stylistic and import-sorting choices across JavaScript,
TypeScript, Vue, JSON/JSONC/JSON5, YAML, TOML, Markdown, HTML and CSS:

```js
// oxlint.config.mjs
import { lintConfig } from 'oxlint-vue/antfu'

export default lintConfig
```

```js
// oxfmt.config.mjs
import { fmtConfig } from 'oxlint-vue/antfu'

export default fmtConfig
```

Run `pnpm oxlint-vue init` to create both files automatically. Spread either
object when you need to override its rules or formatting options.

Oxlint only parses JavaScript and TypeScript, so Antfu's JSONC, YAML, TOML and
Markdown lint rules have no direct equivalent. Those formats are still covered
by oxfmt; unsupported ESLint-only and type-aware rules are omitted.

## Current progress

Target: `eslint-plugin-vue` **10.11.0**, containing 253 rules.

| Status | Rules |
|---|---:|
| Implemented locally | **69** |
| Provided natively by oxlint | **59** |
| Partially compatible | **55** |
| Missing | **70** |

The imported upstream regression corpus currently has **2724 exact matches out
of 2725 cases** across 112 rule suites. Exact means matching rule, diagnostic
count, severity and start location. Fixes, suggestions and unimported edge cases
are tracked separately.

- [Detailed compatibility report](docs/compatibility.md)
- [Complete rule matrix](docs/rules-matrix.md)
- [Usage and configuration](docs/rules.md)

## License

[MIT](./LICENSE)
