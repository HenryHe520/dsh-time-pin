/**
 * Client-half smoke + behavior tests for dsh-time-pin.
 *
 * The browser bundle is loaded in a `node:vm` context with a stub
 * `window.__ModuleLoader__` (captures the factory) and a stub `require`
 * (`require('react')` returns a hook-recording React stand-in). No DOM is
 * involved: the component functions are pure props -> element trees, so a
 * plain object tree is enough to walk buttons, call their handlers and assert
 * both the rendered copy and the `/pin …` line submitted through the injected
 * command face.
 *
 * Covers: the lazy-bundle contract, the optional `configForms` settings page
 * (`plugins.row.config` / `plugins.bundle.config` seats, summary line, page
 * rows, `form.set` / `form.mutate` writes, seconds -> ms clamping, write
 * failures, read-only and loading states), key-identical locale dictionaries,
 * the localized window label, chip/panel rendering and command composition for
 * every as-of/span form, the inline command failures and the per-session future
 * warning. The removed silence status bar is asserted absent from the bundle
 * source and from the slot/locale surface.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const CLIENT_PATH = new URL('../lib/client.js', import.meta.url);
const PLUGIN_ID = 'dsh-time-pin';
const REQUIRED_SERVICES = ['slots', 'remote', 'remote.commands', 'locale'];

// ---------------------------------------------------------------------------
// Harness: a tiny React stand-in and a vm-loaded bundle
// ---------------------------------------------------------------------------

/** A React stand-in: records state updates, effects and returns plain element objects. */
function createReactStub() {
	const stub = {
		__stateIndex: 0,
		__stateOverrides: null,
		__updates: [],
		__effects: [],
		Fragment: Symbol('Fragment'),
		createElement(type, props, ...children) {
			const merged = {};
			if (props !== null && typeof props === 'object') {
				for (const key of Object.keys(props)) merged[key] = props[key];
			}
			const flat = [];
			for (const child of children) {
				if (Array.isArray(child)) {
					for (const nested of child) flat.push(nested);
				} else {
					flat.push(child);
				}
			}
			return { type, props: merged, children: flat };
		},
		useState(initial) {
			const index = stub.__stateIndex;
			stub.__stateIndex += 1;
			const overrides = stub.__stateOverrides;
			const value =
				overrides !== null && index < overrides.length
					? overrides[index]
					: typeof initial === 'function'
						? initial()
						: initial;
			const setter = (next) => {
				stub.__updates.push(typeof next === 'function' ? next(value) : next);
			};
			return [value, setter];
		},
		useEffect(callback) {
			stub.__effects.push(callback);
		},
		useLayoutEffect(callback) {
			stub.__effects.push(callback);
		},
		useInsertionEffect() {},
		useRef(value) {
			return { current: value === undefined ? null : value };
		},
		useMemo(factory) {
			return factory();
		},
		useCallback(callback) {
			return callback;
		},
		memo(component) {
			return component;
		},
	};

	/**
	 * Render one component function with stub hooks, resetting the hook cursor.
	 * @param {Function} component
	 * @param {object} props
	 * @param {unknown[] | null} stateOverrides - values for this component's useState calls, in order.
	 */
	stub.render = (component, props, stateOverrides = null) => {
		stub.__stateIndex = 0;
		stub.__stateOverrides = stateOverrides;
		stub.__updates = [];
		stub.__effects = [];
		return component(props);
	};

	return stub;
}

/** Load the bundle and return its captured factory registration. */
function loadBundle(options = {}) {
	const source = readFileSync(CLIENT_PATH, 'utf8');
	const captured = new Map();
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(entry) {
					captured.set(entry.id, entry);
				},
				create() {
					throw new Error('the test never boots the module system');
				},
			},
		},
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		...(options.document === undefined ? {} : { document: options.document }),
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: 'lib/client.js' });
	return captured;
}

/** The settings value the fake Host form serves before any write. */
const DEFAULT_SETTINGS_VALUE = {
	promptLocale: 'zh',
	silence: { enabled: true, firstDelayMs: 90_000, repeatMs: 180_000 },
};

/** Structured clone through JSON: host-realm literals for strict deepEqual. */
function jsonClone(value) {
	return JSON.parse(JSON.stringify(value));
}

/** Apply one `{op:'set', path}` batch to a settings value (fake Host write). */
function applySettingsOps(value, ops) {
	const next = { ...value, silence: { ...value.silence } };
	for (const op of ops) {
		if (op === null || typeof op !== 'object' || op.op !== 'set') continue;
		if (op.path.length === 1) next[op.path[0]] = op.value;
		else next[op.path[0]] = { ...next[op.path[0]], [op.path[1]]: op.value };
	}
	return next;
}

/**
 * Build a fake Cordis client context and capture what `apply` registers.
 *
 * @param {object} [options]
 * @param {string[] | null} [options.served] - namespaces the fake Host serves (`null` = none).
 * @param {boolean} [options.configForms] - whether the optional `configForms` service exists.
 * @param {boolean} [options.writable] - the Host document's writability.
 * @param {object} [options.snapshot] - a fixed form snapshot (skips the fake writes).
 * @param {boolean} [options.setResult] - value `form.set` resolves to.
 * @param {boolean} [options.mutateResult] - value `form.mutate` resolves to.
 */
