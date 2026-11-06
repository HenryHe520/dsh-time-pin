# SPIKE · dsh-time-pin feasibility (M0) + M1–M4 verification

> Status: **0.1.0 final — M0 passed, M1–M4 implemented, installed and live-verified**
> in the `desktop` profile. 2026-11-04, DSH `0.2.1-rc.5`.
>
> Evidence base: live `cordis_inspect_*` queries against the running Harness, and
> the installed `dsh` package tree extracted read-only from `app.asar` to
> `.dsh-extract/` (17,188 files) for source reading. Nothing in the installation
> was modified.

| # | Question | Verdict | Where it landed |
|---|---|---|---|
| T1 | Is there a usable conversation title-bar Client slot? | **PASS** | `conversation.session.header.actions` (kind `list`, scope `session`, `replaceRisk: none`). Live occupants already: `agent-team`, `agent-preset`, `subagent-catalog`, `job-list`. Our control registers beside them. |
| T2 | How is session-scoped state persisted? | **PASS** | A `sessionProjections` unit folded from standard session events (`command/run` + `command/done`), exactly how the shipped `plan-mode` plugin persists `/plan`. Resume/fork/replay restore it with no plugin-owned storage. |
| T3 | Do search results carry dates we can filter on? | **PASS** | `web_search` structured value is `{ content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }`; `publishedAt` is populated from the provider's `page_age`. Filterable at `tools/post-execute` by replacing the tool `value`. |
| T4 | Are memory/file dates accessible? | **Deferred (P1)** | Not needed for v1: Web search covers the core promise. File `mtime`/git date and memory `valid_from` stay out of scope as designed. |
| T5 | Injection point and snapshot dedupe? | **PASS** | `agent/pre-step` (waterfall) returns `{kind:'enter', messages:[...]}`; `createUserMessage()` (`@deepseek-ai/dsh-llm`) appends a durable source-attributed user message. Duplicate suppression is structural: the projection records the window signature at the last `request/header`, so the block is injected **once per window change**, never per step. |
| T6 | Can anchor echo be detected and corrected? | **PASS** | The same projection folds `assistant/message` and matches the reply's first text against the `时间窗：…` marker line (exact marker + tolerant match). Missing echo → one correction message appended at the next pre-step; after 2 attempts the UI badge degrades instead of blocking. |
| T7 | Jobs events / timers / session injection for silence narration? | **PASS** | `ctx.jobs.events.subscribe({ owners: 'all' }, listener)` emits `registered/progress/output/stopping/settled/removed` with `JobView` (`startedAt`, `status`, `output.total`). The Host half keeps per-job silence bookkeeping and appends a `[TIME FACT]` user message at pre-step. |
| T8 | Can a foreground long tool be sensed mid-flight? | **No** | A foreground tool blocks the model's step; there is no mid-tool injection point. v1 covers **background jobs** only (documented); the plugin renders no progress indicator of its own. |
| T9 | Narrow-screen folding? | **PASS (v1: text chip)** | The control is a compact chip; the header owns overflow. No per-breakpoint API was needed. |
| T10 | Marketplace/publish requirements? | **Documented** | README + locale `meta.title/description` + icon + CHANGELOG + `engines` + zero telemetry. cordis.run submit is a manual step after this milestone. |
| T11 | Version compatibility? | **PASS** | `engines.node >= 20`, peer ranges `>=0.2.1-rc <2` for `@deepseek-ai/dsh-*` packages; validated at load. The Client half has no build step (hand-written lazy bundle). |
| T12 | Token cost? | **PASS by construction** | Default (unrestricted) mode injects nothing at all. Restricted mode injects one block per window change (bytes identical for the same window → snapshot/dedupe safe). |

## Architecture

### Host half (`lib/index.js`)

1. **`timePin` session projection** (`stateVersion: 2`)
   - folds `command/run` / `command/done` for `/pin` into `{ asOf, span }`;
   - folds `request/header` to remember the window signature the model was last
     told about (`injectedSig`);
   - folds `assistant/message` to confirm the anchor echo and to track the last
     model-visible output time.
   - exposes a `wire.view` for the Client: `chipLabel`, raw clock-free fields
     (`modeBase`, `asOfDay`, `asOfInput`, `spanInput`), `anchorPending` and
     `restricted`.
2. **`agent/pre-step`** (prepend, after `next()`): inject the window block only
   when the signature differs from `injectedAtHeader`; inject one anchor
   correction when the echo is missing; append `[TIME FACT]` lines for due
   silent background jobs.
3. **`/pin` command** (`ctx.commands`): the single mutation path, human-only.
   `time_pin_status` tool: read-only self-inspection for the model.
4. **`tools/post-execute`**: in restricted mode rewrite `web_search` results —
   undated sources and out-of-window sources are dropped with an explicit note.
