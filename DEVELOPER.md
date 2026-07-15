# YouTube视频下载助手 — 开发者文档

> **版本：1.0.0** | Manifest V3 | 更新：2026-07-15  
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
| CSS 变量 | `--bdl-*` | `--ytd-*`（媚红 `#77282E` · 白雪 `#D6D4E2`） |
| CDN 下载 | **必须** MAIN world（后台 403） | **优先 background** Range 并行拉 googlevideo；MAIN 负责解析/合并 |
| 高清来源 | B 站 playurl dash | **InnerTube `android_vr`（钉死 1.65.10）** 直链；WEB 常仅 SABR |
| 成品容器 | 主要为 MP4 | **MP4（H.264）或 WebM（VP9+Opus）** |
| 进度 | MAIN `PROGRESS` postMessage | background `YT_DL_BG_PROGRESS` → content |

---

## 0.1 新会话 30 秒上手

```text
项目路径    d:\插件\youtube-downloader
定位        YouTube watch/Shorts 保存视频（MP4 或 WebM），完全免费；个人学习，不破解 DRM/付费
核心分工    MAIN=解析/InnerTube/选流/合并；background=拉取媒体；ISOLATED=UI
双入口 UI   右下角悬浮面板（主操作） + 右上角 popup（信息 + 打开面板）
改 UI       content.js / content.css（面板）  popup/*（工具栏弹窗）
改解析/选流  content/page-agent.js
改拉流/分片  background.js
改合并      lib/webm-mux.js（WebM） / lib/mp4-remux + m4s-mux（MP4）
改版本      manifest.json → version；改 _locales 若改名称描述
打包        python scripts/pack.py  →  youtube-downloader.zip（须含 lib/webm-mux.js）
本地调试    edge://extensions 加载已解压 → YouTube 视频页 F5 → 看面板「调试日志」
```

**改代码后生效：**

| 改了什么 | 用户操作 |
|----------|----------|
| `page-agent.js` | F5 刷新 YouTube 页 |
| `background.js` | **重新加载扩展**（SW）+ F5 |
| `content.js` / `content.css` / `manifest.json` / `popup/*` / `lib/*` | 重新加载扩展 + F5 |
| `_locales/*` | 重新加载扩展；商店需重传 zip |

**实测成功路径特征（调试日志）：**

```text
# 1080P H.264 → MP4
容器模式=mp4 → 直链改 background → video 完成 → audio 完成 → MP4 remux… → 完成 → 标题_1080P.mp4

# 1440P VP9 → WebM
容器模式=webm → itag=271 + Opus 251 → video 完成 · WebM → audio 完成
→ WebM remux… → WebM 完成 → 标题_1440P.webm
```

> 「候选 N 条」= 去重后的 URL。≥2MB 走 **2MB×6 并发 Range**；断线 **分片内续传**。  
> 日志标 `──── #N 开始/完成/失败 ────`，便于区分手动重试（不是自动下两遍）。

---

## 1. 产品决策（勿随意推翻）

| 决策 | 说明 |
|------|------|
| 目标用户 | 界面优先中文，`default_locale: zh_CN` |
| 收费 | **全免费**，无内购/激活码 |
| 功能范围 | 普通 **watch / Shorts** 保存；**不**破解会员/DRM/年龄门绕过 |
| 成品格式 | **有声单文件**：H.264→`.mp4`，或 VP9+Opus→`.webm`；文件名带清晰度 |
| 播放列表 | 首版只下**当前打开这一集**（不做播放列表批量） |
| 下载 UI | 进度条（真实字节 + 阶段）；暂停/继续/取消（合并阶段隐藏暂停） |
| 清晰度 | 以可访问 URL / HLS / 嗅探为准；WEB SABR 无 url **不造假档**；可用时标 `·WebM` / `↓` |
| 合并失败兜底 | **分别保存**音视频轨，避免重下几百 MB（见 §6.6） |
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

**商店状态（2026-07-15）：** 本地开发中，尚未提交 Edge 审核。版本保持 **1.0.0** 直至首发策略确定。

---

## 3. 项目结构

