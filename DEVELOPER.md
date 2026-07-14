# YouTube视频下载助手 — 开发者文档

> **版本：1.0.0** | Manifest V3 | 更新：2026-07-14  
> **新开会话请先通读本文 + `manifest.json`。** 读完应能改 bug、加功能、打包、续开发。  
> **对外页面（`docs/` 隐私/FAQ）勿写实现细节**，只写用户能操作的说明。  
> **对照项目：** `d:\插件\bilibili-downloader`（UI/协议/打包同源；下载通路完全不同）。

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

**与 B 站插件对照（勿混）：**

| 项 | bilibili-downloader | youtube-downloader |
|----|---------------------|--------------------|
| 路径 | `d:\插件\bilibili-downloader` | `d:\插件\youtube-downloader` |
| GitHub | `snowflake-hangdudu/bili-downloader` | `snowflake-hangdudu/youtube-downloader` |
| postMessage | `bili-dl-panel` / `bili-dl-agent` | `yt-dl-panel` / `yt-dl-agent` |
| popup API | `__BILI_DL_API__` / `BILI_DL_*` | `__YT_DL_API__` / `YT_DL_*` |
| 匹配页 | `/video/BV…` | `/watch?v=`、`/shorts/` |
| CSS 变量 | `--bdl-*` | `--ytd-*`（主色红 `#dc2626`） |
| CDN 下载 | **必须** MAIN world（后台 403） | **优先 background** Range 并行拉 googlevideo；MAIN 负责解析/合并 |
| 高清来源 | B 站 playurl dash | **InnerTube `android_vr`（钉死 1.65.10）** 直链；WEB 常仅 SABR |
| 进度 | MAIN `PROGRESS` postMessage | background `YT_DL_BG_PROGRESS` → content |

---

## 0.1 新会话 30 秒上手

```text
项目路径    d:\插件\youtube-downloader
定位        YouTube watch/Shorts 页保存 MP4，完全免费；个人学习，不破解 DRM/付费
核心分工    MAIN=解析/InnerTube/合并；background=拉取媒体；ISOLATED=UI
双入口 UI   右下角悬浮面板（主操作） + 右上角 popup（信息 + 打开面板）
改 UI       content.js / content.css（面板）  popup/*（工具栏弹窗）
改解析/选流  content/page-agent.js
改拉流/分片  background.js
改版本      manifest.json → version；改 _locales 若改名称描述
打包        python scripts/pack.py  →  youtube-downloader.zip
本地调试    edge://extensions 加载已解压 → YouTube 视频页 F5 → 看面板「调试日志」
```

**改代码后生效：**

| 改了什么 | 用户操作 |
|----------|----------|
| `page-agent.js` | F5 刷新 YouTube 页 |
| `background.js` | **重新加载扩展**（SW）+ F5 |
| `content.js` / `content.css` / `manifest.json` / `popup/*` | 重新加载扩展 + F5 |
| `_locales/*` | 重新加载扩展；商店需重传 zip |

**实测成功路径特征（调试日志）：**

```text
InnerTube: android_vr … usable>0 maxH=720+|1440
已有 VR/TV 直链，跳过播放器预热
直链改 background 下载（视频+音频）
后台下载 · video · 候选 N 条
… 音频 …
合并 → 保存
```

> 「候选 N 条」= 去重后的 URL。≥2MB 走 **2MB×6 并发 Range**；断线 **分片内续传**。

---

## 1. 产品决策（勿随意推翻）

| 决策 | 说明 |
|------|------|
| 目标用户 | 界面优先中文，`default_locale: zh_CN` |
| 收费 | **全免费**，无内购/激活码 |
| 功能范围 | 普通 **watch / Shorts** 保存 MP4；**不**破解会员/DRM/年龄门绕过 |
| 播放列表 | 首版只下**当前打开这一集**（不做播放列表批量） |
| 下载 UI | 进度条（真实字节 + 阶段）；暂停/继续/取消（合并阶段隐藏暂停） |
| 清晰度 | 以可访问 URL / HLS / 嗅探为准；WEB SABR 无 url **不造假档**；可用时标来源客户端 |
| 反馈 | QQ `748604487`，`tencent://` + 复制号码 |
| 合规 | 个人学习；遵守 YouTube ToS / 版权；不上传用户数据 |

