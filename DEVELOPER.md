# YouTube视频下载助手 — 开发者文档

> **版本：1.0.0（骨架）** | Manifest V3 | 更新：2026-07-14  
> **新开会话请先通读本文 + `manifest.json`。**  
> **对外页面（`docs/` 隐私/FAQ）勿写实现细节**，只写用户能操作的说明。  
> **当前状态：项目结构已与 `bilibili-downloader` 对齐；下载/清晰度逻辑尚未实现。**

---

## 0. 协作第一原则（最高优先级）

**能让开发者本人操作的，尽量让本人操作。** 本机环境（Edge 重载扩展、YouTube 页 F5、`git push`、Pages 验证、商店上传 zip）通常比 Agent 代跑更方便、更可控。

| Agent 应做 | 交给开发者本人 |
|------------|----------------|
| 改代码、改文档、列步骤与命令 | `git commit` / `git push`（除非明确要求代做） |
| 说明「改完后：重载扩展 + F5」 | 本地加载 / 重载扩展、打开 YouTube 实测 |
| 写好 pack 命令与 zip 路径 | 运行 `pack.py`、上传 Edge 商店 |
| FAQ/隐私改完后给 Pages URL | 浏览器打开验证、等 Pages 部署 |
| 列出可选优化，等确认再写代码 | 产品取舍 |

**与 B 站插件对照：**

| 项 | bilibili-downloader | youtube-downloader |
|----|---------------------|--------------------|
| 路径 | `d:\插件\bilibili-downloader` | `d:\插件\youtube-downloader` |
| postMessage | `bili-dl-panel` / `bili-dl-agent` | `yt-dl-panel` / `yt-dl-agent` |
| popup API | `__BILI_DL_API__` / `BILI_DL_*` | `__YT_DL_API__` / `YT_DL_*` |
| 匹配页 | `/video/BV…` | `/watch?v=`、`/shorts/` |
| CSS 变量 | `--bdl-*` | `--ytd-*`（主色红 `#dc2626`） |
| 下载实现 | ✅ 已完成 | ⏳ 骨架，待实现 |

---

## 0.1 新会话 30 秒上手

```text
项目路径    d:\插件\youtube-downloader
定位        YouTube 视频页保存 MP4（目标），完全免费；当前为结构骨架
核心约束    下载宜在页面 MAIN world；不破解付费/DRM；不收集用户数据
双入口 UI   右下角悬浮面板（主操作） + 右上角 popup（信息 + 打开面板）
改 UI       content.js / content.css（面板）  popup/*（工具栏弹窗）
改下载逻辑   content/page-agent.js   ← 下一步重点
改版本      manifest.json → version；改 _locales 若改名称描述
打包        python scripts/pack.py  →  youtube-downloader.zip
本地调试    edge://extensions 加载已解压 → YouTube 视频页 F5
```

**改代码后生效：**

| 改了什么 | 用户操作 |
|----------|----------|
| `page-agent.js` | F5 刷新 YouTube 页 |
| `content.js` / `content.css` / `manifest.json` / `popup/*` | 重新加载扩展 + F5 |
| `_locales/*` | 重新加载扩展；商店需重传 zip |

---

## 1. 产品决策（骨架阶段约定）

| 决策 | 说明 |
|------|------|
| 目标用户 | 界面优先中文，`default_locale: zh_CN` |
| 收费 | **全免费**，无内购/激活码 |
| 功能范围 | **目标**：普通 watch / Shorts 页保存 MP4；**不做**会员专属绕过、不破解 DRM |
| 播放列表 | 首版建议只下当前打开的这一集（与 B 站「不做合集批量」同思路） |
| 下载 UI | 复用 B 站双入口：进度条、暂停/继续/取消（实现下载时接入） |
| 反馈 | QQ `748604487`，`tencent://` + 复制号码 |
| 合规 | 个人学习；遵守 YouTube ToS / 版权；不上传数据 |

---

## 2. 外部链接

| 用途 | URL |
|------|------|
| 隐私政策（Pages，待建仓） | https://snowflake-hangdudu.github.io/youtube-downloader/ |
| 常见问题 FAQ（Pages） | https://snowflake-hangdudu.github.io/youtube-downloader/faq.html |
| Edge 开发者 | https://partner.microsoft.com/dashboard |
| Edge 上架说明 | 见 `store/EDGE_SUBMIT.md` |
| GitHub Pages 说明 | 见 `store/GITHUB_PAGES.md` |

---

## 3. 项目结构