function createFakeContext(options = {}) {
	const served =
		options.served === undefined ? ['dsh-time-pin', 'include:dsh-time-pin'] : options.served;
	const writable = options.writable === undefined ? true : options.writable;
	const captured = {
		slots: [],
		locales: [],
		effects: [],
		commands: [],
		injections: [],
		whileServed: [],
		formGets: [],
		formSets: [],
		formMutations: [],
		formSubscriptions: 0,
		formUnsubscribes: 0,
	};

	const listeners = new Set();
	let snapshot =
		options.snapshot === undefined
			? {
					status: 'ready',
					value: JSON.parse(JSON.stringify(DEFAULT_SETTINGS_VALUE)),
					base: undefined,
					user: undefined,
					revision: 4,
					writable,
				}
			: options.snapshot;
	if (options.snapshot === undefined) snapshot.writable = writable;

	/** Publish a new snapshot to every fake subscriber. */
	const commit = (next) => {
		snapshot = next;
		for (const listener of listeners) listener();
	};

	const form = {
		getSnapshot() {
			return snapshot;
		},
		subscribe(listener) {
			captured.formSubscriptions += 1;
			listeners.add(listener);
			return () => {
				captured.formUnsubscribes += 1;
				listeners.delete(listener);
			};
		},
		async set(field, value) {
			captured.formSets.push({ field: String(field), value: String(value) });
			if (options.setResult === false) return false;
			if (options.snapshot === undefined) {
				commit({
					...snapshot,
					revision: snapshot.revision + 1,
					value: applySettingsOps(snapshot.value, [{ op: 'set', path: [field], value }]),
				});
			}
			return true;
		},
		async mutate(ops) {
			// Record host-realm copies: vm-realm objects fail strict deepEqual.
			captured.formMutations.push(jsonClone(ops));
			if (options.mutateResult === false) return false;
			if (options.snapshot === undefined) {
				commit({
					...snapshot,
					revision: snapshot.revision + 1,
					value: applySettingsOps(snapshot.value, ops),
				});
			}
			return true;
		},
	};

	const configForms = {
		whileServed(namespaces, register) {
			captured.whileServed.push([...namespaces]);
			if (served === null || served.length === 0) return () => {};
			let off;
			const sync = () => {
				const watched = namespaces.some((namespace) => served.includes(namespace));
				if (watched && off === undefined) off = register(new Set(served));
				else if (!watched && off !== undefined) {
					off();
					off = undefined;
				}
			};
			sync();
			return () => {
				if (off !== undefined) off();
				off = undefined;
			};
		},
		get(namespace) {
			captured.formGets.push(String(namespace));
			return form;
		},
	};

	const layout = {
		effect(callback, label) {
			captured.effects.push(String(label));
			const disposer = typeof callback === 'function' ? callback() : undefined;
			return typeof disposer === 'function' ? disposer : () => {};
		},
		locale: {
			register(namespace, dictionaries) {
				captured.locales.push({ namespace, dictionaries });
				return () => {};
			},
			bind() {
				return (key) => key;
			},
		},
		slots: {
			inject(_name, callback) {
				return callback();
			},
			register(options, component) {
				captured.slots.push({ options, component });
				return () => {};
			},
		},
	};

	const ctx = {
		...layout,
		inject(names, callback) {
			captured.injections.push(Array.isArray(names) ? [...names] : [names]);
			if (options.configForms === false) return () => {};
			const child = { ...layout, configForms };
			const result = callback(child);
			return typeof result === 'function' ? result : () => {};
		},
		remote: {
			commands: {
				async execute(sessionId, line, attachments) {
					// Record primitives only: vm-realm objects fail strict deepEqual
					// against host-realm literals even when structurally identical.
					captured.commands.push({
						sessionId: String(sessionId),
						line: String(line),
						attachmentCount: Array.isArray(attachments) ? attachments.length : -1,
					});
					return { ok: true };
				},
			},
		},
	};
	return { ctx, captured, form };
}

/** Interpolate `{name}` placeholders exactly like the locale face does. */
function translateFrom(dict) {
	return (key, params) => {
		const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
		if (params === undefined || params === null) return String(template);
		return String(template).replace(/\{(\w+)\}/g, (match, name) =>
			Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
		);
	};
}

/** Depth-first search of an element tree for the first matching element. */
function findElement(node, predicate) {
	if (node === null || node === undefined || typeof node !== 'object') return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findElement(child, predicate);
			if (found !== null) return found;
		}
		return null;
	}
	if (predicate(node)) return node;
	const children = node.children === undefined ? [] : node.children;
	for (const child of children) {
		const found = findElement(child, predicate);
		if (found !== null) return found;
	}
	return null;
}

/** Flatten an element tree into text content. */
function collectText(node, out = []) {
	if (node === null || node === undefined) return out;
	if (typeof node === 'string') {
		out.push(node);
		return out;
	}
	if (typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const child of node) collectText(child, out);
		return out;
	}
	const children = node.children === undefined ? [] : node.children;
	for (const child of children) collectText(child, out);
	return out;
}