---

## 2. 外部链接

| 用途 | URL |
|------|------|
| GitHub 仓库 | https://github.com/snowflake-hangdudu/youtube-downloader |
| 隐私政策（Pages） | https://snowflake-hangdudu.github.io/youtube-downloader/ |
| 常见问题 FAQ（Pages） | https://snowflake-hangdudu.github.io/youtube-downloader/faq.html |
| Edge 开发者 | https://partner.microsoft.com/dashboard |
| Edge 上架说明 | 见 `store/EDGE_SUBMIT.md` |
| GitHub Pages 说明 | 见 `store/GITHUB_PAGES.md` |

**商店状态（2026-07-14）：** 本地开发中，尚未提交 Edge 审核。版本保持 **1.0.0** 直至首发策略确定。

---

## 3. 项目结构

```
youtube-downloader/
├── manifest.json              # 版本、权限（含 downloads/webRequest）、content_scripts
├── background.js              # ★ Service Worker：嗅探 googlevideo、顺序下载、进度
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
├── content/
│   ├── page-agent.js          # ★ MAIN：playerResponse、InnerTube、选流、HLS、合并指令
│   ├── content.js             # ★ ISOLATED：悬浮 UI、bgFetch、合并回调、调试日志面板
│   └── content.css            # 悬浮面板（红主色 --ytd-*）
├── popup/
│   ├── popup.html/js/css
├── lib/
│   ├── mp4-remux.iife.js      # DASH 合并（MIT）
│   └── m4s-mux.js             # YtM4sMux.mergeM4s
├── icons/
├── assets/icon-source.png
├── docs/index.html / faq.html
├── store/
│   ├── privacy.html / faq.html
│   ├── EDGE_SUBMIT.md / GITHUB_PAGES.md
│   └──（logo/tile 由 scripts 生成）
├── scripts/
│   ├── pack.py
│   ├── gen_icons.py
│   └── gen_store_assets.py
├── test/
└── youtube-downloader.zip
```

结构与 `bilibili-downloader` **一一对应**；差异集中在 `page-agent.js` + **真正干活的 `background.js`**。

---

## 4. 架构

### 4.1 三层分工（与 B 站不同，勿改回「只在 MAIN 拉流」）

```
YouTube 页面
┌─────────────────────┐  postMessage   ┌──────────────────┐
│ page-agent.js       │ ◄────────────► │ content.js       │
│ (MAIN)              │ yt-dl-panel    │ (ISOLATED)       │
│ · playerResponse    │ yt-dl-agent    │ · 悬浮 UI / 调试区│
│ · InnerTube 多端    │                │ · chrome.runtime │
│ · 选流 / HLS 解析   │                │ · bgFetch → SW   │
│ · MERGE_BUFFERS     │                │ · <a download>   │
└─────────────────────┘                └────────┬─────────┘
         ▲ 外链 mp4-remux + m4s-mux             │
                                                ▼
                                       ┌──────────────────┐
                                       │ background.js    │
                                       │ · YT_DL_BG_FETCH │
                                       │ · 单连接顺序拉取 │
                                       │ · webRequest 嗅探│
                                       │ · YT_DL_BG_PROGRESS
                                       └──────────────────┘
```

**为何 background 拉流：** 页面 `fetch(googlevideo)` 常遇 CORS；SW 有 `host_permissions`。  
**为何 MAIN 仍必要：** InnerTube / `ytInitialPlayerResponse` / 播放器钩子只在页面上下文可靠；合并库注入在页面。

### 4.2 postMessage 协议（content ↔ page-agent）

**常量（两处必须一致）：**

```javascript
const PANEL = 'yt-dl-panel';  // content.js 发出
const AGENT = 'yt-dl-agent';  // page-agent.js 发出
```

**content → page-agent：**