```
youtube-downloader/
├── manifest.json              # 版本、权限、content_scripts、web_accessible_resources
├── background.js              # ★ SW：并行 Range 拉 googlevideo、base64 分块回传、嗅探
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
├── content/
│   ├── page-agent.js          # ★ MAIN：InnerTube、选流、合并路由
│   ├── content.js             # ★ ISOLATED：UI、bgFetch、合并编排、调试日志
│   └── content.css
├── popup/
├── lib/
│   ├── mp4-remux.iife.js      # H.264+AAC → MP4（MIT）
│   ├── m4s-mux.js             # YtM4sMux.mergeM4s
│   └── webm-mux.js            # ★ YtWebmMux.mergeWebm（VP9/Opus → .webm）
├── icons/
├── docs/ / store/ / scripts/ / test/
└── youtube-downloader.zip
```

---

## 4. 架构

### 4.1 三层分工

```
YouTube 页面
┌─────────────────────┐  postMessage   ┌──────────────────┐
│ page-agent.js       │ ◄────────────► │ content.js       │
│ (MAIN)              │ yt-dl-panel    │ (ISOLATED)       │
│ · InnerTube / 选流  │ yt-dl-agent    │ · 悬浮 UI / 调试  │
│ · 容器模式 mp4|webm │                │ · bgFetch → SW   │
│ · MERGE_* / 分轨兜底│                │ · <a download>   │
└──────────┬──────────┘                └────────┬─────────┘
           │ 注入（web_accessible）              │
   lib/mp4-remux + m4s-mux + webm-mux           ▼
                                       ┌──────────────────┐
                                       │ background.js    │
                                       │ · 2MB×6 并行拉取 │
                                       │ · Range 续传     │
                                       │ · base64 分块回传│
                                       └──────────────────┘
```

**为何 background 拉流：** 页面 `fetch(googlevideo)` 常遇 CORS。  
**为何 MAIN 仍必要：** InnerTube / 播放器钩子 / 合并库须在页面上下文。

### 4.2 postMessage（content ↔ page-agent）

```javascript
const PANEL = 'yt-dl-panel';  // content 发出
const AGENT = 'yt-dl-agent';  // page-agent 发出
```

| type | 要点 |
|------|------|
| `START_DOWNLOAD` | 返回 `bgFetch` / `container` / `actualQn` / `filename` 等，见 §11 |
| `MERGE_BUFFERS` | `videoBuffer`+`audioBuffer`+`filename`；成功 `{ blob }`；失败可 `{ savedTracks: true, videoName, audioName }` |
| `MERGE_PENDING_VIDEO` | 合并 `__YT_DL_PENDING_VIDEO__`；同样支持分轨兜底 |
| `SAVE_PENDING_VIDEO` | 仅存无声视频 |
| `PAUSE` / `RESUME` / `CANCEL_DOWNLOAD` | + `YT_DL_BG_ABORT` |

`agentCall` 超时约 600000ms（大文件合并要留足）。

### 4.3 content ↔ background

| type | 作用 |
|------|------|
| `YT_DL_BG_FETCH` | 多 URL 回退、并行/单连接下载 |
| `YT_DL_BG_FETCH_CONCAT` | HLS 多分片拼接 |
| `YT_DL_BG_PROGRESS` | 进度 → UI |
| `YT_DL_BG_LOG` | 精简步骤日志（约 25% 收流、防刷屏） |
| `YT_DL_BG_GET_CHUNK` / `RELEASE` | 大文件 **base64** 分块回传（Edge 直传 ArrayBuffer 会空包） |
| `YT_DL_BG_ABORT` | 取消 |
| `YT_DL_GET_SNIFFED` | 嗅探 URL |

### 4.4 popup ↔ content

`YT_DL_GET_INFO` / `YT_DL_OPEN_PANEL`；`window.__YT_DL_API__`。

---

## 5. UI 说明

- 清晰度胶囊：`1080P`、`1440P·WebM`（走 WebM 通路）、`1440P↓`（无可合并轨，会降档）
- 下载中：按钮立即禁用 + `downloading` 锁，防连点开两趟
- 调试区：`──── #N 开始 / 完成 / 失败 ────`；心跳约 20s 一条

---

## 6. 核心流程与技术方案

### 6.1 元数据

```
fetchSnapshot → RESOLVE_VIDEO → readPlayerResponse()
```

### 6.2 清晰度 `getQualities()`

1. `loadFullStreamingData`：页内 + 多端 InnerTube（**`android_vr` 1.65.10 主力**）  
2. `buildQualityList`：标 `remuxable` / `webm`；`·WebM` / `↓`  
3. HLS 常因 bot/SABR 拿不到（`HLS=0` 正常）