5. **Silence narration** (`ctx.jobs`): rolling per-job bookkeeping, first report
   after `silence.firstDelayMs`, refresh every `silence.repeatMs`.

### Client half (`lib/client.js`)

- `conversation.session.header.actions` → the Time Anchor chip (order `-15`),
  reading the `timePin` projection through `useProjection('timePin')`.
- Chip opens a panel (as-of input, span presets + free input, Apply / Clear).
  Apply submits `/pin <as-of> [span]` through
  `ctx.remote.commands.execute(sessionId, line, [])` — the same command the user
  could type, so there is one implementation of the operation.
- The Plugins UI **Configure** page: the Client optionally injects the Harness
  config-forms service and, once it serves this plugin, registers one settings
  form at the plugin manager's keyed `plugins.row.config` slot
  (`dsh-time-pin#dsh-time-pin`, with bundle-detail fallbacks). It edits
  `promptLocale`, `silence.enabled`, `silence.firstDelayMs` (seconds in the UI)
  and `silence.repeatMs` through the form controller, so writes go through the
  Harness settings service and apply live.
- All copy goes through `ctx.locale.register('time-pin', { zh, en })`, including
  the chip label built from the projection's raw fields (the Host `chipLabel` is
  the fallback).

## Design constraints discovered (carried into the implementation)

- **Never append a custom session event type.** Readers reject unknown stored
  events without `ignorable: true`, and `Session.append()` cannot set it. State
  is therefore folded from *standard* events only (`command/*`, `request/header`,
  `assistant/message`) — the same set `plan-mode` uses.
- **Injection must be byte-stable per window.** `windowSignature()` is the
  dedupe key; text depends only on the window and the pinned clock resolution
  (day granularity), never on per-step timestamps.
- **Model-facing text locale** is a Config field (`promptLocale`, default `zh`,
  matching the product spec); UI copy is localized independently.
- **Command-line grammar** (`/pin 2000-01-01 10年`) is the only wire format
  between Client and Host, so validation lives in one place
  (`lib/core/window.js`) and is unit-tested.
- **A plugin config needs a volatile field to be configurable at all.** The
  Harness settings service only serves forms for schema subtrees that contain a
  `.volatile()` field; a config of ordinary fields is excluded from
  `settings.describe()`, so the Plugins row shows no Configure control and no
  client settings registration ever fires. `promptLocale` and `silence` are
  therefore `.volatile()`; a volatile edit is committed into the running plugin
  without remounting, and the Host's `loader/volatile-update` listener re-reads
  it (prompt locale + fresh silence bookkeeper) live.
- **Host modules are not hot-reloaded.** A fresh install or upgrade needs one
  DSH restart before the Host-loaded Configure control appears; after that,
  settings edits apply live.

## Residual risks

| Risk | Mitigation |
|---|---|
| Client half cannot resolve `ctx.remote.commands` in a third-party bundle | Verified against the shipped `@deepseek-ai/dsh-client-ui-plan` bundle, which calls `ctx.remote.commands.execute(sessionId, '/plan off', [])` from a Client-slot component. Falls back to asking the user to type `/pin`. |
| `publishedAt` is a relative age string (`"3 days ago"`), not ISO | Evidence parser accepts ISO dates, `YYYY`, `YYYY/MM/DD`, `today/yesterday`, and `N unit(s) ago`; anything else counts as undated → excluded in restricted mode (by design). |
| Provider returns no dates at all | Restricted mode degrades to "no dated evidence" honest response rather than silently using undated sources — the product promise holds. |
| Anchor echo is ignored by the model | One correction, then a Client badge; never blocks the turn. |

## M1–M4 verification (2026-11-03, desktop profile)

### Automated

| Suite | Result |
|---|---|
| `npm test` (window/fold/evidence/text/silence/client bundles + Host wiring + schema parsing) | **144 tests: 132 pass, 12 skipped in a plain checkout, 0 fail** |
| `tests/host-wiring.test.mjs` in a sandbox linked to the real installed `@deepseek-ai` packages | **5/5 pass** — the real `Config` schema, real `defineTool` (output-schema validated), real `createUserMessage`, real projection registration |
| `tests/host-schema.test.mjs` in the same sandbox | **7/7 pass** — real zod parses every projection state / Client view the fold can produce, rejects malformed views, and resolves the `Config` defaults |
| `tests/client.dom.test.mjs` | **34/34 pass** — chip, panel, command lines, removed-bar trace check, and the settings page (registration, namespace spellings, summary, four rows, writes, seconds→ms clamping, read-only, loading) |
| `node --check` on every shipped `.js` | clean |
| Real `web_search` output-schema validation of filtered values | pass (see `tests/evidence.test.mjs` notes) |

### Live installation (`plugin_manager install_bundle`, local directory link)