| type | 参数 | 返回 data |
|------|------|-----------|
| `PARSE_URL` | `href` | `{ idInfo: { videoId } }` |
| `RESOLVE_VIDEO` | `href, pageIndex` | `{ info }` |
| `GET_QUALITIES` | `aid, cid`（= videoId） | `{ qualities[], maxQn, maxLabel, loginHint?, debug? }` |
| `GET_ESTIMATE` | `aid, cid, qn, duration` | `{ sizeBytes, sizeLabel, estimateNote? }` |
| `START_DOWNLOAD` | `aid, cid, qn, title, itag?, client?, mode?, hlsUrl?` | 见 §11 |
| `MERGE_BUFFERS` | `videoBuffer, audioBuffer, filename` | `{ merged: true, filename, blob }` |
| `MERGE_PENDING_VIDEO` | `audioBuffer` | 合并 `__YT_DL_PENDING_VIDEO__` |
| `SAVE_PENDING_VIDEO` | — | 仅存无声视频 |
| `PAUSE` / `RESUME` / `CANCEL_DOWNLOAD` | — | 信号；bg 侧另发 `YT_DL_BG_ABORT` |

**`RESOLVE_VIDEO` 的 info：**

```javascript
{ videoId, bvid, aid, cid, title, pages, pic, author, view, pubdate, duration }
// aid/cid 复用 B 站 UI 字段，值均为 videoId
```

**page-agent → content：** `OK` / `ERR`（带 `id`）、`LOG`（调试区）、`PROGRESS`（页面侧下载时）

**content 封装：** `agentCall(type, payload)`，超时约 600000ms。

### 4.3 content ↔ background（chrome.runtime）

| type | 方向 | 作用 |
|------|------|------|
| `YT_DL_BG_FETCH` | content→SW | 多 URL 回退、单连接顺序下载 |
| `YT_DL_BG_FETCH_CONCAT` | content→SW | HLS 多分片顺序拼接 |
| `YT_DL_BG_PROGRESS` | SW→content | `{ step, percent, received, total }` → `updateProgress` |
| `YT_DL_BG_LOG` | SW→content | 详细步骤进调试区 |
| `YT_DL_BG_GET_CHUNK` / `YT_DL_BG_RELEASE` | content↔SW | 大文件 **base64** 分块回传（ArrayBuffer 消息在 Edge 会空包） |
| `YT_DL_BG_ABORT` | content→SW | 取消当前 tab 下载 |
| `YT_DL_GET_SNIFFED` | content→SW | 取 webRequest 嗅探到的 googlevideo URL |

### 4.4 popup ↔ content

| type | 作用 |
|------|------|
| `YT_DL_GET_INFO` | `fetchSnapshot()` |
| `YT_DL_OPEN_PANEL` | 打开悬浮面板 |

`window.__YT_DL_API__`。

---

## 5. UI 说明

### 5.1 右下角悬浮面板（主入口）

- 文件：`content.js` + `content.css`
- FAB + 面板：识别条 → 视频卡片 → 清晰度胶囊（可标 `HLS`）→ 预计大小 / 登录提示 → 开始下载
- **调试日志区**：`LOG` + content `debugLog`；支持复制/清空 —— **联调必看**
- 进度：阶段文字、`已收/总量 · %`；视频段与音频段各走一轮
- 底栏：FAQ Pages + QQ 反馈

### 5.2 右上角 popup

- 视频页：封面/标题/清晰度预览、「打开下载面板」
- 非视频页：三步引导
- **实际下载只在面板操作**

---

## 6. 核心流程

### 6.1 元数据

```
fetchSnapshot → RESOLVE_VIDEO → readPlayerResponse()
  优先 #movie_player.getPlayerResponse()
  其次 ytInitialPlayerResponse / DOM og 兜底
```

### 6.2 清晰度 `getQualities()`

1. `loadFullStreamingData(videoId)`：合并页内 `streamingData` + 多客户端 InnerTube  
2. `buildQualityList`：只列可访问档；统计 `sabr无地址` / `cipher` / `drm`  
3. 尝试 `loadHlsBundle`（`web_page` / `web_safari` → `hlsManifestUrl`）；常因 bot/SABR **拿不到 HLS**（日志 `HLS=0` 正常）  
4. UI `mode`：`durl` | `dash` | `hls` | `sniff`

