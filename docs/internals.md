# Internals

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
