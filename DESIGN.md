# dsh-time-pin (时间锚定 / Time Anchor) — design

> Status: shipped design for **0.1.0** (2026-11-04), built against DSH `0.2.1-rc.x`.
> Display name: **时间锚定 / Time Anchor** (package id `dsh-time-pin`, internal
> projection key / tool name / `[TIME PIN]` markers unchanged).
> This file records *what was decided and why*. User-facing documentation is in
> [README.md](README.md) / [README.zh.md](README.zh.md); the feasibility evidence
> collected before implementation is in [SPIKE.md](SPIKE.md).

## 1. Summary

`dsh-time-pin` pins a conversation's effective "now" to a user-chosen time point
(`as_of`) and adds a retrieval range split into a side **before** and a side
**after** it. Together they form the evidence window
`[as_of − before, as_of + after]`. In **restricted mode** the agent is told, once
per window change, which window it may reason from and which evidence rules
apply; `web_search` results are filtered to *dated* sources inside that window,
and the first reply must echo the active window. A second capability narrates
long-running silent **background** jobs with deterministic `[TIME FACT]` facts.
The plugin's global settings (prompt language, silence thresholds) are editable
from the Plugins UI; the time window itself stays per-conversation state.

Two sentences keep the product honest:

- It is **evidence isolation, not model amnesia** — the model may still know
  about events after `as_of`; the plugin constrains what may be used as evidence
  and makes the model state its window, but it does not and cannot erase
  training knowledge.
- The default mode does **nothing** to the model context: no pin, no range, no
  injection, no filtering. Installing the plugin is not supposed to change a
  normal conversation.

## 2. Problem

1. Asking a model to answer "from" a historical point in time fails silently:
   it keeps using present-day knowledge unless it is told which evidence window
   is authoritative and required to acknowledge it.
2. Asking for "only the last 7 days" does not restrict evidence either —
   search results from outside the range leak in, and undated results are
   indistinguishable from dated ones.
3. Future-perspective role-play ("answer from the year 3000") needs the model to
   label speculation instead of presenting invented events as facts.
4. A long background task produces nothing; the user cannot tell whether it is
   still working, and no model turn is available to say so.

## 3. Scope and non-goals

In scope: a session-scoped as-of/range window, model-facing injection of the
window and its rules, anchoring of the first restricted-mode reply, filtering of
`web_search` evidence, future view, background-job silence narration, and a
global settings page in the Plugins UI.

Explicitly out of scope for 0.1.0 (see §11 for the deferred items):

- It is **not** an amnesia or censorship mechanism, and it does not block or
  rewrite model output ("leak detection" was considered and deferred).
- Not a time/calendar calculator — `@deepseek-ai/dsh-tool-time` already does
  timezone and arithmetic work; the pin is conversation state, not a tool.
- Not a reminder/scheduler — `@deepseek-ai/dsh-schedule` covers that.
- No staleness scoring or source-credibility scoring; the window replaces a
  score with a hard date rule.
- No proactivity, follow-up questions, or chat — this plugin only shapes the
  evidence frame of a conversation.
- No memory or workspace-file evidence filtering in 0.1.0 (P1, see §11).

## 4. Core concepts

| Term | Definition |
|---|---|
| `as_of` | The conversation's effective time point. Default = local "today" and follows the clock; once pinned it stays fixed. |
| `before` | Retrieval range before the pin. Default = unbounded. Finite forms: N days / months / years. |
| `after` | Retrieval range after the pin. Default = unbounded. Same forms. One supplied side mirrors the other. |
| **window** | `[as_of − before, as_of + after]`, day granularity, endpoints inclusive; an unbounded side admits everything on that side. |
| **default mode** | No pin and no range → no evidence filtering, no injection. |
| **restricted mode** | A pin or a bounded range is set → evidence rules are enforced. |
| evidence date `d(source)` | A source's date used for filtering. In 0.1.x only `web_search` sources expose one (`publishedAt`). |
| **anchor echo** | After entering/changing a restricted window, the model's first reply must start with a confirmation line (`时间窗：2000-01-01 · 前后各10年`, or `Time window: … · ±10 years` under `promptLocale: en`). |
| **time fact** | A deterministic statement about a silent background job, injected so the model can report status without guessing. |
| **global settings** | One plugin `Config` per installed profile (prompt language, silence thresholds), edited from the Configure page in the Plugins UI. Distinct from the per-conversation window. |
| window signature | The as-of key plus both range keys. Identical windows produce identical signatures and byte-identical injections. |