**InnerTube 客户端（关键）：**

| key | 用途 |
|-----|------|
| `web_page` | 页内上下文 + visitorData，抗 bot |
| `web_safari` | 争取 `hlsManifestUrl` |
| **`android_vr`（1.65.10）** | **当前高清直链主力**；版本升高易变纯 SABR |
| `android_vr_old` | 兜底 |
| `tv` / `tv_simply` / `mweb` … | 补充 |

必须带 **`visitorData`**（`ytcfg` / Cookie）时再试 WEB，否则易 `LOGIN_REQUIRED`。

**评分倾向：** `android_vr` ≫ `tv` ≫ 无 `n` 参数直链 ≫ mp4/avc1。

### 6.3 下载 `handleDownload` → content `runSingleDownload`

```
选流 pickStreamsForQn
  ├─ hls     → bgFetchConcat（分片）→ 保存
  ├─ sniff   → 播放器捕获 URL → 页内或 bgFetch
  ├─ durl    → bgFetch 单文件
  └─ dash    → bgFetch 视频 + bgFetch 音频 → MERGE_BUFFERS → 保存
```

- 已有 **VR/TV 直链**：**跳过**播放器预热（预热常抓到无 itag 垃圾请求）  
- DASH 直链默认 **`bgFetch: true`**（视频+音频都走 SW）  
- 页内下完视频、音频失败时：可 `__YT_DL_PENDING_VIDEO__` + 后台补音频  

### 6.4 background 下载与进度

- `fetchOne`：体积 ≥2MB → **2MB 分块 × 最多 6 路并发**；否则单连接；分片/连接断线 → **Range 续传**
- 候选 URL 按 `id|itag|clen` **去重**（避免 withFullRange 伪候选导致断线重头下）；失败可换 Chrome UA 再试
- `readBodyWithStall`：约 **45s 无字节** 或 **20s 吞吐 <32KB** → 假死；已收字节可带 `partial` 供续传
- 有 `Content-Length` / `clen` 时要求收满 **≥95%**，否则续传或失败
- `makeThrottledProgress`：约 80ms 节流；调试区有并行/续传日志（`YT_DL_BG_LOG`）
- 多候选 URL 顺序回退；再失败可尝试 `chrome.downloads` 

### 6.5 合并与落盘

- DASH：视频 bg 完成后**先** `<a download>` 存无声视频轨；音频成功合并后再存一份有声成品（共 2 文件）
- 注入 `lib/mp4-remux.iife.js`、`lib/m4s-mux.js`（**外链**，禁内联）  
- content → page-agent：`MERGE_BUFFERS` 用 **transferable** 移交 ArrayBuffer（零拷贝），避免大文件 structured clone 卡死  
- `YtM4sMux.mergeM4s`；禁止依赖 FFmpeg.wasm  
- 调试：background 经 `YT_DL_BG_LOG` 刷面板；调试区上限约 800 行 

---

## 7. YouTube 数据源与限制

| 来源 | 用途 |
|------|------|
| URL `v=` / `/shorts/` | videoId |
| `getPlayerResponse` / `videoDetails` | 标题封面等 |
| `streamingData.formats` | 一体流（常仅 360P） |
| `streamingData.adaptiveFormats` | 分离轨；WEB 常无 https url（SABR） |
| InnerTube `player` | 补直链 / HLS 指针 |
| `webRequest` 嗅探 | sniff 模式兜底 |

**硬限制（文档级共识）：**

- WEB 高清经常 **只有 SABR、无 `videoplayback` URL** —— 不是 UI 过滤错了  
- **不做**完整 JS `n`/`sig` 解密栈（除非产品明确要求上 yt-dlp 级 player JS）  
- **不做** DRM（`drmFamilies`）绕过  
- `android_vr` **钉死 1.65.10**；擅自升版可能导致 `usable=0`

---

## 8. 国际化

