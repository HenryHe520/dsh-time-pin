# INDEXING · 社区索引/分发渠道状态

> 更新：2026-11-06 ｜ npm `dsh-time-pin@0.1.0`（0.1.1 已就绪待发布）
> 仓库 <https://github.com/HenryHe520/dsh-time-pin> ｜ 已加 topic `dsh-plugin`

| 渠道 | 机制 | 状态 | 下一步 |
|---|---|---|---|
| **dshfind.com**（hikariming/dshfind） | 每天 02:17 UTC 自动抓取 GitHub topic `dsh-plugin`，无需 PR | topic 已于 2026-11-06 加入 → **预计 2026-11-07 10:17（UTC+8）后出现** | 下次同步后到站点确认；两天仍无则提 issue |
| **awesome-dsh-plugin**（`dsh-market` 插件市场的数据源，9,111 条） | 官方仓库 PR，一个插件一个 YAML（`data/plugins/<owner>__<repo>.yml`） | **PR 已开**：[#12650](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/12650)（fork 分支 `HenryHe520:add-dsh-time-pin`，条目 `data/plugins/HenryHe520__dsh-time-pin.yml`，分类 `tools`） | 等 CI/维护者合并；合并后站点当日重建，`dsh-market` 打开即拉到 |
| **dshpluginhub.ai**（独立社区，PaxTech） | 有「发布插件」dashboard，需要账号 | 未提交 | **需要你登录**：<https://dshpluginhub.ai/zh/dashboard>；文案见下方 §1 |
| **cordis.run** | 官方市场，提交后人工审核 | **审核中**（2026-11-04 提交；未挂反链所以是人工队列） | 等结果；想加速可补反链走 24h 快速通道 |
| 第三方镜像页（dshbase.com、dshplugin.store、deepseekharness.io 等） | 多为自动镜像 npm / awesome 列表 | 未出现 | 随 awesome 收录 + npm 元数据更新后自行出现，无需单独提交 |

## 1. dshpluginhub 提交材料（登录后填）

- 插件名：`Time Anchor`
- npm：`dsh-time-pin`（若要求版本：`0.1.1` 发布后填最新）
- GitHub：https://github.com/HenryHe520/dsh-time-pin
- 一句话：`Pin the agent's as-of clock and give every conversation a dated evidence window.`
- 详细描述：见 `SUBMIT.md` §2「简短描述（20–800 字符，英文）」
- 分类/标签：`AI 能力增强`、`个人助理`、`开发辅助`；标签 `时间锚定, 历史视角, 证据窗口, as-of, 检索过滤, DSH 插件`
- Logo：`docs/screenshots/logo-512.png`；封面：`docs/screenshots/cover-16x9.png`
- 截图：`docs/screenshots/shot-0*.png`

## 2. awesome-dsh-plugin 条目（已提交，留档）

```yaml
url: https://github.com/HenryHe520/dsh-time-pin
name: HenryHe520/dsh-time-pin
category: tools
icon: https://raw.githubusercontent.com/HenryHe520/dsh-time-pin/main/docs/screenshots/icon-512.png
description:
  en: '…'   # 见 market/HenryHe520__dsh-time-pin.yml
  zh: '…'
```

CI 要求（均已满足）：仓库声明 `dsh.bundle`、仓库创建满 1 天、`dsh-plugin` topic、描述与代码一致、单文件 PR、不改生成 README。

## 3. 待办（需要维护者手动做）

1. **npm token 过期**：`~/.npmrc` 里的 token 已失效（`npm whoami` → 401）。重新 `npm login` 后，
   `cd dsh-time-pin && npm stage publish` 或 `npm publish --otp=<code>` 发布 `0.1.1`
   （0.1.1 只含打包/文档更新：`repository`/`homepage`/`bugs`/`author`、npm README 截图、
   `screenshots.json`、打包内截图；无运行时行为变更）。
2. **dshpluginhub.ai** 登录后按 §1 提交。
3. **cordis.run** 审核结果出来后：通过则把市场链接补进 README/PUBLISH；被拒则按原因修改重提。