Day granularity is deliberate: the window is a date range, not an instant, so
timezone/DST arithmetic cannot produce "wrong day" answers. A local time zone is
used to resolve "today".

## 5. Behavior

### 5.1 Title-bar control

The control is registered by the Client half into the conversation title bar
(`conversation.session.header.actions`, order `-15`), so it sits with the other
session controls instead of the composer. It renders a compact chip from the
`timePin` projection: the current window label, a mode glyph
(default/recent 🕐, past 🕰, future 🌌), and an unconfirmed-window dot while the
anchor echo is still pending. Opening it shows the as-of input (prefilled), two
range inputs (before / after the as-of) with shared presets
(`不限 / 7天 / 30天 / 1年 / 10年 / 100年`), Apply, Clear and Close, inline
validation errors, and a dismissible one-time warning when the window reaches
past today. Enter applies; Escape and outside-click close the panel. The popover
is portaled to `document.body` and positioned from the chip's bounding rect as a
`position: fixed` layer, because the shell clips overlays inside the header
actions slot.

The window label is built in the active **UI locale** from the projection's raw
clock-free fields (`modeBase`, `asOfInput`, `before`, `after`), e.g.
`默认 · 不限` / `Default · Unlimited` and `2000-01-01 · 前后各10年` /
`2000-01-01 · ±10 years`, falling back to the Host's `chipLabel` when those
raw fields are unavailable. This is deliberately separate from `promptLocale`:
the UI language and the model prompt language are independent.

The panel's Apply/Clear does not mutate state directly: it submits the same
`/pin …` command line a user could type. There is exactly one mutation path, so
validation and state changes cannot diverge between the UI and the command.

### 5.2 `/pin` — the single mutation path

`/pin` is a session command (human-only; the model cannot move the window) and
the only way state changes. Grammar:

```text
/pin                             # show the current window/mode (status query)
/pin <as-of>                     # pin the as-of, keep the current range
/pin <as-of> <range>             # one side; the other mirrors it
/pin <as-of> <前…> <后…>         # asymmetric range, both sides explicit
/pin <range>                     # keep the default clock-following as-of, set the range
/pin off                         # clear the window, return to default mode
```

Argument details:

- as-of forms: `2000-01-01`, `2000-1-1`, `2000/01/01`, `2000年1月1日`,
  `2000年1月1`, `公元2000年`, `2000` (bare year → January 1 of that year),
  `公元前200年`, `前200年`, `BC 200`, `BCE 200`; month/day default to January 1;
  full-width digits and `．`/`－` punctuation are normalized.
- range forms: `7天`, `30 天`, `6个月`, `10年`, `100年`, `7d`, `month(s)`,
  `year(s)`, or `不限`/`unlimited`/`-`/`—` for an unbounded side. A token may
  carry a side prefix (`前`/`近`/`last`/`past` or `后`/`next`/`after`); one
  supplied side mirrors to the other; two supplied sides are positional
  (`before after`) unless the prefixes say otherwise; a slash form
  (`前10年/后5年`) is accepted too. Both range fields empty in the panel, or a
  pair of `不限` in `/pin`, means an unbounded range on both sides.
- accepted years are 1–9999 in either era, including years after today (future
  view). There is no year 0: `公元前0年` is rejected, and 1 BC is followed by
  AD 1.
- invalid input is rejected with an actionable message (bad month/day, bad unit,
  negative or zero range, unparseable text).
- `/pin` and `/pin status` (also `状态`, `?`, `help`) print the current mode and
  window.
