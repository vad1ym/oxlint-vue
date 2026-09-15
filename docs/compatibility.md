# Vue rule compatibility

The compatibility target is **eslint-plugin-vue 10.11.0**, run by **ESLint
10.10.0** and **vue-eslint-parser 10.4.1**. These are pinned development
references, not runtime dependencies. TypeScript 7 still builds the package;
the TypeScript 6 API alias is used only by the reference TypeScript parser.

See the [full rule inventory](rules-matrix.md) for all 253 rules and priorities.

## Current measurement

| Corpus | Result |
|---|---|
| 1203 upstream cases, 61 common structural rules | **1202 exact matches (99.9%)** |
| Original generated cases: layout, CRLF, Unicode, entities, loop/slot scopes | **880/880** |
| Four pinned Nuxt components, each checked against all 61 rules | **244/244 comparisons** |
| Real oxlint pipeline including upstream props and scope regressions | **1242/1242 comparisons** |

The upstream result started at 295/568 before these fixes. The denominator
includes upstream options, valid cases, invalid cases, script-only cases and
known failures. One parser-crashing case is explicitly excluded below. Sixty
of the sixty-one suites currently match on every imported case.

**An exact match here means rule identity, finding count, severity and start
line/column.** It does not mean matching message wording, end ranges, suggestions
or autofixes. Equal finding counts with different locations are classified as
`location`; that category can also represent different findings cancelling out
in the count. The reference case's original expected count is checked before
comparison, so a broken parser/configuration cannot pass as an empty result.

One `no-deprecated-v-bind-sync` reference case is explicitly unmeasured because
`@vue/compiler-sfc` 3.5.41 crashes internally on argumentless
`v-bind.sync='value'`. The committed corpus records this parser limitation by
the upstream case ID; regeneration cannot silently add or remove the exception.

This is **not 99.8% compatibility with the entire plugin**. The pinned plugin
exports 253 rule names; 192 are not measured by this structural-rule harness,
including native oxlint rule implementations. Existing rule-count coverage
against a preset is a separate metric. More cases and rule families must be
added before making a broader claim.

## Remaining upstream differences

The single remaining upstream case is recorded with both diagnostic lists in
[`test/compat/baseline.json`](../test/compat/baseline.json):

- **One `no-dupe-v-else-if` case:** our semantic comparison recognizes
  `a === 1` and `a === (1)` as equivalent; the reference's token comparison does
  not report this case. This stronger check is intentionally retained and
  explicitly counted as a mismatch.

Beyond these imported cases, conditional `<template>` keys are intentionally
allowed by our `no-template-key` implementation for Vue 3. The reference rule
can reject them. No claim of exhaustive behavior compatibility is made for a
rule whose current corpus happens to be green.

`vue/no-target-blank` and `vue/require-v-for-with-index-key` are project-specific
names. They are listed separately instead of being silently equated to an
upstream rule. `no-target-blank` is not a measured alias for the upstream
`no-template-target-blank` rule.

## Prop mutation scope regressions

All **48 upstream `no-mutating-props` cases match**. Script and template checks
share the same mutation logic. Script roots are resolved by lexical binding,
including setup parameters, destructuring, optional calls, `Object.assign`,
component `this` and constant aliases of `this`. Script-only SFCs are checked
in the CLI and LSP, including clearing stale diagnostics after an edit.

An additional **70 original scope cases** run with LF and CRLF. Of these,
64 match the reference exactly. Six deliberately avoid three upstream false
positives (each represented with both line endings):

- `Object.assign` when `Object` is a local parameter.
- `this.prop` in an ordinary nested function with its own `this`.
- A template reference to a script-setup binding shadowing an Options API prop.

These differences have explicit reasons and expected diagnostics in
`test/compat/props.js`, are checked in both directions, and appear in the CI
report. They are not counted as exact matches or hidden in the upstream rate.
All 70 cases and all 48 upstream prop cases also run through the real pipeline.
Arbitrary aliases of props/individual prop values and imported type members
remain outside this syntax-based analyzer; this is not a type-checking engine.

## Running and reviewing

```sh
pnpm build
pnpm compat --json
pnpm test
pnpm stress:self
```

`compat-report.json` includes per-rule counts, exact known differences and the
unmeasured rule inventory. CI uploads it as an artifact and rejects any change
to the reviewed baseline, including a resolved entry that should be removed.
The regular tests also exercise off/warning/error severity for every upstream
case, source offsets through the real pipeline, and reference positive and
negative controls. Inputs with identical basenames in separate Unicode paths
must retain distinct diagnoses. Stress tests reject empty corpora, missing or
invalid engine output, unexpected exits and incomplete file counts.

Do not refresh the baseline just to make CI green. Inspect each changed case,
fix regressions, and only then explicitly update it:

```sh
pnpm compat --json --write-baseline
```

The JSON upstream corpus is vendored: ordinary tests require no GitHub access.
To regenerate it, review a checkout of `vuejs/eslint-plugin-vue` at `v10.11.0`
and run `node scripts/import-vue-compat.mjs /path/to/checkout` on Node 22.13+.
The importer records source-file SHA-256 hashes, preserves options and original
expected counts, and fails on unreviewed imports. Commit the corpus and
baseline diff together when upgrading the reference. Upstream fixture licensing
is preserved in `test/compat/LICENSE.upstream`.

The Nuxt samples are unmodified files from `nuxt/nuxt` at
`412786a1d8283aaa2360a855d44ebd3ac21924f1` (`v4.1.2`), with their original license
and paths/hashes in `test/fixtures/nuxt/provenance.json`. They are regression
samples from Nuxt's own fixture project, not an audit of every Nuxt feature.

## Next compatibility work

1. Expand native-rule and configuration compatibility coverage.
2. Extend the corpus with additional application patterns and rule options.
3. Measure autofixes, suppressions, options/preset interactions and LSP parity.
4. Expand the corpus before adding new rule families, starting with essential
   `valid-*` rules.