**评分：** `android_vr` ≫ 无 `n` 直链 ≫ **avc1 加分** / **av01·webm 降权**（选流时）；下载时再按容器策略纠正。

### 6.3 选流与容器模式（关键）

YouTube 高清常见形态：

| 形态 | mime 例 | 扩展能不能硬合进可播文件 |
|------|---------|--------------------------|
| H.264 + AAC | `video/mp4; codecs="avc1…"` + `mp4a` | ✅ → `.mp4`（mp4-remux） |
| VP9 + Opus | `video/webm; codecs="vp9"` + `audio/webm; codecs="opus"` | ✅ → `.webm`（webm-mux） |
| AV1 in MP4 | `video/mp4; codecs="av01…"` | ❌ 当前 remux 不支持；若同高有 VP9 则改走 WebM |
| VP9 + AAC | WebM 视频 + m4a 音频 | ❌ 容器不一致；须配 Opus |

**`handleDownload` 决策顺序：**

```
pickStreamsForQn(requestQn)
  │
  ├─ 已是 WebM 且有 Opus          → containerMode = webm（真 1440 等）
  ├─ 非 avc1 但同档有 WebM+Opus   → 改用 WebM itag（如 271+251）
  ├─ 否则找 ≤qn 最高 avc1         → containerMode = mp4（可能降档）
  └─ 都没有                       → 报错 / 嗅探兜底
```

文件名：`buildOutName(title, actualQn, '', '.mp4'|'.webm')` → `标题_1440P.webm`（**actualQn** = 实际轨高度）。

返回字段含：`container: 'webm'|'mp4'`、`actualQn`、`requestedQn`、`filename`。

### 6.4 下载通路

```
hls     → bgFetchConcat
sniff   → 页内或 bgFetch
durl    → bgFetch 一体流
dash    → bgFetch 视频 + bgFetch 音频 → MERGE_BUFFERS → 保存
```

- VR/TV 直链：**跳过**播放器预热  
- WebM 档音频候选优先 itag **251/250/249**（Opus）

### 6.5 background 拉取

| 项 | 策略 |
|----|------|
| 大文件 | ≥2MB → **2MB 分块 × 最多 6 并发** |
| 断线 | 分片内 **Range 续传** |
| 收满 | ≥ **95%** expected（clen / Content-Length） |
| 假死 | ~45s 无字节 或 ~20s 吞吐 &lt;32KB |
| 候选 | `id\|itag\|clen` 去重；可换 Chrome UA |
| 回传 | **base64 分块**（512KB），禁止大块 ArrayBuffer 消息 |
| 日志 | 收流约每 **25%**、块进度约每 1/4，避免刷屏 |

### 6.6 合并技术方案

#### A. MP4 通路

- 库：`mp4-remux.iife.js` + `m4s-mux.js`（`YtM4sMux.mergeM4s`）  
- 输入：H.264（avc1）视频轨 + AAC（mp4a）音频轨  
- 输出：`video/mp4`

#### B. WebM 通路（`lib/webm-mux.js`）

- **无 FFmpeg**；对两路完整 WebM 做 **EBML 无损 remux**  
- 流程：解析 EBML/Segment → 取 TrackEntry → 音频轨改 TrackNumber=2 → 按 Cluster Timecode 交织 → 写新 Segment  
- **实现要点（曾踩坑）：** Element **ID** 必须按「整段字节即 ID」读取（含长度标记位），**不能**按 size vint 剥位。误剥后 `1A45DFA3` 对不上 → 报「EBML 头异常」。正确入口：`readId()`。  
- API：`YtWebmMux.mergeWebm(videoAb, audioAb, { log })`  
- 注入：`content` → `setupMuxInPage()` 依次加载 remux → m4s-mux → **webm-mux**（`web_accessible_resources`）

#### C. 合并入口路由（`mergeM4sInPage`）

```
读视频头 magic
  ├─ 1A 45 DF A3（WebM）→ 要求音频也是 WebM → YtWebmMux
  └─ 其它               → YtM4sMux + mp4Remux
```

`MERGE_BUFFERS` 用 **transferable** 零拷贝移交 ArrayBuffer。

#### D. 合并失败兜底（避免重下）

音视频已到手后若 remux 抛错：

