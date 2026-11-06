/**
 * dsh-time-pin — Client half.
 *
 * A hand-written DSH Web lazy bundle (no build step, no JSX, no bare imports):
 * the shell's module table materializes this file, which only registers a
 * factory; `factory(require)` runs on first use and returns the Cordis plugin
 * `{ inject, apply }`.
 *
 * What it adds to the Web UI:
 *
 * 1. A compact "Time Anchor" chip in `conversation.session.header.actions`. It
 *    reads the Host's clock-free `timePin` session projection through the
 *    standard `useProjection('timePin')` slot prop and renders a localized
 *    window label (built from the raw `modeBase`/`span`/`asOfInput` fields, so
 *    the UI follows the active language instead of the Host's prompt copy) with
 *    a mode glyph (day / past / future). Clicking it opens a panel with an
 *    as-of text field, a lookback span field with presets, and Apply / Clear.
 *    Apply submits the same `/pin …` session command a user could type —
 *    through `ctx.remote.commands.execute(sessionId, line, [])` — so the Host
 *    keeps one implementation of the mutation and one validator.
 * 2. A configuration page in the Plugins UI: a client plugin occupies the
 *    bundle row's keyed `plugins.row.config` seat (with `plugins.bundle.config`
 *    as the bundle-level fallback), so the Plugins page offers a configure
 *    control for the Host's own `promptLocale` / `silence.*` settings. State is
 *    read through the `configForms` service (the one browser mirror of the
 *    Host settings document) and written back with its ordered mutation API.
 *    The dependency is OPTIONAL — without a composed settings UI the chip and
 *    its panel keep working and no configuration seat is registered.
 *
 * The panel is a `position: fixed` popover anchored to the chip's
 * `getBoundingClientRect()`. The chip lives in the header actions slot, which
 * the shell clips (and fades) when a long title does not fit, so the panel is
 * rendered through `ReactDOM.createPortal` into `document.body` — the shell's
 * own contract for overlays in the title/actions slots. Without a portal the
 * panel is clipped together with the chip and clicking it looks like a no-op.
 * Placement self-corrects by measuring where the panel actually landed and
 * cancelling any offset (the header title row is a contained layout context).
 * On a shell without `react-dom` the bundle degrades to rendering the panel
 * inline (clipped, but never a crash). The only other DOM insertion at module
 * level is one `<style>` tag owned by `apply` and removed by its effect
 * disposer.
 *
 * All copy goes through the `time-pin` locale namespace (`zh` is the key-set
 * source of truth, `en` must stay key-identical). Every command call is
 * wrapped: a missing projection, missing session, missing command service or a
 * rejected command degrades to an inline message instead of crashing the
 * header.
 */

