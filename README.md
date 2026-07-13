# YouTube视频下载助手

Microsoft Edge / Chrome 浏览器扩展（Manifest V3）。在 YouTube 视频页保存视频为 MP4，仅供个人学习使用。

- 版本：1.0.0（**骨架**：结构已对齐 B 站插件，下载功能开发中）
- 反馈 QQ：748604487
- 对照项目：[`bilibili-downloader`](../bilibili-downloader)

## 功能概览（目标）

- 在 YouTube **watch / Shorts** 页保存 MP4
- 右下角悬浮面板：视频信息、清晰度、进度、暂停/继续/取消
- 工具栏 popup：视频页预览；非视频页引导
- 完全免费，不收集用户数据

## 当前进度

| 模块 | 状态 |
|------|------|
| 项目结构 / 打包 / i18n / 双入口 UI | ✅ |
| 识别标题、封面、作者 | ✅ |
| 清晰度列表 / 下载 / 合并 | ⏳ 待实现 |

## 帮助与隐私

| 页面 | 链接（建仓开启 Pages 后） |
|------|------|
| 常见问题 | https://snowflake-hangdudu.github.io/youtube-downloader/faq.html |
| 隐私政策 | https://snowflake-hangdudu.github.io/youtube-downloader/ |

## 开发者

详见 **[DEVELOPER.md](DEVELOPER.md)**（新开会话先读此文档即可继续开发）。

## 本地加载

1. `chrome://extensions` 或 `edge://extensions`
2. 开启「开发者模式」
3. 「加载 unpacked」→ 选择本目录
4. 打开任意 YouTube 视频页并 **F5**

## 打包

```bash
python scripts/pack.py
```

## Edge 上架

见 [store/EDGE_SUBMIT.md](store/EDGE_SUBMIT.md)