```
youtube-downloader/
├── manifest.json              # 版本、权限、content_scripts、i18n 入口
├── background.js              # Service Worker，仅安装日志
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
├── content/
│   ├── page-agent.js          # ★ MAIN world：解析/下载（骨架，待实现）
│   ├── content.js             # ★ ISOLATED world：悬浮 UI、postMessage、popup 通信
│   └── content.css            # 悬浮面板样式（红主色）
├── popup/
│   ├── popup.html/js/css
├── lib/
│   ├── mp4-remux.iife.js      # 第三方 DASH 合并（MIT）
│   └── m4s-mux.js             # 封装 mergeM4s（YtM4sMux / BiliM4sMux）
├── icons/
├── assets/icon-source.png
├── docs/index.html            # GitHub Pages 隐私政策
├── docs/faq.html
├── store/
│   ├── privacy.html / faq.html
│   ├── EDGE_SUBMIT.md / GITHUB_PAGES.md
│   └──（logo/tile 用 scripts/gen_store_assets.py 生成）
├── scripts/
│   ├── pack.py
│   ├── gen_icons.py
│   └── gen_store_assets.py
├── test/
└── youtube-downloader.zip     # pack.py 输出
```

结构与 `bilibili-downloader` **一一对应**，便于双项目同步改 UI / 打包 / 商店流程。

---

## 4. 架构

### 4.1 为何双 World

YouTube 媒体流（`googlevideo.com`）通常也需页面上下文的 Cookie / 身份。与 B 站相同：**MAIN world** 做解析与拉流，**ISOLATED** 做 UI 与 `chrome.runtime`。

```
YouTube 页面
┌─────────────────────┐   postMessage    ┌──────────────────┐
│ page-agent.js       │ ◄──────────────► │ content.js       │
│ (MAIN)              │  yt-dl-panel     │ (ISOLATED)       │
│ · 解析 playerResponse│  yt-dl-agent    │ · 悬浮 UI        │
│ · CDN 下载（待实现） │                  │ · chrome.runtime │
│ · mp4-remux 合并     │                  │ · <a download>   │
└─────────────────────┘                  └──────────────────┘
         ▲ 外链注入 mp4-remux.iife.js + m4s-mux.js
```

### 4.2 postMessage 协议（content ↔ page-agent）

**常量（两处必须一致）：**

```javascript
const PANEL = 'yt-dl-panel';  // content.js 发出
const AGENT = 'yt-dl-agent';  // page-agent.js 发出
```

**content → page-agent：**（与 B 站同名指令，便于对照）

| type | 参数 | 返回 data | 状态 |
|------|------|-----------|------|
| `PARSE_URL` | `href` | `{ idInfo: { videoId } }` | ✅ |
| `RESOLVE_VIDEO` | `href, pageIndex` | `{ info }` | ✅ 基础信息 |
| `GET_QUALITIES` | `aid, cid`（当前等于 videoId） | `{ qualities[], maxQn, maxLabel, loginHint? }` | ⏳ 空列表 |
| `GET_ESTIMATE` | … | `{ sizeBytes, sizeLabel }` | ⏳ |
| `START_DOWNLOAD` | … | 见实现后文档 | ⏳ 抛错提示 |
| `PAUSE/RESUME/CANCEL_DOWNLOAD` | — | — | ⏳ 空操作 |

**`RESOLVE_VIDEO` 的 info 字段（骨架）：**

```javascript
{ videoId, bvid, aid, cid, title, pages, pic, author, view, pubdate, duration, _stub: true }
// 说明：aid/cid 暂填 videoId，仅为复用 content.js；实现下载后可统一改为 videoId
```

**page-agent → content：** `OK` / `ERR`（带 `id`）、`LOG`、`PROGRESS`

### 4.3 popup ↔ content

| type | 作用 |
|------|------|
| `YT_DL_GET_INFO` | 返回 `fetchSnapshot()` |
| `YT_DL_OPEN_PANEL` | 打开悬浮面板 |

`window.__YT_DL_API__` 暴露给 content 内部。

---

## 5. UI 说明

与 B 站插件相同分工：

- **悬浮面板**：主下载入口（`content.js` + `content.css`）
- **popup**：信息预览 +「打开下载面板」

骨架阶段：面板可识别标题/封面/作者；清晰度为空；下载按钮因无清晰度保持禁用。

---

## 6. 核心流程（目标，待实现）

```
打开面板 → RESOLVE_VIDEO（ytInitialPlayerResponse）
         → GET_QUALITIES（streamingData / itag）
         → START_DOWNLOAD（拉 googlevideo 流 → 必要时合并 → 保存 MP4）
```

实现时注意：

- 优先 progressive `formats`（音视频一体）；否则 adaptive 分离轨 + `YtM4sMux.mergeM4s`
- 尊重签名 URL 有效期；失败时提示刷新页面
- **禁止**绕过 DRM / Premium 专属加密流

---

## 7. YouTube 数据源（实现时）

