# YouTube视频下载助手

Microsoft Edge / Chrome 浏览器扩展（Manifest V3）。在 YouTube 视频页保存视频，仅供个人学习使用。

- 版本：1.0.0（结构对齐 B 站插件；支持 MP4 / WebM）
- 反馈 QQ：748604487
- 对照项目：[`bilibili-downloader`](../bilibili-downloader)

## 功能概览

- 在 YouTube **watch / Shorts** 页保存视频
  - **H.264 + AAC** → `.mp4`（如 `标题_1080P.mp4`）
  - **VP9 + Opus** → `.webm`（如 `标题_1440P.webm`，真·高清常见）
- 右下角悬浮面板：清晰度、进度、暂停/继续/取消、调试日志
- 工具栏 popup：视频页预览；非视频页引导
- 完全免费，不收集用户数据

## 当前进度

| 模块 | 状态 |
|------|------|
| 项目结构 / 打包 / i18n / 双入口 UI | ✅ |
| 识别标题、封面、作者 | ✅ |
| 清晰度列表（InnerTube，含 android_vr 高清） | ✅ |
| background 并行 Range 下载 + base64 回传 | ✅ |
| DASH 合并：MP4（H.264）/ WebM（VP9+Opus） | ✅ |
| 合并失败时分轨落盘（免重下） | ✅ |
| HLS / WEB SABR | ⚠️ 环境相关，见 DEVELOPER.md |

## 帮助与隐私

| 页面 | 链接 |
|------|------|
| 常见问题 | https://snowflake-hangdudu.github.io/youtube-downloader/faq.html |
| 隐私政策 | https://snowflake-hangdudu.github.io/youtube-downloader/ |

## 开发者

详见 **[DEVELOPER.md](DEVELOPER.md)**（技术方案、架构、选流、合并、已知问题；**新开会话先读**）。

## 本地加载

1. `chrome://extensions` 或 `edge://extensions`
2. 开启「开发者模式」
3. 「加载 unpacked」→ 选择本目录
4. 打开任意 YouTube 视频页并 **F5**
5. 改 `lib/` / `background.js` / `content.js` 后需 **重载扩展** 再 F5

## 打包

```bash
python scripts/pack.py
```

zip 须含 `lib/webm-mux.js`（与 mp4-remux、m4s-mux 一并打入）。

## Edge 上架

见 [store/EDGE_SUBMIT.md](store/EDGE_SUBMIT.md)
