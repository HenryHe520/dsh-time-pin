# PUBLISH · dsh-time-pin

## 已发布

| 项 | 值 |
|---|---|
| npm 包 | `dsh-time-pin` |
| 已发布版本 | `0.1.0` |
| dist-tag | `latest` → `0.1.0` |
| 发布时间 | 2026-11-04 11:22 (本地) |
| 发布账号 | `henryhe520` |
| 包地址 | https://www.npmjs.com/package/dsh-time-pin |
| tarball | https://registry.npmjs.org/dsh-time-pin/-/dsh-time-pin-0.1.0.tgz |
| GitHub 仓库 | https://github.com/HenryHe520/dsh-time-pin |
| 市场素材 | `docs/screenshots/`（4 张 1280×720 成品图 + `icon-512.png` + slideshow GIF），已随 README 引用 |
| 校验 | published tarball 与本地 19 个发布文件 **逐文件哈希一致**（0 差异） |

发布流程说明：这次用的是 npm 的 **staged publishing**（`npm stage publish` + `npm stage approve`），registry 里会先出现一个
`0.0.0-stage` 占位版本，批准后真正的 `0.1.0` 才生效；`0.0.0-stage` 是 npm 的占位记录，不是产品版本。

## 安装（面向用户）

```sh
dsh plugin --profile <profile> add dsh-time-pin
# 首次安装 / 升级后重启一次 DSH（Host 模块不热重载）
```

本机 desktop profile 已切换为 npm 版本（`"dsh-time-pin": "0.1.0"`），重启后从 registry 副本加载。

## 后续版本发布流程

1. 改 `package.json` `version`（如 `0.1.1`），在 `CHANGELOG.md` 加一节；
2. `npm publish`（或 `npm stage publish` + `npm stage approve`）；
3. `npm view dsh-time-pin version` 确认；
4. 市场没有原地升级：用户 `remove` 后 `add`（窗口状态从会话日志推导，不会丢）。

## 发布前自检命令

```sh
node --test tests/window.test.mjs tests/fold.test.mjs tests/evidence.test.mjs tests/silence.test.mjs tests/client.dom.test.mjs tests/host-wiring.test.mjs tests/host-schema.test.mjs
npm pack --dry-run                # 检查 files / tarball 内容
npm publish --dry-run             # 检查 registry / tag / access
```

（Windows 上 `node --test <目录>` 会报 MODULE_NOT_FOUND，直接列文件即可。）

## ⚠️ 维护者警告：本地 link 安装的卸载会删除源码目录

本机开发时用 `plugin_manager install_bundle <本地目录>` 安装（profile 依赖写成
`link:E:/.../dsh-time-pin`）。**卸载这个 link 依赖时，pnpm 会递归删除 junction 目标的内容**，
实测把整个工作区项目目录清空了（2026-11-04 事故）。

因此：

- 从本地路径安装的插件，在 `remove` 之前**先备份/提交源码**；
- 或者改用 `npm pack` 出的 tarball / npm registry 版本做卸载测试；
- 事故恢复方式（已验证可行）：published tarball 解包即可恢复全部发布文件；
  未发布的测试文件可从 `E:\dshdata\sessions` 的会话日志中回放 `write`/`edit`
  工具调用恢复（本次已恢复到 121 tests / 109 pass / 0 fail / 12 skipped）。

## cordis.run 上架（已提交，审核中）

> 其他社区索引/分发渠道（dshfind、awesome-dsh-plugin、dshpluginhub 等）的状态与待办见
> [`INDEXING.md`](INDEXING.md)。

提交入口：<https://cordis.run/submit> ｜ 表单：5 步（网址 / cordis 插件信息 / 基本信息·图片 / 分类标签 / 富内容）

- **状态**：`审核中`（2026-11-04 提交，人工审核队列；未提供反链，因此不走 24h 快速通道）
- 提交快照：`Time Anchor` · `dsh-time-pin` · 2026-11-04
- 预期页面：<https://cordis.run/plugins/dsh-time-pin>（审核通过后生效；当前 404 属正常）
- 提交材料与逐字段文案：见 [`SUBMIT.md`](SUBMIT.md)
- 市场素材：`docs/screenshots/cover-16x9.png`（封面）、`logo-512.png`（Logo）、4 张 1280×720 功能图、`demo-slideshow.gif`
- 审核通过后的收尾：README 加 marketplace 链接/徽章；把 `cordis.run/plugins/dsh-time-pin` 补进本文件的发布记录。

### 审核期间可选的改进

1. **加反链走快速通道**：任何可编辑的网站/博客加一个指向 `https://github.com/HenryHe520/dsh-time-pin` 的链接，并在 cordis.run 表单里补填该 URL（验证后 24h 自动发布）。
2. **npm 0.1.1**：npm 上 `0.1.0` 的 README 是发布前版本（没有截图章节和 GitHub/npm 链接）。发布 `0.1.1` 可让 npm 页面也带上截图；需要维护者用 OTP 执行 `npm publish`（`npm stage publish` 可延后 2FA，但 approve 仍需 OTP）。

