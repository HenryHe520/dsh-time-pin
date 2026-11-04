#!/usr/bin/env python3
"""Text-fit helper for the cordis.run submission form.

Prints each field value with its character count against the form's limit so the
submitter can paste without guessing. Kept in the repo so a future release can
re-verify the copy.
"""
from __future__ import annotations

FIELDS = {
    "tool_name": "Time Anchor",
    "tagline (≤120)": "Pin the agent's as-of clock and give every conversation a dated evidence window",
    "short_description_en (20–800)": (
        "Time Anchor gives every DeepSeek Harness conversation a pinned \"as of\" clock and a lookback span: "
        "the evidence window [as_of - span, as_of]. Pin a past, future, or BC time point from the chat header or "
        "with /pin. In restricted mode the agent is told the exact window and must only use dated sources inside "
        "it: web_search results are filtered by publication date, undated sources are excluded, and the first "
        "reply must echo the active window (a missing echo gets one nudge). Long silent background jobs produce "
        "deterministic [TIME FACT] facts. A read-only time_pin_status tool lets the agent inspect its own window. "
        "Default mode injects nothing. Evidence isolation, not model amnesia. Zero telemetry."
    ),
    "tags (≤8, each ≤30)": "时间锚定, 历史视角, 证据窗口, as-of, 检索过滤, DSH 插件",
}

for label, value in FIELDS.items():
    print(f"{label}: {len(value)} chars")
    print(value)
    print()