1. page-agent **分别 `saveBlob`**：`标题_1440P_video.webm` + `标题_1440P_audio.webm`  
2. 向 content 返回 `{ savedTracks: true, videoName, audioName, error }`（**不**走 ERR，以免 buffer 已 transfer 无法回滚）  
3. UI 提示：合并未成功，轨已保存，可用外部工具合并，**无需重下**

外部合并示例：

```bash
ffmpeg -i 标题_1440P_video.webm -i 标题_1440P_audio.webm -c copy 标题_1440P.webm
```

> **「下了两遍」辨析：** 调试日志若出现两次 `──── #1 … #2 ────` 或两次完整 440MB，通常是**上次失败后用户再次点击**，不是 SW 自动重下。合并失败兜底后应显著减少「失败还要再点下载」的场景。

### 6.7 为何不做 FFmpeg.wasm

文档共识：**禁止**依赖 FFmpeg.wasm（体积、SharedArrayBuffer、商店审核成本）。WebM 用自研 EBML remux；极端失败交给本机 ffmpeg / VLC。

---

## 7. YouTube 数据源与限制

| 来源 | 用途 |
|------|------|
| URL `v=` / `/shorts/` | videoId |
| `getPlayerResponse` | 标题封面 |
| `streamingData.formats` | 一体流（常仅 360P） |
| `streamingData.adaptiveFormats` | 分离轨；WEB 常 SABR 无 url |
| InnerTube `player` | 补直链 / HLS |
| `webRequest` 嗅探 | sniff 兜底 |

**硬限制：**

- WEB 高清经常 **只有 SABR、无 `videoplayback` URL**  
- **不做**完整 `n`/`sig` 解密栈（除非产品要求上 yt-dlp 级方案）  
- **不做** DRM 绕过  
- `android_vr` **钉死 1.65.10**

**常见 itag（参考）：**

| 高度 | avc1 | vp9/webm | av01 |
|------|------|----------|------|
| 720 | 136 / 298 | 247 | 398 |
| 1080 | 137 / 299 | 248 | 399 |
| 1440 | 264 | **271** | 400 |
| 音频 | 140 AAC | **249/250/251 Opus** | — |

---

## 8. 国际化

`default_locale: zh_CN`；名称/描述只在 `_locales/*/messages.json`。

---

## 9. 常见修改

| 任务 | 位置 |
|------|------|
| 改版本 | `manifest.json` → `version` |
| InnerTube / 选流 / 容器模式 | `page-agent.js` |
| WebM remux / EBML | `lib/webm-mux.js` |
| MP4 remux | `lib/mp4-remux.iife.js`, `m4s-mux.js` |
| 并行下载 / 回传 | `background.js` |
| bg 编排 / 兜底 UI / 调试 | `content.js` |
| 打包列表 | `scripts/pack.py` → **须含 `lib/webm-mux.js`** |
| WAR 声明 | `manifest.json` → `web_accessible_resources` |

---

## 10. 测试

```bash
edge://extensions → 加载已解压 → youtube-downloader
打开 https://www.youtube.com/watch?v=… → F5 → 右下角面板
```

**回归清单：**

1. 清晰度出现 VR 高清；1440 可标 `·WebM`  
2. **480/1080P** → `*_480P.mp4` / `*_1080P.mp4`，可播有声  
3. **1440P·WebM** → 日志 `容器模式=webm`、`WebM remux` → `*_1440P.webm`，可播有声  
4. 进度：视频一段 + 音频一段；大文件并行块进度不应狂刷日志  
5. （可选）故意破坏合并：应落盘 `_video` + `_audio`，提示无需重下  
6. 连点「开始下载」不应开两趟  

---

## 11. `START_DOWNLOAD` / `MERGE_*` 返回值

```javascript
// content 走 background DASH
{
  bgFetch: true,
  dash: true,
  videoUrls, audioUrls,
  filename: '标题_1440P.webm',   // 或 .mp4
  videoOnlyFilename,
  userAgent, itag, audioItag,
  videoExpectedBytes, audioExpectedBytes,
  actualQn, requestedQn,
  container: 'webm' | 'mp4'
}

// MERGE_BUFFERS 成功
{ blob: Blob, size }

// MERGE_BUFFERS / MERGE_PENDING_VIDEO 合并失败但已分轨保存
{
  savedTracks: true,
  error: string,
  videoName: '标题_1440P_video.webm',
  audioName: '标题_1440P_audio.webm'
}
```

---

## 12. 打包与发布

```bash
python scripts/pack.py          # → youtube-downloader.zip
python scripts/gen_icons.py
python scripts/gen_store_assets.py
```