| 来源 | 用途 |
|------|------|
| `ytInitialPlayerResponse.videoDetails` | 标题、作者、时长、封面 |
| `streamingData.formats` | 渐进式 MP4（若有） |
| `streamingData.adaptiveFormats` | 分离音视频（需合并） |
| URL `v=` / `/shorts/` | videoId |

---

## 8. 国际化

同 B 站：`default_locale: zh_CN`，名称/描述在 `_locales/*/messages.json`。

---

## 9. 常见修改

| 任务 | 位置 |
|------|------|
| 改版本 | `manifest.json` → `version` |
| 改扩展名/描述 | `_locales/zh_CN`、`en` |
| 下载/清晰度 | `page-agent.js` |
| 悬浮 UI | `content.js` + `content.css` |
| popup UI | `popup/*` |
| 匹配 URL | `manifest.json` matches |
| 反馈 QQ | `content.js`、`popup.html`、`docs/` |
| 图标 | `assets/icon-source.png` → `python scripts/gen_icons.py` |
| 打包列表 | `scripts/pack.py` → `INCLUDE` |

### 改 UI 主题

CSS 变量在 `content/content.css` 顶部 `--ytd-*`（主色 `#dc2626`）。

---

## 10. 测试

```bash
# 合并链路（与 B 站共用 mp4-remux，可选）
cd test && npm install
npm run test:merge

# 浏览器
edge://extensions → 加载已解压 → youtube-downloader 目录
打开任意 https://www.youtube.com/watch?v=… → F5 → 右下角按钮
```

---

## 11. START_DOWNLOAD 返回值（目标约定）

与 B 站对齐，便于 content.js 少改：

```javascript
{ dash: false }                                    // 已由 page-agent saveBlob
{ merged: true, filename: '标题.mp4', blob: Blob } // content 侧保存
{ dash: true, videoOnly: true }                    // 仅视频轨
```

---

## 12. 打包与发布

```bash
python scripts/pack.py          # → youtube-downloader.zip
python scripts/gen_icons.py
python scripts/gen_store_assets.py
```

**zip 根目录必须直接是 `manifest.json`。** 勿把 `docs/`、`store/`、`DEVELOPER.md`、`test/` 打进扩展包。

---

## 13. 已知问题 / 骨架限制

| 问题 | 处理 |
|------|------|
| 清晰度列表为空 | 正常：`GET_QUALITIES` 未实现 |
| 点下载提示未实现 | 正常：`START_DOWNLOAD` 骨架 |
| 图标暂与 B 站同源 | 可换 `assets/icon-source.png` 后跑 `gen_icons.py` |
| Shorts / 嵌套播放器 | matches 已含 shorts；复杂页需实测补强 |

---

## 14. 代码速查

| 想改… | 文件 | 符号 |
|--------|------|------|
| 下载 | `page-agent.js` | `handleDownload`（待写） |
| 清晰度 | `page-agent.js` | `getQualities`（待写） |
| 面板 UI | `content.js`, `content.css` | `mountUI`, `loadVideoInfo` |
| popup | `popup.js` | `init`, `renderVideo` |
| popup↔面板 | `content.js` | `__YT_DL_API__`, `YT_DL_*` |
| 权限/匹配 | `manifest.json` | — |
| 打包列表 | `scripts/pack.py` | `INCLUDE` |

---

## 15. 版本史

| 版本 | 说明 |
|------|------|
| v1.0.0 | 项目骨架：目录/协议/UI 与 bilibili-downloader 对齐；识别视频元数据；下载待实现 |

---

## 16. 依赖

| 文件 | 来源 |
|------|------|
| `lib/mp4-remux.iife.js` | [mscststs/mp4-remux](https://github.com/mscststs/mp4-remux) MIT |

---

## 17. 新会话推荐第一句话

```text
请先阅读 youtube-downloader/DEVELOPER.md 和 manifest.json，然后实现：<你的需求>
```

---

## 18. 后续实现清单（相对 B 站插件）

| 优先级 | 项 | 说明 |
|--------|-----|------|
| 高 | `getQualities` | 从 `streamingData` 解析可用清晰度 |
| 高 | `handleDownload` | 拉流 + 合并 + 保存 |
| 高 | 错误指引 | 刷新 / 先播放 / 换清晰度 |
| 中 | SPA 路由 | YouTube 客户端路由切换时刷新面板 |
| 中 | 独立图标 | 替换 `icon-source.png` |
| 低 | 播放列表批量 | 首版建议不做 |
| 低 | 商店上架 | Pages + pack + Partner Center |

---

*文档与骨架同步至 v1.0.0（2026-07-14）。实现下载后请更新 §6–§7、§11、§13、§15。*
