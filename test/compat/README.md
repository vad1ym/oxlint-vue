# Reference corpus

See [the compatibility guide](../../docs/compatibility.md) for the measured
scope, known gaps, regeneration and baseline review process.

- `upstream.json`: 2622 cases from 109 upstream RuleTester suites, including
  their options, parser configuration and expected finding counts.
- `LICENSE.upstream`: upstream MIT license for the imported cases.
- `baseline.json`: exact unresolved differences; changes require review.
- `generated.js`: original layout/scope/Unicode variations with no allowances.
- `props.js`: additional scope regressions and documented upstream false positives.
- `real.js`: integrity-checked, unmodified Nuxt fixtures, measured per rule.
- `runner.js`: pinned reference engine plus the actual structural checker.

Neither failed nor resolved differences can silently disappear in CI. No
percentage in this corpus measures all eslint-plugin-vue rules or autofixes.
