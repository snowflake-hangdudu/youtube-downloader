/**
 * YouTube 下载 — 页面内下载代理（MAIN world）骨架
 * 协议与 bilibili-downloader 对齐；下载 / 清晰度解析待实现。
 */
(function () {
  'use strict';
  if (window.__YT_DL_AGENT__) return;
  window.__YT_DL_AGENT__ = true;

  const PANEL = 'yt-dl-panel';
  const AGENT = 'yt-dl-agent';

  function reply(id, payload) {
    window.postMessage({ source: AGENT, id, ...payload }, '*');
  }

  function log(step, msg) {
    reply(null, { type: 'LOG', step, msg });
    console.log('[YtDL-Agent]', step, msg);
  }

  function formatDownloadError(err) {
    const msg = err?.message || String(err);
    return msg;
  }

  /** 从 URL 解析 videoId */
  function parseVideoId(href) {
    try {
      const u = new URL(href || location.href);
      if (u.hostname.includes('youtu.be')) {
        const id = u.pathname.replace(/^\//, '').split('/')[0];
        return id ? { videoId: id } : null;
      }
      if (u.pathname.startsWith('/shorts/')) {
        const id = u.pathname.split('/')[2];
        return id ? { videoId: id } : null;
      }
      if (u.pathname === '/watch' || u.pathname.startsWith('/watch')) {
        const id = u.searchParams.get('v');
        return id ? { videoId: id } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  function readPlayerResponse() {
    if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
      return window.ytInitialPlayerResponse;
    }
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const t = s.textContent || '';
        const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/);
        if (m) {
          return JSON.parse(m[1]);
        }
      }
    } catch (_) {}
    return null;
  }

  /**
   * 返回与 content.js 兼容的 info（暂用 videoId 填充 aid/cid，便于复用 UI）
   */
  async function resolveVideo(href, _pageIndex) {
    const idInfo = parseVideoId(href);
    if (!idInfo?.videoId) throw new Error('不是有效的 YouTube 视频页');

    const videoId = idInfo.videoId;
    const pr = readPlayerResponse();
    const vd = pr?.videoDetails;
    const title = vd?.title || document.title?.replace(/\s*-\s*YouTube\s*$/, '') || videoId;
    const author = vd?.author || '';
    const thumbs = vd?.thumbnail?.thumbnails || [];
    const pic = thumbs.length ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    const duration = Number(vd?.lengthSeconds) || 0;
    const view = Number(vd?.viewCount) || 0;

    return {
      videoId,
      // 兼容 bilibili UI 字段名，后续实现下载时再统一改为 videoId
      bvid: videoId,
      aid: videoId,
      cid: videoId,
      title,
      author,
      pic,
      view,
      pubdate: 0,
      duration,
      pages: [{ page: 1, part: title, cid: videoId }],
      _stub: true
    };
  }

  async function getQualities(_aid, _cid) {
    // TODO: 解析 streamingData.adaptiveFormats / formats
    return {
      qualities: [],
      maxQn: 0,
      maxLabel: '—',
      loginHint: '骨架已就绪：清晰度与下载逻辑待实现'
    };
  }

  async function estimateDownloadSize() {
    return { sizeBytes: 0, sizeLabel: '—', estimateNote: '预估体积待实现' };
  }

  async function handleDownload() {
    throw new Error('下载功能尚未实现');
  }

  function pauseDownloadControl() {
    log('控制', 'PAUSE（骨架无操作）');
  }
  function resumeDownloadControl() {
    log('控制', 'RESUME（骨架无操作）');
  }
  function cancelDownloadControl() {
    log('控制', 'CANCEL（骨架无操作）');
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== PANEL) return;
    const { id, type } = e.data;

    try {
      switch (type) {
        case 'PARSE_URL':
          reply(id, { type: 'OK', data: { idInfo: parseVideoId(e.data.href) } });
          break;
        case 'RESOLVE_VIDEO':
          reply(id, { type: 'OK', data: { info: await resolveVideo(e.data.href, e.data.pageIndex || 0) } });
          break;
        case 'GET_QUALITIES':
          reply(id, { type: 'OK', data: await getQualities(e.data.aid, e.data.cid) });
          break;
        case 'GET_ESTIMATE':
          reply(id, {
            type: 'OK',
            data: await estimateDownloadSize(e.data.aid, e.data.cid, e.data.qn, e.data.duration)
          });
          break;
        case 'START_DOWNLOAD': {
          const result = await handleDownload(e.data.aid, e.data.cid, e.data.qn, e.data.title);
          reply(id, { type: 'OK', data: result });
          break;
        }
        case 'PAUSE_DOWNLOAD':
          pauseDownloadControl();
          break;
        case 'RESUME_DOWNLOAD':
          resumeDownloadControl();
          break;
        case 'CANCEL_DOWNLOAD':
          cancelDownloadControl();
          break;
        default:
          reply(id, { type: 'ERR', error: '未知请求: ' + type });
      }
    } catch (err) {
      reply(id, { type: 'ERR', error: formatDownloadError(err) });
    }
  });

  log('初始化', '页面代理已就绪 (MAIN world · 骨架)');
})();
