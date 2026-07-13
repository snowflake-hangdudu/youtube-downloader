(function () {
  'use strict';

  if (window.__YT_DL_INIT__) return;
  window.__YT_DL_INIT__ = true;

  const PANEL = 'yt-dl-panel';
  const AGENT = 'yt-dl-agent';
  const VERSION = chrome.runtime.getManifest().version;
  const ICON_URL = chrome.runtime.getURL('icons/icon128.png');
  const FAQ_URL = 'https://snowflake-hangdudu.github.io/youtube-downloader/faq.html';

  let muxReadyPromise = null;

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
    if (/合并库|合并模块|mp4-remux|YtM4sMux|未加载/.test(m)) {
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
    muxReadyPromise = loadScript('mp4-remux.iife.js').then(() => loadScript('m4s-mux.js'));
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
  async function mergeBuffersViaPage(videoBuffer, audioBuffer) {
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
      { videoBuffer: videoBuf, audioBuffer: audioBuf },
      transfer
    );
    if (!merged?.blob || merged.blob.size < 50 * 1024) {
      throw new Error('合并结果过小');
    }
    return merged.blob;
  }

  function downloadBlob(blob, filename) {
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
  let queueRunning = false;
  let queueCancelled = false;

  /** YouTube view API：pages.length > 1 且每 P 有 cid 才是真·多 P */
  function isMultiPartVideo(pages) {
    return Array.isArray(pages) && pages.length > 1 && pages.every((p) => p && p.cid);
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

            <details id="yt-dl-debug" class="yt-dl-debug" open>
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
    const DEBUG_MAX = 300;

    function setQueueLabel(count) {
      queueLabelEl.textContent = count > 1 ? `队列下载全部 ${count} 个分 P` : '队列下载全部分 P';
    }

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
      queue: '分 P 队列下载'
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
      if (!qualities.length) {
        pillsEl.innerHTML = '<span class="yt-dl-pill disabled">无可用清晰度</span>';
        selectedQn = 0;
        return;
      }
      if (!qualities.some((q) => q.qn === selectedQn)) {
        selectedQn = qualities[0].qn;
      }
      pillsEl.innerHTML = qualities.map((q) =>
        `<button type="button" class="yt-dl-pill${q.qn === selectedQn ? ' active' : ''}" data-qn="${q.qn}" title="${q.mode || ''}">${q.label}${q.mode === 'hls' ? ' HLS' : ''}</button>`
      ).join('');
      pillsEl.querySelectorAll('.yt-dl-pill[data-qn]').forEach((btn) => {
        btn.onclick = () => {
          selectedQn = +btn.dataset.qn;
          pillsEl.querySelectorAll('.yt-dl-pill').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          refreshEstimate();
        };
      });
      refreshEstimate();
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

        debugLog('加载', `${videoInfo.aid}/${videoInfo.cid} · ${snap.qualities.map((q) => q.label).join(', ')}`);
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
      }
    }

    function getSelectedQualityLabel() {
      return qualities.find((q) => q.qn === selectedQn)?.label || '';
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
      return resp;
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
      let ticks = 0;
      const hb = setInterval(() => {
        ticks += 1;
        debugLog('bg', `${step || 'download'} 进行中… ${ticks * 8}s（进度条应在涨；若长时间不动会自动换线路）`);
      }, 8000);
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
      debugLog(
        'bg',
        `${step || 'download'} 完成 · ${((resp.buffer?.byteLength || resp.size || 0) / 1024 / 1024).toFixed(1)}MB`
      );
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
          `视频已就绪 ${(result.videoBytes / 1024 / 1024).toFixed(1)}MB，改 background 拉音频`
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
          if (!aResp.buffer || aResp.buffer.byteLength < 1024) {
            throw new Error('background 音频过小');
          }
          updateProgress('merge', 5);
          await setupMuxInPage();
          const transfer = [];
          if (aResp.buffer instanceof ArrayBuffer) transfer.push(aResp.buffer);
          const merged = await agentCall(
            'MERGE_PENDING_VIDEO',
            {
              audioBuffer: aResp.buffer,
              filename: result.filename || 'youtube.mp4'
            },
            transfer
          );
          updateProgress('save', 100);
          return { merged: true, bytes: merged?.size || 0, via: 'bg-audio' };
        } catch (e) {
          console.warn('[YtDL:content] background 音频也失败，仅存视频', e);
          debugLog('音频', 'background 也失败，仅保存视频轨: ' + (e.message || e));
          try {
            await agentCall('SAVE_PENDING_VIDEO', {
              filename: result.videoOnlyFilename || 'video.mp4'
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
          const vResp = await bgFetch(
            result.videoUrls || [],
            result.videoOnlyFilename || 'video.mp4',
            'video',
            ua,
            result.itag || null
          );
          if (vResp.mode === 'downloads') {
            if ((vResp.size || 0) < 50 * 1024) throw new Error('视频文件过小');
            return { via: 'downloads', downloadId: vResp.downloadId };
          }
          if (!vResp.buffer || vResp.buffer.byteLength < 50 * 1024) {
            throw new Error('视频数据过小（' + (vResp.buffer?.byteLength || 0) + ' bytes）');
          }

          if (!(result.audioUrls || []).length) {
            const vBlob = new Blob([vResp.buffer], { type: 'video/mp4' });
            await downloadBlob(vBlob, result.videoOnlyFilename || result.filename || 'video.mp4');
            updateProgress('save', 100);
            return { videoOnly: true };
          }

          updateProgress('audio', 0);
          let aResp;
          try {
            aResp = await bgFetch(result.audioUrls, 'audio.m4a', 'audio', ua, result.audioItag || null);
          } catch (e) {
            console.warn('[YtDL:content] 音频失败，仅存视频轨', e);
            const vBlob = new Blob([vResp.buffer], { type: 'video/mp4' });
            await downloadBlob(vBlob, result.videoOnlyFilename || 'video.mp4');
            updateProgress('save', 100);
            return { videoOnly: true };
          }

          if (aResp.mode === 'downloads' || !aResp.buffer || aResp.buffer.byteLength < 1024) {
            const vBlob = new Blob([vResp.buffer], { type: 'video/mp4' });
            await downloadBlob(vBlob, result.videoOnlyFilename || 'video.mp4');
            updateProgress('save', 100);
            return { videoOnly: true };
          }

          const totalBytes = vResp.buffer.byteLength + aResp.buffer.byteLength;
          updateProgress('merge', 5, totalBytes, totalBytes);
          debugLog(
            '合并',
            `页面合成（零拷贝移交）· 视频 ${(vResp.buffer.byteLength / 1024 / 1024).toFixed(1)}MB + 音频 ${(aResp.buffer.byteLength / 1024 / 1024).toFixed(1)}MB`
          );
          const mergedBlob = await mergeBuffersViaPage(vResp.buffer, aResp.buffer);
          updateProgress('save', 95);
          await downloadBlob(mergedBlob, result.filename || 'youtube.mp4');
          updateProgress('save', 100);
          return { merged: true, bytes: mergedBlob.size };
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
          if ((resp.size || 0) < 50 * 1024) {
            throw new Error('浏览器下载文件过小（' + (resp.size || 0) + ' bytes），已视为失败');
          }
          updateProgress('save', 100);
          return { dash: false, via: 'downloads', downloadId: resp.downloadId, size: resp.size };
        }
        if (!resp.buffer || resp.buffer.byteLength < 50 * 1024) {
          throw new Error(
            '后台返回数据过小（' + (resp.buffer?.byteLength || 0) + ' bytes），拒绝保存空文件'
          );
        }
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
      if (!selectedQn || !videoInfo || queueRunning) return;
      if (!(await ensureMuxReady())) return;

      startBtn.disabled = true;
      queueBtn.disabled = true;
      startBtn.textContent = '下载中…';
      statusEl.classList.add('hidden');
      showProgressStart();
      debugLog('下载', `qn=${selectedQn}`);

      try {
        const result = await runSingleDownload(videoInfo);
        hideProgress();
        if (result.videoOnly) {
          showStatus(
            'success',
            result.audioFailed
              ? '视频已保存（无声音）。音频轨下载失败，可改较低清晰度重试'
              : '已下载视频轨（无音频）'
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
          showStatus('success', '下载完成，已保存为 MP4');
        }
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
      } finally {
        startBtn.disabled = false;
        queueBtn.disabled = false;
        startBtn.innerHTML = btnDefaultHtml;
      }
    }

    async function startQueueDownload() {
      if (!selectedQn || !videoInfo || !isMultiPartVideo(videoInfo.pages) || queueRunning) return;
      if (!(await ensureMuxReady())) return;

      const total = videoInfo.pages.length;
      queueRunning = true;
      queueCancelled = false;
      startBtn.disabled = true;
      queueBtn.disabled = true;
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
    }

    toggleBtn.onclick = async () => {
      isOpen = !isOpen;
      menu.classList.toggle('hidden', !isOpen);
      if (isOpen) await loadVideoInfo();
    };
    closeBtn.onclick = () => { isOpen = false; menu.classList.add('hidden'); };
    startBtn.onclick = startDownload;
    queueBtn.onclick = startQueueDownload;

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
    if (msg?.type === 'YT_DL_BG_PROGRESS') {
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

