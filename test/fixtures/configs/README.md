# Test fixtures, not the published presets

These are copies of the configs from
[`antfu-oxlint-vue`](https://github.com/vad1ym/antfu-oxlint-vue), kept here so
the suite can exercise a realistic config without depending on a separate
package being published and installed.

They are fixtures: the suite asserts that oxlint-vue *reads* a config of this
shape, not that these particular rules are correct. That is the other
repository's job, and its own tests cover it.

Refresh them when the preset changes shape (new keys, a moved `settings`
block); drift in individual rule severities does not matter here.
