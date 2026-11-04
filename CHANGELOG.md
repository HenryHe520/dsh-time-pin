# Changelog

All notable changes to `dsh-time-pin` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-11-03

First public release: the time window (pinned as-of + lookback evidence window)
plus deterministic silence narration as model-facing facts for silent background
jobs.

### Added

- **Session-scoped time window.** Every conversation can pin an `as_of` time
  point and a lookback `span`, forming the evidence window
  `[as_of − span, as_of]` at day granularity. Default mode (no pin, no span)
  follows the local clock and filters nothing.
- **`/pin` command** — the single mutation path: `/pin` (status), `/pin <as-of>`
  (pin the point, keep the current span), `/pin <as-of> <span>` (pin both; a
  span of `不限` pins the point with no lookback bound), `/pin <span>` (keep the
  default clock-following time point with a finite lookback — "recent" mode),
  and `/pin off` (clear). Accepts ISO dates, Chinese date forms, bare years,
  `公元` years, and BC forms (`公元前200年`, `前200年`, `BC 200`); spans in days,
  calendar months, and calendar years. Invalid input is rejected with an
  actionable message.
- **Chat-header control.** A compact chip in the conversation title bar shows
  the current window and mode glyph, and opens a panel with as-of/span inputs,
  span presets, Apply, Clear, inline validation and a one-time future-view
  warning. The panel submits the same `/pin` command a user could type.
- **Model-side injection, once per window change.** In restricted mode the
  agent receives a durable `[TIME PIN]` block with the effective `as_of`, the
  inclusive window bounds, the evidence rules, and the required anchor line.
  Future windows append a `[FUTURE VIEW]` block; changing an existing window
  prepends a current-state summary; leaving restricted mode injects one clear
  notice. Identical windows produce byte-identical text, so no re-injection
  happens while the window is unchanged.
- **Anchor echo.** After entering or changing a restricted window, the first
  reply must open with the window confirmation line (for example
  `时间窗：2000-01-01 · 前10年`). A missing echo is corrected once at the next
  turn start, at most twice per window; anchoring never blocks a turn.
- **`web_search` evidence filtering** in restricted mode. Source dates are
  parsed from ISO dates/timestamps, `YYYY/MM/DD`, `YYYY-MM`, `YYYY`,
  `today`/`yesterday`, and relative ages (`3 days ago`, …). Only dated sources
  inside the inclusive window are kept; undated and out-of-window sources are
  dropped with a note, and a zero-evidence note tells the model to say the
  window has no usable dated evidence.
- **`time_pin_status` tool** — read-only self-inspection of the current window
  for the agent (no parameters).
- **Silent background-job narration.** Deterministic `[TIME FACT]` messages for
  background jobs that produce no output: first after 90 s, refreshed every
  3 minutes, stopping when the job ends. Configurable via `silence.enabled`,
  `silence.firstDelayMs`, `silence.repeatMs`.
- **Plugin settings page.** A **Configure** page in the Plugins UI
  (Plugins → Installed → dsh-time-pin → Configure, also on the bundle detail
  page) edits the global plugin config live: `promptLocale`, `silence.enabled`,
  and the two silence delays (shown in seconds, written in milliseconds).
  Changes apply without a restart and to every conversation in the profile; the
  control itself appears after one DSH restart following install/upgrade
  (Host modules are not hot-reloaded).
- **`promptLocale` config** (`zh` default, `en`) for model-facing blocks and
  `/pin` result text, independent of the browser UI locale.
- **Bilingual UI copy.** The chip's window label, panel text, buttons and errors
  are localized in the active UI locale
  (`Default · Unlimited`, `2000-01-01 · last 10 years`, `Default · last 7 days`
  in English; `默认 · 不限`, `2000-01-01 · 前10年`, `默认 · 近7天` in Chinese).
- **Locale metadata** (`locale/en.json`, `locale/zh.json`) and an original
  `icon.svg` (64×64 clock with a pin at twelve o'clock).

### Changed

- **Display name is now 时间锚定 / Time Anchor** (was 时间窗 / Time Pin), per
  product feedback. The npm package id `dsh-time-pin`, the `timePin` session
  projection key, the `time_pin_status` tool name and the `[TIME PIN]` prompt
  markers are unchanged, so existing sessions, config rows and scripts keep
  working; only the user-visible title, panel title, locale metadata and status
  summary text change.

### Removed

- **Composer-dock silence status bar** (`conversation.composer.dock` occupant `time-pin-silence`): removed per product feedback — the model-facing `[TIME FACT]` narration already covers silent background jobs, so the extra client-only progress line was judged unnecessary.
  It was a Client-only presentation and was never part of the Host contract or the
  session log; no data or behavior depended on it.

### Fixed

Fixes made during implementation before this release:

- Injection dedupe: the "model was told" watermark is now recorded from
  `request/header` (the signature actually sent), superseding the initial
  every-step design that would have defeated runtime-context snapshot dedupe.
- Anchor correction is now limited to a turn start after a real assistant
  reply, so a tool call or an intra-turn step can no longer trigger a bogus
  "you forgot the anchor" reminder.
- BC date arithmetic is proleptic Gregorian with no year 0 (1 BC → AD 1), and
  leap-year, month-clamping and day-number round-trips are unit tested.
- Window bounds are inclusive at both endpoints for both evidence filtering and
  UI labels, so a source dated exactly on the boundary is never dropped.
- Span-only `/pin` lines (`/pin 7天`) now fold to a window with no pinned as-of
  and report the change as "default time point + lookback" instead of failing or
  reporting the wrong shape.
- The chip and panel's window label is now built client-side from the raw
  projection fields, so an English UI shows `Default · Unlimited` /
  `2000-01-01 · last 10 years` instead of the Host's Chinese label (the Host
  label remains the fallback).