**zip 根须含：** `manifest.json`、`background.js`、`content/`、`popup/`、`lib/`（**含 webm-mux.js**）、`icons/`、`_locales/`。  
勿打进 `docs/`、`store/`、`DEVELOPER.md`、`test/`。

---

## 13. 已知问题

| 问题 | 处理 / 现状 |
|------|-------------|
| WEB 仅 SABR | 走 `android_vr`；不伪造 URL |
| HLS 常空 | bot/SABR；日志诚实 |
| 403 | VR UA、换候选、嗅探 |
| SW→content 空 ArrayBuffer | **base64 分块**回传 |
| 断线重头下 | 并行 + 分片 Range 续传 + 候选去重 |
| 旧版 WebM 合失败「EBML 头异常」 | **已修** `readId`；须重载含 `webm-mux.js` 的扩展 |
| AV1（itag 400）无法 mp4-remux | 同高有 VP9 则改 WebM；否则降 H.264 |
| 合并仍偶发失败 | **分轨落盘兜底**，勿让用户重下 |
| 日志出现两次完整大下载 | 多为手动重试；看 `#N` 序号 |
| DRM / cipher / n | 跳过或不优先；不做完整解密 |
| FFmpeg.wasm | **不做** |

---

## 14. 代码速查

| 想改… | 文件 | 符号 |
|--------|------|------|
| InnerTube | `page-agent.js` | `INNERTUBE_CLIENTS`, `fetchInnertubePlayer` |
| 清晰度 / WebM 标签 | `page-agent.js` | `buildQualityList`, `getQualities` |
| 容器模式 / 选 Opus | `page-agent.js` | `findWebmVideo`, `pickOpusAudio`, `findRemuxableVideo`, `handleDownload` |
| 合并路由 | `page-agent.js` | `mergeM4sInPage` |
| WebM EBML remux | `lib/webm-mux.js` | `readId`, `parseWebm`, `mergeWebm` |
| 合并失败分轨 | `page-agent.js` | `MERGE_BUFFERS` / `MERGE_PENDING_VIDEO` catch |
| 并行下载 | `background.js` | `fetchOneParallel`, `fetchByteRange` |
| bg 编排 / 下载锁 | `content.js` | `runSingleDownload`, `startDownload`, `mergeBuffersViaPage` |
| 权限 / WAR | `manifest.json` | `web_accessible_resources` → `lib/webm-mux.js` |

---

## 15. 版本史

| 版本 | 说明 |
|------|------|
| v1.0.0 | 对齐 B 站结构；InnerTube + `android_vr`；bg 并行 Range；**双通路合并 MP4/WebM**；文件名带清晰度；合并失败分轨兜底；base64 回传 |

---

## 16. 依赖

| 文件 | 来源 | 协议 |
|------|------|------|
| `lib/mp4-remux.iife.js` | [mscststs/mp4-remux](https://github.com/mscststs/mp4-remux) | MIT |
| `lib/m4s-mux.js` | 本仓库封装 | — |
| `lib/webm-mux.js` | 本仓库自研 EBML remux | — |

---

## 17. 新会话推荐第一句话

```text
请先阅读 d:\插件\youtube-downloader\DEVELOPER.md 和 manifest.json，然后在 youtube-downloader 上执行：<你的需求>
```

---

## 18. 后续优化清单

> 已实现：VR 直链、并行下载、base64 回传、**WebM 真 1440**、**MP4 H.264**、文件名清晰度、合并分轨兜底、防连点、日志分会话。

| 优先级 | 项 | 说明 |
|--------|-----|------|
| ✅ | WebM 无损合并 | `webm-mux.js`；Element ID 用 `readId` |
| ✅ | 合并失败不重下 | `savedTracks` 分轨落盘 |
| ✅ | 防连点 / 会话日志 | `downloading` 锁 + `#N` |
| 中 | bot / HLS | 仍常无 `hlsManifestUrl` |
| 低 | AV1→可播 | 仅当无 VP9/avc1；或引入更重 demux（非优先） |
| 低 | Cues/ Seek 索引 | WebM remux 暂可不写 Cues（可播，Seek 略慢） |
| 低 | Edge 上架 / 独立图标 / 播放列表 | 搁置 |

---

*文档与代码同步至 v1.0.0（2026-07-15）。改架构或产品决策请更新本文对应章节。*
