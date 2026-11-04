# SUBMIT · cordis.run 上架（按真实 5 步表单）

> 入口：<https://cordis.run/submit>（需登录；**所有字段用英文**；提供反链可走快速通道 24h 自动发布）
> 已发布 npm 包：`dsh-time-pin@0.1.0`（已声明 `dsh.bundle`，表单校验会通过）
> GitHub：<https://github.com/HenryHe520/dsh-time-pin>

---

## 01 / 05 网址

**官网 URL**：填 GitHub 仓库地址，然后点「自动填充」：

```text
https://github.com/HenryHe520/dsh-time-pin
```

自动填充若拿不到信息，就手动按 03 步填写。备用 URL（npm 包页）：
`https://www.npmjs.com/package/dsh-time-pin`

## 02 / 05 cordis 插件信息

**npm 包名**

```text
dsh-time-pin
```

**GitHub 仓库（可选）**

```text
https://github.com/HenryHe520/dsh-time-pin
```

## 03 / 05 基本信息

**工具名称**

```text
Time Anchor
```

**一句话简介（≤120 字）** —— 79 字符

```text
Pin the agent's as-of clock and give every conversation a dated evidence window
```

**简短描述（20–800 字符，英文）** —— 699 字符

```text
Time Anchor gives every DeepSeek Harness conversation a pinned "as of" clock and a lookback span: the evidence window [as_of - span, as_of]. Pin a past, future, or BC time point from the chat header or with /pin. In restricted mode the agent is told the exact window and must only use dated sources inside it: web_search results are filtered by publication date, undated sources are excluded, and the first reply must echo the active window (a missing echo gets one nudge). Long silent background jobs produce deterministic [TIME FACT] facts. A read-only time_pin_status tool lets the agent inspect its own window. Default mode injects nothing. Evidence isolation, not model amnesia. MIT-licensed and free; zero telemetry.
```

**定价模式**：选最接近「免费」的选项（MIT 开源、无付费功能）。

## 03 / 05 图片

| 字段 | 文件 |
|---|---|
| Logo（方形 PNG/JPG/WebP ≤5MB） | `docs/screenshots/logo-512.png`（512×512） |
| 封面图（16:9，可选） | `docs/screenshots/cover-16x9.png`（1280×720） |

## 04 / 05 分类与标签

**分类（可多选，最多 6）**：建议选 3 个
`AI 能力增强`、`个人助理`、`开发辅助`（如选项不同：`工作流自动化` / `自动化` 亦可）

**建议标签（逗号分隔，最多 8 个，每个 ≤30 字符）**

```text
时间锚定, 历史视角, 证据窗口, as-of, 检索过滤, DSH 插件
```

## 05 / 05 富内容（可选，但建议填）

**核心亮点**

```text
Pin any as-of date — past, future, or BC — from the chat header or with /pin.
Restricted evidence: only dated sources inside [as_of − span, as_of]; undated sources are rejected.
Anchor echo: the first reply must confirm the active window; a missing echo gets one nudge.
web_search results filtered by publication date, with an explicit exclusion note.
Deterministic [TIME FACT] narration for long silent background jobs.
Read-only time_pin_status tool so the agent can inspect its own window; default mode injects nothing.
```

**使用场景**

```text
Historical perspective: "What did the web look like in 2000? Use only sources published before 2000."
Freshness bound: "Only the last 7 days of information for this market question."
Future or fiction framing: "Reason from 3000 CE as a setting — label speculation as speculation."
Long tasks: get a deterministic status fact when a background job goes quiet.
```

**常见问题**

```text
Q: Does it make the model forget the future?
A: No — evidence isolation, not amnesia. It constrains what may be used as evidence and requires an explicit window statement; it cannot erase training knowledge.

Q: What gets filtered?
A: In restricted mode, web_search results: undated sources and sources outside the window are dropped with a note.

Q: Does default mode change anything?
A: No. Default mode injects nothing and filters nothing.

Q: Where do I configure it?
A: Plugins → Installed → dsh-time-pin → Configure. Restart DSH once after installing; after that, settings apply live.
```

## 提交后

把结果（审核中 / 已发布 / 拒绝原因）告诉维护者，更新 `PUBLISH.md` 记录；若被拒，按原因改材料重提。