- **Missing Configure page (found in live use): the Harness settings service only
  serves forms for config schema subtrees that contain a `.volatile()` field, so
  a config of ordinary fields is excluded from `settings.describe()` and the
  Plugins row showed no configurable page (and no client settings registration
  ever fired). `promptLocale` and `silence` are now `.volatile()`; a
  `loader/volatile-update` listener re-reads the running config, so prompt
  language and silence thresholds change live without remounting the plugin.
  `tests/host-schema.test.mjs` also resolves the `Config` defaults through the
  real schemastery as part of the schema-parsing suite.
- **Crash fix (pre-release, found in live use): the `timePin` projection's Client
  wire-view schema declared `modeBase` as `zod.union(['default', 'recent',
  'pinned'])` — schemastery syntax passed to zod. zod accepts the call but throws
  in its internal `.run` when a value is validated, and the Session projection
  registry validates every published view before it reaches the browser, so
  loading any conversation's projection snapshot failed for every session. Fixed
  to `zod.enum([...])`. Added `tests/host-schema.test.mjs`, which parses the real
  `stateSchema` / `wire.viewSchema` with the real zod for every state the fold can
  produce (default, past, recent, future, BC, anchor pending/confirmed, running
  turn, cleared) — it fails on the pre-fix code with
  `TypeError: Cannot read properties of undefined (reading 'run')` and passes on
  the fix. Session logs and caches were verified intact afterwards (60 logs,
  19,213 zstd frames, 32,764 JSONL records, 0 unparsable).

### Notes

- Verified on DSH `0.2.1-rc.5`; requires Node.js `>= 20`; peer ranges
  `>=0.2.1-rc <2` for `@deepseek-ai/dsh-*` packages.
- This is **evidence isolation, not model amnesia**: the agent may still know
  post-`as_of` events; the plugin constrains evidence use and requires a window
  statement, and does not promise zero leakage.
- Evidence filtering covers `web_search` only in 0.1.0. Memory and workspace-file
  dates are deferred; long foreground tools are not narrated mid-flight
  (background jobs only).
- The note appended to filtered `web_search` results is fixed Chinese text in
  0.1.0 even under `promptLocale: en`; the window block and time facts are
  localized.
- The plugin is zero-telemetry and makes no network requests of its own.
- Settings edited on the Configure page are **global** to the installed profile;
  the time window stays per-conversation state set by `/pin` or the title-bar
  control. A fresh install or upgrade needs one DSH restart before the
  Host-loaded Configure control appears; afterwards settings edits apply live.
- The DSH plugin marketplace has no in-place upgrade for ordinary plugins:
  upgrade by uninstalling and reinstalling. Window state is derived from the
  session log, so reinstalling does not lose it.
- **Uninstall was exercised in the 0.1.0 review session** (`plugin_manager`
  `remove_bundle`, then a fresh `install_bundle`): the profile's `package.json`
  and bundle selection return to exactly their previous state, the Host row and
  its configuration schema disappear immediately, `time_pin_status` leaves the
  live tool set, and the Plugins-page configuration seats unregister. The
  title-bar chip in an **already-open page** can linger until the page is
  refreshed (client module-eviction timing, not stored state); a refresh or
  restart clears it. No session data, plugin storage or custom event type is
  involved, and reinstalling restores everything (verified live, including the
  renamed display title).
- **Published to npm** as `dsh-time-pin@0.1.0` on 2026-11-04 (`latest`), via
  npm's staged publishing (`npm stage publish` + `npm stage approve`; the
  registry also carries the harmless `0.0.0-stage` staged-publish placeholder).
  The published tarball was compared file-by-file against the workspace and is
  identical; the desktop profile was switched from the local `link:` install to
  the registry version. Install with
  `dsh plugin --profile <profile> add dsh-time-pin` and restart DSH once.