同 B 站：`default_locale: zh_CN`，名称/描述只在 `_locales/*/messages.json`。

---

## 9. 常见修改

| 任务 | 位置 |
|------|------|
| 改版本 | `manifest.json` → `version` |
| 改扩展名/描述 | `_locales/zh_CN`、`en` |
| InnerTube / 选流 / HLS | `page-agent.js` |
| 顺序下载 / 进度推送 | `background.js` |
| bgFetch / 调试区 / 进度 UI | `content.js` |
| 悬浮样式 | `content.css`（`--ytd-*`） |
| popup | `popup/*` |
| 权限/匹配 | `manifest.json` |
| 反馈 QQ | `content.js`、`popup.html`、`docs/` |
| 图标 | `assets/icon-source.png` → `python scripts/gen_icons.py` |
| 打包列表 | `scripts/pack.py` → `INCLUDE` |

---

## 10. 测试

```bash
# 可选：合并库
cd test && npm install && npm run test:merge

# 浏览器
edge://extensions → 开发者模式 → 加载已解压 → youtube-downloader
打开 https://www.youtube.com/watch?v=… → F5 → 右下角按钮
选 720P/1080P → 开始下载 → 盯调试日志 + 进度条
下载完成后必须本地打开文件确认有声（曾出现长度漂移/无声需复测）
```

**回归清单：**

1. 列表出现 VR dash 高清（`maxH≥720`）  
2. 跳过预热、bg 顺序下载、进度连续上涨  
3. 视频段结束后音频段再涨一轮  
4. 合并保存后有声音  

---

## 11. `START_DOWNLOAD` 返回值

```javascript
// 页内已保存
{ dash: false } | { dash: true, via: 'page-sniff' } | { videoOnly: true, … }

 // 交给 content 走 background
{
  bgFetch: true,
  dash?: true,
  videoUrls: string[],
  audioUrls?: string[],
  filename: string,
  videoOnlyFilename?: string,
  userAgent?: string,
  itag?, audioItag?,
  videoExpectedBytes?, audioExpectedBytes?,  // contentLength/clen，供收满校验
  hls?: true, urls?: string[]   // HLS concat
}

// 合并结果（MERGE_*）
{ merged: true, filename, blob }
```

content 根据 `bgFetch` / `needBgAudio` 分支调用 `bgFetch` / `bgFetchConcat` / `MERGE_*`。

---

## 12. 打包与发布

```bash
python scripts/pack.py          # → youtube-downloader.zip
python scripts/gen_icons.py
python scripts/gen_store_assets.py
```

**zip 根目录必须是 `manifest.json`。** 勿打进 `docs/`、`store/`、`DEVELOPER.md`、`test/`。

**本机检查清单（上传前）：**

1. `manifest.json` → `version`  
2. `python scripts/pack.py`  
3. 解压确认有 `content/`、`popup/`、`lib/`、`icons/`、`_locales/`、`background.js`  
4. Partner Center 上传  

隐私/FAQ 变更：同步 `docs/` 与 `store/`，`git push`，Pages 更新。

---

## 13. 已知问题

| 问题 | 处理 / 现状 |
|------|-------------|
| WEB 仅 SABR、无直链 | 走 `android_vr`；UI 不伪造 URL |
| `hlsManifestUrl` 常为空 | bot / SABR；日志诚实写「无 HLS」 |
| InnerTube bot / LOGIN_REQUIRED | visitorData + 登录确认机器人 + F5 |
| 高清 403 | VR UA、换候选 URL、嗅探播放后的链 |
| 进度「卡住」 | 无字节 45s / 吞吐过慢 20s；并行分片内会 Range 续传；音视频阶段重置为 0 正常；需**重载扩展**拿新 SW |
| 视频「完成 N MB」却报无 ArrayBuffer / 取回 0B | SW→content **禁止**直传 ArrayBuffer；改 **base64 分块** |
| 单连接过慢 / 80% 断线重头下 | 2MB×6 并发；分片 Range 续传；候选按 itag/clen 去重 |
| 下载完无法合成 | MERGE 用 transferable 零拷贝 |
| 视频完音频慢/失败 | 音频走 background；校验最终文件有声 |
| `ERR_CONTENT_LENGTH_MISMATCH` | 勿仅以提示成功为准，本地点开听 |
| cipher / n 参数 | 优先选无 n 或 VR 链；不做完整解密 |
| DRM | 跳过，不计为可下 |