- `/pin off` (also `清空`, `默认`, `clear`, `reset`, `off`) restores default
  mode.
- a range-only line (`/pin 7天`) keeps the default, clock-following as-of and
  sets a symmetric range around today, i.e. the "recent" mode
  (`默认 · 前后各7天`); with no pinned date, `/pin 不限` has no window to hold and
  folds back to default mode (same visible result as `/pin off`). To keep a
  pinned as-of with an unbounded range, use `/pin <as-of> 不限`.

The command's *result text* follows the `promptLocale` config (see §8); the
panel/chip copy follows the browser UI locale through the Client locale
namespace. The two are independent by design: a Chinese UI can drive an English
prompt, and vice versa.

### 5.3 Injection model

Injected model-facing text lives in `lib/core/text.js` and is a pure function of
the window (plus, for time facts, the due facts). That makes it byte-stable.

- **Default mode injects nothing at all.** No block, no timestamp, no token cost.
- **One block per window change.** The projection records the window signature
  the model was last told about when a request header is composed. At
  `agent/pre-step`, the window block is appended as a durable, source-attributed
  user message only when the current signature differs from the recorded one.
  Because `injectedSig` becomes that signature with the next `request/header`,
  the next step does not inject again — the block is sent exactly once per
  window change and never per step.
- **Window content** (Chinese prompt shown; `promptLocale: en` has an equivalent
  English block): `[TIME PIN]` header, the effective `as_of`, the evidence
  window bounds (inclusive), the four evidence rules, and the exact anchor-echo
  line the reply must start with. A future window appends a `[FUTURE VIEW]`
  block (model does not know the period; mark every concrete event as
  speculation; the window contains no verifiable sources).
- **When the model was already told a window state** (including default mode),
  the block is prefixed with a one-line status summary, so the model sees both
  "where it is now" and "what changed".
- **Leaving restricted mode** injects one short notice that the evidence window
  was cleared and date filtering no longer applies.
- **Anchor echo** applies once per new restriction. Missing/incorrect echo on
  the first reply → one `[TIME PIN · ANCHOR]` reminder at the start of the next
  turn (never between tool calls of the same turn), for at most two reminders
  per window signature; after that the UI keeps an "unconfirmed" badge and the
  turn continues. Anchoring never blocks a turn. The echo is verified
  **semantically, not by prefix** (`hasAnchorEcho`): the marker plus the echoed
  date plus both echoed range sides must equal the active window (date-format
  variants the `/pin` parser accepts are tolerated; symmetric ranges echo as
  `前后各10年` / `±10 years`, asymmetric as `前10年/后5年` /
  `last 10 years / next 5 years`, and a clock-following window must echo
  `默认` / `default`). A wrong date, a wrong range, or a truncated line does not
  count as confirmation.
- **Token cost**: default mode = 0 tokens; restricted mode = one block per
  window change. This is the product-level answer to the runtime-context
  snapshot dedupe constraint recorded in SPIKE.md.

### 5.4 Evidence filtering (`web_search`)

In restricted mode the Host rewrites the structured value of `web_search` at
`tools/post-execute`:

1. Every source in `value.sources` is dated from `publishedAt` (provider
   `page_age`). Relative ages such as "3 days ago", `today`/`yesterday`, ISO
   dates, `YYYY/MM/DD`, `YYYY-MM`, `YYYY` are resolved to a day number.
2. Sources dated inside `[as_of − before, as_of + after]` are kept; sources
   dated outside are dropped; sources with no parseable date are dropped
   (product decision: *any credible source states its date*). A side with no
   range is unbounded and admits every date on that side.
3. The provider-generated `content` summary is **dropped** in restricted mode
   (it is not a dated source and may restate filtered or truncated results); the
   replacement `content` is one byte-stable note saying how many sources were
   excluded and for which reason, plus the window bounds. If no dated source
   remains, the note tells the model to say plainly that the window has no
   usable dated evidence.
4. When nothing was dropped and there is no provider summary to remove, the
   original value object is returned unchanged (identity preserved) so
   downstream consumers see no modification.