| Evidence | Observed |
|---|---|
| Bundle + package | `dsh.profile.bundles` contains `dsh-time-pin`; dependency `dsh-time-pin: link:…/dsh-time-pin`; `application: applied` |
| Host row + Config schema | `Config.listConfigs` entry `include:dsh-time-pin` status `schema` — `promptLocale` enum (`zh`/`en`, default `zh`) and `silence.{enabled,firstDelayMs,repeatMs}` defaults `true/90000/180000`, declared volatile so the settings service serves them |
| Model tool | `time_pin_status` appears in the live tool set and executes: `unrestricted · mode=default · window [unbounded, default] · span 不限 · now 2026-11-03T13:38:22.196Z (Asia/Shanghai)` |
| Client chip | `conversation.session.header.actions` occupant `time-pin`, order `-15`, `active: true` |
| Plugins Configure page | live: contributed at `plugins.row.config` key `dsh-time-pin#dsh-time-pin` (bundle page: `plugins.bundle.config` key `dsh-time-pin`), namespace = Loader entry id (`dsh-time-pin` or `include:dsh-time-pin`); appears after one DSH restart following install, edits then apply live |

### Verified by construction / by unit test, not by a live model turn

- Restricted-mode injection, anchor echo, update/clear notices, future view, BCE
  windows and dedupe are covered by `tests/fold.test.mjs` (14 cases) and by the
  Host-wiring sandbox, which folds a real `/pin` turn and asserts exactly one
  `[TIME PIN]` message, then none after the request header.
- The `/pin` command path itself (Client → `ctx.remote.commands.execute` → Host
  handler → `command/run` + `command/done` → projection) is covered end-to-end
  in two halves: the Client half is asserted by `tests/client.dom.test.mjs`
  (34 cases, exact command lines, chip/panel rendering, settings-page writes and
  the absence of the removed Client progress UI), the Host half by the fold +
  wiring tests. A full live click-through requires a browser action; the
  acceptance script is in README.md ("Quick start").
- Uninstall was exercised in this session: `plugin_manager remove_bundle`
  (`stage: remove`, `application: applied`) restored the profile's
  `package.json`/bundle selection to their previous state, removed the Host row
  + config schema (`Config.listConfigs` → 0 entries), removed `time_pin_status`
  from the live tool list, and unregistered the Plugins-page configuration
  seats. The title-bar chip in the already-open page lingered until a refresh
  (client module-eviction timing); a fresh `install_bundle` restored every
  surface, including the renamed `时间锚定 / Time Anchor` display title.

## Incident: the 0.1.0 projection-view schema crash (fixed)

**What happened.** The first installed build broke conversation loading in every
session: the chat view failed as soon as it touched the `timePin` projection.
The cause was one line — the Client wire-view schema declared

```js
modeBase: zod.union(['default', 'recent', 'pinned']),   // WRONG
```

`schemastery` accepts literal arrays in `union` (that is what `Config`'s
`promptLocale: z.union(['zh', 'en'])` correctly does), **`zod` does not**: it
expects schema instances, accepts the call at construction time, and then throws
inside its internal `.run` the first time a value is validated
(`TypeError: Cannot read properties of undefined (reading 'run')`). The Session
projection registry validates every published view through `viewSchema` before a
client reads it — and every conversation publishes this projection — so one bad
schema took down history loading for all sessions at once. Fixed to
`zod.enum(['default', 'recent', 'pinned'])`.

**Impact.** UI-level only. No session data was written by the failing path (the
throw happens while validating a read-only derived view), and the logs were
verified afterwards: 60 session files, 19,213 zstd frames, 32,764 JSONL records,
**0 unparsable**, 0 undecodable files.

**Why the test suite missed it.** The Host wiring smoke test imported the module
and exercised `projection.apply()` / `wire.view()` — but never called
`.parse()` on a schema. A schema that is never parsed is not tested. That is
exactly the shape of this bug: construction succeeds, only validation throws.

**Prevention now in place.** `tests/host-schema.test.mjs` parses the **real**
`stateSchema` and `wire.viewSchema` with the **real** zod for every state the
fold can produce (default, pinned past/future/BC, span-only "recent", anchor
pending/confirmed, running turn, cleared after pin), asserts that malformed
views are rejected (so the schema is load-bearing rather than decorative), and
resolves `Config` defaults through schemastery. Against the pre-fix code the
same file fails with the production error
(`TypeError: Cannot read properties of undefined (reading 'run')` / `('optin')`);
against the fix it passes. It runs wherever the Harness packages resolve
(installed profile or a linked sandbox) and skips — never fails — in a bare
checkout, like `tests/host-wiring.test.mjs`.

**Rule derived.** Any schema the runtime validates on a hot read path (session
projections, tool outputs, settings forms) must have a test that parses real
values of every shape the code can produce, using the same schema library the
runtime uses. Importing the module is not enough.


