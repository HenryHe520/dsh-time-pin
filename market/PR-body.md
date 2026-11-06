Add dsh-time-pin (Time Anchor)

- Repo: https://github.com/HenryHe520/dsh-time-pin
- npm: https://www.npmjs.com/package/dsh-time-pin (`dsh-time-pin@0.1.0`, `latest`)
- Category: `tools` (closest existing neighbour is `ALittleLov/dsh-clock-tools`; maintainers may re-file)

What it does: one conversation can pin an `as_of` date plus a lookback span, giving the evidence window `[as_of − span, as_of]`. In restricted mode the agent is told the window and the evidence rules once per change, `web_search` results are filtered to dated sources inside the window (undated sources are rejected), and the first reply must echo the window. Long silent background jobs get deterministic `[TIME FACT]` facts; a read-only `time_pin_status` tool exposes the current window; default mode injects nothing.

Checks from `contributing.md`:

- [x] `dsh.bundle` declared in `package.json` (`bundle.patch: ./cordis.patch.yml`), client half declared under `dsh.client`
- [x] real, working code — Host + Client halves, 121 tests (109 pass, 12 skipped in a bare checkout; the 12 need a real Harness dependency set and pass there)
- [x] repo public, created 2026-11-04 (more than 1 day old), `dsh-plugin` topic added
- [x] published to npm with `repository` pointing at this repo (`0.1.1` carries the field; `0.1.0` is the current `latest`)
- [x] `description.en` is factual and checked against the code; no marketing claims
- [x] screenshot declaration lives in this repo (`screenshots.json`, 4 images)
- [x] single-file submission: `data/plugins/HenryHe520__dsh-time-pin.yml` only; generated READMEs untouched
- [x] no duplicates: the index has no entry for this repo; the only neighbouring entries are generic time/evidence tooling

Honest disclaimer kept in the README: this is evidence isolation, not model amnesia — the model may still know events after `as_of`; the plugin constrains what may be used as evidence and requires the model to state its window.