window.__ModuleLoader__.load({
	id: 'dsh-time-pin',
	factory: (require) => {
		'use strict';

		/** The documented baseline module table member this bundle needs. */
		const React = require('react');

		/**
		 * Platform-shared React DOM, used only to portal the panel outside the
		 * clipped header actions slot. Optional: an older shell that does not
		 * share `react-dom` still runs the bundle (the panel falls back inline).
		 */
		let ReactDOM = null;
		try {
			ReactDOM = require('react-dom');
		} catch {
			ReactDOM = null;
		}

		/** Locale namespace owned by this plugin. */
		const NS = 'time-pin';
		/** Session projection key registered by the Host half (`lib/core/fold.js`). */
		const PROJECTION_KEY = 'timePin';
		/** Popover width in px — must equal `.dshtp_panel` width in CSS below. */
		const PANEL_WIDTH = 336;
		/** Gap between the trigger's bottom edge and the panel. */
		const PANEL_GAP = 6;
		/** Minimum distance kept between the panel and the viewport edges. */
		const VIEWPORT_MARGIN = 12;
		/** Maximum placement self-corrections per opening (layout containment). */
		const MAX_PLACEMENT_CORRECTIONS = 3;
		/** Span spellings that mean "no lower bound" in every locale. */
		const SPAN_NONE = /^(?:不限|无限制|全部|无限|无|all|any|unlimited|none|off|-|—)$/i;
		/** Canonical unlimited span token; the Host parser accepts it regardless of UI locale. */
		const SPAN_UNLIMITED = '不限';

		/**
		 * Browser-lifetime memory shared by every mounted instance of this
		 * module (the factory runs once per page, so this is plugin-level memory).
		 */
		/** Session ids whose future-view warning the user dismissed. */
		const futureWarningDismissed = new Set();

		// ------------------------------------------------------------------
		// Small pure helpers
		// ------------------------------------------------------------------

		/** Coerce a wire value to a display string. */
		function asText(value) {
			return typeof value === 'string' ? value : '';
		}

		/** Trimmed display string. */
		function trimmed(value) {
			return asText(value).trim();
		}

		/** Day number (1970-01-01 = 0) for one proleptic-Gregorian CE date, year 1 included. */
		function dayNumberOfCe(year, month, day) {
			const date = new Date(0);
			date.setUTCFullYear(year, month - 1, day);
			date.setUTCHours(0, 0, 0, 0);
			return Math.floor(date.getTime() / 86400000);
		}

		/** Browser-local calendar day number for one epoch instant. */
		function todayDayNumber(nowMs) {
			const date = new Date(nowMs);
			return dayNumberOfCe(date.getFullYear(), date.getMonth() + 1, date.getDate());
		}

		/**
		 * Decode the Host's as-of storage key (`ce:2000-01-01`, `bce:200-01-01`).
		 * @returns {{ era: 'ce' | 'bce', year: number, month: number, day: number } | null}
		 */
		function decodeAsOfKey(value) {
			const raw = trimmed(value);
			const match = /^(ce|bce):(\d{1,4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
			if (match === null) return null;
			return {
				era: match[1],
				year: Number(match[2]),
				month: Number(match[3]),
				day: Number(match[4]),
			};
		}

		/** Day number of a pinned as-of storage key (CE only); null for BC or undecodable input. */
		function asOfDayFromKey(value) {
			const asOf = decodeAsOfKey(value);
			if (asOf === null || asOf.era === 'bce') return null;
			return dayNumberOfCe(asOf.year, asOf.month, asOf.day);
		}

		/**
		 * Whether the pinned as-of day lies after the browser's local today.
		 *
		 * The Host wire view is deliberately clock-free (publication dedupe needs a
		 * pure function of state), so "future" is the Client's own comparison of
		 * the Host's `asOfDay` against the local calendar day. Undated/BC pins are
		 * never future.
		 */
		function isFutureView(view, nowMs) {
			if (typeof view.future === 'boolean') return view.future;
			const pinned =
				typeof view.asOfDay === 'number' && Number.isFinite(view.asOfDay)
					? view.asOfDay
					: asOfDayFromKey(view.asOf);
			if (pinned === null) return false;
			return pinned > todayDayNumber(nowMs);
		}

		/**
		 * Resolve the control mode from the Host wire view.
		 *
		 * Host vocabulary: `modeBase` is `'default'` (no window), `'recent'`
		 * (default as-of + finite span) or `'pinned'` (explicit as-of); only
		 * `'pinned'` can be `'future'` and that split is made here against the
		 * browser clock. A defensive fallback also accepts the older documented
		 * view shape (`mode` / `future` / `restricted`).
		 * @returns {'default' | 'past' | 'future' | 'recent'}
		 */
		function resolveMode(view, nowMs) {
			if (view === null || view === undefined) return 'default';
			const base = asText(view.modeBase);
			if (base === 'default') return 'default';
			if (base === 'recent') return 'recent';
			if (base === 'pinned') return isFutureView(view, nowMs) ? 'future' : 'past';
			const explicit = asText(view.mode);
			if (explicit === 'default' || explicit === 'past' || explicit === 'future' || explicit === 'recent') {
				return explicit;
			}
			if (view.restricted !== true) return 'default';
			if (isFutureView(view, nowMs)) return 'future';
			return decodeAsOfKey(view.asOf) === null ? 'recent' : 'past';
		}

		/** Mode glyph: default/recent clock, past mantel clock, future space. */
		function glyphFor(mode) {
			if (mode === 'future') return '🌌';
			if (mode === 'past') return '🕰';
			return '🕐';
		}

		/** Span magnitude decoded from the Host storage key (`10y`, `7d`, `6m`). */
		function parseSpanKey(value) {
			const match = /^(\d{1,7})([dmy])$/.exec(trimmed(value));
			if (match === null) return null;
			return { amount: Number(match[1]), unit: match[2] };
		}

		/** Span magnitude decoded from the Host display token (`10年`, `6个月`, `7天`). */
		function parseSpanInput(value) {
			const match = /^(\d{1,7})(天|个月|年)$/.exec(trimmed(value));
			if (match === null) return null;
			const unit = match[2] === '天' ? 'd' : match[2] === '个月' ? 'm' : 'y';
			return { amount: Number(match[1]), unit };
		}

		/** Localized unit magnitude (`10年` / `10 years`). */
		function spanMagnitudeOf(span, t) {
			const base =
				span.unit === 'd' ? 'label.unit.day' : span.unit === 'm' ? 'label.unit.month' : 'label.unit.year';
			return t(span.amount === 1 ? base + '.one' : base + '.other', { amount: span.amount });
		}

		/**
		 * Localized span magnitude for the current window, or null when unlimited.
		 * Prefers the raw projection key and falls back to the display token.
		 */
		function spanTextOf(view, t) {
			const decoded = parseSpanKey(view.span) ?? parseSpanInput(view.spanInput);
			return decoded === null ? null : spanMagnitudeOf(decoded, t);
		}

		/**
		 * Build the displayed window label in the ACTIVE UI locale.
		 *
		 * The Host view carries raw clock-free fields (`restricted`, `modeBase`,
		 * `span`, `asOfInput`), so the browser owns the localized copy instead of
		 * rendering the Host's model-facing Chinese label. Falls back to the Host
		 * `chipLabel` when the raw fields are missing or a pinned as-of has no
		 * displayable input.
		 */
		function windowLabelOf(view, t) {
			const hostLabel = trimmed(view.chipLabel);
			const base = asText(view.modeBase);
			const hasRawShape = base !== '' || typeof view.restricted === 'boolean';
			if (!hasRawShape) return hostLabel !== '' ? hostLabel : t('chip.fallback');

			const span = spanTextOf(view, t);
			const unlimited = t('span.none');
			if (base === 'default' || (base === '' && view.restricted !== true)) {
				return t('label.default');
			}
			if (base === 'recent') {
				return t('label.recent', { span: span === null ? unlimited : span });
			}
			if (base === 'pinned') {
				const asOf = trimmed(view.asOfInput) !== '' ? trimmed(view.asOfInput) : trimmed(view.asOfLabel);
				if (asOf === '') return hostLabel !== '' ? hostLabel : t('chip.fallback');
				return t('label.pinned', {
					asOf: asOf,
					span: span === null ? unlimited : t('label.spanPinned', { span: span }),
				});
			}

			// Defensive fallback for the older documented view shape (no modeBase):
			// derive the same localized string from `restricted` + `asOf` + `span`.
			if (decodeAsOfKey(view.asOf) === null) {
				return t('label.recent', { span: span === null ? unlimited : span });
			}
			const asOf = trimmed(view.asOfInput) !== '' ? trimmed(view.asOfInput) : trimmed(view.asOfLabel);
			if (asOf === '') return hostLabel !== '' ? hostLabel : t('chip.fallback');
			return t('label.pinned', {
				asOf: asOf,
				span: span === null ? unlimited : t('label.spanPinned', { span: span }),
			});
		}

		/**
		 * Compose the `/pin …` line the panel submits.
		 *
		 * The Host grammar is `<as-of> [<span>] | off`. A bare as-of keeps the
		 * current span, so an explicitly cleared span is spelled out as `不限`;
		 * a span-only line means "default as-of + that span" (mode `recent`) and
		 * clears back to default mode when both fields are empty.
		 */
		function composeLine(asOfText, spanText) {
			const asOf = trimmed(asOfText);
			const span = trimmed(spanText);
			const spanToken = span === '' || SPAN_NONE.test(span) ? '' : span;
			if (asOf === '') {
				if (spanToken === '') return '/pin off';
				return '/pin ' + spanToken;
			}
			if (spanToken === '') return '/pin ' + asOf + ' ' + SPAN_UNLIMITED;
			return '/pin ' + asOf + ' ' + spanToken;
		}

		/**
		 * Human-readable failure of a `remote.commands.execute` result, or null
		 * when the command was admitted successfully. A handler-level error keeps
		 * the Host's own text (it is the same copy the user would see by typing
		 * the command); transport/admission failures get a localized fallback.
		 */
		function failureOf(result, t) {
			if (result === null || result === undefined) return t('error.unmatched');
			if (result.ok === false) {
				const error = result.error;
				const message = error !== null && error !== undefined ? asText(error.message) : '';
				const code = error !== null && error !== undefined ? asText(error.code) : '';
				if (message !== '' && code !== '') return message + ' (' + code + ')';
				if (message !== '') return message;
				if (code !== '') return code;
				return t('error.failed', { message: 'unknown' });
			}
			if (result.value === undefined || result.value === null) return t('error.unmatched');
			const outcome = result.value.result;
			if (
				outcome !== null &&
				outcome !== undefined &&
				outcome.kind === 'error' &&
				asText(outcome.text) !== ''
			) {
				return outcome.text;
			}
			return null;
		}

		/** Message for a thrown/rejected command call (duck-typed: rejected values may cross realms). */
		function thrownMessage(error, t) {
			if (error !== null && error !== undefined) {
				if (typeof error === 'object' && typeof error.message === 'string' && error.message !== '') {
					return t('error.failed', { message: error.message });
				}
				if (typeof error === 'string' && error !== '') return t('error.failed', { message: error });
			}
			return t('error.failed', { message: 'unknown' });
		}

		/** Run a layout-affecting effect before paint when the React face supports it. */
		const useIsomorphicLayoutEffect =
			typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;

		/** Translate function fallback so a missing `t` seat can never crash a render. */
		function fallbackTranslate(key) {
			return key;
		}

		/** Resolve the slot's translator seat defensively. */
		function translatorOf(props) {
			return typeof props.t === 'function' ? props.t : fallbackTranslate;
		}

		// ------------------------------------------------------------------
		// Locale (`zh` is the key-set source of truth; `en` must stay identical)
		// ------------------------------------------------------------------

		const zh = {
			'chip.fallback': '时间窗',
			'chip.title': '时间窗：{window} · 点击设置',
			'chip.aria': '时间窗控件：{window}',
			'chip.pending': '窗口未确认',
			'label.default': '默认 · 不限',
			'label.recent': '默认 · 近{span}',
			'label.pinned': '{asOf} · {span}',
			'label.spanPinned': '前{span}',
			'label.asOfDefault': '默认',
			'label.unit.day.one': '{amount}天',
			'label.unit.day.other': '{amount}天',
			'label.unit.month.one': '{amount}个月',
			'label.unit.month.other': '{amount}个月',
			'label.unit.year.one': '{amount}年',
			'label.unit.year.other': '{amount}年',
			'panel.title': '时间锚定',
			'panel.current': '当前：{window}',
			'panel.asOf': '时间点',
			'panel.asOfPlaceholder': '2000-01-01 / 公元前200年 / 3000',
			'panel.asOfHint': '留空 = 跟随本地当前时间',
			'panel.span': '检索范围',
			'panel.spanPlaceholder': '不限 / 7天 / 6个月 / 10年',
			'panel.hint': '受限模式下只使用带日期且在时间窗内的来源；无日期来源一律排除。',
			'panel.apply': '应用',
			'panel.applying': '应用中…',
			'panel.clear': '清空回默认',
			'panel.close': '关闭',
			'span.none': '不限',
			'span.d7': '7天',
			'span.d30': '30天',
			'span.y1': '1年',
			'span.y10': '10年',
			'span.y100': '100年',
			'future.title': '未来视角',
			'future.body': '模型不知道未来。以下回答按设定视角推演，不是事实预测。',
			'future.dismiss': '知道了',
			'error.applyUnavailable': '控件未就绪，无法提交 /pin 命令',
			'error.commandUnavailable': '命令服务不可用，请直接在输入框输入 /pin …',
			'error.failed': '命令执行失败：{message}',
			'error.unmatched': '无法识别的 /pin 命令',
			'settings.title': '时间锚定设置',
			'settings.summary': '模型提示 {locale} · 静默播报 {state} · {first} / {repeat}',
			'settings.promptLocale.label': '模型提示语言',
			'settings.promptLocale.hint': '只影响 Host 注入给模型的提示文字，不改变本界面语言。',
			'settings.promptLocale.zh': '中文',
			'settings.promptLocale.en': 'English',
			'settings.silence.enabled': '静默播报',
			'settings.silence.on': '开',
			'settings.silence.off': '关',
			'settings.silence.firstDelay': '首次提示延迟',
			'settings.silence.firstDelayHint': '任务连续无输出多久后开始播报，单位秒（1–86400）。',
			'settings.silence.repeat': '更新间隔',
			'settings.silence.repeatHint': '同一任务两次播报之间的最小间隔，单位秒（1–86400）。',
			'settings.seconds': '秒',
			'settings.readOnly': '本部署的设置为只读，只能查看。',
			'settings.loading': '正在读取设置…',
			'settings.unavailable': '该插件当前未加载，暂时无法配置。',
			'settings.saved': '已保存',
			'settings.failed': '保存失败',
			'settings.invalidNumber': '请填数字（秒），留空不会保存。',
		};

		const en = {
			'chip.fallback': 'Time window',
			'chip.title': 'Time window: {window} · click to set',
			'chip.aria': 'Time window control: {window}',
			'chip.pending': 'window unconfirmed',
			'label.default': 'Default · Unlimited',
			'label.recent': 'Default · last {span}',
			'label.pinned': '{asOf} · {span}',
			'label.spanPinned': 'last {span}',
			'label.asOfDefault': 'Default',
			'label.unit.day.one': '{amount} day',
			'label.unit.day.other': '{amount} days',
			'label.unit.month.one': '{amount} month',
			'label.unit.month.other': '{amount} months',
			'label.unit.year.one': '{amount} year',
			'label.unit.year.other': '{amount} years',
			'panel.title': 'Time Anchor',
			'panel.current': 'Current: {window}',
			'panel.asOf': 'As of',
			'panel.asOfPlaceholder': '2000-01-01 / 200 BC / 3000',
			'panel.asOfHint': 'Leave empty to follow the local clock',
			'panel.span': 'Lookback span',
			'panel.spanPlaceholder': 'unlimited / 7 days / 6 months / 10 years',
			'panel.hint': 'In restricted mode only dated sources inside the window are used; undated sources are excluded.',
			'panel.apply': 'Apply',
			'panel.applying': 'Applying…',
			'panel.clear': 'Clear to default',
			'panel.close': 'Close',
			'span.none': 'Unlimited',
			'span.d7': '7 days',
			'span.d30': '30 days',
			'span.y1': '1 year',
			'span.y10': '10 years',
			'span.y100': '100 years',
			'future.title': 'Future view',
			'future.body':
				'The model does not know the future. Answers are in-universe speculation from the pinned viewpoint, not factual predictions.',
			'future.dismiss': 'Got it',
			'error.applyUnavailable': 'The control is not ready to submit /pin',
			'error.commandUnavailable':
				'The command service is unavailable; type /pin … in the composer instead',
			'error.failed': 'Command failed: {message}',
			'error.unmatched': 'The /pin command was not recognized',
			'settings.title': 'Time Anchor settings',
			'settings.summary': 'Model prompt {locale} · silence narration {state} · {first} / {repeat}',
			'settings.promptLocale.label': 'Model prompt language',
			'settings.promptLocale.hint':
				'Only changes the Host copy injected for the model, not this interface language.',
			'settings.promptLocale.zh': '中文',
			'settings.promptLocale.en': 'English',
			'settings.silence.enabled': 'Silence narration',
			'settings.silence.on': 'on',
			'settings.silence.off': 'off',
			'settings.silence.firstDelay': 'First reminder delay',
			'settings.silence.firstDelayHint':
				'How long a task may stay silent before the first narration, in seconds (1–86400).',
			'settings.silence.repeat': 'Update interval',
			'settings.silence.repeatHint':
				'Minimum gap between two narrations of the same task, in seconds (1–86400).',
			'settings.seconds': 's',
			'settings.readOnly': 'Settings are read-only in this deployment.',
			'settings.loading': 'Loading settings…',
			'settings.unavailable': 'This plugin is not loaded, so it cannot be configured right now.',
			'settings.saved': 'Saved',
			'settings.failed': 'Not saved',
			'settings.invalidNumber': 'Enter a number of seconds; empty values are not saved.',
		};

		// ------------------------------------------------------------------
		// Styles (host theme tokens only; `dshtp_` prefix is ours)
		// ------------------------------------------------------------------

		const STYLE_TAG_ID = 'dsh-time-pin/client.css';

		const CSS = [
			'.dshtp_root{position:relative;display:inline-flex;align-items:center;flex:none;min-width:0}',
			'.dshtp_chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;max-width:220px;height:28px;padding:0 8px;margin:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;overflow:hidden}',
			'.dshtp_chip:hover,.dshtp_chip:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.dshtp_chip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.dshtp_chip[data-mode=past],.dshtp_chip[data-mode=recent]{color:var(--dsw-alias-label-primary)}',
			'.dshtp_chip[data-mode=future]{color:var(--dsw-alias-state-business-primary)}',
			'.dshtp_glyph{flex:none;font-size:12px;line-height:1}',
			'.dshtp_label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
			'.dshtp_pending{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-warn-primary)}',
			'.dshtp_panel{position:fixed;z-index:120;box-sizing:border-box;width:336px;max-width:calc(100vw - 24px);max-height:min(420px,calc(100vh - 32px));overflow:auto;padding:12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter,none);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px;text-align:left;display:flex;flex-direction:column;gap:10px}',
			'.dshtp_head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
			'.dshtp_title{color:var(--dsw-alias-label-secondary);font-weight:500}',
			'.dshtp_close{flex:none;display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:18px;cursor:pointer}',
			'.dshtp_close:hover,.dshtp_close:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dshtp_current{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}',
			'.dshtp_field{display:flex;flex-direction:column;gap:4px}',
			'.dshtp_fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
			'.dshtp_input{box-sizing:border-box;width:100%;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}',
			'.dshtp_input::placeholder{color:var(--dsw-alias-label-caption)}',
			'.dshtp_input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-color:var(--dsw-alias-state-business-primary)}',
			'.dshtp_presets{display:flex;flex-wrap:wrap;gap:6px}',
			'.dshtp_preset{box-sizing:border-box;height:24px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
			'.dshtp_preset:hover,.dshtp_preset:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dshtp_preset:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.dshtp_preset[data-active=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
			'.dshtp_actions{display:flex;align-items:center;gap:8px}',
			'.dshtp_primary{box-sizing:border-box;height:28px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
			'.dshtp_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
			'.dshtp_primary:disabled{opacity:.6;cursor:default}',
			'.dshtp_secondary{box-sizing:border-box;height:28px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}',
			'.dshtp_secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dshtp_error{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-label-error);padding:4px 8px;font-size:12px;line-height:18px;overflow-wrap:anywhere}',
			'.dshtp_warn{display:flex;flex-direction:column;gap:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);padding:8px 10px;font-size:12px;line-height:18px}',
			'.dshtp_warnTitle{font-weight:600}',
			'.dshtp_warnDismiss{align-self:flex-start;margin-top:2px;height:22px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-warn-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
			'.dshtp_warnDismiss:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}',
			'.dshtp_hint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
			'.dshtp_set{display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;padding:4px 0}',
			'.dshtp_setMuted{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}',
			'.dshtp_setTitle{color:var(--dsw-alias-label-secondary);font-weight:500}',
			'.dshtp_setRow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}',
			'.dshtp_setLabel{flex:none;color:var(--dsw-alias-label-primary)}',
			'.dshtp_setSeg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform)}',
			'.dshtp_setBtn{box-sizing:border-box;height:24px;padding:0 10px;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
			'.dshtp_setBtn:hover:not(:disabled),.dshtp_setBtn:focus-visible{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dshtp_setBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
			'.dshtp_setBtn[data-active=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
			'.dshtp_setBtn[data-active=true]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}',
			'.dshtp_setBtn:disabled{opacity:.6;cursor:default}',
			'.dshtp_setNum{display:inline-flex;align-items:center;gap:6px}',
			'.dshtp_setInput{box-sizing:border-box;width:76px;height:28px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:right}',
			'.dshtp_setInput:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-color:var(--dsw-alias-state-business-primary)}',
			'.dshtp_setInput:disabled{opacity:.6;cursor:default}',
			'.dshtp_setUnit{flex:none;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}',
			'.dshtp_setHint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}',
			'.dshtp_setStatus{border-radius:var(--dsw-radius-sm);padding:4px 8px;font-size:12px;line-height:18px;overflow-wrap:anywhere}',
			'.dshtp_setStatus[data-time-pin-settings-status=saved]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.dshtp_setStatus[data-time-pin-settings-status=failed]{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-label-error)}',
		].join('');

		/** Shared no-op effect disposer (the stylesheet is installed once). */
		function noop() {}

		/**
		 * Insert this plugin's single stylesheet.
		 * @returns a disposer that removes exactly the tag it created.
		 */
		function installStyles() {
			if (typeof document === 'undefined' || document === null) return noop;
			const head = document.head;
			if (head === null || head === undefined) return noop;
			const existing = document.querySelector(
				'style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']',
			);
			if (existing !== null) return noop;
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-time-pin';
			tag.dataset.pluginCss = STYLE_TAG_ID;
			tag.textContent = CSS;
			head.appendChild(tag);
			return function removeStyle() {
				if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
			};
		}

		// ------------------------------------------------------------------
		// Header chip + popover panel
		// ------------------------------------------------------------------

		/** The panel: as-of field, span field with presets, Apply / Clear, inline error. */
		function TimePinPanel(props) {
			const t = translatorOf(props);
			const view = props.view;
			const submitCommand = props.submit;
			const sessionId = props.sessionId;
			const anchor = props.anchor;
			const panelRef = props.panelRef;
			const onRequestClose = props.onRequestClose;

			const now = Date.now();
			const mode = resolveMode(view, now);
			const isFuture = mode === 'future';

			const [asOfText, setAsOfText] = React.useState(() => asText(view.asOfInput));
			const [spanText, setSpanText] = React.useState(() => asText(view.spanInput));
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [warningVisible, setWarningVisible] = React.useState(
				() => isFuture && !futureWarningDismissed.has(String(sessionId)),
			);
			const inputRef = React.useRef(null);
			const aliveRef = React.useRef(true);
			const focusedRef = React.useRef(false);

			React.useEffect(() => {
				aliveRef.current = true;
				return () => {
					aliveRef.current = false;
				};
			}, []);

			// The panel is laid out only after the first placement; focus then.
			React.useEffect(() => {
				if (focusedRef.current || anchor === null) return;
				const input = inputRef.current;
				if (input === null) return;
				focusedRef.current = true;
				if (typeof input.focus === 'function') input.focus();
				if (typeof input.select === 'function') input.select();
			}, [anchor]);

			const submit = (line) => {
				if (busy) return;
				if (typeof submitCommand !== 'function') {
					setError(t('error.applyUnavailable'));
					return;
				}
				setBusy(true);
				setError(null);
				let pending;
				try {
					pending = Promise.resolve(submitCommand(line));
				} catch (thrown) {
					if (!aliveRef.current) return;
					setBusy(false);
					setError(thrownMessage(thrown, t));
					return;
				}
				pending.then(
					(result) => {
						if (!aliveRef.current) return;
						setBusy(false);
						const failure = failureOf(result, t);
						if (failure !== null) {
							setError(failure);
							return;
						}
						onRequestClose();
					},
					(thrown) => {
						if (!aliveRef.current) return;
						setBusy(false);
						setError(thrownMessage(thrown, t));
					},
				);
			};

			const applyNow = () => submit(composeLine(asOfText, spanText));
			const clearNow = () => submit('/pin off');

			const spanRef = React.useRef(null);

			// Preset tokens are the localized labels the Host parser accepts in both
			// languages (`7天` / `7 days`, `不限` / `Unlimited`); the `不限` preset
			// spells the unlimited token out so Apply submits an explicit
			// `/pin <as-of> 不限` rather than silently keeping the previous span.
			const presets = [
				{ id: 'none', labelKey: 'span.none', token: t('span.none') },
				{ id: 'd7', labelKey: 'span.d7', token: t('span.d7') },
				{ id: 'd30', labelKey: 'span.d30', token: t('span.d30') },
				{ id: 'y1', labelKey: 'span.y1', token: t('span.y1') },
				{ id: 'y10', labelKey: 'span.y10', token: t('span.y10') },
				{ id: 'y100', labelKey: 'span.y100', token: t('span.y100') },
			];

			const currentSpan = trimmed(spanText);
			const presetRow = React.createElement(
				'div',
				{ className: 'dshtp_presets' },
				presets.map((preset) => {
					const active =
						preset.id === 'none'
							? currentSpan === '' || SPAN_NONE.test(currentSpan)
							: currentSpan === preset.token;
					return React.createElement(
						'button',
						{
							key: preset.id,
							type: 'button',
							className: 'dshtp_preset',
							'data-time-pin-preset': preset.id,
							'data-active': active ? 'true' : 'false',
							'aria-pressed': active,
							onClick: () => {
								setSpanText(preset.token);
								setError(null);
								const input = spanRef.current;
								if (input !== null && typeof input.focus === 'function') input.focus();
							},
						},
						t(preset.labelKey),
					);
				}),
			);

			const header = React.createElement(
				'div',
				{ className: 'dshtp_head' },
				React.createElement('span', { className: 'dshtp_title' }, t('panel.title')),
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'dshtp_close',
						'aria-label': t('panel.close'),
						title: t('panel.close'),
						onClick: () => onRequestClose(),
					},
					'×',
				),
			);

			const warning = warningVisible
				? React.createElement(
						'div',
						{
							className: 'dshtp_warn',
							role: 'note',
							'data-time-pin-future-warning': true,
						},
						React.createElement('div', { className: 'dshtp_warnTitle' }, t('future.title')),
						React.createElement('div', { className: 'dshtp_warnBody' }, t('future.body')),
						React.createElement(
							'button',
							{
								type: 'button',
								className: 'dshtp_warnDismiss',
								onClick: () => {
									futureWarningDismissed.add(String(sessionId));
									setWarningVisible(false);
								},
							},
							t('future.dismiss'),
						),
					)
				: null;

			const asOfField = React.createElement(
				'label',
				{ className: 'dshtp_field' },
				React.createElement('span', { className: 'dshtp_fieldLabel' }, t('panel.asOf')),
				React.createElement('input', {
					ref: inputRef,
					type: 'text',
					className: 'dshtp_input',
					'data-time-pin-asof': true,
					value: asOfText,
					placeholder: t('panel.asOfPlaceholder'),
					title: t('panel.asOfHint'),
					spellCheck: false,
					autoComplete: 'off',
					onChange: (event) => {
						setAsOfText(event.target.value);
						setError(null);
					},
					onKeyDown: (event) => {
						if (event.key !== 'Enter') return;
						event.preventDefault();
						applyNow();
					},
				}),
			);

			const spanField = React.createElement(
				'label',
				{ className: 'dshtp_field' },
				React.createElement('span', { className: 'dshtp_fieldLabel' }, t('panel.span')),
				React.createElement('input', {
					ref: spanRef,
					type: 'text',
					className: 'dshtp_input',
					'data-time-pin-span': true,
					value: spanText,
					placeholder: t('panel.spanPlaceholder'),
					spellCheck: false,
					autoComplete: 'off',
					onChange: (event) => {
						setSpanText(event.target.value);
						setError(null);
					},
					onKeyDown: (event) => {
						if (event.key !== 'Enter') return;
						event.preventDefault();
						applyNow();
					},
				}),
				presetRow,
			);

			const footer = React.createElement(
				'div',
				{ className: 'dshtp_actions' },
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'dshtp_primary',
						disabled: busy,
						'data-time-pin-apply': true,
						onClick: applyNow,
					},
					busy ? t('panel.applying') : t('panel.apply'),
				),
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'dshtp_secondary',
						disabled: busy,
						'data-time-pin-clear': true,
						onClick: clearNow,
					},
					t('panel.clear'),
				),
			);

			const errorLine =
				error === null
					? null
					: React.createElement(
							'div',
							{ className: 'dshtp_error', role: 'alert', 'data-time-pin-error': true },
							error,
						);

			const style =
				anchor === null
					? { visibility: 'hidden', left: 0, top: 0 }
					: { left: anchor.left, top: anchor.top };

			return React.createElement(
				'div',
				{
					ref: panelRef,
					className: 'dshtp_panel',
					'data-time-pin-panel': true,
					role: 'dialog',
					'aria-label': t('panel.title'),
					style: style,
				},
				header,
				React.createElement(
					'div',
					{ className: 'dshtp_current' },
					t('panel.current', { window: windowLabelOf(view, t) }),
				),
				warning,
				asOfField,
				spanField,
				footer,
				errorLine,
				React.createElement('div', { className: 'dshtp_hint' }, t('panel.hint')),
			);
		}

		/**
		 * Header chip for the `timePin` projection.
		 *
		 * Renders nothing without a projection (never a blank or placeholder
		 * control: the header must not advertise a window it cannot read).
		 */
		function TimePinChip(props) {
			const t = translatorOf(props);
			const sessionId = props.sessionId;
			const useProjection = props.useProjection;

			const view =
				typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined;

			const [open, setOpen] = React.useState(false);
			const [anchor, setAnchor] = React.useState(null);
			const rootRef = React.useRef(null);
			const triggerRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const placeRef = React.useRef(null);
			const correctionsRef = React.useRef(0);

			// Latest placement closure: recomputed on every open/resize/scroll so
			// the fixed panel tracks the trigger without a portal.
			placeRef.current = () => {
				const trigger = triggerRef.current;
				if (trigger === null || typeof window === 'undefined') return;
				const rect = trigger.getBoundingClientRect();
				const viewportWidth =
					typeof window.innerWidth === 'number' && window.innerWidth > 0
						? window.innerWidth
						: PANEL_WIDTH + VIEWPORT_MARGIN * 2;
				const width = Math.min(PANEL_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2);
				const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
				const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.right - width), maxLeft);
				setAnchor({ left: left, top: rect.bottom + PANEL_GAP });
			};

			// Track the trigger while open (window resize and any scroll inside the
			// conversation pane, captured so nested scrollers count too).
			useIsomorphicLayoutEffect(() => {
				if (!open) return undefined;
				if (typeof window === 'undefined') return undefined;
				correctionsRef.current = 0;
				const reposition = () => {
					if (placeRef.current !== null) placeRef.current();
				};
				reposition();
				window.addEventListener('resize', reposition);
				window.addEventListener('scroll', reposition, true);
				return () => {
					window.removeEventListener('resize', reposition);
					window.removeEventListener('scroll', reposition, true);
				};
			}, [open]);

			// Layout containment (`container-type` on the header title row) turns
			// `position: fixed` into "fixed against that ancestor". Measure where
			// the panel actually landed and cancel the offset — at most a few
			// times per opening, so a pathological layout can never loop.
			useIsomorphicLayoutEffect(() => {
				if (!open || anchor === null) return;
				if (correctionsRef.current >= MAX_PLACEMENT_CORRECTIONS) return;
				const panel = panelRef.current;
				if (panel === null) return;
				const rect = panel.getBoundingClientRect();
				const dx = rect.left - anchor.left;
				const dy = rect.top - anchor.top;
				if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
				correctionsRef.current += 1;
				setAnchor({ left: anchor.left - dx, top: anchor.top - dy });
			}, [open, anchor]);

			// Outside pointer press closes. The panel is portaled to
			// `document.body`, so "inside" covers both the chip wrapper and the
			// panel node itself.
			React.useEffect(() => {
				if (!open || typeof document === 'undefined') return undefined;
				const onPointerDown = (event) => {
					const root = rootRef.current;
					const panelNode = panelRef.current;
					const target = event.target;
					if (target === null || target === undefined) return;
					const inRoot =
						root !== null && typeof root.contains === 'function' && root.contains(target);
					const inPanel =
						panelNode !== null &&
						typeof panelNode.contains === 'function' &&
						panelNode.contains(target);
					if (inRoot || inPanel) return;
					setOpen(false);
				};
				document.addEventListener('mousedown', onPointerDown, true);
				document.addEventListener('touchstart', onPointerDown, true);
				return () => {
					document.removeEventListener('mousedown', onPointerDown, true);
					document.removeEventListener('touchstart', onPointerDown, true);
				};
			}, [open]);

			// Escape closes and returns focus to the trigger.
			React.useEffect(() => {
				if (!open || typeof document === 'undefined') return undefined;
				const onKeyDown = (event) => {
					if (event.key !== 'Escape') return;
					event.preventDefault();
					setOpen(false);
					const trigger = triggerRef.current;
					if (trigger !== null && typeof trigger.focus === 'function') trigger.focus();
				};
				document.addEventListener('keydown', onKeyDown, true);
				return () => document.removeEventListener('keydown', onKeyDown, true);
			}, [open]);

			if (view === undefined || view === null) return null;

			const now = Date.now();
			const mode = resolveMode(view, now);
			const label = windowLabelOf(view, t);
			const pending = view.anchorPending === true;
			const title =
				t('chip.title', { window: label }) + (pending ? ' · ' + t('chip.pending') : '');

			const trigger = React.createElement(
				'button',
				{
					ref: triggerRef,
					type: 'button',
					className: 'dshtp_chip',
					'data-time-pin-chip': true,
					'data-mode': mode,
					'aria-haspopup': 'dialog',
					'aria-expanded': open,
					'aria-label': t('chip.aria', { window: label }),
					title: title,
					onClick: () => {
						setOpen((current) => !current);
					},
				},
				React.createElement('span', { className: 'dshtp_glyph', 'aria-hidden': 'true' }, glyphFor(mode)),
				React.createElement('span', { className: 'dshtp_label' }, label),
				pending
					? React.createElement('span', {
							className: 'dshtp_pending',
							'aria-hidden': 'true',
						})
					: null,
			);

			const closePanel = () => {
				setOpen(false);
				const triggerNode = triggerRef.current;
				if (triggerNode !== null && typeof triggerNode.focus === 'function') triggerNode.focus();
			};

			const panel = open
				? React.createElement(TimePinPanel, {
						t: t,
						view: view,
						sessionId: sessionId,
						submit: props.apply,
						anchor: anchor,
						panelRef: panelRef,
						onRequestClose: closePanel,
					})
				: null;

			// The header actions slot clips its children; portal the panel to the
			// body so it stays visible and clickable. Inline rendering is only a
			// fallback for a shell without react-dom.
			const portaledPanel =
				panel !== null &&
				typeof document !== 'undefined' &&
				typeof document.body !== 'undefined' &&
				ReactDOM !== null &&
				typeof ReactDOM.createPortal === 'function'
					? ReactDOM.createPortal(panel, document.body)
					: panel;

			return React.createElement(
				'div',
				{ ref: rootRef, className: 'dshtp_root', 'data-time-pin-root': true },
				trigger,
				portaledPanel,
			);
		}

		// ------------------------------------------------------------------
		// Plugins-page settings (the Host's own `configForms` configuration)
		// ------------------------------------------------------------------

		/** Milliseconds bounds the Host schema accepts for `silence.*Ms`. */
		const DELAY_MIN_MS = 1_000;
		const DELAY_MAX_MS = 86_400_000;
		/** Shipped Host defaults, shown only until the form delivers a value. */
		const FIRST_DELAY_DEFAULT_MS = 90_000;
		const REPEAT_DEFAULT_MS = 180_000;
		/**
		 * Loader entry ids this bundle's Host configuration can be served under:
		 * the bare package name, or its `include:` wrapper when the profile
		 * mounts the bundle through an include layer.
		 */
		const SETTINGS_CANDIDATES = ['dsh-time-pin', 'include:dsh-time-pin'];
		/** Key of the bundle row's configuration seat: `<package>#<row id>`. */
		const ROW_CONFIG_KEY = 'dsh-time-pin#dsh-time-pin';
		/** The same row addressed under the `include:` namespace spelling. */
		const ROW_CONFIG_INCLUDE_KEY = 'dsh-time-pin#include:dsh-time-pin';
		/** Key of the bundle-level configuration seat (the package name). */
		const BUNDLE_CONFIG_KEY = 'dsh-time-pin';

		/** Clamp one millisecond setting into the Host schema bounds. */
		function clampDelayMs(value, fallback) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
			return Math.min(DELAY_MAX_MS, Math.max(DELAY_MIN_MS, Math.round(value)));
		}

		/** Compact duration for the summary line (`90s`, `3min`). */
		function secondsText(ms) {
			const seconds = Math.max(0, Math.round(ms / 1000));
			if (seconds >= 60 && seconds % 60 === 0) return String(seconds / 60) + 'min';
			return String(seconds) + 's';
		}

		/** Normalize a `ConfigFormController` snapshot into the shape this page renders. */
		function settingsValueOf(snapshot) {
			const raw = snapshot !== null && snapshot !== undefined ? snapshot.value : undefined;
			const value = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : {};
			const silence =
				value.silence !== null && value.silence !== undefined && typeof value.silence === 'object'
					? value.silence
					: {};
			return {
				promptLocale: value.promptLocale === 'en' ? 'en' : 'zh',
				silence: {
					enabled: silence.enabled !== false,
					firstDelayMs: clampDelayMs(silence.firstDelayMs, FIRST_DELAY_DEFAULT_MS),
					repeatMs: clampDelayMs(silence.repeatMs, REPEAT_DEFAULT_MS),
				},
			};
		}

		/** Defensive snapshot read: a missing form must never crash a render. */
		function snapshotOf(form) {
			if (form === null || form === undefined || typeof form.getSnapshot !== 'function') {
				return null;
			}
			return form.getSnapshot();
		}

		/** The one-line summary the bundle row uses as its description fallback. */
		function settingsSummaryOf(value, t) {
			return t('settings.summary', {
				locale: value.promptLocale,
				state: value.silence.enabled ? t('settings.silence.on') : t('settings.silence.off'),
				first: secondsText(value.silence.firstDelayMs),
				repeat: secondsText(value.silence.repeatMs),
			});
		}

		/** Failure copy for a refused or rejected settings write. */
		function settingsFailureText(thrown, t) {
			const base = t('settings.failed');
			if (thrown !== null && thrown !== undefined) {
				if (typeof thrown === 'object' && typeof thrown.message === 'string' && thrown.message !== '') {
					return base + ' · ' + thrown.message;
				}
				if (typeof thrown === 'string' && thrown !== '') return base + ' · ' + thrown;
			}
			return base;
		}

		/**
		 * Build this bundle's Plugins-page configuration component.
		 *
		 * The component renders `view: 'summary'` as the row's one-liner and
		 * `view: 'page'` as the four settings rows. Values come from the shared
		 * `ConfigFormController` (`getSnapshot` + `subscribe`), writes go through
		 * its ordered `set` / `mutate` contract, and every refused or rejected
		 * write degrades to an inline status line instead of throwing.
		 *
		 * @param {{ form: object, t: Function }} options - the namespace's form controller and its translator.
		 * @returns {Function} the React component both configuration seats render.
		 */
		function makeSettingsComponent(options) {
			const form = options.form;
			const boundTranslate = typeof options.t === 'function' ? options.t : fallbackTranslate;

			/** The settings page / row summary. */
			function TimePinSettings(props) {
				const t = typeof props.t === 'function' ? props.t : boundTranslate;

				// Hooks run unconditionally: the first frame is often `loading`.
				const [snapshot, setSnapshot] = React.useState(() => snapshotOf(form));
				const [notice, setNotice] = React.useState(null);
				const aliveRef = React.useRef(true);

				React.useEffect(() => {
					aliveRef.current = true;
					const read = () => {
						if (!aliveRef.current) return;
						setSnapshot(snapshotOf(form));
					};
					let off = noop;
					if (form !== null && form !== undefined && typeof form.subscribe === 'function') {
						off = form.subscribe(read) || noop;
					}
					read();
					return () => {
						aliveRef.current = false;
						if (typeof off === 'function') off();
					};
				}, []);

				const value = settingsValueOf(snapshot);
				const status = snapshot !== null && snapshot !== undefined ? snapshot.status : 'loading';
				const readOnly = snapshot !== null && snapshot !== undefined && snapshot.writable === false;

				/** Report the settlement of one write (accepted boolean / rejection). */
				const announce = (pending) => {
					let settled;
					try {
						settled = Promise.resolve(pending);
					} catch (thrown) {
						if (aliveRef.current) setNotice({ tone: 'failed', text: settingsFailureText(thrown, t) });
						return;
					}
					settled.then(
						(accepted) => {
							if (!aliveRef.current) return;
							setNotice(
								accepted === false
									? { tone: 'failed', text: t('settings.failed') }
									: { tone: 'saved', text: t('settings.saved') },
							);
						},
						(thrown) => {
							if (!aliveRef.current) return;
							setNotice({ tone: 'failed', text: settingsFailureText(thrown, t) });
						},
					);
				};

				const choosePromptLocale = (locale) => {
					if (readOnly || typeof form.set !== 'function') return;
					announce(form.set('promptLocale', locale));
				};

				const chooseSilenceEnabled = (enabled) => {
					if (readOnly || typeof form.mutate !== 'function') return;
					announce(form.mutate([{ op: 'set', path: ['silence', 'enabled'], value: enabled }]));
				};

				/** Commit one seconds field; clamps to the Host's millisecond bounds. */
				const commitDelay = (field, text, fallback) => {
					if (readOnly || typeof form.mutate !== 'function') return;
					const seconds = Number.parseFloat(String(text === undefined ? '' : text).trim());
					if (!Number.isFinite(seconds)) {
						setNotice({ tone: 'failed', text: t('settings.invalidNumber') });
						return;
					}
					const valueMs = clampDelayMs(seconds * 1000, fallback);
					announce(form.mutate([{ op: 'set', path: ['silence', field], value: valueMs }]));
				};

				if (status !== 'ready') {
					const line =
						status === 'unavailable' ? t('settings.unavailable') : t('settings.loading');
					if (props.view === 'summary') return line;
					return React.createElement(
						'div',
						{ className: 'dshtp_set dshtp_setMuted', 'data-time-pin-settings': status },
						line,
					);
				}

				if (props.view === 'summary') return settingsSummaryOf(value, t);

				const localeButton = (id, labelKey) =>
					React.createElement(
						'button',
						{
							key: id,
							type: 'button',
							className: 'dshtp_setBtn',
							'data-time-pin-prompt-locale': id,
							'data-active': value.promptLocale === id ? 'true' : 'false',
							'aria-pressed': value.promptLocale === id,
							disabled: readOnly,
							onClick: () => choosePromptLocale(id),
						},
						t(labelKey),
					);

				const enabledButton = (enabled, labelKey) =>
					React.createElement(
						'button',
						{
							key: enabled ? 'on' : 'off',
							type: 'button',
							className: 'dshtp_setBtn',
							'data-time-pin-silence-toggle': enabled ? 'on' : 'off',
							'data-active': value.silence.enabled === enabled ? 'true' : 'false',
							'aria-pressed': value.silence.enabled === enabled,
							disabled: readOnly,
							onClick: () => chooseSilenceEnabled(enabled),
						},
						t(labelKey),
					);

				const numberField = (field, dataAttribute, currentMs, fallback) =>
					React.createElement(
						'div',
						{ className: 'dshtp_setNum' },
						React.createElement('input', {
							key:
								field +
								':' +
								String(snapshot === null || snapshot === undefined ? 0 : snapshot.revision),
							type: 'number',
							className: 'dshtp_setInput',
							[dataAttribute]: true,
							min: DELAY_MIN_MS / 1000,
							max: DELAY_MAX_MS / 1000,
							step: 1,
							defaultValue: String(Math.round(currentMs / 1000)),
							disabled: readOnly,
							spellCheck: false,
							autoComplete: 'off',
							onBlur: (event) =>
								commitDelay(
									field,
									event === null || event === undefined ? '' : event.target.value,
									fallback,
								),
							onKeyDown: (event) => {
								if (event.key !== 'Enter') return;
								event.preventDefault();
								commitDelay(field, event.target.value, fallback);
							},
						}),
						React.createElement('span', { className: 'dshtp_setUnit' }, t('settings.seconds')),
					);

				const localeRow = React.createElement(
					'div',
					{ className: 'dshtp_setRow' },
					React.createElement(
						'span',
						{ className: 'dshtp_setLabel' },
						t('settings.promptLocale.label'),
					),
					React.createElement(
						'div',
						{ className: 'dshtp_setSeg' },
						localeButton('zh', 'settings.promptLocale.zh'),
						localeButton('en', 'settings.promptLocale.en'),
					),
				);

				const silenceRow = React.createElement(
					'div',
					{ className: 'dshtp_setRow' },
					React.createElement('span', { className: 'dshtp_setLabel' }, t('settings.silence.enabled')),
					React.createElement(
						'div',
						{ className: 'dshtp_setSeg' },
						enabledButton(true, 'settings.silence.on'),
						enabledButton(false, 'settings.silence.off'),
					),
				);

				const firstDelayRow = React.createElement(
					'div',
					{ className: 'dshtp_setRow' },
					React.createElement(
						'span',
						{ className: 'dshtp_setLabel' },
						t('settings.silence.firstDelay'),
					),
					numberField('firstDelayMs', 'data-time-pin-first-delay', value.silence.firstDelayMs, FIRST_DELAY_DEFAULT_MS),
				);

				const repeatRow = React.createElement(
					'div',
					{ className: 'dshtp_setRow' },
					React.createElement('span', { className: 'dshtp_setLabel' }, t('settings.silence.repeat')),
					numberField('repeatMs', 'data-time-pin-repeat', value.silence.repeatMs, REPEAT_DEFAULT_MS),
				);

				const readOnlyLine = readOnly
					? React.createElement(
							'div',
							{ className: 'dshtp_setHint', 'data-time-pin-readonly': true },
							t('settings.readOnly'),
						)
					: null;

				const noticeLine =
					notice === null
						? null
						: React.createElement(
								'div',
								{
									className: 'dshtp_setStatus',
									'data-time-pin-settings-status': notice.tone,
									role: 'status',
								},
								notice.text,
							);

				return React.createElement(
					'div',
					{ className: 'dshtp_set', 'data-time-pin-settings': 'ready' },
					React.createElement('div', { className: 'dshtp_setTitle' }, t('settings.title')),
					localeRow,
					React.createElement(
						'div',
						{ className: 'dshtp_setHint' },
						t('settings.promptLocale.hint'),
					),
					silenceRow,
					firstDelayRow,
					React.createElement(
						'div',
						{ className: 'dshtp_setHint' },
						t('settings.silence.firstDelayHint'),
					),
					repeatRow,
					React.createElement(
						'div',
						{ className: 'dshtp_setHint' },
						t('settings.silence.repeatHint'),
					),
					readOnlyLine,
					noticeLine,
				);
			}

			return TimePinSettings;
		}

		// ------------------------------------------------------------------
		// Plugin wiring
		// ------------------------------------------------------------------

		/** Client services this plugin reads; all are shipped baseline services. */
		const inject = ['slots', 'remote', 'remote.commands', 'locale'];

		/**
		 * Register the locale dictionaries, the single stylesheet and the header
		 * chip for the lifetime of `ctx`. When the settings UI is composed, also
		 * occupy this bundle's configuration seats.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);

			ctx.effect(
				() => ctx.locale.register(NS, { zh, en }),
				'dsh-time-pin: locale dictionaries',
			);
			ctx.effect(() => installStyles(), 'dsh-time-pin: stylesheet');

			ctx.slots.inject('conversation.session.header.actions', () =>
				ctx.slots.register(
					{
						name: 'conversation.session.header.actions',
						id: 'time-pin',
						order: -15,
						locale: NS,
						inject: (sessionId) => ({
							apply: (line) => ctx.remote.commands.execute(sessionId, line, []),
						}),
					},
					TimePinChip,
				),
			);

			// `configForms` is an OPTIONAL dependency: inject() runs this block only
			// while the settings UI is composed, so the chip never depends on it.
			ctx.inject(['configForms'], (cfgCtx) => {
				cfgCtx.effect(
					() =>
						cfgCtx.configForms.whileServed(SETTINGS_CANDIDATES, (served) => {
							const namespace = SETTINGS_CANDIDATES.find((candidate) => served.has(candidate));
							if (namespace === undefined) return noop;
							const form = cfgCtx.configForms.get(namespace);
							const component = makeSettingsComponent({ form, t });
							// The same component occupies every configuration seat this bundle
							// can be dispatched under; keys the owner never dispatches are inert.
							const disposers = [
								cfgCtx.slots.inject('plugins.row.config', () =>
									cfgCtx.slots.register(
										{ name: 'plugins.row.config', key: ROW_CONFIG_KEY, locale: NS },
										component,
									),
								),
								cfgCtx.slots.inject('plugins.row.config', () =>
									cfgCtx.slots.register(
										{ name: 'plugins.row.config', key: ROW_CONFIG_INCLUDE_KEY, locale: NS },
										component,
									),
								),
								cfgCtx.slots.inject('plugins.bundle.config', () =>
									cfgCtx.slots.register(
										{ name: 'plugins.bundle.config', key: BUNDLE_CONFIG_KEY, locale: NS },
										component,
									),
								),
							];
							return () => {
								for (const dispose of disposers) dispose();
							};
						}),
					'dsh-time-pin: settings page',
				);
			});
		}

		return { inject, apply };
	},
});