/** Wait for the promise chains inside a submit handler to settle. */
async function flush() {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

/** Proleptic-Gregorian day number for one CE calendar date. */
function dayNumberOfCe(year, month, day) {
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	return Math.floor(date.getTime() / 86400000);
}

/** Browser-local day number for today, matching the bundle's own arithmetic. */
function todayDayNumber() {
	const now = new Date();
	return dayNumberOfCe(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// ---------------------------------------------------------------------------
// Load once per file: plugin + captured slot components + dictionaries
// ---------------------------------------------------------------------------

const SOURCE = readFileSync(CLIENT_PATH, 'utf8');
const registrations = loadBundle();
const reactStub = createReactStub();
/** `react-dom` stand-in: records what is portaled where. */
const reactDomStub = {
	__portals: [],
	createPortal(node, container) {
		reactDomStub.__portals.push({ node, container });
		return { type: 'portal', props: { node, container }, children: [] };
	},
};
const requireStub = (id) => {
	if (id === 'react') return reactStub;
	if (id === 'react-dom') return reactDomStub;
	throw new Error('unexpected require("' + id + '") — the bundle must only require react / react-dom');
};
const plugin = registrations.get(PLUGIN_ID).factory(requireStub);

const surface = (() => {
	const { ctx, captured } = createFakeContext();
	plugin.apply(ctx);
	const header = captured.slots.find(
		(slot) => slot.options.name === 'conversation.session.header.actions',
	);
	return {
		header,
		chip: header.component,
		seats: captured.slots.filter(
			(slot) =>
				slot.options.name === 'plugins.row.config' || slot.options.name === 'plugins.bundle.config',
		),
		zh: captured.locales[0].dictionaries.zh,
		en: captured.locales[0].dictionaries.en,
	};
})();
const tZh = translateFrom(surface.zh);
const tEn = translateFrom(surface.en);

/** Expected configuration seats: name -> key pairs. */
const EXPECTED_SEATS = [
	{ name: 'plugins.row.config', key: 'dsh-time-pin#dsh-time-pin' },
	{ name: 'plugins.row.config', key: 'dsh-time-pin#include:dsh-time-pin' },
	{ name: 'plugins.bundle.config', key: 'dsh-time-pin' },
];

/**
 * Apply the plugin to a fresh fake context and expose the settings component.
 * @param {object} [options] - forwarded to {@link createFakeContext}.
 */
function settingsOf(options = {}) {
	const { ctx, captured, form } = createFakeContext(options);
	plugin.apply(ctx);
	const seats = captured.slots.filter(
		(slot) =>
			slot.options.name === 'plugins.row.config' || slot.options.name === 'plugins.bundle.config',
	);
	const rowSeat = seats.find((slot) => slot.options.key === 'dsh-time-pin#dsh-time-pin');
	return {
		ctx,
		captured,
		form,
		seats,
		rowSeat,
		component: rowSeat === undefined ? undefined : rowSeat.component,
	};
}

/** Render the settings component for one page view. */
function renderSettings(component, view = 'page', t = tZh, states = null) {
	return reactStub.render(component, { view, t }, states);
}

/** Status notices pushed by the component after a write settles. */
function noticesOf() {
	return reactStub.__updates.filter((value) => value !== null && typeof value === 'object');
}

/** A successful `remote.commands.execute` result (`{ ok, value: { commandId, result } }`). */
const SUCCESS_RESULT = { ok: true, value: { commandId: 'cmd-1', result: { kind: 'success' } } };

/** Representative Host wire view of a pinned past window (clock-free shape). */
function pinnedView(overrides = {}) {
	return {
		restricted: true,
		modeBase: 'pinned',
		asOf: 'ce:2000-01-01',
		asOfDay: dayNumberOfCe(2000, 1, 1),
		before: '10y',
		after: '10y',
		asOfLabel: '2000-01-01',
		rangeLabel: '前后各10年',
		chipLabel: '2000-01-01 · 前后各10年',
		asOfInput: '2000-01-01',
		beforeInput: '10年',
		afterInput: '10年',
		anchorPending: false,
		lastOutputAt: null,
		runStartedAt: null,
		updatedAt: null,
		version: 1,
		...overrides,
	};
}

function renderChip(view, props = {}, states = null) {
	return reactStub.render(
		surface.chip,
		{
			sessionId: 'session-1',
			t: tZh,
			useProjection: () => view,
			apply: async () => ({ ok: true }),
			...props,
		},
		states,
	);
}

/** Find the panel COMPONENT element the open chip renders (not its output). */
function panelElementOf(tree) {
	return findElement(
		tree,
		(node) =>
			typeof node.type === 'function' &&
			node.props.panelRef !== undefined &&
			node.props.onRequestClose !== undefined,
	);
}

/** Render the panel component element into its own element tree. */
function renderedPanelOf(tree) {
	const element = panelElementOf(tree);
	assert.ok(element !== null, 'open chip must render the panel');
	return reactStub.render(element.type, { ...element.props });
}

function renderPanel(view, submit, onRequestClose, sessionId = 'session-panel', t = tZh) {
	const tree = renderChip(view, { t }, [true, null]);
	const element = panelElementOf(tree);
	assert.ok(element !== null, 'open chip must render the panel');
	return reactStub.render(element.type, {
		...element.props,
		sessionId,
		submit,
		onRequestClose,
	});
}

// ---------------------------------------------------------------------------
// Bundle + plugin contract
// ---------------------------------------------------------------------------

test('lazy bundle registers the dsh-time-pin factory and returns a plugin', () => {
	const entry = registrations.get(PLUGIN_ID);
	assert.ok(entry !== undefined, 'bundle must call window.__ModuleLoader__.load with id dsh-time-pin');
	assert.equal(typeof entry.factory, 'function');
	assert.equal(typeof plugin.apply, 'function');
	assert.ok(Array.isArray(plugin.inject));
	for (const service of REQUIRED_SERVICES) {
		assert.ok(plugin.inject.includes(service), `plugin.inject must declare "${service}"`);
	}
	assert.ok(
		!plugin.inject.includes('configForms'),
		'configForms is OPTIONAL: the chip must never depend on the settings UI',
	);
});

test('apply registers locale, stylesheet, header chip and the configuration seats', () => {
	const { ctx, captured } = createFakeContext();
	plugin.apply(ctx);

	assert.equal(captured.locales.length, 1);
	assert.equal(captured.locales[0].namespace, 'time-pin');
	assert.equal(typeof captured.locales[0].dictionaries.zh, 'object');
	assert.equal(typeof captured.locales[0].dictionaries.en, 'object');

	assert.equal(surface.header.options.name, 'conversation.session.header.actions');
	assert.equal(surface.header.options.id, 'time-pin');
	assert.equal(surface.header.options.order, -15);
	assert.equal(surface.header.options.locale, 'time-pin');
	assert.equal(typeof surface.chip, 'function');

	// The silence bar is gone: nothing may occupy the composer dock any more.
	assert.equal(
		captured.slots.some((slot) => slot.options.name === 'conversation.composer.dock'),
		false,
		'the silence status bar must not be registered',
	);

	assert.ok(
		captured.effects.some((label) => label.includes('stylesheet')),
		'apply must install the stylesheet through a ctx.effect',
	);
	assert.ok(
		captured.effects.some((label) => label.includes('settings page')),
		'apply must register the optional settings page through a ctx.effect',
	);
});

test('the removed silence bar leaves no source, slot or locale trace', () => {
	assert.ok(!SOURCE.includes('TimePinSilence'), 'TimePinSilence component must be deleted');
	assert.ok(!SOURCE.includes('SILENCE_THRESHOLD_MS'), 'SILENCE_THRESHOLD_MS must be deleted');
	assert.ok(!SOURCE.includes('observedRunningSince'), 'observedRunningSince state must be deleted');
	assert.ok(!SOURCE.includes('silence.text'), 'the silence.text locale key must be deleted');
	assert.ok(!SOURCE.includes("'silence.text'"), 'the silence.text locale key must be deleted');
	assert.ok(!SOURCE.includes('dshtp_dock'), 'the .dshtp_dock CSS rule must be deleted');
	assert.ok(!SOURCE.includes('conversation.composer.dock'), 'the composer dock slot must not be used');
	assert.ok(!SOURCE.includes('formatDuration'), 'formatDuration was only used by the silence bar');
	assert.ok(!SOURCE.includes('epochMs'), 'epochMs was only used by the silence bar');
	assert.ok(!('silence.text' in surface.zh), 'zh must not define silence.text');
	assert.ok(!('silence.text' in surface.en), 'en must not define silence.text');
});

test('locale zh/en dictionaries are key-identical and non-empty', () => {
	const zhKeys = Object.keys(surface.zh).sort();
	const enKeys = Object.keys(surface.en).sort();
	assert.ok(zhKeys.length > 0);
	assert.deepEqual(enKeys, zhKeys, 'en must mirror the zh key set exactly');
	for (const key of zhKeys) {
		assert.notEqual(String(surface.zh[key]).trim(), '', `zh["${key}"] must not be empty`);
		assert.notEqual(String(surface.en[key]).trim(), '', `en["${key}"] must not be empty`);
	}
});

test('the injected command face executes /pin on the slot session', async () => {
	const { ctx, captured } = createFakeContext();
	plugin.apply(ctx);
	const header = captured.slots.find(
		(slot) => slot.options.name === 'conversation.session.header.actions',
	);
	const face = header.options.inject('session-42');
	assert.equal(typeof face.apply, 'function');
	await face.apply('/pin 2000-01-01 10年');
	assert.deepEqual(captured.commands, [
		{ sessionId: 'session-42', line: '/pin 2000-01-01 10年', attachmentCount: 0 },
	]);
});

// ---------------------------------------------------------------------------
// Plugins-page configuration (`configForms` -> plugins.row.config seats)
// ---------------------------------------------------------------------------

test('the configuration seats register once configForms serves the bundle namespace', () => {
	const settings = settingsOf();
	assert.deepEqual(settings.captured.injections[0], ['configForms']);
	assert.deepEqual(settings.captured.whileServed[0], ['dsh-time-pin', 'include:dsh-time-pin']);
	assert.deepEqual(settings.captured.formGets, ['dsh-time-pin']);

	const pairs = settings.seats.map((seat) => seat.options.name + '|' + seat.options.key).sort();
	assert.deepEqual(
		pairs,
		EXPECTED_SEATS.map((seat) => seat.name + '|' + seat.key).sort(),
	);
	for (const seat of settings.seats) {
		assert.equal(typeof seat.component, 'function');
		assert.equal(seat.options.locale, 'time-pin');
	}
});

test('the include: namespace spelling is followed when that is what the Host serves', () => {
	const settings = settingsOf({ served: ['include:dsh-time-pin'] });
	assert.equal(settings.seats.length, 3);
	assert.deepEqual(settings.captured.formGets, ['include:dsh-time-pin']);
});

test('without the settings UI or a served namespace no configuration seat appears', () => {
	const unserved = settingsOf({ served: null });
	assert.equal(unserved.seats.length, 0);
	assert.equal(unserved.captured.formGets.length, 0);
	assert.ok(
		unserved.captured.slots.some(
			(slot) => slot.options.name === 'conversation.session.header.actions',
		),
		'the chip must survive a deployment without the settings UI',
	);

	const absent = settingsOf({ configForms: false });
	assert.deepEqual(absent.captured.injections[0], ['configForms']);
	assert.equal(absent.seats.length, 0);
	assert.ok(absent.captured.slots.some((slot) => slot.options.name === 'conversation.session.header.actions'));
});

test('settings summary renders the localized one-liner', () => {
	const settings = settingsOf();
	const zh = renderSettings(settings.component, 'summary');
	assert.equal(typeof zh, 'string');
	assert.ok(zh.includes('模型提示 zh'), zh);
	assert.ok(zh.includes('静默播报 开'), zh);
	assert.ok(zh.includes('90s / 3min'), zh);

	const en = renderSettings(settings.component, 'summary', tEn);
	assert.ok(en.includes('Model prompt zh'), en);
	assert.ok(en.includes('silence narration on'), en);

	const off = settingsOf({
		snapshot: {
			status: 'ready',
			value: {
				promptLocale: 'en',
				silence: { enabled: false, firstDelayMs: 90_000, repeatMs: 180_000 },
			},
			revision: 1,
			writable: true,
		},
	});
	const offLine = renderSettings(off.component, 'summary');
	assert.ok(offLine.includes('静默播报 关'), offLine);
});

test('settings page renders the four rows with the current values', () => {
	const settings = settingsOf();
	const page = renderSettings(settings.component);
	const text = collectText(page).join('');
	for (const label of ['模型提示语言', '静默播报', '首次提示延迟', '更新间隔']) {
		assert.ok(text.includes(label), `missing settings row "${label}": ${text}`);
	}

	const zhButton = findElement(page, (node) => node.props['data-time-pin-prompt-locale'] === 'zh');
	const enButton = findElement(page, (node) => node.props['data-time-pin-prompt-locale'] === 'en');
	assert.equal(zhButton.props['data-active'], 'true');
	assert.equal(enButton.props['data-active'], 'false');
	assert.equal(zhButton.props['aria-pressed'], true);

	assert.equal(
		findElement(page, (node) => node.props['data-time-pin-silence-toggle'] === 'on').props[
			'data-active'
		],
		'true',
	);
	assert.equal(
		findElement(page, (node) => node.props['data-time-pin-silence-toggle'] === 'off').props[
			'data-active'
		],
		'false',
	);
	assert.equal(
		findElement(page, (node) => node.props['data-time-pin-first-delay'] === true).props.defaultValue,
		'90',
	);
	assert.equal(
		findElement(page, (node) => node.props['data-time-pin-repeat'] === true).props.defaultValue,
		'180',
	);
});

test('prompt locale buttons write through form.set and confirm the save', async () => {
	const settings = settingsOf();
	const page = renderSettings(settings.component);
	findElement(page, (node) => node.props['data-time-pin-prompt-locale'] === 'en').props.onClick();
	await flush();

	assert.deepEqual(settings.captured.formSets, [{ field: 'promptLocale', value: 'en' }]);
	assert.ok(
		noticesOf().some(
			(notice) => notice.tone === 'saved' && notice.text === surface.zh['settings.saved'],
		),
		`saved notice expected, updates: ${JSON.stringify(reactStub.__updates)}`,
	);

	const after = renderSettings(settings.component);
	assert.equal(
		findElement(after, (node) => node.props['data-time-pin-prompt-locale'] === 'en').props[
			'data-active'
		],
		'true',
	);
});

test('the silence toggle writes the nested path through form.mutate', async () => {
	const settings = settingsOf();
	const page = renderSettings(settings.component);
	findElement(page, (node) => node.props['data-time-pin-silence-toggle'] === 'off').props.onClick();
	await flush();

	assert.deepEqual(settings.captured.formMutations, [
		[{ op: 'set', path: ['silence', 'enabled'], value: false }],
	]);
	const after = renderSettings(settings.component);
	assert.equal(
		findElement(after, (node) => node.props['data-time-pin-silence-toggle'] === 'off').props[
			'data-active'
		],
		'true',
	);
});

test('number inputs commit seconds converted to milliseconds and clamped', async () => {
	const settings = settingsOf();
	let page = renderSettings(settings.component);

	findElement(page, (node) => node.props['data-time-pin-first-delay'] === true).props.onBlur({
		target: { value: '120' },
	});
	await flush();
	findElement(page, (node) => node.props['data-time-pin-repeat'] === true).props.onKeyDown({
		key: 'Enter',
		preventDefault() {},
		target: { value: '200' },
	});
	await flush();
	assert.deepEqual(settings.captured.formMutations, [
		[{ op: 'set', path: ['silence', 'firstDelayMs'], value: 120_000 }],
		[{ op: 'set', path: ['silence', 'repeatMs'], value: 200_000 }],
	]);

	page = renderSettings(settings.component);
	findElement(page, (node) => node.props['data-time-pin-first-delay'] === true).props.onBlur({
		target: { value: '0.2' },
	});
	await flush();
	assert.deepEqual(settings.captured.formMutations[2], [
		{ op: 'set', path: ['silence', 'firstDelayMs'], value: 1_000 },
	]);

	page = renderSettings(settings.component);
	findElement(page, (node) => node.props['data-time-pin-first-delay'] === true).props.onBlur({
		target: { value: '999999' },
	});
	await flush();
	assert.deepEqual(settings.captured.formMutations[3], [
		{ op: 'set', path: ['silence', 'firstDelayMs'], value: 86_400_000 },
	]);

	page = renderSettings(settings.component);
	findElement(page, (node) => node.props['data-time-pin-first-delay'] === true).props.onBlur({
		target: { value: 'not-a-number' },
	});
	await flush();
	assert.equal(settings.captured.formMutations.length, 4);
	assert.ok(
		noticesOf().some((notice) => notice.text === surface.zh['settings.invalidNumber']),
		JSON.stringify(reactStub.__updates),
	);
});

test('a refused write shows the failure line', async () => {
	const settings = settingsOf({ setResult: false });
	const page = renderSettings(settings.component);
	findElement(page, (node) => node.props['data-time-pin-prompt-locale'] === 'en').props.onClick();
	await flush();
	assert.ok(
		noticesOf().some(
			(notice) => notice.tone === 'failed' && notice.text === surface.zh['settings.failed'],
		),
		`failure notice expected, updates: ${JSON.stringify(reactStub.__updates)}`,
	);
});

test('a rejected write surfaces the rejection text', async () => {
	const settings = settingsOf();
	settings.form.set = async () => {
		throw new Error('settings transport closed');
	};
	const page = renderSettings(settings.component);
	findElement(page, (node) => node.props['data-time-pin-prompt-locale'] === 'en').props.onClick();
	await flush();
	assert.ok(
		noticesOf().some(
			(notice) =>
				notice.tone === 'failed' &&
				typeof notice.text === 'string' &&
				notice.text.includes('settings transport closed'),
		),
		JSON.stringify(reactStub.__updates),
	);
});

test('read-only deployments render the values without writing', async () => {
	const settings = settingsOf({ writable: false });
	const page = renderSettings(settings.component);
	assert.ok(collectText(page).join('').includes(surface.zh['settings.readOnly']));

	const enButton = findElement(page, (node) => node.props['data-time-pin-prompt-locale'] === 'en');
	assert.equal(enButton.props.disabled, true);
	assert.equal(
		findElement(page, (node) => node.props['data-time-pin-first-delay'] === true).props.disabled,
		true,
	);
	assert.equal(
		findElement(page, (node) => node.props['data-time-pin-repeat'] === true).props.disabled,
		true,
	);

	enButton.props.onClick();
	findElement(page, (node) => node.props['data-time-pin-silence-toggle'] === 'off').props.onClick();
	findElement(page, (node) => node.props['data-time-pin-repeat'] === true).props.onBlur({
		target: { value: '60' },
	});
	await flush();
	assert.deepEqual(settings.captured.formSets, []);
	assert.deepEqual(settings.captured.formMutations, []);
});

test('settings render safely before the form is ready', () => {
	const loading = settingsOf({ snapshot: { status: 'loading', writable: false } });
	assert.ok(
		collectText(renderSettings(loading.component)).join('').includes(surface.zh['settings.loading']),
	);
	assert.equal(renderSettings(loading.component, 'summary'), surface.zh['settings.loading']);

	const unavailable = settingsOf({ snapshot: { status: 'unavailable', writable: false } });
	assert.ok(
		collectText(renderSettings(unavailable.component))
			.join('')
			.includes(surface.zh['settings.unavailable']),
	);
	assert.equal(renderSettings(unavailable.component, 'summary'), surface.zh['settings.unavailable']);
});

test('the settings page subscribes to the form and releases it on unmount', () => {
	const settings = settingsOf();
	renderSettings(settings.component);
	assert.equal(reactStub.__effects.length, 1, 'the page must mount exactly one effect');
	assert.equal(settings.captured.formSubscriptions, 0, 'subscribing is the effect body, not render');
	const cleanup = reactStub.__effects[0]();
	assert.equal(settings.captured.formSubscriptions, 1);
	assert.equal(typeof cleanup, 'function');
	cleanup();
	assert.equal(settings.captured.formUnsubscribes, 1);
});

// ---------------------------------------------------------------------------
// Chip rendering + localized window label
// ---------------------------------------------------------------------------

function chipButtonOf(tree) {
	return findElement(tree, (node) => node.props['data-time-pin-chip'] === true);
}

test('chip renders nothing when the projection is missing', () => {
	assert.equal(renderChip(undefined), null);
	assert.equal(renderChip(null), null);
	assert.equal(reactStub.render(surface.chip, { sessionId: 's', t: tZh }), null);
});

test('chip renders the localized zh label with the per-mode glyph', () => {
	const pinned = chipButtonOf(renderChip(pinnedView()));
	assert.equal(pinned.props['data-mode'], 'past');
	const pinnedText = collectText(pinned).join('');
	assert.ok(pinnedText.includes('🕰'), pinnedText);
	assert.ok(pinnedText.includes('2000-01-01 · 前后各10年'), pinnedText);

	const recent = chipButtonOf(
		renderChip(
			pinnedView({
				modeBase: 'recent',
				asOf: null,
				asOfDay: null,
				asOfLabel: '默认',
				asOfInput: '',
				before: '7d',
				after: '7d',
				beforeInput: '7天',
				afterInput: '7天',
				rangeLabel: '前后各7天',
				chipLabel: '默认 · 前后各7天',
			}),
		),
	);
	assert.equal(recent.props['data-mode'], 'recent');
	assert.ok(collectText(recent).join('').includes('默认 · 前后各7天'));
	assert.ok(collectText(recent).join('').includes('🕐'));

	const fallback = chipButtonOf(
		renderChip(
			pinnedView({
				modeBase: 'default',
				restricted: false,
				asOf: null,
				asOfDay: null,
				asOfLabel: '默认',
				asOfInput: '',
				before: null,
				after: null,
				beforeInput: '',
				afterInput: '',
				rangeLabel: '不限',
				chipLabel: '默认 · 不限',
			}),
		),
	);
	assert.equal(fallback.props['data-mode'], 'default');
	assert.ok(collectText(fallback).join('').includes('默认 · 不限'));
	assert.ok(collectText(fallback).join('').includes('🕐'));
});

test('chip renders future mode from asOfDay plus the browser day', () => {
	const future = chipButtonOf(
		renderChip(
			pinnedView({
				asOf: 'ce:3000-01-01',
				asOfDay: todayDayNumber() + 1,
				asOfLabel: '3000-01-01',
				asOfInput: '3000-01-01',
				before: null,
				after: null,
				beforeInput: '',
				afterInput: '',
				rangeLabel: '不限',
				chipLabel: '3000-01-01 · 不限',
			}),
		),
	);
	assert.equal(future.props['data-mode'], 'future');
	assert.ok(collectText(future).join('').includes('🌌'));
	assert.ok(collectText(future).join('').includes('3000-01-01 · 不限'));
});

test('chip label is localized in en from raw fields, not the host copy', () => {
	const enChip = chipButtonOf(renderChip(pinnedView(), { t: tEn }));
	assert.ok(collectText(enChip).join('').includes('2000-01-01 · ±10 years'));

	const enDefault = chipButtonOf(
		renderChip(
			pinnedView({
				modeBase: 'default',
				restricted: false,
				asOf: null,
				asOfDay: null,
				before: null,
				after: null,
				beforeInput: '',
				afterInput: '',
			}),
			{ t: tEn },
		),
	);
	assert.ok(collectText(enDefault).join('').includes('Default · Unlimited'));

	const enRecent = chipButtonOf(
		renderChip(
			pinnedView({
				modeBase: 'recent',
				asOf: null,
				asOfDay: null,
				asOfInput: '',
				before: '7d',
				after: '7d',
				beforeInput: '7天',
				afterInput: '7天',
			}),
			{ t: tEn },
		),
	);
	assert.ok(collectText(enRecent).join('').includes('Default · ±7 days'));
	assert.ok(!collectText(enRecent).join('').includes('近'));
});

test('chip falls back to the host chipLabel when raw fields are absent', () => {
	const legacy = chipButtonOf(
		renderChip({ chipLabel: '2000-01-01 · 前后各10年', asOfLabel: '2000-01-01' }),
	);
	assert.ok(collectText(legacy).join('').includes('2000-01-01 · 前后各10年'));
});

test('chip shows the anchor-pending dot and unconfirmed title', () => {
	const chip = chipButtonOf(renderChip(pinnedView({ anchorPending: true })));
	assert.ok(findElement(chip, (node) => node.props.className === 'dshtp_pending') !== null);
	assert.ok(String(chip.props.title).includes(surface.zh['chip.pending']));
});

test('chip opens the panel with prefilled localized fields', () => {
	const panel = renderedPanelOf(renderChip(pinnedView(), {}, [true, null]));
	const asOfInput = findElement(panel, (node) => node.props['data-time-pin-asof'] === true);
	const beforeInput = findElement(panel, (node) => node.props['data-time-pin-before'] === true);
	const afterInput = findElement(panel, (node) => node.props['data-time-pin-after'] === true);
	assert.equal(asOfInput.props.value, '2000-01-01');
	assert.equal(beforeInput.props.value, '10年');
	assert.equal(afterInput.props.value, '10年');
	assert.ok(collectText(panel).join('').includes('当前：2000-01-01 · 前后各10年'));

	const enTree = reactStub.render(
		surface.chip,
		{
			sessionId: 'session-en',
			t: tEn,
			useProjection: () => pinnedView(),
			apply: async () => ({ ok: true }),
		},
		[true, null],
	);
	assert.ok(collectText(renderedPanelOf(enTree)).join('').includes('Current: 2000-01-01 · ±10 years'));
});

test('panel exposes all six span presets with local tokens', () => {
	const panel = renderedPanelOf(renderChip(pinnedView(), {}, [true, null]));
	for (const id of ['none', 'd7', 'd30', 'y1', 'y10', 'y100']) {
		const preset = findElement(panel, (node) => node.props['data-time-pin-preset'] === id);
		assert.ok(preset !== null, `missing span preset ${id}`);
		assert.equal(typeof preset.props.onClick, 'function');
	}
	const enTree = reactStub.render(
		surface.chip,
		{
			sessionId: 'session-en2',
			t: tEn,
			useProjection: () => pinnedView(),
			apply: async () => ({ ok: true }),
		},
		[true, null],
	);
	const enPanel = renderedPanelOf(enTree);
	const noneEn = findElement(enPanel, (node) => node.props['data-time-pin-preset'] === 'none');
	const d7En = findElement(enPanel, (node) => node.props['data-time-pin-preset'] === 'd7');
	assert.equal(collectText(noneEn).join(''), 'Unlimited');
	assert.equal(collectText(d7En).join(''), '7 days');
});

test('the 不限 preset clears both range fields', () => {
	const panel = renderedPanelOf(renderChip(pinnedView(), {}, [true, null]));
	const none = findElement(panel, (node) => node.props['data-time-pin-preset'] === 'none');
	reactStub.__updates = [];
	none.props.onClick();
	assert.equal(
		reactStub.__updates.filter((value) => value === '').length,
		2,
		JSON.stringify(reactStub.__updates),
	);
});

test('the future warning appears once per session and is dismissible', () => {
	const futureView = pinnedView({ asOf: 'ce:3000-01-01', asOfDay: todayDayNumber() + 1, asOfInput: '3000-01-01' });
	const first = renderPanel(futureView, async () => ({ ok: true }), () => {}, 'session-future');
	const warning = findElement(first, (node) => node.props['data-time-pin-future-warning'] === true);
	assert.ok(warning !== null);
	const warningButtons = [];
	(function walk(node) {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		if (node.type === 'button') warningButtons.push(node);
		(node.children === undefined ? [] : node.children).forEach(walk);
	})(warning);
	assert.equal(warningButtons.length, 1);
	warningButtons[0].props.onClick();

	const second = renderPanel(futureView, async () => ({ ok: true }), () => {}, 'session-future');
	assert.equal(
		findElement(second, (node) => node.props['data-time-pin-future-warning'] === true),
		null,
		'dismissed warning must not reappear for the same session',
	);
	const other = renderPanel(futureView, async () => ({ ok: true }), () => {}, 'session-other');
	assert.ok(findElement(other, (node) => node.props['data-time-pin-future-warning'] === true) !== null);
});

// ---------------------------------------------------------------------------
// Panel -> /pin line composition
// ---------------------------------------------------------------------------

test('panel composes the /pin line for every as-of/range form', async () => {
	const cases = [
		{
			asOfInput: '2000-01-01',
			beforeInput: '10年',
			afterInput: '10年',
			expected: '/pin 2000-01-01 前10年 后10年',
		},
		{
			asOfInput: '2000-01-01',
			beforeInput: '10年',
			afterInput: '',
			expected: '/pin 2000-01-01 前10年',
		},
		{
			asOfInput: '2000-01-01',
			beforeInput: '',
			afterInput: '5年',
			expected: '/pin 2000-01-01 后5年',
		},
		{
			asOfInput: '公元前200年',
			beforeInput: '',
			afterInput: '',
			expected: '/pin 公元前200年 不限',
		},
		{
			asOfInput: '3000',
			beforeInput: '不限',
			afterInput: '',
			expected: '/pin 3000 前不限',
		},
		{
			asOfInput: '',
			beforeInput: '7天',
			afterInput: '',
			expected: '/pin 前7天',
		},
		{
			asOfInput: '',
			beforeInput: '',
			afterInput: '30天',
			expected: '/pin 后30天',
		},
		{ asOfInput: '', beforeInput: '', afterInput: '', expected: '/pin off' },
	];

	for (const entry of cases) {
		const submitted = [];
		let closed = 0;
		const panel = renderPanel(
			pinnedView({
				asOfInput: entry.asOfInput,
				beforeInput: entry.beforeInput,
				afterInput: entry.afterInput,
			}),
			async (line) => {
				submitted.push(line);
				return SUCCESS_RESULT;
			},
			() => {
				closed += 1;
			},
		);
		const apply = findElement(panel, (node) => node.props['data-time-pin-apply'] === true);
		assert.ok(apply !== null);
		apply.props.onClick();
		await flush();
		assert.deepEqual(submitted, [entry.expected], JSON.stringify(entry));
		assert.equal(closed, 1, 'a successful apply closes the panel');
	}
});

test('panel clear button submits /pin off', async () => {
	const submitted = [];
	const panel = renderPanel(pinnedView(), async (line) => {
		submitted.push(line);
		return SUCCESS_RESULT;
	}, () => {});
	findElement(panel, (node) => node.props['data-time-pin-clear'] === true).props.onClick();
	await flush();
	assert.deepEqual(submitted, ['/pin off']);
});

test('panel renders an admission failure inline and stays open', async () => {
	let closed = 0;
	const panel = renderPanel(
		pinnedView(),
		async () => ({ ok: false, error: { code: 'invalid_format', message: '无法识别，请用 2000-01-01' } }),
		() => {
			closed += 1;
		},
	);
	findElement(panel, (node) => node.props['data-time-pin-apply'] === true).props.onClick();
	await flush();
	assert.ok(
		reactStub.__updates.some(
			(value) =>
				typeof value === 'string' &&
				value.includes('无法识别，请用 2000-01-01') &&
				value.includes('invalid_format'),
		),
		`inline error expected, updates: ${JSON.stringify(reactStub.__updates)}`,
	);
	assert.equal(closed, 0, 'a failed apply keeps the panel open');
});

test('panel surfaces a handler-level error result', async () => {
	const panel = renderPanel(
		pinnedView(),
		async () => ({
			ok: true,
			value: { commandId: 'cmd-1', result: { kind: 'error', text: '日期不存在：2026 年 2 月没有 30 日' } },
		}),
		() => {},
	);
	findElement(panel, (node) => node.props['data-time-pin-apply'] === true).props.onClick();
	await flush();
	assert.ok(reactStub.__updates.some((value) => typeof value === 'string' && value.includes('日期不存在')));
});

test('panel reports unknown commands and a missing command service without throwing', async () => {
	const unknownPanel = renderPanel(pinnedView(), async () => ({ ok: true }), () => {});
	findElement(unknownPanel, (node) => node.props['data-time-pin-apply'] === true).props.onClick();
	await flush();
	assert.ok(
		reactStub.__updates.some((value) => value === surface.zh['error.unmatched']),
		`unknown-command error expected: ${JSON.stringify(reactStub.__updates)}`,
	);

	const missingPanel = renderPanel(pinnedView(), undefined, () => {});
	const apply = findElement(missingPanel, (node) => node.props['data-time-pin-apply'] === true);
	assert.doesNotThrow(() => apply.props.onClick());
	await flush();
	assert.ok(reactStub.__updates.some((value) => value === surface.zh['error.applyUnavailable']));
});

test('the chip portals its panel to document.body (the header clips plain overlays)', () => {
	const body = { tagName: 'BODY' };
	const documentStub = {
		body,
		head: { appendChild() {}, removeChild() {} },
		createElement: () => ({
			style: {},
			dataset: {},
			setAttribute() {},
			appendChild() {},
			remove() {},
		}),
		querySelector: () => null,
		querySelectorAll: () => [],
		addEventListener() {},
		removeEventListener() {},
	};
	// Isolated load: this factory sees a document, so the panel must portal.
	const isolated = loadBundle({ document: documentStub });
	const pluginWithDom = isolated.get(PLUGIN_ID).factory(requireStub);
	const { ctx, captured } = createFakeContext();
	pluginWithDom.apply(ctx);
	const header = captured.slots.find(
		(slot) => slot.options.name === 'conversation.session.header.actions',
	);
	assert.ok(header !== undefined, 'the header action must register');
	reactDomStub.__portals.length = 0;
	const tree = reactStub.render(
		header.component,
		{
			sessionId: 'session-portal',
			t: tZh,
			useProjection: () => pinnedView(),
			apply: async () => ({ ok: true }),
		},
		[true, null],
	);
	const portal = findElement(tree, (node) => node.type === 'portal');
	assert.ok(portal !== null, 'an open chip must render its panel through createPortal');
	assert.equal(portal.props.container, body);
	assert.equal(reactDomStub.__portals.length, 1);
	assert.ok(portal.props.node !== null && typeof portal.props.node === 'object');
});

test('panel recovers from a rejected command (busy state never sticks)', async () => {
	const panel = renderPanel(
		pinnedView(),
		async () => {
			throw new Error('transport closed');
		},
		() => {},
	);
	const apply = findElement(panel, (node) => node.props['data-time-pin-apply'] === true);
	apply.props.onClick();
	await flush();
	assert.ok(
		reactStub.__updates.some(
			(value) =>
				typeof value === 'string' && value.includes('命令执行失败') && value.includes('transport closed'),
		),
		`rejection must surface inline: ${JSON.stringify(reactStub.__updates)}`,
	);
	assert.equal(apply.props.disabled, false);
	// A second press is accepted (the first failure released the busy flag).
	assert.doesNotThrow(() => apply.props.onClick());
	await flush();
});