---

## 14. 代码速查

| 想改… | 文件 | 符号 |
|--------|------|------|
| InnerTube 客户端 | `page-agent.js` | `INNERTUBE_CLIENTS`（名以代码为准）、`fetchInnertubePlayer` |
| 合并流 / 清晰度 | `page-agent.js` | `loadFullStreamingData`, `buildQualityList`, `getQualities` |
| 选流 / 下载入口 | `page-agent.js` | `pickStreamsForQn`, `handleDownload`, `handleHlsDownload` |
| HLS | `page-agent.js` | `loadHlsBundle`, `mergeHlsIntoQualities` |
| 合并 | `page-agent.js`, `lib/m4s-mux.js` | `MERGE_BUFFERS`, `mergeM4sInPage` |
| 顺序下载 / 进度 | `background.js` | `fetchOne`, `fetchOneParallel`, `fetchByteRange`, `fetchOneSequentialResumable` |
| 嗅探 | `background.js` | `rememberTabGv`, `YT_DL_GET_SNIFFED` |
| bg 编排 | `content.js` | `bgFetch`, `bgFetchConcat`, `runSingleDownload` |
| 进度 UI | `content.js` | `updateProgress` |
| 调试区 | `content.js` | `debugLog`, `LOG` 监听 |
| 失败短指引 | `page-agent.js`, `content.js` | `formatDownloadError`, `friendlyError`, `errorFaqAnchor` |
| SPA 切页 | `content.js` | `watchUrlChange`, `__YT_DL_API__.onNavigate` |
| popup↔面板 | `content.js` | `__YT_DL_API__` |
| 权限 | `manifest.json` | `downloads`, `webRequest`, host_permissions |

---

## 15. 版本史

| 版本 | 说明 |
|------|------|
| v1.0.0 | 结构对齐 B 站；InnerTube 多端；`android_vr` 高清直链；HLS 尝试；background 顺序下载 + 节流进度；调试日志；DASH 音视频 bg 下载合并 |

---

## 16. 依赖

| 文件 | 来源 |
|------|------|
| `lib/mp4-remux.iife.js` | [mscststs/mp4-remux](https://github.com/mscststs/mp4-remux) MIT |

更新：自 `test/node_modules/mp4-remux` 拷贝至 `lib/`（如有）。

---

## 17. 新会话推荐第一句话

```text
请先阅读 d:\插件\youtube-downloader\DEVELOPER.md 和 manifest.json，然后在 youtube-downloader 上执行：<你的需求>
```

---

## 18. 后续优化清单（未实现 / 待定）

> 已实现：清晰度、VR 直链下载、bg 顺序下载、进度流式刷新、调试区、HLS 通路骨架、音视频 bg 合并、**失败短指引**、**SPA `yt-navigate-finish` 监听**。

| 优先级 | 项 | 说明 |
|--------|-----|------|
| ✅ | 错误短指引 | `formatDownloadError` / `friendlyError`：播放 / 720P / 刷新 / 机器人确认 |
| ✅ | SPA 切视频 | `yt-navigate-finish` + `yt-page-data-updated` + 轮询兜底 |
| 中 | bot / HLS 稳定性 | visitorData、web_safari 仍常无 `hlsManifestUrl` |
| 低 | 独立图标 | 换 `icon-source.png` |
| 低 | 播放列表批量 | **搁置**（同 B 站合集） |
| 低 | player JS 解密 | 仅当 VR 全面失效再考虑 |
| 低 | Edge 上架 | Pages + pack + Partner Center |
| 低 | FAB 可拖拽 / 快捷键 | 体验项 |

---

*文档与代码同步至 v1.0.0（2026-07-14）。改架构或产品决策请更新本文对应章节。*
