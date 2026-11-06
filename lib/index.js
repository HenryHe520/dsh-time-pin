/**
 * Host half of dsh-time-pin.
 *
 * The plugin gives every conversation a pinned "as of" time point plus a
 * lookback span, i.e. an evidence window `[as_of - span, as_of]`. In restricted
 * mode the window is injected once per window change as a durable,
 * source-attributed user message, `web_search` evidence is filtered to dated
 * sources inside the window, and long-running silent background jobs produce a
 * `[TIME FACT]` narration on the model's next step.
 *
 * State lives in a `timePin` session projection folded from **standard** session
 * events only (`command/run`, `command/done`, `request/header`,
 * `assistant/message`, `tool/result`), so resume, fork and replay restore it and
 * no custom event type is ever written. The `/pin` session command is the one
 * mutation path; the Client half submits the same command line.
 *
 * All decision logic lives in `lib/core/fold.js` (pure, unit-tested); this file
 * only adapts Cordis services and builds durable messages.
 *
 * @module dsh-time-pin
 */

import z from '@deepseek-ai/schemastery';
import { z as zod } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import {
  formatAsOfDate,
  formatAsOfDateEn,
  formatSpanEn,
  formatSpanZh,
  isFuture,
  isRestricted,
  parsePinArgs,
  resolveAsOf,
  subtractSpan,
} from './core/window.js';
import { anchorLine, statusSummary, timeFactBlock } from './core/text.js';
import {
  PROJECTION_KEY,
  SOURCE_KIND,
  STATE_VERSION,
  applyEvent,
  createViewCache,
  initialState,
  planStep,
  windowFromState,
} from './core/fold.js';
import { createEvidencePostExecute } from './evidence.js';
import { createSilenceNarration } from './silence.js';
import { createStatusTool } from './tools.js';

/** Loader diagnostics name. */
export const name = 'dsh-time-pin';

/** Hard dependency: the projection registry owns our state. */
export const inject = ['sessionProjections'];

/**
 * Schemastery schema for the profile row's `config`.
 *
 * Both fields are `.volatile()` on purpose, for two reasons:
 * 1. The Harness settings UI only offers a form for schema subtrees with a
 *    volatile field — a config made only of ordinary fields is excluded from
 *    `settings.describe()`, so the plugin would show no configurable page at
 *    all (and no client settings registration would ever fire).
 * 2. A volatile-only change is committed into the running plugin's config refs
 *    without remounting the fiber, so `/pin` result text, injected block locale
 *    and silence thresholds change live.
 */
export const Config = z.object({
  promptLocale: z.union(['zh', 'en']).default('zh').volatile(),
  silence: z
    .object({
      enabled: z.boolean().default(true),
      firstDelayMs: z.number().step(1).min(1000).max(86_400_000).default(90_000),
      repeatMs: z.number().step(1).min(1000).max(86_400_000).default(180_000),
    })
    .default({ enabled: true, firstDelayMs: 90_000, repeatMs: 180_000 })
    .volatile(),
});

/** Read a config value that may be a live volatile ref (`{get}`) or a plain value. */
function configValue(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get();
    return current === undefined ? fallback : current;
  }
  return value === undefined ? fallback : value;
}

/** Resolve the model-facing prompt locale from a (possibly volatile) config. */
function readPromptLocale(config) {
  return configValue(config.promptLocale, 'zh') === 'en' ? 'en' : 'zh';
}

/** Resolve the silence-narration settings from a (possibly volatile) config. */
function readSilenceConfig(config) {
  const raw = configValue(config.silence, {}) ?? {};
  return {
    enabled: raw.enabled !== false,
    firstDelayMs: Number(raw.firstDelayMs ?? 90_000),
    repeatMs: Number(raw.repeatMs ?? 180_000),
  };
}

/** Projection state: plain JSON so the projection cache can checkpoint it. */
const timePinStateSchema = zod.object({
  restricted: zod.boolean(),
  asOf: zod.string().nullable(),
  span: zod.string().nullable(),
  injectedSig: zod.string().nullable(),
  anchorPending: zod.boolean(),
  lastOutputAt: zod.number().nullable(),
  runStartedAt: zod.number().nullable(),
  updatedAt: zod.number().nullable(),
  running: zod.object({ commandId: zod.string(), args: zod.string() }).nullable(),
});

