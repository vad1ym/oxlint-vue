# Test fixtures, not the published presets

These are snapshots of the built-in configs exported from `oxlint-vue/antfu`,
kept here so the suite can exercise realistic JSON configs.

They are fixtures: the suite asserts that oxlint-vue *reads* a config of this
shape. `test/antfu.test.js` validates the published preset itself.

Refresh them when the preset changes shape (new keys, a moved `settings`
block); drift in individual rule severities does not matter here.