Only `web_search` is filtered in 0.1.x. Memory entries and workspace files are
not filtered (P1). Prompt-supplied text has no machine date and is not evidence
under restricted mode — the model is told not to use undated material.

### 5.5 Future view

A window that reaches past today — a future `as_of`, or an after-side that
crosses today — is a future view. It is not an error: it is the "stand in the
year 3000 and look back" use case, or a range that deliberately includes recent
and future dates. In addition to the normal window block, the model receives the
`[FUTURE VIEW]` block and is told that concrete events past today must be
labelled as assumptions. The UI shows a one-time warning ("the model does not
know the future; answers are in-universe speculation"). The plugin still filters
evidence normally; a fully future window usually yields the honest "no
verifiable sources" answer.

### 5.6 Silence narration

The Host subscribes to `ctx.jobs.events` and keeps per-job bookkeeping (start,
last output, last narration time). At pre-step, for every background job owned by
the session that has produced no output for `silence.firstDelayMs` (default 90 s)
and is due for a refresh (`silence.repeatMs`, default 3 min), it appends one
`[TIME FACT]` user message describing how long the job has been running, how long
it has been silent, and that it is still running. The model is allowed — not
required — to report this to the user. The facts are deterministic: the plugin
never invents progress.

Coverage is **background jobs only**. A foreground long-running tool blocks the
model's step and there is no mid-tool injection point (SPIKE T8), so a foreground
tool can only be described after it returns. The plugin does not render any
progress indicator of its own in the transcript or composer.

### 5.7 Read-only model tool

`time_pin_status` (no parameters) lets the model inspect the current frame:
`restricted`, `mode` (`default` / `past` / `future` / `recent`), `asOfLabel`,
`rangeLabel`, `windowLowerLabel`, `windowUpperLabel`, `timezone`, `nowIso`,
`future` and `anchorPending`. It is read-only by design: the user owns the
window, the model may suggest widening it but cannot change it. Labels are
already rendered in the `promptLocale` language by the Host.

### 5.8 Session lifecycle

The window is **session-scoped**: each conversation has its own state; new
sessions start in default mode; switching conversations does not leak state.
State is folded from standard session events (see §6.3), so resuming, replaying,
and **forking** restore the window. A fork inherits the parent's window because
the fork copies the parent's event prefix and the projection refolds it; after the
fork, the two sessions are independent. Migration/reparenting of a window between
already-independent sessions is neither supported nor claimed.

## 6. Architecture

### 6.1 Host half

| Module | Responsibility |
|---|---|
| `lib/index.js` | Plugin entry: volatile config schema + live re-read, projection registration, `agent/pre-step` injection, `/pin` command, `time_pin_status` tool, `tools/post-execute` evidence filter wiring, jobs subscription. |
| `lib/core/window.js` | Pure window model: as-of and before/after range parsing, proleptic-Gregorian day math with BC eras, bounds, labels, storage keys, `[TIME PIN]`-related formatting. Unit tested in plain Node. |
| `lib/core/text.js` | Pure model-facing text builders (window block, future block, anchor line/reminder, time facts, status summary). Byte-stable per window. |
| `lib/core/fold.js` | The projection fold: standard session events → window state + anchor/last-output bookkeeping. |
| `lib/evidence.js` | `publishedAt` parsing and `web_search` value filtering; `tools/post-execute` listener factory. |
| `lib/silence.js` | Per-job silence bookkeeping; due-fact calculation; no timers of its own. |
| `lib/tools.js` | `time_pin_status` tool definition. |
| `lib/client.js` | Web Client half: header chip + panel, plus the Configure page contributed to the Plugins UI; hand-written lazy bundle, no build step. |

### 6.2 Client half

- Registers the chip in `conversation.session.header.actions` and reads the
  `timePin` projection through the standard slot prop. The chip shows a mode
  glyph (default/recent 🕐, past 🕰, future 🌌), the window label, and an
  unconfirmed-window dot when the anchor echo is still pending.
- The panel contains the as-of input and two range inputs — before / after the
  as-of — prefilled from the projection, shared presets
  (`不限 / 7天 / 30天 / 1年 / 10年 / 100年`) that fill both sides, Apply, Clear and
  Close, inline validation errors, and a dismissible one-time future-view
  warning per session. Escape and outside-click close it; the panel is portaled
  to `document.body` and positioned from the chip's bounding rect as a
  `position: fixed` layer, because the shell clips overlays inside the header
  actions slot.
- The panel submits `/pin …` via the remote command seam, so the Client never
  duplicates validation. It composes exactly the grammar the Host owns:
  `/pin off` when both range fields are empty and no as-of, `/pin 前<spans>` /
  `/pin 后<spans>` for one supplied side, `/pin <as-of> 不限` when both range
  fields are empty with an as-of, and `/pin <as-of> 前… 后…` otherwise.
- Contributes a **Configure** page to the Plugins UI. When the Harness
  config-forms service serves this plugin's namespace, the Client registers one
  form component into the keyed `plugins.row.config` slot (`dsh-time-pin#…`, with
  bundle-detail fallbacks) and edits `promptLocale`, `silence.enabled`,
  `silence.firstDelayMs` and `silence.repeatMs` through the form controller.
  Writes go through the Harness settings service and apply live; the chip does
  not depend on the settings UI (the config-forms service is an optional
  injection).
- All user-visible panel/settings copy is registered in locale namespace
  `time-pin` (`zh` + `en`); the window label itself is derived from the
  projection's raw fields (falling back to the Host label).

### 6.3 State: one session projection, standard events only

State lives in the `timePin` session projection (`stateVersion: 2`). The fold
consumes only standard session events:

| Event | Folded into |
|---|---|
| `command/run` | remembers the running `/pin` invocation (command id + argument string) |
| `command/done` | applies the parsed window for a successful run, sets `anchorPending` for a new restriction, stamps `updatedAt`; `injectedSig` deliberately keeps the previous window so the planner treats the new signature as an update (with a status summary) rather than the first description |
| `request/header` | records the window signature the model was last told about (`injectedSig`) — this is the dedupe key |
| `assistant/message` | confirms or keeps the anchor echo pending; tracks `lastOutputAt` for "last model-visible output" |
| `tool/result` | tracks `lastOutputAt` so tool-only progress also counts as activity |
| `turn/start` / `turn/end` | track the turn's start/end time in the projection state (host bookkeeping; no longer rendered by a Client progress bar) |

Two engineering rules shaped this design:

1. **Never append a custom session event type.** Readers reject unknown stored
   events without `ignorable: true`, and `Session.append()` cannot set it. The
   plugin therefore writes no state events; it folds the standard log and appends
   ordinary source-attributed user messages. Resume/fork/replay work for free,
   and there is no plugin-owned storage to migrate.
2. **Injection must be byte-stable per window.** Text depends only on the window
   (and the pinned clock resolution, day granularity), never on a per-step
   timestamp. Otherwise runtime-context snapshot dedupe would fail and every
   step would cost another message (see SPIKE.md, T5/T12).

### 6.4 Single mutation path

`/pin` is the only writer. The title-bar panel calls the same command line, and
the projection applies state only from a successful `command/done`. This makes
the session log the source of truth: a replay reproduces the exact same windows,
which is why resume/fork restore state without a storage service.

## 7. Decisions and rejected alternatives

| Decision | Chosen because | Alternative rejected |
|---|---|---|
| Button in the conversation title bar | The window is a property of the conversation, not of the input box; it must be visible while reading. | Composer control area. |
| Bare year = January 1 00:00 | Matches how people type historical years ("2000 年"). | Reject bare years; require full dates. |
| BC support with no year 0 | Historical use case ("秦末汉初") needs it; proleptic Gregorian + astronomical year mapping keeps math testable. | Restrict to CE; special-case strings for BC. |
| Future pins allowed | "Standing in 3000 and looking back" is a valid speculative mode when labelled as such. | Reject future as_of. |
| Undated sources excluded in restricted mode | A date is the minimum bar for verifiable evidence; "undated but probably right" is exactly the failure mode this plugin exists to prevent. | Keep undated sources as background. |
| Window state in a session projection | Resume/fork/replay restore automatically, no plugin storage, no migration; same mechanism shipped plugins use. | Plugin-owned key/value storage keyed by session id. |
| `/pin` command as the single mutation path | One validator, one wire format between Client and Host, one log entry per change. | Panel mutating projection state directly. |
| Inject once per window change | Snapshot dedupe safety and near-zero token cost; preserves the "install changes nothing by default" promise. | Inject every step (rejected: token cost); inject at every conversation start (rejected: noise). |
| Anchor echo as a user-message correction, max 2, never blocking | Cheap to detect, degrades gracefully when a model ignores it. | Hard output rewriting/blocking; per-step nudging. |
| `web_search` as the only evidence source in 0.1.0 | Its structured value carries source dates; memory/files do not expose dates to a plugin yet. | Block v1 on memory/file support. |
| Background jobs only for silence narration | A foreground tool blocks the model turn, so there is no injection point; narrating after the fact is too late to be useful. | Pretend to cover foreground tools; poll for mid-tool injection points. |
| Host facts at 90 s / 3 min, configurable as global plugin settings | Predictable, quiet enough for long builds, and the only user-visible knob most people need. | Per-session switches, model-chosen cadence. |
| Plugin settings exposed as a Configure page in the Plugins UI | The plugin manager renders a bundle row's config only when a client plugin occupies `plugins.row.config`; without an occupant the plugin looks unconfigurable even though its `Config` schema exists. | Documenting hand-edited profile patches as the only settings path. |
| Config fields declared `.volatile()` | The Harness settings service only serves forms for schema subtrees containing a volatile field — an ordinary config is excluded from `settings.describe()` entirely (this is what caused the "no configurable place" report). Volatile writes are also committed into the running plugin without remounting, so a `loader/volatile-update` listener can re-read prompt locale and silence thresholds live. | Ordinary (non-volatile) config + restart-on-change. |
| Bilingual UI by localizing the window label in the Client from raw projection fields | The UI language and the prompt language are independent; rendering the Host's Chinese label in an English UI was a localization defect found in review. | Shipping a single-language UI; putting UI copy in the Host. |

## 8. Configuration

Global plugin settings (one set per installed profile). The shipped defaults live
in the plugin row's `config` block in `cordis.patch.yml`; the user edits them
live from the **Configure** page in the Plugins UI (also rendered on the bundle
detail page), which writes through the Harness settings service.

| Key | Default | Meaning | UI |
|---|---|---|---|
| `promptLocale` | `zh` | Language of model-facing blocks and command result text (`zh` or `en`). Independent of UI locale. | segmented 中文 / English |
| `silence.enabled` | `true` | Master switch for background-job time facts. | segmented on/off |
| `silence.firstDelayMs` | `90000` | Silence before the first time fact (1000–86400000). | number input in **seconds** (90) |
| `silence.repeatMs` | `180000` | Refresh interval while the job stays silent (1000–86400000). | number input in **seconds** (180) |

The settings are **global**: they apply to every conversation in the profile.
The time window is separate **per-session state** owned by `/pin` and the
title-bar control; it is deliberately not a setting. There is no per-session
silence switch.

A profile's own Cordis patch layer can override the plugin row's config; an
id-targeted override replaces the whole `config` object rather than deep-merging
it, so an override must restate every field it keeps.

**Why this page exists (and why a restart is needed once).** The Harness settings
service only serves forms for config schema subtrees that contain a `.volatile()`
field; a config made only of ordinary fields is excluded from
`settings.describe()` entirely, so the Plugins row would show no Configure
control. `promptLocale` and `silence` are therefore volatile. The benefit beyond
visibility: a volatile settings edit is committed into the running plugin's
config refs without remounting the fiber, and the plugin's
`loader/volatile-update` listener re-reads it — so the prompt locale and silence
thresholds (including a fresh silence bookkeeper) change immediately. The one
exception is module loading: Host modules are not hot-reloaded, so a fresh
install or upgrade needs one DSH restart before the Configure control appears.

## 9. Compatibility and packaging

- `type: module`; Node `>= 20`; peer ranges `>=0.2.1-rc <2` for the
  `@deepseek-ai/dsh-*` packages used, `@deepseek-ai/cordis >=4.0.0-rc <5`,
  `@deepseek-ai/schemastery ^3.18.0`, `zod ^4`. Peers are optional so the
  profile's own copies are used; validated at load.
- Bundle layer: `cordis.patch.yml` inserts one Host row (`id: dsh-time-pin`)
  with the default config. The Client half is declared under `dsh.client` and
  served from `lib/client.js`; it is a hand-written lazy bundle (no build step).
- Distribution: npm package or Git repository; installed into a profile with
  `dsh plugin --profile <name> add <spec>`. The marketplace does not support
  in-place upgrades for ordinary plugins — upgrades are uninstall + reinstall
  (documented in the README).
- The 0.1.0 build was installed into a DSH desktop profile and verified live
  (`0.2.1-rc.5`): the bundle row was active with the config schema, the
  chat-header chip registered and was active, the `time_pin_status` tool
  returned a coherent default-mode snapshot, and the Configure control was
  contributed at the plugin manager's `plugins.row.config` key
  `dsh-time-pin#dsh-time-pin` (the bundle page also gets `plugins.bundle.config`
  key `dsh-time-pin`; the settings namespace is the Loader entry id, either
  `dsh-time-pin` or `include:dsh-time-pin`). One restart after the install was
  needed before the Host-loaded control appeared; afterwards settings edits
  apply live. The uninstall path is documented but was not exercised in that
  session.
- Zero telemetry; no network access of its own (the only network use is the
  host's normal `web_search`).

## 10. Known limitations

- Training knowledge cannot be erased: a model may still know post-`as_of`
  events. The anchor, rules and date rules constrain evidence use, not memory.
- Evidence filtering covers `web_search` only; text the user pastes, model
  memory and files are not machine-dated in 0.1.0.
- Search providers that return no dates make restricted mode degrade to "no
  dated evidence" — honest but less useful. The parser accepts several relative
  date formats; anything else counts as undated.
- Foreground long tools are not narrated mid-flight (background jobs only), and
  the plugin paints no progress indicator of its own while a tool runs.
- The `web_search` exclusion note line is fixed Chinese text in 0.1.0, even
  under `promptLocale: en`; the window block and the time facts are localized.
- Window resolution is one day; times of day are not part of the window.
- The window is conversation state: it protects a conversation's evidence
  frame, not a whole profile, and it does not carry across independent sessions
  (only resume/fork of the same session lineage).

## 11. Open items (deferred, not forgotten)

| Item | Why deferred | Sketch |
|---|---|---|
| Memory / workspace-file evidence dates (P1) | No date seam available to a plugin in this DSH version; would need memory `valid_from` / file `mtime` / git commit dates. | Extend evidence filtering to those providers once a date interface exists. |
| Dedicated `/pin` keyboard entry (P2) | Typing the slash command already works; a hotkey/shortcut needs a stable keybinding seam. | Shortcut or header focus target; not a separate state path. |
| `knowledgeCutoff` config (P1) | The future-view block is generic; a user-supplied model knowledge cutoff would make the warning more precise. | Optional config; append a line to `[FUTURE VIEW]`. |
| Desktop notifications for silent jobs (P1) | Chat status is enough for 0.1.0. | Optional `silence.channel`. |
| Output leak detection (P2) | Blocking/rewriting output is invasive and easy to get wrong; rules + anchor first. | Post-assistant check, warn-only initially. |
| Provider date coverage | Depends on upstream search providers, not on this plugin. | Keep the "undated → excluded" rule; document the degradation. |

Resolved during implementation (no longer open): title-bar slot (T1), session
state persistence (T2), search-result dates (T3), injection/dedupe (T5), anchor
echo (T6), jobs events (T7), narrow-screen behavior (T9, compact chip), version
compatibility (T11), token cost (T12), separate client-side localization of the
window label (no longer renders the Host's Chinese label in an English UI),
configurable settings page in the Plugins UI (the plugin row now has a
`plugins.row.config` occupant, so the Configure control appears).
Background-only narration (T8) is a documented limitation, not an open question.

## 12. Acceptance coverage

The criteria come from the reviewed product design; labels below use the default
product UI language (Chinese). The Client localizes the same states for other UI
locales, and model-facing lines follow `promptLocale`.

| # | Acceptance criterion | Where |
|---|---|---|
| 1 | Title-bar control shows default `🕐 默认 · 不限` | Client chip + projection view |
| 2 | Pinning `2000-01-01` shows `2000-01-01 · 不限`; survives resume | `/pin` projection + chip |
| 3 | `2000-01-01` + `10年` → `2000-01-01 · 前后各10年`; injection contains `[1990-01-01, 2010-01-01]` | `windowBlock` + pre-step |
| 4 | `3000-01-01` valid → future view, one-time warning, future injection | `isFuture` + `[FUTURE VIEW]` |
| 5 | `公元前200年` / `前200年` valid; `公元前0年` rejected | `parseAsOf` (unit tested) |
| 6 | Bare `2000` → `2000-01-01` | `parseAsOf` |
| 7 | Invalid dates rejected with a clear message | `validateAsOf` messages |
| 8 | `7天 / 30天 / 10年 / 100年 / 不限` work on both sides; `0天` rejected; one supplied side mirrors | `parsePinArgs` / `windowFromInput` |
| 9 | Out-of-window search results never reach the model | `web_search` value filter |
| 10 | Undated sources excluded and explained | filter note |
| 11 | Zero dated evidence → model told to say so | zero-evidence note |
| 12 | First reply echoes the window; one correction; ≤2 reminders | anchor fold + pre-step |
| 13 | Unchanged window → no repeated injection | `injectedSig` dedupe |
| 14 | Silent background job → `[TIME FACT]` at 90 s, then every 3 min; ended jobs stop | silence bookkeeping + pre-step |
| 15 | `silence.enabled=false` stops model-facing narration | config + `factsFor` |
| 16 | Default mode injects nothing | pre-step early-out |
| 17 | Uninstall leaves no residue | no storage, no custom events (path documented, not exercised in the review session) |
| 18 | The Plugins UI shows a Configure page for the row (after one restart following install) and edits `promptLocale` / `silence.*` live, with delays in seconds | volatile config + Client `plugins.row.config` occupant + config-forms controller |

## 13. Relationship to neighboring plugins

The full comparison table is in the READMEs. In short: none of the neighbors
overlaps with the *user-pinned as-of + before/after range + future/BC view +
anchor echo* combination. `dsh-plugin-verified-search` enforces a date discipline
inside search itself; `dsh-task-heartbeat` and `dsh-turn-watchdog` detect stalled
work; `dsh-env-facts` uses "as of" wording for environment facts. This plugin
complements them rather than replacing them; its silence narration is host-side
and deterministic, so it needs no model beat in the middle of a stalled turn.

## 14. References

- Product design source: `dsh-time-pin.md` (workspace, reviewed 2026-11-03).
- Feasibility: [SPIKE.md](SPIKE.md) — T1–T12 verdicts and the architecture that
  was actually built.
- DSH packages relied on: `@deepseek-ai/dsh-session-projection`,
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-jobs`
  (events), `@deepseek-ai/dsh-client-ui-conversation` (Client slots).
- Neighbors: [dsh-plugin-verified-search](https://github.com/f0909172434/dsh-plugin-verified-search),
  [dsh-task-heartbeat](https://github.com/jerentpan-lab/dsh-task-heartbeat),
  [dsh-turn-watchdog](https://github.com/Equinox7379/dsh-turn-watchdog),
  [dsh-env-facts](https://github.com/zszzlzm/dsh-env-facts).