/** Client wire view: pure function of projection state (no clock reads). */
const timePinViewSchema = zod.object({
  restricted: zod.boolean(),
  asOf: zod.string().nullable(),
  span: zod.string().nullable(),
  asOfLabel: zod.string(),
  spanLabel: zod.string(),
  chipLabel: zod.string(),
  asOfInput: zod.string(),
  spanInput: zod.string(),
  modeBase: zod.enum(['default', 'recent', 'pinned']),
  asOfDay: zod.number().nullable(),
  anchorPending: zod.boolean(),
  lastOutputAt: zod.number().nullable(),
  runStartedAt: zod.number().nullable(),
  updatedAt: zod.number().nullable(),
  version: zod.number(),
});

/** Human summary of a restriction change, used by the command result. */
function pinResultText(window, locale) {
  if (window == null) {
    return locale === 'en'
      ? 'Time window cleared; default mode restored (no evidence filtering).'
      : '时间窗已清空，回到默认模式（不做证据过滤）。';
  }
  const anchor = anchorLine(window, locale);
  const future = isFuture(window);
  if (locale === 'en') {
    return [
      `Time window updated: ${anchor.replace(/^[^:]*:\s*/, '')}.`,
      future
        ? 'Future view: the model does not know this period; answers are in-universe speculation.'
        : 'Restricted mode: only dated sources inside the window are used; undated sources are excluded.',
    ].join(' ');
  }
  return [
    `时间窗已更新：${anchor.replace(/^[^：]*：/, '')}。`,
    future
      ? '未来视角：模型不知道该时段，回答按设定视角推演。'
      : '受限模式：只使用窗口内带日期的来源，无日期来源一律排除。',
  ].join('');
}

/** Wrap one planned injection as a durable, source-attributed user message. */
function pluginMessage(text, form) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: SOURCE_KIND,
      form,
      summary: text.split('\n', 1)[0],
      ...(form === 'snapshot' ? { sections: [{ name: SOURCE_KIND, text }] } : {}),
    },
  });
}

/**
 * Register the projection, injections, command, tool, evidence filter and
 * silence narration for the lifetime of `ctx`.
 *
 * @param ctx - plugin context.
 * @param config - validated row config.
 */
