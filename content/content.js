(function () {
  'use strict';

  if (window.__YT_DL_INIT__) return;
  window.__YT_DL_INIT__ = true;

  const PANEL = 'yt-dl-panel';
  const AGENT = 'yt-dl-agent';
  const VERSION = chrome.runtime.getManifest().version;
  const ICON_URL = chrome.runtime.getURL('icons/icon128.png');
  const FAQ_URL = 'https://snowflake-hangdudu.github.io/youtube-downloader/faq.html';
  const MIN_VIDEO_BYTES = 50 * 1024;
  const MIN_AUDIO_BYTES = 8 * 1024;
  const EXPECT_RATIO = 0.95;

  let muxReadyPromise = null;
  /** 最近一次 bg 进度（给心跳文案用） */
  let lastBgProgress = { step: '', received: 0, total: 0, percent: 0, at: 0 };

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1024 / 1024).toFixed(2) + 'MB';
  }

  function respBytes(resp) {
    const fromBuf = resp?.buffer?.byteLength;
    if (typeof fromBuf === 'number' && fromBuf > 0) return fromBuf;
    return Number(resp?.size) || 0;
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  /** SW 大文件：base64 分块回传（本环境 ArrayBuffer 消息会变成空对象） */
  async function pullChunkedBuffer(resp) {
    if (resp?.buffer && typeof resp.buffer.byteLength === 'number' && resp.buffer.byteLength > 0) {
      return resp;
    }
    if (resp?.mode !== 'chunked' || !resp.transferId) {
      return resp;
    }
    const chunks = Number(resp.chunks) || 0;
    const chunkSize = Number(resp.chunkSize) || 512 * 1024;
    const expect = Number(resp.size) || 0;
    if (chunks < 1 || expect < 1) {
      throw new Error('分块回传元数据无效');
    }
    const dlog = (m) => {
      if (typeof debugLog === 'function') debugLog('bg', m);
      else console.log('[YtDL]', m);
    };
    dlog(`分块取回 · ${chunks} 片 · ${formatBytes(expect)}`);
    const parts = [];
    let got = 0;
    let lastPct = -1;
    for (let i = 0; i < chunks; i++) {
      const r = await chrome.runtime.sendMessage({
        type: 'YT_DL_BG_GET_CHUNK',
        transferId: resp.transferId,
        index: i,
        chunkSize
      });
      if (!r?.ok) {
        throw new Error(`取回分块 #${i}/${chunks} 失败: ${r?.error || '空响应'}`);
      }
      let u8;
      if (r.encoding === 'base64' && typeof r.data === 'string') {
        u8 = b64ToU8(r.data);
      } else if (r.chunk instanceof ArrayBuffer && r.chunk.byteLength > 0) {
        u8 = new Uint8Array(r.chunk);
      } else if (ArrayBuffer.isView(r.chunk) && r.chunk.byteLength > 0) {
        u8 = new Uint8Array(r.chunk.buffer, r.chunk.byteOffset, r.chunk.byteLength);
      } else {
        throw new Error(
          `取回分块 #${i} 无效 · encoding=${r.encoding || '?'} · ` +
            `byteLength声称=${r.byteLength || 0} · typeof data=${typeof r.data} · typeof chunk=${typeof r.chunk}`
        );
      }
      if (r.byteLength && u8.byteLength !== r.byteLength) {
        throw new Error(
          `取回分块 #${i} 长度不符 decode=${u8.byteLength} claim=${r.byteLength}`
        );
      }
      if (u8.byteLength < 1) {
        throw new Error(`取回分块 #${i} 解码后为空`);
      }
      parts.push(u8);
      got += u8.byteLength;
      const pct = expect ? Math.round((got / expect) * 100) : Math.round(((i + 1) / chunks) * 100);
      if (i === chunks - 1 || pct - lastPct >= 25) {
        lastPct = pct;
        dlog(`分块取回 ${pct}% · ${formatBytes(got)}/${formatBytes(expect)}`);
      }
    }
    try {
      await chrome.runtime.sendMessage({
        type: 'YT_DL_BG_RELEASE',
        transferId: resp.transferId
      });
    } catch (_) {}

    const out = new Uint8Array(got);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    if (expect > 0 && got < expect * 0.95) {
      throw new Error(`分块取回不完整 ${formatBytes(got)}/${formatBytes(expect)}`);
    }
    dlog(`分块取回完成 · ${formatBytes(got)}`);
    resp.buffer = out.buffer;
    resp.size = got;
    resp.mode = 'buffer';
    delete resp.transferId;
    return resp;
  }

  function assertBgMedia(resp, step, minBytes, expectedBytes) {
    const bytes = respBytes(resp);
    if (!resp?.buffer || typeof resp.buffer.byteLength !== 'number') {
      throw new Error(`${step} 无有效数据（消息未带回 ArrayBuffer）`);
    }
    if (bytes < minBytes) {
      throw new Error(`${step} 过小 ${formatBytes(bytes)}（疑似空壳/断流）`);
    }
    const expect = Number(expectedBytes) || 0;
    if (expect > minBytes && bytes < expect * EXPECT_RATIO) {
      const pct = Math.round((bytes / expect) * 100);
      throw new Error(
        `${step} 未收满 ${formatBytes(bytes)}/${formatBytes(expect)}（${pct}%）`
      );
    }
    return bytes;
  }

  /** YouTube SPA：DOM 事件优先，轮询兜底（ISOLATED 无法拦截 MAIN 的 history） */
  function watchUrlChange(onChange, intervalMs = 2000) {
    let lastUrl = location.href;
    const check = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      onChange(lastUrl);
    };
    document.addEventListener('yt-navigate-finish', check);
    document.addEventListener('yt-page-data-updated', check);
    window.addEventListener('popstate', check);
    setInterval(check, intervalMs);
  }

  /** content/bg 侧抛错也收成短指引（page-agent 已走 formatDownloadError） */
  function friendlyError(msg) {
    const m = msg || '下载失败';
    if (m === '下载已取消') return m;
    if (/Extension context invalidated|扩展已重载/i.test(m)) {
      return '扩展已重载，请按 F5 刷新本页后再点下载';
    }
    if (/合并库|合并模块|mp4-remux|YtM4sMux|YtWebmMux|WebM 合并|未加载/.test(m)) {
      return '请刷新页面后重试';
    }
    if (/bot|机器人|LOGIN_REQUIRED|Sign in|不是机器人/i.test(m)) {
      return '请登录并完成 YouTube「确认你不是机器人」，F5 后再试';
    }
    if (/未捕获|请.*播放|请先播放|无下载地址|无可用地址|嗅探/.test(m)) {
      return '请先播放目标清晰度 5～10 秒，再点下载';
    }
    if (/文件过大|改选较低/.test(m)) {
      return '文件过大，请改选较低清晰度（如 720P）';
    }
    if (/403|HTTP 4|过小|空壳|疑似|假死|background.*(失败|下载)/i.test(m)) {
      return '下载失败。请先播放 5～10 秒，或改选 720P 后重试';
    }
    if (/超时|timeout/i.test(m)) {
      return '请求超时，请刷新页面后重试';
    }
    if (/请先|请改选|请刷新|F5|720P/.test(m) && m.length < 90) return m;
    return m;
  }

  /** MAIN world 注入（合并库跑在页面上下文） */
  function setupMuxInPage() {
    if (muxReadyPromise) return muxReadyPromise;
    const base = chrome.runtime.getURL('lib/');
    const loadScript = (file) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + file;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('加载失败: ' + file));
      (document.documentElement || document.head).appendChild(s);
    });
    muxReadyPromise = loadScript('mp4-remux.iife.js')
      .then(() => loadScript('m4s-mux.js'))
      .then(() => loadScript('webm-mux.js'));
    return muxReadyPromise;
  }
  setupMuxInPage().catch(() => {});

  function agentCall(type, payload, transferList) {
    return new Promise((resolve, reject) => {
      const id = 'req-' + (++reqId);
      pending.set(id, { resolve, reject });
      const msg = { source: PANEL, id, type, ...payload };
      if (transferList?.length) {
        window.postMessage(msg, '*', transferList);
      } else {
        window.postMessage(msg, '*');
      }
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('页面代理超时，请刷新页面重试'));
        }
      }, 600000);
    });
  }

  /**
   * 合并：用 transferable 把 ArrayBuffer 所有权交给 MAIN（零拷贝），
   * 避免几十 MB 结构化克隆把页面卡死 →「进度停住 / 无法合成」。
   */
  async function mergeBuffersViaPage(videoBuffer, audioBuffer, meta) {
    await setupMuxInPage();
    const transfer = [];
    const toBuf = (buf) => {
      if (!buf) return buf;
      if (buf instanceof ArrayBuffer) {
        transfer.push(buf);
        return buf;
      }
      if (ArrayBuffer.isView(buf)) {
        if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
          transfer.push(buf.buffer);
          return buf.buffer;
        }
        const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        transfer.push(copy);
        return copy;
      }
      return buf;
    };
    const videoBuf = toBuf(videoBuffer);
    const audioBuf = toBuf(audioBuffer);
    const vLen = videoBuf?.byteLength || 0;
    const aLen = audioBuf?.byteLength || 0;
    if (vLen < 1024) throw new Error('视频数据为空');
    if (aLen < 256) throw new Error('音频数据为空');
    const merged = await agentCall(
      'MERGE_BUFFERS',
      {
        videoBuffer: videoBuf,
        audioBuffer: audioBuf,
        filename: meta?.filename || null
      },
      transfer
    );
    // 合并失败但已分别落盘音视频轨（避免重下几百 MB）
    if (merged?.savedTracks) {
      return { savedTracks: true, error: merged.error || '合并失败', videoName: merged.videoName, audioName: merged.audioName };
    }
    if (!merged?.blob || merged.blob.size < 50 * 1024) {
      throw new Error('合并结果过小');
    }
    return { blob: merged.blob, size: merged.size };
  }

  function downloadBlob(blob, filename) {
    if (typeof debugLog === 'function') {
      debugLog('保存', `触发浏览器下载 · ${filename} · ${formatBytes(blob?.size || 0)}`);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    return new Promise((resolve) => {
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
        resolve();
      }, 1000);
    });
  }

  function peekMagic(buf, n = 8) {
    try {
      let u8;
      if (buf instanceof ArrayBuffer) u8 = new Uint8Array(buf, 0, Math.min(n, buf.byteLength));
      else if (ArrayBuffer.isView(buf))
        u8 = new Uint8Array(buf.buffer, buf.byteOffset, Math.min(n, buf.byteLength));
      else return '-';
      return Array.from(u8)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
    } catch (_) {
      return '?';
    }
  }

  function formatView(n) {
    const v = Number(n) || 0;
    if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
    return String(v);
  }

  function formatTime(ts) {
    if (!ts) return '';
    const diff = Math.max(0, Date.now() - ts * 1000);
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + '分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '小时前';
    const d = Math.floor(h / 24);
    if (d < 30) return d + '天前';
    const mo = Math.floor(d / 30);
    if (mo < 12) return mo + '个月前';
    return Math.floor(mo / 12) + '年前';
  }

  let videoInfo = null;
  let qualities = [];
  let selectedQn = 0;
  let pageIndex = 0;
  let isOpen = false;
  let reqId = 0;
  const pending = new Map();

  let downloading = false;
  let downloadPaused = false;
  let downloadSeq = 0;
  let queueRunning = false;
  let queueCancelled = false;
  let playlistInfo = null;
  let activeTab = 'current';
  let parsedLinkItems = [];

  /** YouTube view API：pages.length > 1 且每 P 有 cid 才是真·多 P */
  function isMultiPartVideo(pages) {
    return Array.isArray(pages) && pages.length > 1 && pages.every((p) => p && p.cid);
  }

  function urlHasPlaylist(href) {
    try {
      return !!new URL(href || location.href).searchParams.get('list');
    } catch {
      return false;
    }
  }

  /** 从任意文本抽出 YouTube 链接 / videoId（换行、空格、逗号均可分隔） */
  function parseYouTubeLinksFromText(text) {
    const raw = String(text || '');
    if (!raw.trim()) return [];
    const found = [];
    const seen = new Set();

    const push = (videoId, url) => {
      const id = String(videoId || '').trim();
      if (!/^[a-zA-Z0-9_-]{11}$/.test(id) || seen.has(id)) return;
      seen.add(id);
      found.push({
        videoId: id,
        title: id,
        url: url || `https://www.youtube.com/watch?v=${id}`,
        index: found.length + 1
      });
    };

    const urlRe =
      /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)\/(?:watch\?[^\s]*|shorts\/[a-zA-Z0-9_-]{11}|embed\/[a-zA-Z0-9_-]{11}|live\/[a-zA-Z0-9_-]{11})|https?:\/\/youtu\.be\/[a-zA-Z0-9_-]{11}[^\s]*/gi;
    let m;
    while ((m = urlRe.exec(raw)) !== null) {
      const chunk = m[0].replace(/[),.;]+$/g, '');
      try {
        const u = new URL(chunk);
        let id = u.searchParams.get('v');
        if (!id && u.hostname.includes('youtu.be')) id = u.pathname.split('/').filter(Boolean)[0];
        if (!id && /\/(?:shorts|embed|live)\//.test(u.pathname)) {
          id = u.pathname.split('/').filter(Boolean)[1];
        }
        if (id) push(id.split('?')[0], chunk);
      } catch (_) {}
    }

    // 纯 11 位 ID / 被空格拆开的残留 token
    const tokens = raw.split(/[\s,，;；|]+/).filter(Boolean);
    for (const tok of tokens) {
      if (/^[a-zA-Z0-9_-]{11}$/.test(tok)) push(tok);
    }

    return found;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== AGENT) return;
    const { id, type, step, msg, data, error } = e.data;

    if (type === 'LOG') {
      if (typeof debugLog === 'function') debugLog(step, msg);
      return;
    }
    if (type === 'PROGRESS') {
      if (typeof updateProgress === 'function') {
        updateProgress(e.data.step, e.data.percent, e.data.received, e.data.total);
      }
      return;
    }

    if (id && pending.has(id)) {
      const { resolve, reject } = pending.get(id);
      pending.delete(id);
      if (type === 'OK') resolve(data);
      else reject(new Error(error || '请求失败'));
    }
  });

  function agentSignal(type) {
    window.postMessage({ source: PANEL, type }, '*');
  }

  let debugLog, showStatus, updateProgress;

  function mountUI() {
    if (document.getElementById('yt-dl-panel-root')) return;

    const panel = document.createElement('div');
    panel.id = 'yt-dl-panel-root';
    panel.innerHTML = `
      <div id="yt-dl-panel">
        <button id="yt-dl-toggle" title="下载视频">
          <img src="${ICON_URL}" alt="">
        </button>
        <div id="yt-dl-menu" class="hidden">
          <div class="yt-dl-header">
            <div class="yt-dl-header-left">
              <img class="yt-dl-header-icon" src="${ICON_URL}" alt="" width="22" height="22">
              <span class="yt-dl-title">YouTube 下载</span>
              <span class="yt-dl-version">v${VERSION}</span>
            </div>
            <button id="yt-dl-close" aria-label="关闭">&times;</button>
          </div>
          <div class="yt-dl-body">
            <div class="yt-dl-detect">
              <span class="yt-dl-dot"></span>
              <span id="yt-dl-detect-text">识别页面中…</span>
              <span class="yt-dl-tag">YouTube · 视频</span>
              <span id="yt-dl-ready" class="yt-dl-badge hidden">可用</span>
            </div>

            <div id="yt-dl-video-card" class="yt-dl-video-card">
              <div class="yt-dl-cover-wrap">
                <div id="yt-dl-cover-sk" class="yt-dl-sk-cover yt-dl-shimmer"></div>
                <img id="yt-dl-cover" class="yt-dl-cover hidden" alt="">
                <div id="yt-dl-cover-ph" class="yt-dl-cover-ph hidden">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
              <div class="yt-dl-video-meta">
                <div id="yt-dl-video-sk" class="yt-dl-video-sk">
                  <span class="yt-dl-sk-line yt-dl-shimmer"></span>
                  <span class="yt-dl-sk-line yt-dl-shimmer short"></span>
                  <span class="yt-dl-sk-line yt-dl-shimmer shorter"></span>
                </div>
                <div id="yt-dl-video-content" class="yt-dl-video-content hidden">
                  <div id="yt-dl-video-title" class="yt-dl-video-title"></div>
                  <div id="yt-dl-video-author" class="yt-dl-video-author hidden"></div>
                  <div id="yt-dl-video-sub" class="yt-dl-video-sub"></div>
                </div>
              </div>
            </div>

            <div id="yt-dl-tabs" class="yt-dl-tabs">
              <button type="button" class="yt-dl-tab active" data-tab="current">当前视频</button>
              <button type="button" class="yt-dl-tab hidden" data-tab="playlist" id="yt-dl-tab-playlist">播放列表</button>
              <button type="button" class="yt-dl-tab" data-tab="links" id="yt-dl-tab-links">多链接</button>
            </div>

            <div id="yt-dl-panel-current" class="yt-dl-tab-panel">
            <div id="yt-dl-pages" class="yt-dl-pages hidden"></div>

            <div class="yt-dl-section">
              <div class="yt-dl-section-head">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                清晰度
              </div>
              <div id="yt-dl-quality-pills" class="yt-dl-quality-pills">
                <span class="yt-dl-pill loading">加载中</span>
              </div>
            </div>

            <div class="yt-dl-info-row">
              <span class="yt-dl-info-item">格式 MP4</span>
              <span id="yt-dl-max-label" class="yt-dl-info-tip">源最高 —</span>
            </div>

            <div id="yt-dl-estimate" class="yt-dl-estimate hidden">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
              <span id="yt-dl-estimate-text">预计大小 —</span>
            </div>

            <div id="yt-dl-login-hint" class="yt-dl-hint hidden"></div>

            <button id="yt-dl-start" class="yt-dl-btn" disabled>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
              开始下载
            </button>
            <button id="yt-dl-queue-all" type="button" class="yt-dl-btn yt-dl-btn-secondary hidden">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
              <span id="yt-dl-queue-label">队列下载全部分 P</span>
            </button>
            </div>

            <div id="yt-dl-panel-playlist" class="yt-dl-tab-panel hidden">
              <div id="yt-dl-pl-meta" class="yt-dl-pl-meta">加载播放列表…</div>
              <div class="yt-dl-pl-toolbar">
                <label class="yt-dl-pl-checkall"><input type="checkbox" id="yt-dl-pl-checkall" checked> 全选</label>
                <span id="yt-dl-pl-count" class="yt-dl-pl-count">0 / 0</span>
              </div>
              <div id="yt-dl-pl-list" class="yt-dl-pl-list"></div>
              <p class="yt-dl-pl-tip">队列将使用「当前视频」页所选清晰度；无匹配档时自动降档。</p>
              <button id="yt-dl-pl-queue" type="button" class="yt-dl-btn" disabled>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                <span id="yt-dl-pl-queue-label">队列下载选中</span>
              </button>
            </div>

            <div id="yt-dl-panel-links" class="yt-dl-tab-panel hidden">
              <label class="yt-dl-links-label" for="yt-dl-links-input">粘贴多个 YouTube 链接</label>
              <textarea id="yt-dl-links-input" class="yt-dl-links-input" rows="5" placeholder="支持换行 / 空格 / 逗号分隔&#10;https://www.youtube.com/watch?v=…&#10;https://youtu.be/…&#10;https://www.youtube.com/shorts/…"></textarea>
              <div class="yt-dl-pl-toolbar">
                <span id="yt-dl-links-meta" class="yt-dl-links-meta">未检测到链接</span>
                <button type="button" id="yt-dl-links-clear" class="yt-dl-links-clear">清空</button>
              </div>
              <div id="yt-dl-links-list" class="yt-dl-pl-list yt-dl-links-list">
                <div class="yt-dl-pl-empty">粘贴后自动识别 videoId</div>
              </div>
              <div class="yt-dl-section">
                <div class="yt-dl-section-head">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                  清晰度（队列统一）
                </div>
                <div id="yt-dl-links-quality-pills" class="yt-dl-quality-pills">
                  <span class="yt-dl-pill loading">加载中</span>
                </div>
              </div>
              <p class="yt-dl-pl-tip">识别到 ≥1 条即可队列下载；上列清晰度为统一偏好，单条无匹配档时会自动降档。重复 ID 会自动去重。</p>
              <button id="yt-dl-links-queue" type="button" class="yt-dl-btn" disabled>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                <span id="yt-dl-links-queue-label">队列下载链接</span>
              </button>
            </div>

            <div id="yt-dl-progress" class="yt-dl-progress hidden">
              <div class="yt-dl-progress-meta">
                <span id="yt-dl-progress-title" class="yt-dl-progress-title"></span>
                <span id="yt-dl-progress-q" class="yt-dl-progress-q"></span>
              </div>
              <div class="yt-dl-progress-head">
                <span id="yt-dl-progress-phase">下载中…</span>
                <span id="yt-dl-progress-pct">0%</span>
              </div>
              <div class="yt-dl-progress-track">
                <div id="yt-dl-progress-bar" class="yt-dl-progress-bar"></div>
              </div>
              <div id="yt-dl-progress-actions" class="yt-dl-progress-actions hidden">
                <button id="yt-dl-pause" type="button" class="yt-dl-action-btn">暂停</button>
                <button id="yt-dl-cancel-dl" type="button" class="yt-dl-action-btn danger">取消</button>
              </div>
            </div>
            <div id="yt-dl-status" class="yt-dl-status hidden"></div>

            <details id="yt-dl-debug" class="yt-dl-debug">
              <summary class="yt-dl-debug-summary">
                <span>调试日志</span>
                <span id="yt-dl-debug-count" class="yt-dl-debug-count">0</span>
                <span class="yt-dl-debug-actions">
                  <button type="button" id="yt-dl-debug-copy" class="yt-dl-debug-btn">复制</button>
                  <button type="button" id="yt-dl-debug-clear" class="yt-dl-debug-btn">清空</button>
                </span>
              </summary>
              <pre id="yt-dl-debug-log" class="yt-dl-debug-log"></pre>
            </details>
          </div>
          <div class="yt-dl-footer">
            <span class="yt-dl-footer-text">当前页面 · YouTube 视频页</span>
            <div class="yt-dl-footer-links">
              <a class="yt-dl-faq-link" href="${FAQ_URL}" target="_blank" rel="noopener">常见问题</a>
              <a class="yt-dl-feedback" href="tencent://message/?uin=748604487&amp;Site=qq&amp;Menu=yes" title="有问题请通过 QQ 反馈">反馈 QQ</a>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const toggleBtn = panel.querySelector('#yt-dl-toggle');
    const menu = panel.querySelector('#yt-dl-menu');
    const closeBtn = panel.querySelector('#yt-dl-close');
    const detectText = panel.querySelector('#yt-dl-detect-text');
    const readyBadge = panel.querySelector('#yt-dl-ready');
    const videoCard = panel.querySelector('#yt-dl-video-card');
    const coverSk = panel.querySelector('#yt-dl-cover-sk');
    const coverImg = panel.querySelector('#yt-dl-cover');
    const coverPh = panel.querySelector('#yt-dl-cover-ph');
    const videoSk = panel.querySelector('#yt-dl-video-sk');
    const videoContent = panel.querySelector('#yt-dl-video-content');
    const titleEl = panel.querySelector('#yt-dl-video-title');
    const authorEl = panel.querySelector('#yt-dl-video-author');
    const subEl = panel.querySelector('#yt-dl-video-sub');
    const pagesEl = panel.querySelector('#yt-dl-pages');
    const tabsEl = panel.querySelector('#yt-dl-tabs');
    const tabPlaylistBtn = panel.querySelector('#yt-dl-tab-playlist');
    const panelCurrent = panel.querySelector('#yt-dl-panel-current');
    const panelPlaylist = panel.querySelector('#yt-dl-panel-playlist');
    const panelLinks = panel.querySelector('#yt-dl-panel-links');
    const plMetaEl = panel.querySelector('#yt-dl-pl-meta');
    const plListEl = panel.querySelector('#yt-dl-pl-list');
    const plCheckAll = panel.querySelector('#yt-dl-pl-checkall');
    const plCountEl = panel.querySelector('#yt-dl-pl-count');
    const plQueueBtn = panel.querySelector('#yt-dl-pl-queue');
    const plQueueLabel = panel.querySelector('#yt-dl-pl-queue-label');
    const linksInput = panel.querySelector('#yt-dl-links-input');
    const linksMetaEl = panel.querySelector('#yt-dl-links-meta');
    const linksListEl = panel.querySelector('#yt-dl-links-list');
    const linksClearBtn = panel.querySelector('#yt-dl-links-clear');
    const linksQueueBtn = panel.querySelector('#yt-dl-links-queue');
    const linksQueueLabel = panel.querySelector('#yt-dl-links-queue-label');
    const linksPillsEl = panel.querySelector('#yt-dl-links-quality-pills');
    const pillsEl = panel.querySelector('#yt-dl-quality-pills');
    const maxLabelEl = panel.querySelector('#yt-dl-max-label');
    const estimateEl = panel.querySelector('#yt-dl-estimate');
    const estimateText = panel.querySelector('#yt-dl-estimate-text');
    const loginHintEl = panel.querySelector('#yt-dl-login-hint');
    const startBtn = panel.querySelector('#yt-dl-start');
    const queueBtn = panel.querySelector('#yt-dl-queue-all');
    const queueLabelEl = panel.querySelector('#yt-dl-queue-label');
    const progressEl = panel.querySelector('#yt-dl-progress');
    const progressTitle = panel.querySelector('#yt-dl-progress-title');
    const progressQ = panel.querySelector('#yt-dl-progress-q');
    const progressPhase = panel.querySelector('#yt-dl-progress-phase');
    const progressPct = panel.querySelector('#yt-dl-progress-pct');
    const progressBar = panel.querySelector('#yt-dl-progress-bar');
    const progressActions = panel.querySelector('#yt-dl-progress-actions');
    const pauseBtn = panel.querySelector('#yt-dl-pause');
    const cancelDlBtn = panel.querySelector('#yt-dl-cancel-dl');
    const statusEl = panel.querySelector('#yt-dl-status');
    const debugLogEl = panel.querySelector('#yt-dl-debug-log');
    const debugCountEl = panel.querySelector('#yt-dl-debug-count');
    const debugClearBtn = panel.querySelector('#yt-dl-debug-clear');
    const debugCopyBtn = panel.querySelector('#yt-dl-debug-copy');
    const btnDefaultHtml = startBtn.innerHTML;
    const debugLines = [];
    const DEBUG_MAX = 800;

    function setQueueLabel(count) {
      queueLabelEl.textContent = count > 1 ? `队列下载全部 ${count} 个分 P` : '队列下载全部分 P';
    }

    function setActiveTab(name) {
      const allowed = name === 'playlist' || name === 'links' ? name : 'current';
      if (allowed === 'playlist' && tabPlaylistBtn.classList.contains('hidden')) {
        activeTab = 'current';
      } else {
        activeTab = allowed;
      }
      tabsEl.querySelectorAll('.yt-dl-tab').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === activeTab);
      });
      panelCurrent.classList.toggle('hidden', activeTab !== 'current');
      panelPlaylist.classList.toggle('hidden', activeTab !== 'playlist');
      panelLinks.classList.toggle('hidden', activeTab !== 'links');
    }

    function getSelectedPlaylistItems() {
      if (!playlistInfo?.items?.length) return [];
      const boxes = plListEl.querySelectorAll('input.yt-dl-pl-item[type="checkbox"]');
      const selected = new Set();
      boxes.forEach((box) => {
        if (box.checked) selected.add(box.dataset.vid);
      });
      return playlistInfo.items.filter((it) => selected.has(it.videoId));
    }

    function updatePlaylistSelectionUi() {
      const all = playlistInfo?.items || [];
      const picked = getSelectedPlaylistItems();
      plCountEl.textContent = `${picked.length} / ${all.length}`;
      plCheckAll.checked = all.length > 0 && picked.length === all.length;
      plCheckAll.indeterminate = picked.length > 0 && picked.length < all.length;
      plQueueBtn.disabled = !picked.length || !selectedQn || queueRunning || downloading;
      plQueueLabel.textContent =
        picked.length > 0 ? `队列下载选中 (${picked.length})` : '队列下载选中';
      updateLinksQueueUi();
    }

    function updateLinksQueueUi() {
      const n = parsedLinkItems.length;
      linksMetaEl.textContent = n ? `已识别 ${n} 条（已去重）` : '未检测到链接';
      linksQueueBtn.disabled = n < 1 || !selectedQn || queueRunning || downloading;
      linksQueueLabel.textContent = n > 0 ? `队列下载链接 (${n})` : '队列下载链接';
    }

    function renderParsedLinks(items) {
      parsedLinkItems = items || [];
      if (!parsedLinkItems.length) {
        linksListEl.innerHTML = '<div class="yt-dl-pl-empty">粘贴后自动识别 videoId</div>';
        updateLinksQueueUi();
        return;
      }
      const qLabel = getSelectedQualityLabel() || (selectedQn ? selectedQn + 'P' : '—');
      linksListEl.innerHTML = parsedLinkItems
        .map((it) => {
          const title = it.title && it.title !== it.videoId ? it.title : it.videoId;
          const loading = it._loading ? ' · 解析标题…' : '';
          const qn = it._loading ? '' : `<span class="yt-dl-pl-dur">${qLabel}</span>`;
          const tip = String(it.url || it.videoId).replace(/"/g, '&quot;');
          const shown = String(title + loading).replace(/</g, '&lt;');
          return `<div class="yt-dl-pl-row" data-vid="${it.videoId}">
            <span class="yt-dl-pl-idx">${it.index}</span>
            <span class="yt-dl-pl-title" title="${tip}">${shown}</span>
            ${qn}
          </div>`;
        })
        .join('');
      updateLinksQueueUi();
    }

    let linksMetaSeq = 0;
    async function hydrateParsedLinkTitles(items) {
      const seq = ++linksMetaSeq;
      const list = items || [];
      for (let i = 0; i < list.length; i++) {
        if (seq !== linksMetaSeq) return;
        const it = list[i];
        if (it.title && it.title !== it.videoId && it._resolved) continue;
        it._loading = true;
        renderParsedLinks(parsedLinkItems);
        try {
          const res = await agentCall('RESOLVE_VIDEO_META', { videoId: it.videoId });
          if (seq !== linksMetaSeq) return;
          const info = res?.info || res;
          if (info?.title) {
            it.title = info.title;
            it.author = info.author || '';
            it._resolved = true;
          }
        } catch (err) {
          debugLog('多链接', `${it.videoId} 标题解析失败: ${err.message || err}`);
        } finally {
          it._loading = false;
        }
        if (seq !== linksMetaSeq) return;
        renderParsedLinks(parsedLinkItems);
      }
    }

    function refreshParsedLinksFromInput() {
      const items = parseYouTubeLinksFromText(linksInput.value);
      // 保留已解析过的标题
      const prev = new Map((parsedLinkItems || []).map((x) => [x.videoId, x]));
      for (const it of items) {
        const old = prev.get(it.videoId);
        if (old?.title && old.title !== old.videoId) {
          it.title = old.title;
          it.author = old.author || '';
          it._resolved = !!old._resolved;
        }
      }
      renderParsedLinks(items);
      if (items.length) {
        debugLog('多链接', `识别 ${items.length} 条: ${items.map((x) => x.videoId).join(', ')}`);
        hydrateParsedLinkTitles(items);
      }
    }

    function renderPlaylistPanel(pl) {
      playlistInfo = pl;
      if (!pl?.inPlaylist) {
        tabPlaylistBtn.classList.add('hidden');
        if (activeTab === 'playlist') setActiveTab('current');
        plMetaEl.textContent = '';
        plListEl.innerHTML = '';
        updatePlaylistSelectionUi();
        return;
      }

      tabPlaylistBtn.classList.remove('hidden');
      const shown = pl.items?.length || 0;
      const total = pl.totalVideos || shown;
      tabPlaylistBtn.textContent = total > shown ? `播放列表 · ${shown}+` : `播放列表 · ${shown}`;
      plMetaEl.textContent = pl.title
        ? `${pl.title}${total ? ` · 共 ${total} 条` : ''}${pl.hint ? ' · ' + pl.hint : ''}`
        : pl.hint || '播放列表';

      if (!pl.items?.length) {
        plListEl.innerHTML = `<div class="yt-dl-pl-empty">${pl.hint || '暂无条目'}</div>`;
        updatePlaylistSelectionUi();
        return;
      }

      const currentId = videoInfo?.videoId || videoInfo?.aid || '';
      plListEl.innerHTML = pl.items
        .map((it) => {
          const cur = it.videoId === currentId ? ' is-current' : '';
          const dur = it.duration ? `<span class="yt-dl-pl-dur">${it.duration}</span>` : '';
          return `<label class="yt-dl-pl-row${cur}">
            <input type="checkbox" class="yt-dl-pl-item" data-vid="${it.videoId}" checked>
            <span class="yt-dl-pl-idx">${it.index || ''}</span>
            <span class="yt-dl-pl-title" title="${String(it.title || '').replace(/"/g, '&quot;')}">${it.title || it.videoId}</span>
            ${dur}
          </label>`;
        })
        .join('');

      plListEl.querySelectorAll('input.yt-dl-pl-item').forEach((box) => {
        box.addEventListener('change', updatePlaylistSelectionUi);
      });
      updatePlaylistSelectionUi();
    }

    async function loadPlaylistInfo() {
      if (!urlHasPlaylist(location.href)) {
        renderPlaylistPanel({ inPlaylist: false, items: [] });
        return;
      }
      plMetaEl.textContent = '加载播放列表…';
      try {
        const pl = await agentCall('GET_PLAYLIST', { href: location.href });
        renderPlaylistPanel(pl);
        debugLog(
          '播放列表',
          `${pl.source || '?'} · ${pl.items?.length || 0}/${pl.totalVideos || 0} · ${pl.title || ''}`
        );
      } catch (err) {
        renderPlaylistPanel({
          inPlaylist: true,
          title: '播放列表',
          items: [],
          hint: err.message || '加载失败'
        });
        debugLog('播放列表', '失败: ' + (err.message || err));
      }
    }

    tabsEl.querySelectorAll('.yt-dl-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('hidden')) return;
        setActiveTab(btn.dataset.tab);
      });
    });
    plCheckAll.addEventListener('change', () => {
      const on = plCheckAll.checked;
      plListEl.querySelectorAll('input.yt-dl-pl-item').forEach((box) => {
        box.checked = on;
      });
      updatePlaylistSelectionUi();
    });
    let linksParseTimer = null;
    linksInput.addEventListener('input', () => {
      clearTimeout(linksParseTimer);
      linksParseTimer = setTimeout(refreshParsedLinksFromInput, 200);
    });
    linksInput.addEventListener('paste', () => {
      setTimeout(refreshParsedLinksFromInput, 0);
    });
    linksClearBtn.addEventListener('click', () => {
      linksInput.value = '';
      renderParsedLinks([]);
    });

    function appendDebugLine(step, msg) {
      const t = new Date();
      const ts =
        String(t.getHours()).padStart(2, '0') +
        ':' +
        String(t.getMinutes()).padStart(2, '0') +
        ':' +
        String(t.getSeconds()).padStart(2, '0');
      const line = `[${ts}] ${step}: ${msg}`;
      debugLines.push(line);
      if (debugLines.length > DEBUG_MAX) debugLines.splice(0, debugLines.length - DEBUG_MAX);
      if (debugLogEl) {
        debugLogEl.textContent = debugLines.join('\n');
        debugLogEl.scrollTop = debugLogEl.scrollHeight;
      }
      if (debugCountEl) debugCountEl.textContent = String(debugLines.length);
    }

    debugLog = (step, msg) => {
      console.log('[YtDL]', step, msg);
      appendDebugLine(step, typeof msg === 'string' ? msg : JSON.stringify(msg));
    };

    debugClearBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      debugLines.length = 0;
      if (debugLogEl) debugLogEl.textContent = '';
      if (debugCountEl) debugCountEl.textContent = '0';
    });

    debugCopyBtn?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = debugLines.join('\n');
      try {
        await navigator.clipboard.writeText(text);
        debugCopyBtn.textContent = '已复制';
        setTimeout(() => {
          debugCopyBtn.textContent = '复制';
        }, 1200);
      } catch (_) {
        debugCopyBtn.textContent = '失败';
        setTimeout(() => {
          debugCopyBtn.textContent = '复制';
        }, 1200);
      }
    });

    showStatus = (type, text) => {
      statusEl.classList.remove('hidden', 'success', 'error');
      statusEl.classList.add(type);
      statusEl.textContent = text;
    };

    function showErrorWithFaq(text, anchor) {
      statusEl.classList.remove('hidden', 'success', 'error');
      statusEl.classList.add('error');
      const href = anchor ? `${FAQ_URL}#${anchor}` : FAQ_URL;
      statusEl.innerHTML = `${text} <a href="${href}" target="_blank" rel="noopener" class="yt-dl-status-link">查看常见问题</a>`;
    }

    const STEP_LABELS = {
      prepare: '准备中',
      download: '下载视频',
      video: '下载视频',
      audio: '下载音频',
      merge: '合并音视频',
      save: '保存文件',
      paused: '已暂停',
      queue: '分 P 队列下载',
      playlist: '播放列表队列',
      links: '多链接队列'
    };

    function formatBytes(n) {
      const v = Number(n) || 0;
      if (v >= 1024 * 1024 * 1024) return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
      if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      if (v >= 1024) return Math.round(v / 1024) + ' KB';
      if (v > 0) return v + ' B';
      return '0 B';
    }

    function setLoginHint(text) {
      if (text) {
        loginHintEl.textContent = text;
        loginHintEl.classList.remove('hidden');
      } else {
        loginHintEl.textContent = '';
        loginHintEl.classList.add('hidden');
      }
    }

    async function refreshEstimate() {
      if (!selectedQn || !videoInfo?.aid || !videoInfo?.cid) {
        estimateEl.classList.add('hidden');
        return;
      }
      try {
        const est = await agentCall('GET_ESTIMATE', {
          aid: videoInfo.aid,
          cid: videoInfo.cid,
          qn: selectedQn,
          duration: videoInfo.duration
        });
        let text = '预计大小：约 ' + (est.sizeLabel || '未知');
        if (est.estimateNote) text += '（' + est.estimateNote + '）';
        estimateText.textContent = text;
        estimateEl.classList.remove('hidden');
      } catch {
        estimateEl.classList.add('hidden');
      }
    }

    function errorFaqAnchor(msg) {
      if (/过大/.test(msg)) return 'file-size';
      if (/合成|合并/.test(msg)) return 'merge-slow';
      if (/取消/.test(msg)) return null;
      if (/bot|机器人|登录|LOGIN/i.test(msg)) return 'login';
      if (/清晰度|720P|质量|quality/i.test(msg)) return 'quality';
      return 'download-fail';
    }

    function setProgressActionsVisible(visible) {
      progressActions.classList.toggle('hidden', !visible);
    }

    function resetPauseUI() {
      downloadPaused = false;
      pauseBtn.textContent = '暂停';
      progressBar.classList.remove('paused');
    }

    function hideProgress() {
      downloading = false;
      resetPauseUI();
      progressEl.classList.add('hidden');
      setProgressActionsVisible(false);
      progressBar.style.width = '0%';
      progressBar.classList.remove('indeterminate');
      progressPct.classList.remove('hidden');
    }

    function showProgressStart() {
      downloading = true;
      resetPauseUI();
      progressEl.classList.remove('hidden');
      setProgressActionsVisible(true);
      progressTitle.textContent = videoInfo?.title || '视频';
      progressTitle.title = videoInfo?.title || '';
      progressQ.textContent = getSelectedQualityLabel();
      updateProgress('prepare', 0);
    }

    updateProgress = (step, percent, received, total) => {
      if (!downloading) return;
      progressEl.classList.remove('hidden');

      if (step === 'merge' || step === 'save') {
        setProgressActionsVisible(false);
      } else if (step !== 'paused') {
        setProgressActionsVisible(true);
      }

      if (step === 'paused') {
        downloadPaused = true;
        pauseBtn.textContent = '继续';
        progressPhase.textContent = STEP_LABELS.paused;
        progressBar.classList.add('paused');
        return;
      }

      if (downloadPaused && step !== 'paused') {
        downloadPaused = false;
        pauseBtn.textContent = '暂停';
        progressBar.classList.remove('paused');
      }

      if (step === 'queue') {
        progressPhase.textContent = STEP_LABELS.queue;
        const qp = Math.min(100, Math.max(0, Number(percent) || 0));
        progressPct.textContent = qp + '%';
        progressBar.style.width = qp + '%';
        progressBar.classList.remove('indeterminate', 'paused');
        progressPct.classList.remove('hidden');
        return;
      }

      const pct = Number(percent);
      const recv = Number(received) || 0;
      const tot = Number(total) || 0;

      if (step === 'merge') {
        const sizeHint = tot || recv;
        progressPhase.textContent = sizeHint
          ? '正在合成，约 ' + formatBytes(sizeHint)
          : STEP_LABELS.merge;
        progressBar.classList.add('indeterminate');
        progressPct.classList.add('hidden');
        return;
      }

      progressPhase.textContent = STEP_LABELS[step] || '下载中…';

      if (tot > 0) {
        const displayPct = Math.min(100, Math.max(0, pct >= 0 ? pct : Math.round((recv / tot) * 100)));
        progressPct.textContent = formatBytes(recv) + ' / ' + formatBytes(tot)
          + (displayPct < 100 ? ' · ' + displayPct + '%' : '');
        progressBar.style.width = displayPct + '%';
        progressBar.classList.remove('indeterminate');
        progressPct.classList.remove('hidden');
        return;
      }

      if (recv > 0) {
        progressPct.textContent = '已收 ' + formatBytes(recv);
        progressBar.classList.add('indeterminate');
        progressPct.classList.remove('hidden');
        return;
      }

      if (pct > 0) {
        progressPct.textContent = Math.min(100, pct) + '%';
        progressBar.style.width = Math.min(100, pct) + '%';
        progressBar.classList.remove('indeterminate');
        progressPct.classList.remove('hidden');
      } else {
        // 尚无字节：转圈 + 文案，避免空白像“卡住”
        progressBar.classList.add('indeterminate');
        progressPct.textContent = STEP_LABELS[step] || '连接中…';
        progressPct.classList.remove('hidden');
      }
    };

    function setDetect(text, ready) {
      detectText.textContent = text;
      readyBadge.classList.toggle('hidden', !ready);
    }

    function setVideoLoading(loading) {
      videoCard.classList.toggle('is-loading', loading);
      if (loading) {
        coverSk.classList.remove('hidden');
        coverImg.classList.add('hidden');
        coverPh.classList.add('hidden');
      }
      videoSk.classList.toggle('hidden', !loading);
      videoContent.classList.toggle('hidden', loading);
    }

    function renderQualityPills(list) {
      qualities = list || [];
      const preferFallback = [
        { qn: 2160, label: '2160P', mode: 'prefer' },
        { qn: 1440, label: '1440P', mode: 'prefer' },
        { qn: 1080, label: '1080P', mode: 'prefer' },
        { qn: 720, label: '720P', mode: 'prefer' },
        { qn: 480, label: '480P', mode: 'prefer' },
        { qn: 360, label: '360P', mode: 'prefer' }
      ];

      function pillHtml(q) {
        return `<button type="button" class="yt-dl-pill${q.qn === selectedQn ? ' active' : ''}" data-qn="${q.qn}" title="${q.mode || ''}${q.webm ? ' · WebM+Opus→.webm' : ''}${q.remuxable === false ? ' · 无可合并轨，将自动降档' : ''}">${q.label}${q.mode === 'hls' ? ' HLS' : ''}</button>`;
      }

      function bindPills(el, listForBind) {
        if (!el) return;
        el.querySelectorAll('.yt-dl-pill[data-qn]').forEach((btn) => {
          btn.onclick = () => {
            selectedQn = +btn.dataset.qn;
            // 两边胶囊同步高亮
            [pillsEl, linksPillsEl].forEach((box) => {
              box?.querySelectorAll('.yt-dl-pill[data-qn]').forEach((b) => {
                b.classList.toggle('active', +b.dataset.qn === selectedQn);
              });
            });
            // 若点的是偏好档且当前列表里没有，不打断
            if (listForBind.length && !listForBind.some((q) => q.qn === selectedQn)) {
              // keep selectedQn as preference for queue
            }
            refreshEstimate();
            updatePlaylistSelectionUi();
            if (parsedLinkItems.length) renderParsedLinks(parsedLinkItems);
          };
        });
      }

      if (!qualities.length) {
        pillsEl.innerHTML = '<span class="yt-dl-pill disabled">无可用清晰度</span>';
        if (!selectedQn) selectedQn = 1080;
        linksPillsEl.innerHTML = preferFallback.map(pillHtml).join('');
        bindPills(linksPillsEl, preferFallback);
        updatePlaylistSelectionUi();
        if (parsedLinkItems.length) renderParsedLinks(parsedLinkItems);
        return;
      }

      if (!qualities.some((q) => q.qn === selectedQn)) {
        selectedQn = qualities[0].qn;
      }
      const html = qualities.map(pillHtml).join('');
      pillsEl.innerHTML = html;
      linksPillsEl.innerHTML = html;
      bindPills(pillsEl, qualities);
      bindPills(linksPillsEl, qualities);
      refreshEstimate();
      updatePlaylistSelectionUi();
      if (parsedLinkItems.length) renderParsedLinks(parsedLinkItems);
    }

    async function fetchSnapshot() {
      const res = await agentCall('RESOLVE_VIDEO', { href: location.href, pageIndex });
      const qRes = await agentCall('GET_QUALITIES', { aid: res.info.aid, cid: res.info.cid });
      return {
        info: res.info,
        qualities: qRes.qualities || [],
        maxLabel: qRes.maxLabel || '',
        loginHint: qRes.loginHint || null
      };
    }

    async function loadVideoInfo() {
      setDetect('识别页面中…', false);
      setVideoLoading(true);
      titleEl.textContent = '';
      authorEl.textContent = '';
      authorEl.classList.add('hidden');
      subEl.textContent = '';
      estimateEl.classList.add('hidden');
      loginHintEl.classList.add('hidden');
      queueBtn.classList.add('hidden');
      startBtn.disabled = true;
      statusEl.classList.add('hidden');
      pillsEl.innerHTML = '<span class="yt-dl-pill loading">加载中</span>';
      if (linksPillsEl) linksPillsEl.innerHTML = '<span class="yt-dl-pill loading">加载中</span>';
      if (!urlHasPlaylist(location.href)) {
        renderPlaylistPanel({ inPlaylist: false, items: [] });
      } else {
        // 有 list= 时先露出播放列表 Tab，再异步填内容
        tabPlaylistBtn.classList.remove('hidden');
      }

      try {
        const snap = await fetchSnapshot();
        videoInfo = snap.info;
        setVideoLoading(false);
        titleEl.textContent = videoInfo.title;
        setDetect('已识别视频页面', true);
        debugLog('快照', `HLS档=${(snap.qualities || []).filter((q) => q.mode === 'hls').map((q) => q.label).join(',') || '无'} · 全部=${(snap.qualities || []).map((q) => q.label + '/' + q.mode).join(', ')}`);

        if (videoInfo.author) {
          authorEl.textContent = videoInfo.author;
          authorEl.classList.remove('hidden');
        } else {
          authorEl.classList.add('hidden');
        }

        if (videoInfo.pic) {
          coverImg.src = videoInfo.pic;
          const showCover = () => {
            coverImg.classList.remove('hidden');
            coverPh.classList.add('hidden');
            coverSk.classList.add('hidden');
          };
          const showCoverFallback = () => {
            coverImg.classList.add('hidden');
            coverPh.classList.remove('hidden');
            coverSk.classList.add('hidden');
          };
          if (coverImg.complete) {
            coverImg.naturalWidth ? showCover() : showCoverFallback();
          } else {
            coverImg.onload = showCover;
            coverImg.onerror = showCoverFallback;
          }
        } else {
          coverPh.classList.remove('hidden');
          coverSk.classList.add('hidden');
        }

        const parts = [];
        if (videoInfo.view) parts.push(formatView(videoInfo.view) + ' 播放');
        if (videoInfo.pubdate) parts.push(formatTime(videoInfo.pubdate));
        subEl.textContent = parts.length ? parts.join(' · ') : 'YouTube视频';

        if (isMultiPartVideo(videoInfo.pages)) {
          pagesEl.classList.remove('hidden');
          pagesEl.innerHTML = videoInfo.pages
            .map((p, i) => `<button type="button" class="yt-dl-page-btn${i === pageIndex ? ' active' : ''}" data-index="${i}">P${p.page}</button>`)
            .join('');
          pagesEl.querySelectorAll('.yt-dl-page-btn').forEach((btn) => {
            btn.onclick = () => { pageIndex = +btn.dataset.index; loadVideoInfo(); };
          });
          queueBtn.classList.remove('hidden');
          setQueueLabel(videoInfo.pages.length);
        } else {
          pagesEl.classList.add('hidden');
          queueBtn.classList.add('hidden');
        }

        maxLabelEl.textContent = snap.maxLabel ? `源最高 ${snap.maxLabel}` : '源最高 —';
        setLoginHint(snap.loginHint);
        renderQualityPills(snap.qualities);
        if (snap.qualities.some((q) => q.mode === 'dash' || q.mode === 'sniff' || q.mode === 'hls')) {
          setupMuxInPage().catch(() => {});
        }
        startBtn.disabled = !snap.qualities.length;
        updatePlaylistSelectionUi();

        debugLog('加载', `${videoInfo.aid}/${videoInfo.cid} · ${snap.qualities.map((q) => q.label).join(', ')}`);
        loadPlaylistInfo();
      } catch (err) {
        setDetect('识别失败', false);
        setVideoLoading(false);
        titleEl.textContent = '加载失败';
        const tip = friendlyError(err.message);
        subEl.textContent = tip;
        coverPh.classList.remove('hidden');
        coverSk.classList.add('hidden');
        showErrorWithFaq(tip, errorFaqAnchor(tip));
        debugLog('错误', err.message);
        renderQualityPills([]);
      }
    }

    function getSelectedQualityLabel() {
      return qualities.find((q) => q.qn === selectedQn)?.label || (selectedQn ? selectedQn + 'P' : '');
    }

    pauseBtn.onclick = () => {
      if (!downloading) return;
      if (downloadPaused) {
        agentSignal('RESUME_DOWNLOAD');
        downloadPaused = false;
        pauseBtn.textContent = '暂停';
        progressBar.classList.remove('paused');
      } else {
        agentSignal('PAUSE_DOWNLOAD');
      }
    };

    cancelDlBtn.onclick = () => {
      if (!downloading) return;
      queueCancelled = true;
      agentSignal('CANCEL_DOWNLOAD');
      chrome.runtime.sendMessage({ type: 'YT_DL_BG_ABORT' }).catch(() => {});
    };

    async function ensureMuxReady() {
      const sel = qualities.find((q) => q.qn === selectedQn);
      // HLS 预合并 / 一体流不需要 mux
      if (!sel || sel.mode === 'hls' || sel.mode === 'durl') return true;
      if (sel.mode !== 'dash' && sel.mode !== 'sniff') return true;
      try {
        await setupMuxInPage();
        return true;
      } catch {
        showErrorWithFaq('请刷新页面后重试', 'merge-slow');
        return false;
      }
    }

    async function mergeBgSniff(urls, itag) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'YT_DL_GET_SNIFFED',
          itag: itag || null
        });
        if (!resp?.ok) return urls || [];
        console.log('[YtDL:content] bg嗅探', {
          itag,
          hit: (resp.urls || []).length,
          any: (resp.any || []).length,
          itags: resp.itags
        });
        const merged = [];
        const seen = new Set();
        for (const u of [...(resp.urls || []), ...(urls || [])]) {
          if (!u || seen.has(u)) continue;
          seen.add(u);
          merged.push(u);
        }
        // 同 itag 没有时，不轻易用 any（可能是别的清晰度）
        return merged;
      } catch (e) {
        console.warn('[YtDL:content] bg嗅探失败', e);
        return urls || [];
      }
    }

    async function bgFetchConcat(urls, filename, step, userAgent) {
      if (!chrome.runtime?.id) {
        throw new Error('扩展已重载，请按 F5 刷新页面后再下载');
      }
      debugLog('bg', `HLS 分片合并 ${urls.length} 条`);
      const resp = await chrome.runtime.sendMessage({
        type: 'YT_DL_BG_FETCH_CONCAT',
        urls,
        filename,
        step: step || 'download',
        userAgent: userAgent || null
      });
      console.log('[YtDL:content] bgFetchConcat', {
        ok: resp?.ok,
        error: resp?.error,
        bytes: resp?.buffer?.byteLength
      });
      if (!resp?.ok) throw new Error(resp?.error || 'HLS background 合并失败');
      return pullChunkedBuffer(resp);
    }

    async function bgFetch(urls, filename, step, userAgent, itag) {
      if (!chrome.runtime?.id) {
        throw new Error('扩展已重载，请按 F5 刷新页面后再下载');
      }
      const finalUrls = await mergeBgSniff(urls, itag);
      if (!finalUrls.length) {
        throw new Error('无可用地址（扩展未捕获到播放器请求）。请先播放目标清晰度几秒');
      }
      debugLog(
        'bg',
        `后台下载 · ${step || 'download'} · 候选 ${finalUrls.length} 条`
      );
      console.log('[YtDL:content] bgFetch', {
        step,
        n: finalUrls.length,
        ua: userAgent ? String(userAgent).slice(0, 40) : 'default',
        sample: (finalUrls[0] || '').slice(0, 120)
      });
      lastBgProgress = { step: step || 'download', received: 0, total: 0, percent: 0, at: Date.now() };
      let ticks = 0;
      const hb = setInterval(() => {
        ticks += 1;
        const p = lastBgProgress;
        const sameStep = !p.step || p.step === (step || 'download');
        const recv = sameStep ? p.received : 0;
        const tot = sameStep ? p.total : 0;
        const pct = sameStep ? p.percent : 0;
        const prog =
          tot > 0
            ? `${formatBytes(recv)}/${formatBytes(tot)} · ${pct}%`
            : recv > 0
              ? `${formatBytes(recv)}（未知总量）`
              : '尚无字节';
        debugLog(
          'bg',
          `${step || 'download'} 进行中… ${ticks * 20}s · ${prog}`
        );
      }, 20000);
      let resp;
      try {
        resp = await chrome.runtime.sendMessage({
          type: 'YT_DL_BG_FETCH',
          urls: finalUrls,
          filename,
          step: step || 'download',
          userAgent: userAgent || null
        });
      } catch (e) {
        const m = e?.message || String(e);
        if (/Extension context invalidated|context invalidated/i.test(m)) {
          throw new Error('扩展已重载，请按 F5 刷新页面后再下载');
        }
        throw e;
      } finally {
        clearInterval(hb);
      }
      console.log('[YtDL:content] bgFetch 结果', {
        ok: resp?.ok,
        error: resp?.error,
        mode: resp?.mode,
        usedIndex: resp?.usedIndex,
        probes: resp?.probes,
        bytes: resp?.buffer?.byteLength,
        size: resp?.size
      });
      if (!resp?.ok) {
        throw new Error(resp?.error || 'background 下载失败（无详细信息）');
      }
      resp = await pullChunkedBuffer(resp);
      debugLog('bg', `${step || 'download'} 完成 · ${formatBytes(respBytes(resp))}`);
      return resp;
    }

    async function runSingleDownload(info) {
      const sel = qualities.find((q) => q.qn === selectedQn);
      const result = await agentCall('START_DOWNLOAD', {
        aid: info.aid,
        cid: info.cid,
        qn: selectedQn,
        title: info.title,
        itag: sel?.itag || null,
        client: sel?.client || null,
        mode: sel?.mode || null,
        hlsUrl: sel?.hlsUrl || null
      });

      console.log('[YtDL:content] START_DOWNLOAD', result && Object.keys(result), result);

      // 视频已在页面下完、音频失败：background 只补音频，再合并内存中的视频
      if (result?.needBgAudio) {
        const ua = result.userAgent || null;
        debugLog(
          '音频',
          `视频已就绪 ${formatBytes(result.videoBytes)}，改 background 拉音频后合并`
        );
        updateProgress('audio', 0);
        try {
          const aResp = await bgFetch(
            result.audioUrls || [],
            'audio.m4a',
            'audio',
            ua,
            result.audioItag || null
          );
          assertBgMedia(aResp, 'audio', MIN_AUDIO_BYTES, result.audioExpectedBytes || 0);
          debugLog(
            'DASH',
            `音频 OK · ${formatBytes(respBytes(aResp))} · magic=${peekMagic(aResp.buffer)}`
          );
          updateProgress('merge', 5);
          await setupMuxInPage();
          const transfer = [];
          if (aResp.buffer instanceof ArrayBuffer) transfer.push(aResp.buffer);
          const mergeHb = setInterval(() => {
            debugLog('合并', '合成进行中…');
          }, 15000);
          let merged;
          try {
            merged = await agentCall(
              'MERGE_PENDING_VIDEO',
              {
                audioBuffer: aResp.buffer,
                filename: result.filename || 'youtube.mp4'
              },
              transfer
            );
          } finally {
            clearInterval(mergeHb);
          }
          if (merged?.savedTracks) {
            debugLog(
              '合并',
              `失败已分轨保存 · ${merged.videoName || ''} + ${merged.audioName || ''} · ${merged.error || ''}`
            );
            updateProgress('save', 100);
            return {
              savedTracks: true,
              mergeFailed: true,
              videoName: merged.videoName,
              audioName: merged.audioName,
              filename: result.filename
            };
          }
          updateProgress('save', 100);
          debugLog('保存', `合并成品已存 · ${formatBytes(merged?.size || 0)}`);
          return { merged: true, bytes: merged?.size || 0, via: 'bg-audio', filename: result.filename };
        } catch (e) {
          console.warn('[YtDL:content] background 音频也失败，仅存视频', e);
          debugLog('音频', 'background 也失败，仅保存视频轨: ' + (e.message || e));
          try {
            await agentCall('SAVE_PENDING_VIDEO', {
              filename: result.videoOnlyFilename || 'video.mp4',
              keep: false
            });
          } catch (e2) {
            throw new Error('音频失败且保存视频轨失败: ' + (e2.message || e2));
          }
          updateProgress('save', 100);
          return { videoOnly: true, audioFailed: true };
        }
      }

      // 一体流 / DASH / HLS：均可能由 background 拉
      if (result?.bgFetch) {
        const ua = result.userAgent || null;
        if (result.hls) {
          updateProgress('download', 0);
          const resp = await bgFetchConcat(
            result.urls || [],
            result.filename || 'youtube.mp4',
            'download',
            ua
          );
          if (!resp.buffer || resp.buffer.byteLength < 50 * 1024) {
            throw new Error('HLS 合并结果过小（' + (resp.buffer?.byteLength || 0) + ' bytes）');
          }
          const blob = new Blob([resp.buffer], { type: resp.mime || 'video/mp4' });
          updateProgress('save', 95);
          await downloadBlob(blob, resp.filename || result.filename || 'youtube.mp4');
          updateProgress('save', 100);
          return { hls: true, bg: true, bytes: resp.buffer.byteLength };
        }
        if (result.dash) {
          updateProgress('video', 0);
          debugLog(
            'DASH',
            `${result.container || 'dash'} · ${formatBytes(result.videoExpectedBytes || 0)}+${formatBytes(result.audioExpectedBytes || 0)} · ${result.filename || ''}`
          );
          const vResp = await bgFetch(
            result.videoUrls || [],
            result.videoOnlyFilename || result.filename || 'video.mp4',
            'video',
            ua,
            result.itag || null
          );
          if (vResp.mode === 'downloads') {
            if ((vResp.size || 0) < MIN_VIDEO_BYTES) throw new Error('视频文件过小');
            debugLog('DASH', `视频走 downloads API · id=${vResp.downloadId} · ${formatBytes(vResp.size)}`);
            return { via: 'downloads', downloadId: vResp.downloadId };
          }
          const vBytes = assertBgMedia(vResp, 'video', MIN_VIDEO_BYTES, result.videoExpectedBytes || 0);
          const vMagic = peekMagic(vResp.buffer);
          const isWebm = /^1a 45 df a3/i.test(vMagic);
          debugLog('DASH', `视频 OK · ${formatBytes(vBytes)}${isWebm ? ' · WebM' : ''}`);

          if (!(result.audioUrls || []).length) {
            const vBlob = new Blob([vResp.buffer], { type: isWebm ? 'video/webm' : 'video/mp4' });
            await downloadBlob(vBlob, result.videoOnlyFilename || result.filename || (isWebm ? 'video.webm' : 'video.mp4'));
            updateProgress('save', 100);
            return { videoOnly: true };
          }

          updateProgress('audio', 0);
          let aResp;
          try {
            aResp = await bgFetch(result.audioUrls, isWebm ? 'audio.webm' : 'audio.m4a', 'audio', ua, result.audioItag || null);
            const aBytes = assertBgMedia(
              aResp,
              'audio',
              MIN_AUDIO_BYTES,
              result.audioExpectedBytes || 0
            );
            debugLog('DASH', `音频 OK · ${formatBytes(aBytes)}`);
          } catch (e) {
            console.warn('[YtDL:content] 音频失败，仅存视频轨', e);
            debugLog('音频', '失败，仅保存无声视频轨: ' + (e.message || e));
            const vBlob = new Blob([vResp.buffer], { type: isWebm ? 'video/webm' : 'video/mp4' });
            await downloadBlob(vBlob, result.videoOnlyFilename || (isWebm ? 'video.webm' : 'video.mp4'));
            updateProgress('save', 100);
            return { videoOnly: true, audioFailed: true };
          }

          if (aResp.mode === 'downloads') {
            debugLog('音频', '走 downloads，无法合并；仅存视频轨');
            const vBlob = new Blob([vResp.buffer], { type: isWebm ? 'video/webm' : 'video/mp4' });
            await downloadBlob(vBlob, result.videoOnlyFilename || (isWebm ? 'video.webm' : 'video.mp4'));
            updateProgress('save', 100);
            return { videoOnly: true };
          }

          const totalBytes = vResp.buffer.byteLength + aResp.buffer.byteLength;
          updateProgress('merge', 5, totalBytes, totalBytes);
          debugLog(
            '合并',
            `${isWebm ? 'WebM' : 'MP4'} 合成 · ${formatBytes(vResp.buffer.byteLength)}+${formatBytes(aResp.buffer.byteLength)}`
          );
          const mergeHb = setInterval(() => {
            debugLog('合并', '合成进行中…');
          }, 15000);
          let mergeOut;
          try {
            mergeOut = await mergeBuffersViaPage(vResp.buffer, aResp.buffer, {
              filename: result.filename
            });
          } finally {
            clearInterval(mergeHb);
          }
          if (mergeOut?.savedTracks) {
            debugLog(
              '合并',
              `失败已分轨保存 · ${mergeOut.videoName || ''} + ${mergeOut.audioName || ''} · ${mergeOut.error || ''}`
            );
            updateProgress('save', 100);
            return {
              savedTracks: true,
              mergeFailed: true,
              videoName: mergeOut.videoName,
              audioName: mergeOut.audioName,
              filename: result.filename
            };
          }
          const mergedBlob = mergeOut.blob;
          debugLog(
            '合并',
            `完成 · ${formatBytes(mergedBlob.size)} · magic=${peekMagic(await mergedBlob.slice(0, 8).arrayBuffer())}`
          );
          updateProgress('save', 95);
          const mergedName = result.filename || 'youtube.mp4';
          debugLog('保存', `触发浏览器下载 · ${mergedName}`);
          await downloadBlob(mergedBlob, mergedName);
          updateProgress('save', 100);
          return { merged: true, bytes: mergedBlob.size, filename: mergedName };
        }

        updateProgress('download', 0);
        const resp = await bgFetch(
          result.urls || [],
          result.filename || 'youtube.mp4',
          'download',
          ua,
          result.itag || null
        );
        if (resp.mode === 'downloads') {
          if ((resp.size || 0) < MIN_VIDEO_BYTES) {
            throw new Error('浏览器下载文件过小（' + formatBytes(resp.size || 0) + '），已视为失败');
          }
          updateProgress('save', 100);
          return { dash: false, via: 'downloads', downloadId: resp.downloadId, size: resp.size };
        }
        assertBgMedia(resp, 'download', MIN_VIDEO_BYTES, result.videoExpectedBytes || 0);
        const blob = new Blob([resp.buffer], { type: 'video/mp4' });
        updateProgress('save', 95);
        await downloadBlob(blob, resp.filename || result.filename || 'youtube.mp4');
        updateProgress('save', 100);
        return { dash: false, bg: true, probes: resp.probes, bytes: resp.buffer.byteLength };
      }

      if (result.merged) {
        updateProgress('save', 95);
        const blob = result.blob || new Blob([result.mp4], { type: 'video/mp4' });
        await downloadBlob(blob, result.filename);
        updateProgress('save', 100);
      } else if (result.videoOnly) {
        updateProgress('save', 100);
      } else {
        updateProgress('save', 100);
      }
      return result;
    }

    async function startDownload() {
      if (!selectedQn || !videoInfo || queueRunning || downloading) return;

      // 先占位，避免 ensureMuxReady 等待期间连点开两次
      downloading = true;
      startBtn.disabled = true;
      queueBtn.disabled = true;
      plQueueBtn.disabled = true;
      linksQueueBtn.disabled = true;
      startBtn.textContent = '下载中…';
      statusEl.classList.add('hidden');

      if (!(await ensureMuxReady())) {
        downloading = false;
        startBtn.disabled = false;
        queueBtn.disabled = false;
        updatePlaylistSelectionUi();
        updateLinksQueueUi();
        startBtn.innerHTML = btnDefaultHtml;
        return;
      }

      const seq = ++downloadSeq;
      showProgressStart();
      debugLog('下载', `──── #${seq} 开始 · ${selectedQn}P · ${videoInfo.title || ''} ────`);

      try {
        const result = await runSingleDownload(videoInfo);
        hideProgress();
        if (result.videoOnly) {
          showStatus(
            'success',
            result.audioFailed
              ? '视频轨已保存（无声音）。音频失败，可改较低清晰度重试'
              : '已下载视频轨（无音频）'
          );
        } else if (result.savedTracks || result.mergeFailed) {
          showStatus(
            'success',
            `合并未成功，已分别保存音视频轨（无需重下）。可用 VLC / ffmpeg 合并：${result.videoName || '视频'} + ${result.audioName || '音频'}`
          );
        } else if (result.via === 'downloads') {
          showStatus('success', '已交给浏览器下载，请查看右上角下载栏');
        } else if (result.hls) {
          showStatus(
            'success',
            result.ext === 'ts'
              ? 'HLS 下载完成（.ts，可用 VLC 播放）'
              : 'HLS 下载完成，已保存'
          );
        } else {
          showStatus(
            'success',
            result.actualQn && result.requestedQn && result.actualQn !== result.requestedQn
              ? `下载完成（请求 ${result.requestedQn}P 无匹配档，已存 ${result.actualQn}P）`
              : /\.webm$/i.test(result.filename || '')
                ? '下载完成，已保存为 WebM（VP9/Opus）'
                : '下载完成，已保存为 MP4'
          );
        }
        debugLog('下载', `──── #${seq} 完成 ────`);
      } catch (err) {
        hideProgress();
        console.error('[YtDL:content] 下载失败', err);
        let msg = friendlyError(err.message || String(err));
        if (msg === '下载已取消') {
          showStatus('error', '下载已取消');
        } else {
          showErrorWithFaq(msg, errorFaqAnchor(msg));
        }
        debugLog('错误', err.message || String(err));
        debugLog('下载', `──── #${seq} 失败（需重新点下载才会再拉） ────`);
      } finally {
        downloading = false;
        startBtn.disabled = false;
        queueBtn.disabled = false;
        startBtn.innerHTML = btnDefaultHtml;
        updatePlaylistSelectionUi();
      }
    }

    async function runVideoIdQueue(items, opts) {
      opts = opts || {};
      const label = opts.label || '队列';
      const step = opts.step || 'playlist';
      const tab = opts.tab || 'playlist';
      const busyLabelEl = opts.busyLabelEl || null;

      if (!selectedQn || !items.length || queueRunning || downloading) return;
      if (!(await ensureMuxReady())) return;

      const total = items.length;
      queueRunning = true;
      queueCancelled = false;
      startBtn.disabled = true;
      queueBtn.disabled = true;
      plQueueBtn.disabled = true;
      linksQueueBtn.disabled = true;
      if (busyLabelEl) busyLabelEl.textContent = '队列下载中…';
      statusEl.classList.add('hidden');
      setActiveTab(tab);

      let ok = 0;
      let fail = 0;
      const seq = ++downloadSeq;
      debugLog(label, `──── #${seq} 队列开始 · ${total} 条 · ${selectedQn}P ────`);

      for (let i = 0; i < total; i++) {
        if (queueCancelled) break;
        const it = items[i];
        const vid = it.videoId;
        let title = it.title && it.title !== vid ? it.title : '';
        let author = it.author || '';

        // 下载前再解析一次标题，保证文件名正确
        if (!title || title === vid) {
          try {
            const res = await agentCall('RESOLVE_VIDEO_META', { videoId: vid });
            const info = res?.info || res;
            if (info?.title) {
              title = info.title;
              author = info.author || author;
              it.title = title;
              it.author = author;
              it._resolved = true;
              if (parsedLinkItems.includes(it) || opts.tab === 'links') {
                renderParsedLinks(parsedLinkItems);
              }
            }
          } catch (err) {
            debugLog(label, `${vid} 标题解析失败: ${err.message || err}`);
          }
        }
        if (!title) title = vid;

        const partInfo = {
          videoId: vid,
          bvid: vid,
          aid: vid,
          cid: vid,
          title,
          author,
          pages: [{ page: 1, part: title, cid: vid }]
        };

        downloading = true;
        resetPauseUI();
        progressEl.classList.remove('hidden');
        setProgressActionsVisible(true);
        progressTitle.textContent = `${i + 1}/${total} · ${partInfo.title}`;
        progressTitle.title = partInfo.title;
        progressQ.textContent = getSelectedQualityLabel();
        updateProgress(step, Math.round((i / total) * 100));
        debugLog(label, `#${i + 1}/${total} ${vid} · ${String(partInfo.title).slice(0, 40)}`);

        try {
          await runSingleDownload(partInfo);
          ok++;
        } catch (err) {
          if (err.message === '下载已取消' || queueCancelled) break;
          fail++;
          debugLog(label, `#${i + 1} 失败: ${err.message}`);
        }
      }

      hideProgress();
      queueRunning = false;
      downloading = false;

      if (queueCancelled) {
        showStatus('error', `${label}已取消（已完成 ${ok}/${total}）`);
      } else if (fail === 0) {
        showStatus('success', `${label}完成，共 ${ok} 个视频`);
      } else {
        showErrorWithFaq(`部分完成：成功 ${ok}，失败 ${fail}`, 'parts');
      }
      debugLog(label, `──── #${seq} 队列结束 · 成功 ${ok} · 失败 ${fail} ────`);

      startBtn.disabled = false;
      queueBtn.disabled = false;
      startBtn.innerHTML = btnDefaultHtml;
      updatePlaylistSelectionUi();
      updateLinksQueueUi();
    }

    async function startPlaylistQueueDownload() {
      await runVideoIdQueue(getSelectedPlaylistItems(), {
        label: '播放列表',
        step: 'playlist',
        tab: 'playlist',
        busyLabelEl: plQueueLabel
      });
    }

    async function startLinksQueueDownload() {
      refreshParsedLinksFromInput();
      await runVideoIdQueue(parsedLinkItems, {
        label: '多链接',
        step: 'links',
        tab: 'links',
        busyLabelEl: linksQueueLabel
      });
    }

    async function startQueueDownload() {
      if (!selectedQn || !videoInfo || !isMultiPartVideo(videoInfo.pages) || queueRunning) return;
      if (!(await ensureMuxReady())) return;

      const total = videoInfo.pages.length;
      queueRunning = true;
      queueCancelled = false;
      startBtn.disabled = true;
      queueBtn.disabled = true;
      plQueueBtn.disabled = true;
      linksQueueBtn.disabled = true;
      queueLabelEl.textContent = '队列下载中…';
      statusEl.classList.add('hidden');

      let ok = 0;
      let fail = 0;

      for (let i = 0; i < total; i++) {
        if (queueCancelled) break;

        let partInfo;
        try {
          const res = await agentCall('RESOLVE_VIDEO', { href: location.href, pageIndex: i });
          partInfo = res.info;
        } catch (err) {
          fail++;
          debugLog('队列', `P${i + 1} 解析失败: ${err.message}`);
          continue;
        }

        downloading = true;
        resetPauseUI();
        progressEl.classList.remove('hidden');
        setProgressActionsVisible(true);
        progressTitle.textContent = `P${i + 1}/${total} · ${partInfo.title}`;
        progressTitle.title = partInfo.title;
        progressQ.textContent = getSelectedQualityLabel();
        updateProgress('queue', Math.round((i / total) * 100));

        try {
          await runSingleDownload(partInfo);
          ok++;
        } catch (err) {
          if (err.message === '下载已取消' || queueCancelled) break;
          fail++;
          debugLog('队列', `P${i + 1} 失败: ${err.message}`);
        }
      }

      hideProgress();
      queueRunning = false;
      downloading = false;

      if (queueCancelled) {
        showStatus('error', `队列已取消（已完成 ${ok}/${total}）`);
      } else if (fail === 0) {
        showStatus('success', `队列下载完成，共 ${ok} 个分 P`);
      } else {
        showErrorWithFaq(`部分完成：成功 ${ok}，失败 ${fail}。可先播放再重试失败项`, 'parts');
      }

      queueBtn.disabled = false;
      startBtn.disabled = false;
      setQueueLabel(total);
      startBtn.innerHTML = btnDefaultHtml;
      updatePlaylistSelectionUi();
      updateLinksQueueUi();
    }

    toggleBtn.onclick = async () => {
      isOpen = !isOpen;
      menu.classList.toggle('hidden', !isOpen);
      if (isOpen) await loadVideoInfo();
    };
    closeBtn.onclick = () => { isOpen = false; menu.classList.add('hidden'); };
    startBtn.onclick = startDownload;
    queueBtn.onclick = startQueueDownload;
    plQueueBtn.onclick = startPlaylistQueueDownload;
    linksQueueBtn.onclick = startLinksQueueDownload;

    panel.querySelector('.yt-dl-feedback')?.addEventListener('click', () => {
      navigator.clipboard?.writeText('748604487').catch(() => {});
    });

    window.__YT_DL_API__ = {
      fetchSnapshot,
      openPanel: async () => {
        isOpen = true;
        menu.classList.remove('hidden');
        await loadVideoInfo();
      },
      onNavigate: () => {
        pageIndex = 0;
        videoInfo = null;
        selectedQn = 0;
        playlistInfo = null;
        setActiveTab('current');
        if (isOpen) loadVideoInfo();
      }
    };
  }

  function waitAndMount() {
    if (!document.body) {
      setTimeout(waitAndMount, 100);
      return;
    }
    // YouTube SPA：仅在 watch / shorts 页挂载悬浮按钮
    const isVideoPage = () =>
      /[?&]v=/.test(location.search) ||
      location.pathname.startsWith('/shorts/') ||
      location.pathname.startsWith('/watch');
    const syncMount = () => {
      const root = document.getElementById('yt-dl-panel-root');
      if (isVideoPage()) {
        if (!root) {
          mountUI();
        } else if (window.__YT_DL_API__?.onNavigate) {
          window.__YT_DL_API__.onNavigate();
        }
      } else if (root) {
        root.remove();
        window.__YT_DL_API__ = null;
      }
    };
    syncMount();
    watchUrlChange(syncMount, 1500);
  }
  waitAndMount();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'YT_DL_BG_LOG') {
      if (typeof debugLog === 'function') {
        debugLog(msg.step || 'bg', msg.msg || '');
      } else {
        console.log('[YtDL:bg→content]', msg.step, msg.msg);
      }
      return;
    }
    if (msg?.type === 'YT_DL_BG_PROGRESS') {
      lastBgProgress = {
        step: msg.step || 'download',
        received: Number(msg.received) || 0,
        total: Number(msg.total) || 0,
        percent: Number(msg.percent) || 0,
        at: Date.now()
      };
      if (typeof updateProgress === 'function') {
        updateProgress(msg.step || 'download', msg.percent, msg.received, msg.total);
      }
      return;
    }

    const api = window.__YT_DL_API__;
    if (!api) {
      sendResponse({ ok: false, error: '页面未就绪，请刷新后重试' });
      return;
    }
    if (msg.type === 'YT_DL_GET_INFO') {
      api.fetchSnapshot()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg.type === 'YT_DL_OPEN_PANEL') {
      api.openPanel()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
  });
})();

