# sitegen-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Allenhua/sitegen-fast-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Allenhua/sitegen-fast-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: builds the same static sites, byte for byte, in about half the CPU time of the reference.

`run(input)` in `solve.js` returns exactly the output tree makefun-site 1.0.0 returns for one generated site (`{ site, templates, files }`): every page's `index.html`, the index and tag pages, `build-report.txt` and each static file. `main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## How it is faster

Same answers, less work per case (nothing is kept from one case to the next):

- **Markdown**: blocks render straight to a string array (no token objects), block dispatch runs on first characters instead of a regex per line, and inline rendering accumulates literal runs and escapes them in bulk instead of escaping one character at a time. Code-span / strong / emphasis closers are found with native `indexOf` plus a backslash-parity check, which is exactly the reference's escape-skipping scan.
- **Slugs**: ASCII fast path (no `normalize`/regex) plus a per-case cache — the same titles and tag names are slugified several times per build.
- **Templates**: rendering pushes into one array (joined once), loop frames are allocated once per loop execution and mutated per iteration, every page render shares one root scope, and includes whose output depends only on the case (or on one bound value, such as a post's card) are rendered once and cached.
- **Front matter / text**: the `\r` normalisation and the HTML escape both take a fast path when there is nothing to do; a post's card (and its word count) is built once, not once per listing.

## Run it

```sh
node main.ts
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`. Requires Node 22.18 or later; no dependencies, no I/O, no network, no randomness.

## Check it

Against the kit's practice set (3 cases, `practice/input/cases.json` vs `practice/reference/expected.json`) this entry passes every case, and on this machine its `run()` takes about 0.75 s of CPU for the three cases against about 1.3 s for the house baseline.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nimble-marten-40-8602&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