export function apply(ctx, config = {}) {
  // Volatile refs keep these live: a settings-page edit commits into the running
  // config without remounting, and the `loader/volatile-update` listener below
  // re-reads them (silence thresholds get a fresh bookkeeper).
  let promptLocale = readPromptLocale(config);
  let silenceConfig = readSilenceConfig(config);

  /** Per-session anchor reminder budget (in memory; bounded by live sessions). */
  const anchorReminders = new WeakMap();
  const canRemind = (session, signature) => {
    const budget = anchorReminders.get(session);
    const used = budget?.sig === signature ? budget.count : 0;
    if (used >= 2) return false;
    anchorReminders.set(session, { sig: signature, count: used + 1 });
    return true;
  };

  /** Silence bookkeeping fed by `ctx.jobs.events`. */
  let silence = createSilenceNarration({ config: silenceConfig });
  ctx.effect(() => () => silence.dispose(), 'dsh-time-pin: silence lifetime');

  // Re-read volatile config on a live settings edit (no remount).
  ctx.on('loader/volatile-update', () => {
    try {
      promptLocale = readPromptLocale(config);
      const next = readSilenceConfig(config);
      const changed =
        next.enabled !== silenceConfig.enabled ||
        next.firstDelayMs !== silenceConfig.firstDelayMs ||
        next.repeatMs !== silenceConfig.repeatMs;
      if (!changed) return;
      silenceConfig = next;
      silence.dispose();
      silence = createSilenceNarration({ config: next });
    } catch (error) {
      ctx.logger?.warn?.('dsh-time-pin: volatile config update skipped: %o', error);
    }
  });
  const viewOf = createViewCache();

  /** Read the projection state of one session (undefined when not materialized). */
  const stateOf = (session) => {
    if (session == null) return undefined;
    try {
      return ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
    } catch {
      return undefined;
    }
  };

  /** Window of one agent's session, or null in default mode. */
  const windowOf = (agent) => windowFromState(stateOf(agent?.session));

  // 1. Projection: folds standard session events into the window state.
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: timePinStateSchema,
    init: initialState,
    apply: (state, event) => applyEvent(state, event, { promptLocale }),
    wire: {
      viewSchema: timePinViewSchema,
      view: (state) => viewOf(state),
    },
  });

  // 2. Pre-step injection: the window block once per window change, a short
  //    clear notice when restriction is lifted, one anchor correction when the
  //    model skipped the echo, and TIME FACTS for silent background jobs.
  //    Everything is a durable user message, so replay reconstructs it exactly.
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      if (decision == null || decision.kind === 'reject' || payload.signal?.aborted) return decision;
      try {
        const state = stateOf(payload.agent.session);
        if (state === undefined) return decision;
        const now = Date.now();
        let silenceText;
        if (silenceConfig.enabled) {
          const sessionId = String(payload.agent.session?.id ?? payload.agent.id ?? '');
          if (sessionId !== '') {
            const facts = silence.factsFor(sessionId);
            if (facts.length > 0) {
              silence.markNarrated(sessionId, facts);
              silenceText = timeFactBlock(facts, now, promptLocale);
            }
          }
        }
        const planned = planStep({
          state,
          nowMs: now,
          promptLocale,
          turnStart: payload.step === 1,
          canRemind: (signature) => canRemind(payload.agent.session, signature),
          silenceText,
        });
        if (planned.length === 0) return decision;
        return {
          ...decision,
          messages: [...decision.messages, ...planned.map((entry) => pluginMessage(entry.text, entry.form))],
        };
      } catch (error) {
        ctx.logger?.warn?.('dsh-time-pin: pre-step injection skipped: %o', error);
        return decision;
      }
    },
    { prepend: true },
  );

  // 3. The single mutation path: the `/pin` session command (human-only).
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'pin',
      description:
        'Pin the conversation time window (as_of + lookback span), or clear it with /pin off',
      input: { hint: '[<as-of> [<span>]] | off' },
      handler: ({ agent, rawInput }) => {
        const text = String(rawInput ?? '').trim();
        const parsed = parsePinArgs(text);
        if (parsed.kind === 'status') {
          return { kind: 'success', text: statusSummary(windowOf(agent), Date.now(), promptLocale) };
        }
        if (parsed.kind === 'invalid') return { kind: 'error', text: parsed.message };
        const current = windowOf(agent);
        if (parsed.kind === 'off') return { kind: 'success', text: pinResultText(null, promptLocale) };
        if (parsed.kind === 'span') {
          // A span alone keeps the clock on "today"; a null span means the user
          // removed the lower bound, so with no pinned as-of this is default mode.
          const window = parsed.span == null ? null : { asOf: null, span: parsed.span };
          return { kind: 'success', text: pinResultText(window, promptLocale) };
        }
        const window = {
          asOf: parsed.asOf,
          span: parsed.kind === 'asOf' ? (current?.span ?? null) : parsed.span,
        };
        return { kind: 'success', text: pinResultText(window, promptLocale) };
      },
    });
  });

  // 4. Read-only self inspection for the model.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(
      createStatusTool({
        getState: (agent) => {
          const window = windowOf(agent);
          const state = stateOf(agent?.session);
          const now = Date.now();
          const restricted = isRestricted(window);
          const format = promptLocale === 'en' ? formatAsOfDateEn : formatAsOfDate;
          const asOf = restricted ? resolveAsOf(window, now) : null;
          const lower =
            restricted && window?.span != null ? subtractSpan(asOf, window.span) : null;
          let timezone = 'local';
          try {
            timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
          } catch {
            // keep the fallback
          }
          return {
            restricted,
            mode: !restricted
              ? 'default'
              : isFuture(window, now)
                ? 'future'
                : window?.asOf == null
                  ? 'recent'
                  : 'past',
            asOfLabel: asOf == null ? 'default' : format(asOf),
            spanLabel:
              window?.span == null
                ? promptLocale === 'en'
                  ? 'unlimited'
                  : '不限'
                : promptLocale === 'en'
                  ? formatSpanEn(window.span)
                  : formatSpanZh(window.span),
            windowLowerLabel: lower == null ? 'unbounded' : format(lower),
            windowUpperLabel: asOf == null ? 'default' : format(asOf),
            timezone,
            nowIso: new Date(now).toISOString(),
            future: restricted && isFuture(window, now),
            anchorPending: state?.anchorPending === true,
          };
        },
      }),
    );
  });

  // 5. Restricted-mode evidence filtering for `web_search`.
  ctx.on(
    'tools/post-execute',
    createEvidencePostExecute({
      getWindow: (agent) => windowOf(agent),
      locale: () => promptLocale,
    }),
  );

  // 6. Background-job silence bookkeeping.
  ctx.inject(['jobs'], (jobCtx) => {
    jobCtx.effect(
      () => jobCtx.jobs.events.subscribe({ owners: 'all' }, (event) => silence.onJobEvent(event)),
      'dsh-time-pin: job silence events',
    );
  });
}

export { PROJECTION_KEY };
