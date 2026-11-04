# SUBMIT · cordis.run 上架清单

> 上架入口：<https://cordis.run/submit>
> 规则要点（来自提交页）：**所有字段用英文填写**；提供反链可走快速通道（验证后 24h 自动发布），
> 不挂反链则进入人工审核队列；提交需要 cordis.run 账号登录。
> 提交页（登录后）可能还有分类、图标、截图上传等字段，下面英文文案可直接复制。

---

## 1. 前置：GitHub 仓库

仓库名建议 `dsh-time-pin`（public）。本目录已 `git init` 并提交好首个 commit，
你只需建仓库并 push（或让 gh 重新登录后由我代推）：

```sh
cd "E:\工作文件\插件制作\dsh-time-pin"

# 方式 A：用 GitHub CLI（当前 gh token 过期，先重新登录）
gh auth login
gh repo create dsh-time-pin --public --source . --remote origin --push

# 方式 B：先在网页建空仓库（不要勾 README），再
git remote add origin https://github.com/<owner>/dsh-time-pin.git
git push -u origin main
```

## 2. 英文提交文案（可直接复制）

**Name / Title**

```text
Time Anchor
```

**Tagline (short description, ≤ ~80 chars)**

```text
Pin your agent's "as of" clock and give every conversation a dated evidence window.
```

**Full description (English)**

```text
Time Anchor gives every DSH conversation a pinned "as of" clock and a lookback window: the evidence window [as_of - span, as_of].

Pin a time point (past, future, or BC) and a lookback span from the conversation header, or type /pin. In restricted mode the agent is told the exact window and the evidence rules once per window change: it may only use dated sources inside the window, undated sources are excluded, and its first reply must echo the active window (anchor echo). web_search results are filtered to dated sources inside the window; an empty window produces an honest "no dated evidence" answer instead of invention.

It also narrates long-running silent background jobs with deterministic [TIME FACT] facts, and exposes a read-only time_pin_status tool so the agent can inspect its own window. Default mode injects nothing.

Honest disclaimer: this is evidence isolation, not model amnesia — the model may still know events after as_of; the plugin constrains what may be used as evidence and makes the model state its window, but does not promise zero leakage. Zero telemetry, no network requests of its own. Configure it from Plugins -> Installed -> dsh-time-pin -> Configure.
```

**npm package name**

```text
dsh-time-pin
```

**Install command (copy from the marketplace page after submit)**

```text
dsh plugin --profile <profile> add dsh-time-pin
```

**Repository URL**

```text
https://github.com/<owner>/dsh-time-pin
```

**Category suggestions**（按提交页实际选项选择）
`Productivity` / `AI tools` / `Developer tools` / `Time & History`（选最接近的两项）

**Tags / keywords**

```text
dsh, dsh-plugin, time anchor, as-of, time window, historical perspective, evidence filter, anchor echo, background jobs, progress
```

**Compatibility**

```text
DSH >= 0.2.1-rc < 2 (engines.dsh), Node.js >= 20
```

**Privacy / safety statement**

```text
Zero telemetry. The plugin makes no network requests of its own; all web access is the Host's own retrieval capability. No credentials, no filesystem access, no eval / dynamic code execution.
```

**Backlink (可选，快速通道)**：如果你有任何可编辑的网站/博客，加一个指向插件页或仓库的链接，并在提交表单里填该 URL。

## 3. 图标与截图

- Icon：包根 `icon.svg`（64×64，已随 npm 包导出为 `./icon`）。若表单只收 PNG，可用 `docs/screenshots/icon-512.png`（我生成）。
- 截图：放 `docs/screenshots/`，命名与内容见 §4；我会把它们裁切、加标注、转 PNG/JPEG 优化。

## 4. 截图拍摄脚本（你拍，我来处理）

保存目录：`E:\工作文件\插件制作\dsh-time-pin\docs\screenshots\`

| 文件 | 画面 | 操作 |
|---|---|---|
| `raw-01-default.png` | 默认态 | 新对话，标题栏右侧 `🕐 默认 · 不限` chip（可 hover 出 tooltip） |
| `raw-02-panel.png` | 设置面板 | 点 chip 展开面板，as-of 填 `2000-01-01`，span 选 `10年`（先别点应用） |
| `raw-03-pinned.png` | 受限态 | 点「应用」，等 chip 变 `🕰 2000-01-01 · 前10年`，截对话区 |
| `raw-04-future.png` | 未来视角 | 面板输入 `3000-01-01` 应用，截 chip `🌌 3000-01-01 · 不限` 与未来提示 |
| `raw-05-settings.png` | 配置页 | 侧边栏 → 插件 → 已安装 → dsh-time-pin → 配置（四项控件） |
| `raw-06-bc.png`（可选） | 公元前 | `公元前200年` + `前20年` |
| `raw-demo.mp4` / `.gif`（可选） | 30–60s 演示 | 见 §5 |

拍摄工具：`Win + Shift + S` 区域截图（存 PNG），或 `Win + PrtScn` 全屏（存到 图片\屏幕截图）。
注意：**不要拍到**侧边栏其它会话名、账号、文件路径等隐私信息；窗口宽度建议 ≥1200px；深/浅色主题保持一致。

## 5. 演示 GIF / 录屏

- 最简单：`Win + G`（Xbox Game Bar）录 30–60 秒 MP4，保存为 `raw-demo.mp4`，我会转 GIF（需要时我会装一个小工具）。
- 或 `Win + Shift + S` 连拍 4–6 张不同状态，我用 Pillow 拼成 slideshow GIF（不如真实录屏，但够用）。

## 6. 提交步骤

1. 打开 <https://cordis.run/submit> 并登录；
2. 填 §2 的英文文案，上传 icon + 截图（若有分类/标签也按 §2 选）；
3. 有反链就填反链（快速通道），没有就等人工审核；
4. 提交后把结果页/邮件里的状态告诉我，我更新 `PUBLISH.md` 的发布记录并补 README 的截图引用。
