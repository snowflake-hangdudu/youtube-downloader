/**
 * YouTube 下载 — 页面内下载代理（MAIN world）
 * 第一步：可靠读取视频元信息（标题/作者/封面/时长/播放量）
 * 清晰度与下载待后续实现。
 */
(function () {
  'use strict';
  if (window.__YT_DL_AGENT__) return;
  window.__YT_DL_AGENT__ = true;

  const PANEL = 'yt-dl-panel';
  const AGENT = 'yt-dl-agent';

  /** 播放器真实请求过的 googlevideo（n 已有效） */
  const gvCapture = {
    byItag: new Map(), // string itag -> string[] urls
    all: [], // { url, itag, mime, at }[]
    maxAll: 120
  };

  /** itag 可能在 query 或 path：/itag/136/ */
  function extractItagFromUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      let itag = u.searchParams.get('itag');
      if (itag) return String(itag);
      const m =
        u.pathname.match(/\/itag\/(\d+)/i) ||
        String(rawUrl).match(/[/]itag[/](\d+)/i) ||
        String(rawUrl).match(/[?&]itag[=/](\d+)/i);
      return m ? String(m[1]) : null;
    } catch {
      const m = String(rawUrl).match(/[/?&]itag[=/](\d+)/i);
      return m ? String(m[1]) : null;
    }
  }

  function extractMimeFromUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      let mime = u.searchParams.get('mime');
      if (mime) return mime.toLowerCase();
      const m = u.pathname.match(/\/mime\/([^/]+)/i);
      if (m) return decodeURIComponent(m[1]).toLowerCase().replace(/%2f/gi, '/');
    } catch (_) {}
    return '';
  }

  function rememberGvUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    // videoplayback / initplayback；或 path 带 itag 的 googlevideo
    const isGv = /googlevideo\.com/i.test(rawUrl);
    if (!isGv) return;
    const isMedia =
      /\/videoplayback/i.test(rawUrl) ||
      /\/initplayback/i.test(rawUrl) ||
      /\/itag\/\d+/i.test(rawUrl) ||
      /[?&]itag=\d+/i.test(rawUrl);
    if (!isMedia) return;

    let clean = rawUrl;
    let itag = extractItagFromUrl(rawUrl);
    const mime = extractMimeFromUrl(rawUrl);
    try {
      const u = new URL(rawUrl);
      u.searchParams.delete('range');
      u.searchParams.delete('rn');
      u.searchParams.delete('rbuf');
      clean = u.toString();
    } catch {
      return;
    }
    const at = Date.now();
    // 去重：同 clean 不重复堆
    if (gvCapture.all[0]?.url === clean) return;
    gvCapture.all.unshift({ url: clean, itag, mime, at });
    if (gvCapture.all.length > gvCapture.maxAll) gvCapture.all.length = gvCapture.maxAll;
    if (itag) {
      let list = gvCapture.byItag.get(itag);
      if (!list) {
        list = [];
        gvCapture.byItag.set(itag, list);
      }
      if (!list.includes(clean)) list.unshift(clean);
      if (list.length > 10) list.length = 10;
    }
  }

  /** document_start 尽早挂钩，避免漏掉播放器首包 */
  function installNetworkHooks() {
    if (window.__YT_DL_NET_HOOK__) return;
    window.__YT_DL_NET_HOOK__ = true;

    try {
      const nativeFetch = window.fetch;
      if (typeof nativeFetch === 'function') {
        window.fetch = function ytDlFetchHook(input, init) {
          try {
            const url = typeof input === 'string' ? input : input && input.url;
            if (url) rememberGvUrl(url);
          } catch (_) {}
          const ret = nativeFetch.apply(this, arguments);
          if (ret && typeof ret.then === 'function') {
            return ret.then((res) => {
              try {
                if (res && res.url) rememberGvUrl(res.url);
              } catch (_) {}
              return res;
            });
          }
          return ret;
        };
      }
    } catch (_) {}

    try {
      const xo = XMLHttpRequest.prototype.open;
      const xs = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          this.__ytDlUrl = url;
        } catch (_) {}
        return xo.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        try {
          if (this.__ytDlUrl) rememberGvUrl(String(this.__ytDlUrl));
        } catch (_) {}
        return xs.apply(this, arguments);
      };
    } catch (_) {}

    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e && e.name) rememberGvUrl(e.name);
        }
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (_) {}

    console.log('[YtDL-Agent]', '网络钩子', 'fetch/XHR/PerformanceObserver 已安装');
  }

  installNetworkHooks();

  function reply(id, payload) {
    window.postMessage({ source: AGENT, id, ...payload }, '*');
  }

  function log(step, msg) {
    reply(null, { type: 'LOG', step, msg });
    console.log('[YtDL-Agent]', step, msg);
  }

  function formatDownloadError(err) {
    const msg = err?.message || String(err);
    if (msg === '下载已取消') return msg;
    if (/合并库|合并模块|mp4-remux|YtM4sMux|YtWebmMux|未加载/.test(msg)) {
      return '请刷新页面后重试';
    }
    if (/bot|机器人|LOGIN_REQUIRED|Sign in|不是机器人/i.test(msg)) {
      return '请登录并完成 YouTube「确认你不是机器人」，F5 后再试';
    }
    if (/未捕获|请.*播放|请先播放|无下载地址|无可用地址|嗅探/.test(msg)) {
      return '请先播放目标清晰度 5～10 秒，再点下载';
    }
    if (/文件过大|改选较低/.test(msg)) {
      return '文件过大，请改选较低清晰度（如 720P）';
    }
    if (/signatureCipher|cipher|签名解密/.test(msg)) {
      return '该清晰度暂不可下，请改选其它清晰度（如 720P）';
    }
    if (/WebM|AV1/.test(msg)) {
      return '当前格式暂不支持，请改选其它清晰度后重试';
    }
    if (/403|HTTP 4|过小|空壳|疑似|背景.*失败|background/i.test(msg)) {
      return '下载失败。请先播放 5～10 秒，或改选 720P 后重试';
    }
    if (/超时|timeout/i.test(msg)) {
      return '请求超时，请刷新页面后重试';
    }
    // 已含短指引的原文直接透出
    if (/请先|请改选|请刷新|F5|720P/.test(msg) && msg.length < 90) {
      return msg;
    }
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
        const id = u.pathname.split('/').filter(Boolean)[1];
        return id ? { videoId: id } : null;
      }
      if (u.pathname === '/watch' || u.pathname.startsWith('/watch')) {
        const id = u.searchParams.get('v');
        return id ? { videoId: id } : null;
      }
      // 嵌入页
      if (u.pathname.startsWith('/embed/')) {
        const id = u.pathname.split('/')[2];
        return id ? { videoId: id } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 获取 playerResponse（按可靠度排序）
   * 1) #movie_player.getPlayerResponse() — SPA 切视频后也准
   * 2) window.ytInitialPlayerResponse — 首屏注入
   * 3) 页面内联 script 里的赋值（兜底）
   */
  function readPlayerResponse() {
    try {
      const player =
        document.getElementById('movie_player') ||
        document.querySelector('.html5-video-player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const pr = player.getPlayerResponse();
        if (pr?.videoDetails) return pr;
      }
    } catch (_) {}

    if (window.ytInitialPlayerResponse?.videoDetails) {
      return window.ytInitialPlayerResponse;
    }

    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (!t.includes('ytInitialPlayerResponse')) continue;
        const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\})\s*;/);
        if (!m) continue;
        try {
          const pr = JSON.parse(m[1]);
          if (pr?.videoDetails) return pr;
        } catch (_) {}
      }
    } catch (_) {}

    return null;
  }

  function metaContent(sel) {
    const el = document.querySelector(sel);
    return el?.getAttribute('content') || el?.textContent || '';
  }

  function pickThumb(thumbs, videoId) {
    if (Array.isArray(thumbs) && thumbs.length) {
      return thumbs[thumbs.length - 1].url || thumbs[0].url;
    }
    return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '';
  }

  /**
   * 解析视频信息。优先 playerResponse，再用 DOM/meta 兜底。
   */
  async function resolveVideo(href, _pageIndex) {
    const idInfo = parseVideoId(href);
    if (!idInfo?.videoId) throw new Error('不是有效的 YouTube 视频页');

    const videoId = idInfo.videoId;
    const pr = readPlayerResponse();
    const vd = pr?.videoDetails;

    // SPA 时 ytInitialPlayerResponse 可能仍是上一个视频，以 URL 的 videoId 为准校验
    const prId = vd?.videoId;
    const prOk = vd && (!prId || prId === videoId);

    let title = '';
    let author = '';
    let pic = '';
    let duration = 0;
    let view = 0;

    if (prOk) {
      title = vd.title || '';
      author = vd.author || '';
      pic = pickThumb(vd.thumbnail?.thumbnails, videoId);
      duration = Number(vd.lengthSeconds) || 0;
      view = Number(vd.viewCount) || 0;
    }

    // DOM / Open Graph 兜底（不依赖 player 对象）
    if (!title) {
      title =
        metaContent('meta[property="og:title"]') ||
        metaContent('meta[name="title"]') ||
        document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
        document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim() ||
        videoId;
    }
    if (!author) {
      author =
        document.querySelector('#channel-name a')?.textContent?.trim() ||
        document.querySelector('ytd-channel-name a')?.textContent?.trim() ||
        metaContent('link[itemprop="name"]') ||
        '';
    }
    if (!pic) {
      pic =
        metaContent('meta[property="og:image"]') ||
        pickThumb(null, videoId);
    }
    if (!view) {
      const viewText =
        document.querySelector('ytd-watch-info-text #tooltip')?.textContent ||
        document.querySelector('#info-container ytd-watch-info-text')?.textContent ||
        '';
      const m = viewText.replace(/,/g, '').match(/([\d.]+)\s*([万亿KMB]?)/i);
      // 仅作展示；解析失败就保持 0
      if (m && /^\d/.test(viewText.trim())) {
        // YouTube 中文页常见「1,234 次观看」，英文 "1,234 views"
        const num = viewText.replace(/,/g, '').match(/(\d+)/);
        if (num) view = Number(num[1]) || 0;
      }
    }

    log('解析', `${videoId} · ${title.slice(0, 40)}${prOk ? '' : '（DOM兜底）'}`);

    return {
      videoId,
      // 兼容现有 content.js 字段（aid/cid 暂等于 videoId）
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
      source: prOk ? 'playerResponse' : 'dom'
    };
  }

  /**
   * 从 streamingData 收集清晰度列表。
   *
   * 2024+ 现状（重要）：
   * - WEB 播放器常只剩 progressive 360P + SABR（adaptive 无 url）→ 看起来「只有 360P」
   * - 登录也救不了 WEB 的 HTTPS 直链
   * - 需用 InnerTube 其它客户端拉流；优先 ANDROID_VR（无需 PO Token，仍返回经典 URL）
   * - 不能本地「生成」更高清晰度，只能下载平台已有编码
   */
  function isVideoFormat(f) {
    const mime = f?.mimeType || '';
    if (mime.startsWith('audio/')) return false;
    if (mime.startsWith('video/')) return !!(f.height || f.qualityLabel);
    return !!(f?.qualityLabel || f?.height);
  }

  function isAudioFormat(f) {
    const mime = f?.mimeType || '';
    return mime.startsWith('audio/');
  }

  function hasDrm(f) {
    return !!(f?.drmFamilies && f.drmFamilies.length);
  }

  /**
   * 解析可请求的媒体 URL。
   * kind: url | cipher_url | cipher_need_s | none | cipher_broken
   */
  function resolveFormatUrl(f) {
    if (f?.url) return { url: f.url, kind: 'url' };
    const raw = f?.signatureCipher || f?.cipher;
    if (!raw) return { url: null, kind: 'none' };
    try {
      const params = new URLSearchParams(raw);
      const u = params.get('url');
      if (!u) return { url: null, kind: 'cipher_broken' };
      if (params.get('s')) return { url: null, kind: 'cipher_need_s', base: u };
      return { url: u, kind: 'cipher_url' };
    } catch (_) {
      return { url: null, kind: 'cipher_broken' };
    }
  }

  function canAccess(f) {
    return !!resolveFormatUrl(f).url;
  }

  function hydrateFormatUrl(f) {
    if (!f) return f;
    const r = resolveFormatUrl(f);
    if (r.url && !f.url) f.url = r.url;
    return f;
  }

  function formatHeight(f) {
    const h = Number(f.height) || 0;
    if (h) return h;
    const fromLabel = parseInt(String(f.qualityLabel || ''), 10);
    if (fromLabel) return fromLabel;
    const q = String(f.quality || '').toLowerCase();
    const map = {
      tiny: 144,
      small: 240,
      medium: 360,
      large: 480,
      hd720: 720,
      hd1080: 1080,
      hd1440: 1440,
      hd2160: 2160,
      highres: 2160
    };
    return map[q] || 0;
  }

  function normalizeLabel(f) {
    const raw = f.qualityLabel ? String(f.qualityLabel) : '';
    if (raw) return raw.replace(/(\d)p/i, '$1P');
    const h = formatHeight(f);
    if (!h) return '未知';
    return f.fps > 30 ? h + 'P' + f.fps : h + 'P';
  }

  function codecPrefer(mimeType) {
    const mime = mimeType || '';
    if (mime.includes('avc1') || (mime.includes('mp4') && !mime.includes('av01'))) return 2;
    if (mime.includes('vp9') || mime.includes('webm')) return 1;
    if (mime.includes('av01')) return 0;
    return 0;
  }

  function readYtcfg() {
    try {
      const cfg = window.ytcfg;
      if (!cfg) return {};
      const get = (k) => {
        try {
          if (typeof cfg.get === 'function') return cfg.get(k);
        } catch (_) {}
        return cfg.data_?.[k];
      };
      return {
        apiKey: get('INNERTUBE_API_KEY') || '',
        visitorData: get('VISITOR_DATA') || '',
        context: get('INNERTUBE_CONTEXT') || null,
        sts: get('STS') || get('SIGNATURE_TIMESTAMP') || null
      };
    } catch (_) {
      return {};
    }
  }

  /** 与 yt-dlp INNERTUBE_CLIENTS 对齐的可用客户端（优先无 PO Token） */
  const INNERTUBE_CLIENTS = [
    {
      // 复用当前页已过 bot 的 WEB 会话（对抗 LOGIN_REQUIRED）
      key: 'web_page',
      id: 1,
      usePageContext: true,
      credentials: 'include',
      client: {
        clientName: 'WEB',
        clientVersion: '2.20260708.00.00'
      }
    },
    {
      // yt-dlp：web_safari 提供预合并 HLS（91–96≈144–1080），优先尝试
      key: 'web_safari',
      id: 1,
      credentials: 'include',
      client: {
        clientName: 'WEB',
        clientVersion: '2.20260708.00.00',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)'
      }
    },
    {
      key: 'android_vr',
      id: 28,
      credentials: 'omit',
      client: {
        clientName: 'ANDROID_VR',
        // >1.65 易只返回 SABR（无 https url）；钉死 1.65.10
        clientVersion: '1.65.10',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        androidSdkVersion: 32,
        userAgent:
          'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        osName: 'Android',
        osVersion: '12L'
      }
    },
    {
      // 再试稍旧 VR，有时更高清仍给 url
      key: 'android_vr_old',
      id: 28,
      credentials: 'omit',
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.60.19',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 2',
        androidSdkVersion: 29,
        userAgent:
          'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 11; hollywood-user Build/RQ1A) gzip',
        osName: 'Android',
        osVersion: '11'
      }
    },
    {
      key: 'tv',
      id: 7,
      credentials: 'include',
      client: {
        clientName: 'TVHTML5',
        clientVersion: '7.20260707.07.00',
        userAgent:
          'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)'
      }
    },
    {
      key: 'tv_simply',
      id: 75,
      credentials: 'omit',
      client: {
        clientName: 'TVHTML5_SIMPLY',
        clientVersion: '1.0'
      }
    },
    {
      key: 'mweb',
      id: 2,
      credentials: 'include',
      client: {
        clientName: 'MWEB',
        clientVersion: '2.20260708.05.00',
        userAgent:
          'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)'
      }
    },
    {
      // 嵌入播放器有时仍给 progressive / adaptive https url
      key: 'web_embedded',
      id: 56,
      credentials: 'omit',
      client: {
        clientName: 'WEB_EMBEDDED_PLAYER',
        clientVersion: '1.20270708.01.00',
        userAgent: navigator.userAgent
      }
    },
    {
      key: 'ios',
      id: 5,
      credentials: 'omit',
      client: {
        clientName: 'IOS',
        clientVersion: '19.45.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        userAgent:
          'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
        osName: 'iPhone',
        osVersion: '18.1.0'
      }
    },
    {
      key: 'android',
      id: 3,
      credentials: 'omit',
      client: {
        clientName: 'ANDROID',
        clientVersion: '21.26.364',
        androidSdkVersion: 30,
        userAgent: 'com.google.android.youtube/21.26.364 (Linux; U; Android 11) gzip',
        osName: 'Android',
        osVersion: '11'
      }
    }
  ];

  function mergeStreamingData(list) {
    const formats = [];
    const adaptiveFormats = [];
    const seen = new Set();
    const pushAll = (arr, dest, clientKey, clientUA) => {
      for (const raw of arr || []) {
        const f = clientKey
          ? { ...raw, _fromClient: clientKey, ...(clientUA ? { _clientUA: clientUA } : {}) }
          : { ...raw };
        const key = [f.itag, f.bitrate, f.height, f.mimeType, f.qualityLabel, f._fromClient || ''].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        dest.push(f);
      }
    };
    for (const item of list) {
      if (!item) continue;
      if (item.__bundle) {
        pushAll(item.formats, formats, item.client, item.clientUA);
        pushAll(item.adaptiveFormats, adaptiveFormats, item.client, item.clientUA);
      } else {
        pushAll(item.formats, formats, item._client || null, item._clientUA || null);
        pushAll(item.adaptiveFormats, adaptiveFormats, item._client || null, item._clientUA || null);
      }
    }
    return { formats, adaptiveFormats };
  }

  function collectPageStreamingData() {
    const out = [];
    try {
      const player =
        document.getElementById('movie_player') ||
        document.querySelector('.html5-video-player');
      const pr = player?.getPlayerResponse?.();
      if (pr?.streamingData) out.push(pr.streamingData);
    } catch (_) {}
    if (window.ytInitialPlayerResponse?.streamingData) {
      out.push(window.ytInitialPlayerResponse.streamingData);
    }
    return out;
  }

  function countAccessibleVideo(sd) {
    let n = 0;
    let maxH = 0;
    for (const f of [...(sd.formats || []), ...(sd.adaptiveFormats || [])]) {
      if (!isVideoFormat(f) || hasDrm(f)) continue;
      hydrateFormatUrl(f);
      if (!canAccess(f)) continue;
      n++;
      maxH = Math.max(maxH, formatHeight(f));
    }
    return { n, maxH };
  }

  async function fetchInnertubePlayer(videoId, preset) {
    const { apiKey, sts, visitorData, context: pageCtx } = readYtcfg();
    // WEB 页内的 apiKey；visitorData 对抗 “Sign in to confirm you're not a bot”
    const key = apiKey || 'AIzaSyA8eiZmM1FaDVjRy1bhOY3dPt5iiza21MY';
    const pageClient = pageCtx?.client || {};
    const client = {
      hl: pageClient.hl || 'zh-CN',
      gl: pageClient.gl || 'CN',
      ...preset.client
    };
    if (visitorData) client.visitorData = visitorData;
    else if (pageClient.visitorData) client.visitorData = pageClient.visitorData;

    // 尽量复用页面已验证的 Innertube 会话（WEB 系）
    let context;
    if (preset.usePageContext && pageCtx) {
      context = {
        ...pageCtx,
        client: { ...pageClient, ...preset.client, visitorData: client.visitorData }
      };
    } else {
      context = { client };
      if (pageCtx?.user) context.user = pageCtx.user;
    }

    const body = {
      context,
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {
        contentPlaybackContext: {
          html5Preference: 'HTML5_PREF_WANTS',
          ...(sts ? { signatureTimestamp: Number(sts) } : {})
        }
      }
    };

    const url =
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=' +
      encodeURIComponent(key);

    const headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': String(preset.id),
      'X-YouTube-Client-Version': preset.client.clientVersion || pageClient.clientVersion || '',
      'User-Agent': preset.client.userAgent || navigator.userAgent
    };
    if (client.visitorData) headers['X-Goog-Visitor-Id'] = client.visitorData;

    // 页面会话客户端必须带 cookie，否则易 LOGIN_REQUIRED / bot
    const credentials =
      preset.usePageContext || preset.key === 'web_safari' || preset.key === 'mweb' || preset.key === 'tv'
        ? 'include'
        : preset.credentials || 'omit';

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      credentials
    });

    if (!res.ok) {
      log('InnerTube', `${preset.key} HTTP ${res.status}`);
      return null;
    }

    const json = await res.json();
    const status = json?.playabilityStatus?.status || '?';
    const reason = json?.playabilityStatus?.reason || '';
    const nFmt = json?.streamingData?.formats?.length || 0;
    const nAdp = json?.streamingData?.adaptiveFormats?.length || 0;
    const hls = json?.streamingData?.hlsManifestUrl ? 1 : 0;
    const dash = json?.streamingData?.dashManifestUrl ? 1 : 0;
    const acc = countAccessibleVideo(json?.streamingData || {});
    log(
      'InnerTube',
      `${preset.key} status=${status} formats=${nFmt} adaptive=${nAdp} hls=${hls} dash=${dash} usable=${acc.n} maxH=${acc.maxH}` +
        (visitorData ? ' pot=visitor' : ' pot=none') +
        (reason ? ` reason=${reason}` : '')
    );
    if (status === 'LOGIN_REQUIRED' || /not a bot/i.test(reason)) {
      log(
        'InnerTube',
        `${preset.key} 被 bot 校验拦截。若已登录仍失败，请在 YouTube 完成人机验证后 F5 再试`
      );
    }
    return json;
  }

  function resolveUrl(base, rel) {
    try {
      return new URL(rel, base).toString();
    } catch {
      return rel;
    }
  }

  function guessHeightFromItag(itag) {
    const map = {
      91: 144,
      92: 240,
      93: 360,
      94: 480,
      95: 720,
      96: 1080,
      300: 720,
      301: 1080
    };
    return map[Number(itag)] || 0;
  }

  /** 解析 HLS master playlist → variants */
  function parseMasterPlaylist(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/);
    const raw = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const info = line.slice('#EXT-X-STREAM-INF:'.length);
      const resM = info.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bwM = info.match(/BANDWIDTH=(\d+)/i);
      let mediaUrl = '';
      for (let j = i + 1; j < lines.length; j++) {
        const n = lines[j].trim();
        if (!n || n.startsWith('#')) continue;
        mediaUrl = n;
        break;
      }
      if (!mediaUrl) continue;
      const abs = resolveUrl(baseUrl, mediaUrl);
      let itag = null;
      const im = abs.match(/[/]itag[/](\d+)/) || abs.match(/[?&]itag=(\d+)/);
      if (im) itag = Number(im[1]);
      const height = resM ? parseInt(resM[2], 10) : guessHeightFromItag(itag);
      const width = resM ? parseInt(resM[1], 10) : 0;
      raw.push({
        height,
        width,
        bandwidth: bwM ? Number(bwM[1]) : 0,
        url: abs,
        itag,
        codecs: (info.match(/CODECS="([^"]+)"/i) || [])[1] || ''
      });
    }
    const byH = new Map();
    for (const v of raw) {
      if (!v.height) continue;
      const prev = byH.get(v.height);
      if (!prev || v.bandwidth > prev.bandwidth) byH.set(v.height, v);
    }
    return [...byH.values()].sort((a, b) => b.height - a.height);
  }

  function parseMediaPlaylist(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/);
    let initUrl = null;
    const segments = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-MAP:')) {
        const um = line.match(/URI="([^"]+)"/i);
        if (um) initUrl = resolveUrl(baseUrl, um[1]);
        continue;
      }
      if (!line || line.startsWith('#')) continue;
      segments.push(resolveUrl(baseUrl, line));
    }
    return { initUrl, segments };
  }

  async function fetchTextUrl(url, label) {
    log('HLS', `拉取${label || ''} ${String(url).slice(0, 96)}…`);
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      referrer: 'https://www.youtube.com/',
      referrerPolicy: 'origin-when-cross-origin'
    });
    if (!res.ok) throw new Error(`HLS ${label || ''} HTTP ${res.status}`);
    return res.text();
  }

  async function fetchBinaryUrl(url) {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      referrer: 'https://www.youtube.com/',
      referrerPolicy: 'origin-when-cross-origin'
    });
    if (!res.ok) throw new Error('HLS 分片 HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) throw new Error('HLS 分片为空');
    return buf;
  }

  /** web_safari / web_page → hlsManifestUrl → 各清晰度媒体列表 */
  async function loadHlsBundle(videoId) {
    const cache = window.__YT_DL_HLS__;
    if (cache?.videoId === videoId && cache.variants?.length && Date.now() - cache.at < 120000) {
      log('HLS', `使用缓存 ${cache.variants.length} 路`);
      return cache;
    }

    const tryKeys = ['web_page', 'web_safari'];
    let masterUrl = '';
    let lastReason = '';
    for (const key of tryKeys) {
      const preset = INNERTUBE_CLIENTS.find((c) => c.key === key);
      if (!preset) continue;
      log('HLS', `请求 ${key} InnerTube…`);
      const pr = await fetchInnertubePlayer(videoId, preset);
      const status = pr?.playabilityStatus?.status || '';
      masterUrl = pr?.streamingData?.hlsManifestUrl || '';
      if (masterUrl) break;
      lastReason = pr?.playabilityStatus?.reason || status || '无 hlsManifestUrl';
      log('HLS', `${key} 无 HLS · ${lastReason}`);
    }

    if (!masterUrl) {
      log('HLS', '未拿到 hlsManifestUrl（bot 校验或 SABR）。' + (lastReason ? ` ${lastReason}` : ''));
      const empty = { videoId, masterUrl: '', variants: [], at: Date.now() };
      window.__YT_DL_HLS__ = empty;
      return empty;
    }

    log('HLS', 'master=' + masterUrl.slice(0, 120));
    let text;
    try {
      text = await fetchTextUrl(masterUrl, 'master');
    } catch (e) {
      log('HLS', 'master 拉取失败: ' + (e?.message || e));
      const empty = { videoId, masterUrl, variants: [], error: e?.message || String(e), at: Date.now() };
      window.__YT_DL_HLS__ = empty;
      return empty;
    }

    const variants = parseMasterPlaylist(text, masterUrl);
    log(
      'HLS',
      variants.length
        ? `可用清晰度: ${variants.map((v) => `${v.height}P/@${Math.round(v.bandwidth / 1000)}k`).join(', ')}`
        : 'master 解析结果为空（可能需 n 签名）'
    );
    const bundle = { videoId, masterUrl, variants, at: Date.now() };
    window.__YT_DL_HLS__ = bundle;
    return bundle;
  }

  function mergeHlsIntoQualities(qualities, hlsBundle) {
    const list = [...(qualities || [])];
    const byQn = new Map(list.map((q) => [q.qn, q]));
    for (const v of hlsBundle?.variants || []) {
      if (!v.height) continue;
      const prev = byQn.get(v.height);
      const item = {
        qn: v.height,
        label: v.height + 'P',
        mode: 'hls',
        itag: v.itag,
        fps: 30,
        mimeType: 'application/vnd.apple.mpegurl',
        hasUrl: true,
        needsCipher: false,
        needsN: /[/]n[/][^/]+/.test(v.url),
        contentLength: 0,
        client: 'web_safari',
        viaPlayer: false,
        hlsUrl: v.url,
        bandwidth: v.bandwidth
      };
      // HLS 优先于 sniff / 无直链；弱于已验证无 n 的 https
      if (!prev) {
        byQn.set(v.height, item);
      } else if (prev.mode === 'sniff' || !prev.hasUrl || prev.viaPlayer) {
        byQn.set(v.height, item);
      } else if (prev.needsN && !item.needsN) {
        byQn.set(v.height, item);
      } else if (prev.mode !== 'hls' && prev.mode !== 'durl') {
        byQn.set(v.height, { ...prev, mode: 'hls', hlsUrl: v.url, client: 'web_safari', hasUrl: true });
      }
    }
    return [...byQn.values()].sort((a, b) => b.qn - a.qn);
  }

  function concatUint8(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function detectContainer(u8) {
    if (!u8 || u8.length < 4) return { ext: 'bin', kind: 'unknown' };
    if (u8[0] === 0x47) return { ext: 'ts', kind: 'mpegts' };
    // ftyp
    if (u8.length > 8) {
      const tag = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
      if (tag === 'ftyp' || tag === 'moof' || tag === 'sidx') return { ext: 'mp4', kind: 'fmp4' };
    }
    return { ext: 'mp4', kind: 'unknown' };
  }

  async function downloadHlsVariant(mediaPlaylistUrl, onProgress) {
    const text = await fetchTextUrl(mediaPlaylistUrl, 'media');
    const { initUrl, segments } = parseMediaPlaylist(text, mediaPlaylistUrl);
    if (!segments.length && !initUrl) throw new Error('媒体列表无分片');
    const urls = [];
    if (initUrl) urls.push(initUrl);
    for (const s of segments) urls.push(s);
    log('HLS', `开始下分片 total=${urls.length} init=${initUrl ? 'yes' : 'no'}`);

    const chunks = [];
    let received = 0;
    let lastErr = null;
    for (let i = 0; i < urls.length; i++) {
      throwIfCancelled();
      try {
        const buf = await fetchBinaryUrl(urls[i]);
        chunks.push(new Uint8Array(buf));
        received += buf.byteLength;
      } catch (e) {
        lastErr = e;
        log('HLS', `分片 ${i + 1}/${urls.length} 失败: ${e.message}`);
        // 前几个失败直接抛；后期偶尔失败可跳过
        if (i < 2 || chunks.length < 2) throw e;
        continue;
      }
      if (onProgress) {
        onProgress({
          received,
          total: 0,
          percent: Math.min(99, Math.round(((i + 1) / urls.length) * 100)),
          index: i + 1,
          count: urls.length
        });
      }
    }
    if (!chunks.length) throw lastErr || new Error('全部分片失败');
    const merged = concatUint8(chunks);
    const det = detectContainer(merged);
    log('HLS', `合并完成 ${(merged.length / 1024 / 1024).toFixed(1)}MB · ${det.kind}/${det.ext}`);
    if (onProgress) onProgress({ received: merged.length, total: merged.length, percent: 100 });
    return { bytes: merged, ext: det.ext, kind: det.kind };
  }

  async function handleHlsDownload(qn, title, hlsUrl) {
    const outBase = buildOutName(title, qn, '', '');
    sendProgress('prepare', 10);
    let mediaUrl = hlsUrl;
    if (!mediaUrl) {
      const id = parseVideoId(location.href)?.videoId;
      const bundle = await loadHlsBundle(id);
      const hit = (bundle.variants || []).find((v) => v.height === Number(qn));
      mediaUrl = hit?.url;
    }
    if (!mediaUrl) throw new Error(`无 ${qn}P 的 HLS 地址`);
    log('HLS', `选定 ${qn}P → ${mediaUrl.slice(0, 100)}…`);
    sendProgress('download', 0);

    try {
      const result = await downloadHlsVariant(mediaUrl, (p) => {
        sendProgress('download', p.percent, {
          received: p.received,
          total: p.total,
          detail: p.count ? `${p.index}/${p.count}` : ''
        });
      });
      sendProgress('save', 100);
      const name = outBase + '.' + result.ext;
      saveBlob(new Blob([result.bytes], { type: result.ext === 'ts' ? 'video/mp2t' : 'video/mp4' }), name);
      log('HLS', '页面下载成功 → ' + name);
      return { hls: true, via: 'page', ext: result.ext, bytes: result.bytes.length };
    } catch (e) {
      if (e.message === '下载已取消') throw e;
      log('HLS', '页面分片失败 → background: ' + (e.message || e));
      // 把媒体列表再解析一遍，把分片 URL 交给 background
      const text = await fetchTextUrl(mediaUrl, 'media-retry').catch(() => '');
      const parsed = text ? parseMediaPlaylist(text, mediaUrl) : { initUrl: null, segments: [] };
      const urls = [];
      if (parsed.initUrl) urls.push(parsed.initUrl);
      urls.push(...(parsed.segments || []));
      if (!urls.length) throw e;
      return {
        bgFetch: true,
        hls: true,
        urls,
        filename: outBase + '.mp4',
        userAgent: INNERTUBE_CLIENTS.find((c) => c.key === 'web_safari')?.client?.userAgent || null
      };
    }
  }

  async function loadFullStreamingData(videoId) {
    const pageParts = collectPageStreamingData().map((sd) => ({
      __bundle: true,
      client: 'web',
      clientUA: navigator.userAgent,
      formats: sd.formats,
      adaptiveFormats: sd.adaptiveFormats
    }));
    let merged = mergeStreamingData(pageParts);
    const pageStats = countAccessibleVideo(merged);
    log('页内流', `usable=${pageStats.n} maxH=${pageStats.maxH}`);

    // 始终拉 InnerTube：WEB 高清常无直链；android_vr / tv 更容易给到 720/1080 URL
    for (const preset of INNERTUBE_CLIENTS) {
      try {
        const pr = await fetchInnertubePlayer(videoId, preset);
        if (pr?.streamingData) {
          merged = mergeStreamingData([
            merged,
            {
              __bundle: true,
              client: preset.key,
              clientUA: preset.client.userAgent || navigator.userAgent,
              formats: pr.streamingData.formats,
              adaptiveFormats: pr.streamingData.adaptiveFormats
            }
          ]);
        }
        const now = countAccessibleVideo(merged);
        // 已有 ≥720 可用直链即可列高清；再试到 1080 后停止
        if (now.maxH >= 1080) {
          log('合并流', `${preset.key} 后 maxH=${now.maxH}，停止换端`);
          break;
        }
        // android_vr 已给出 720+ 时仍继续扫一遍 TV/嵌入，争取 1080
        if (now.maxH >= 720 && (preset.key === 'ios' || preset.key === 'android')) {
          log('合并流', `${preset.key} 后已有 ${now.maxH}P 直链，后续低价值客户端可跳过`);
          break;
        }
      } catch (err) {
        log('InnerTube', `${preset.key} 失败: ${err?.message || err}`);
      }
    }

    const finalStats = countAccessibleVideo(merged);
    log('合并流', `usable=${finalStats.n} maxH=${finalStats.maxH}`);

    window.__YT_DL_LAST_STREAMS__ = { videoId, ...merged, at: Date.now() };
    return merged;
  }

  function buildQualityList(sd) {
    const byHeight = new Map();
    const metaHeights = new Set();
    let skippedSabr = 0;
    let skippedCipher = 0;
    let skippedDrm = 0;

    const itemScore = (x) => {
      let s = 0;
      // 有直链优先；无直链的 sniff 档也可选（靠播放器抓）
      if (x.hasUrl && !x.needsN) s += 200;
      else if (x.hasUrl) s += 80;
      else if (x.mode === 'sniff') s += 30;
      if (x.client === 'android_vr' || x.client === 'android_vr_old') s += 100;
      else if (x.client === 'tv' || x.client === 'tv_simply') s += 70;
      else if (x.client === 'android' || x.client === 'ios') s += 40;
      if (x.hasUrl && x.needsN) s -= 90;
      if (x.mode === 'durl') s += 40;
      s += codecPrefer(x.mimeType);
      return s;
    };

    const consider = (f, mode) => {
      if (!isVideoFormat(f)) return;
      const height = formatHeight(f);
      if (!height) return;
      metaHeights.add(height);

      if (hasDrm(f)) {
        skippedDrm++;
        return;
      }

      const resolved = resolveFormatUrl(f);
      let itemMode = mode;
      let hasUrl = false;
      let needsN = false;

      if (resolved.url) {
        if (!f.url) f.url = resolved.url;
        hasUrl = true;
        needsN = urlHasNParam(resolved.url);
      } else if (resolved.kind === 'cipher_need_s') {
        skippedCipher++;
        // 仍列入：下载走播放器嗅探
        itemMode = 'sniff';
      } else {
        skippedSabr++;
        itemMode = 'sniff';
      }

      const item = {
        qn: height,
        label: normalizeLabel(f),
        mode: itemMode,
        itag: f.itag,
        fps: f.fps || 30,
        mimeType: f.mimeType || '',
        hasUrl,
        needsCipher: resolved.kind === 'cipher_need_s',
        needsN,
        contentLength: Number(f.contentLength) || 0,
        client: f._fromClient || 'web',
        viaPlayer: !hasUrl || needsN
      };
      const prev = byHeight.get(height);
      if (!prev || itemScore(item) > itemScore(prev)) {
        byHeight.set(height, item);
      }
    };

    for (const f of sd.formats || []) consider(f, 'durl');
    for (const f of sd.adaptiveFormats || []) {
      if (isAudioFormat(f)) continue;
      consider(f, 'dash');
    }

    // 页面播放器可用清晰度也并入（即便 streamingData 是 SABR）
    try {
      const player =
        document.getElementById('movie_player') ||
        document.querySelector('.html5-video-player');
      const levels =
        (typeof player?.getAvailableQualityLevels === 'function' &&
          player.getAvailableQualityLevels()) ||
        [];
      const map = {
        highres: 2160,
        hd2160: 2160,
        hd1440: 1440,
        hd1080: 1080,
        hd720: 720,
        large: 480,
        medium: 360,
        small: 240,
        tiny: 144
      };
      for (const lv of levels) {
        const h = map[String(lv).toLowerCase()] || parseInt(String(lv), 10) || 0;
        if (!h) continue;
        metaHeights.add(h);
        if (!byHeight.has(h)) {
          byHeight.set(h, {
            qn: h,
            label: h + 'P',
            mode: 'sniff',
            itag: null,
            fps: 30,
            mimeType: '',
            hasUrl: false,
            needsCipher: false,
            needsN: false,
            contentLength: 0,
            client: 'player',
            viaPlayer: true
          });
        }
      }
    } catch (_) {}

    const qualities = [...byHeight.values()].sort((a, b) => b.qn - a.qn);
    // 标注：该高度若既无 avc1 也无 webm，点下载可能降档
    const avcHeights = new Set();
    const webmHeights = new Set();
    for (const f of [...(sd.formats || []), ...(sd.adaptiveFormats || [])]) {
      if (!isVideoFormat(f)) continue;
      const h = formatHeight(f);
      if (!h) continue;
      if (/avc1/i.test(f.mimeType || '')) avcHeights.add(h);
      if (/webm/i.test(f.mimeType || '')) webmHeights.add(h);
    }
    for (const q of qualities) {
      q.remuxable = avcHeights.has(q.qn) || webmHeights.has(q.qn);
      q.webm = webmHeights.has(q.qn) && !avcHeights.has(q.qn);
      if (!q.remuxable && q.mode !== 'hls' && q.qn >= 1440) {
        q.label = q.qn + 'P↓';
      } else if (q.webm && q.mode !== 'hls') {
        q.label = q.qn + 'P·WebM';
      }
    }
    const hasAudio = (sd.adaptiveFormats || []).some((f) => {
      if (!isAudioFormat(f) || hasDrm(f)) return false;
      const r = resolveFormatUrl(f);
      if (r.url && !f.url) f.url = r.url;
      return !!r.url;
    });

    const allMeta = [...metaHeights].sort((a, b) => b - a);
    const listed = new Set(qualities.map((q) => q.qn));
    const hiddenHd = allMeta.filter((h) => h >= 720 && !listed.has(h));

    return {
      qualities,
      hasAudio,
      skippedSabr,
      skippedCipher,
      skippedDrm,
      skippedNoAccess: skippedSabr + skippedCipher,
      metaHeights: allMeta,
      hiddenHd
    };
  }

  async function getQualities(aid, cid) {
    const videoId = String(aid || cid || '');
    if (!videoId) {
      return { qualities: [], maxQn: 0, maxLabel: '—', loginHint: '缺少 videoId' };
    }

    const pagePr = readPlayerResponse();
    const status = pagePr?.playabilityStatus;
    const sd = await loadFullStreamingData(videoId);
    let {
      qualities,
      hasAudio,
      skippedSabr,
      skippedCipher,
      skippedDrm,
      skippedNoAccess,
      metaHeights,
      hiddenHd
    } = buildQualityList(sd);

    // 优先补齐 web_safari HLS（yt-dlp 路线：预合并 m3u8，常可达 720/1080）
    let hlsBundle = null;
    try {
      hlsBundle = await loadHlsBundle(videoId);
      qualities = mergeHlsIntoQualities(qualities, hlsBundle);
    } catch (e) {
      log('HLS', '加载失败: ' + (e?.message || e));
    }

    log(
      '清晰度',
      (qualities.map((q) => `${q.label}/${q.client || '?'}(${q.mode})`).join(', ') || '无') +
        ` · sabr无地址=${skippedSabr} cipher待解密=${skippedCipher} drm=${skippedDrm}` +
        ` · HLS=${hlsBundle?.variants?.length || 0}` +
        ` · 元数据高度=[${(metaHeights || []).join(',')}]` +
        (hiddenHd?.length ? ` · 有元数据未列入=${hiddenHd.join(',')}` : '')
    );

    const maxQn = qualities[0]?.qn || 0;
    const maxLabel = qualities[0]?.label || '—';
    const viaPlayer = qualities.some((q) => q.viaPlayer || q.mode === 'sniff');
    const hasHls = qualities.some((q) => q.mode === 'hls');

    let loginHint = null;
    if (!qualities.length) {
      const reason = status?.reason || status?.messages?.[0] || '';
      loginHint = reason
        ? String(reason)
        : '未找到可下载清晰度';
    } else if (hasHls) {
      loginHint = '高清走 Safari HLS（调试中）。无直链属正常；请看下方调试日志';
    } else if (viaPlayer && maxQn >= 720 && !(hlsBundle?.variants?.length)) {
      loginHint =
        'InnerTube/HLS 被 bot 拦截。请先登录并完成 YouTube「确认你不是机器人」，F5 后再试。也可先手动播目标清晰度再下（看调试区样例 URL）';
    } else if (viaPlayer && maxQn >= 720) {
      loginHint =
        '高清将通过播放器抓取（请保持播放）。无直链属正常，不代表不能下 1080P';
    } else if (maxQn >= 720) {
      loginHint = null;
    } else if (hiddenHd?.length) {
      loginHint =
        `检测到 ${hiddenHd.map((h) => h + 'P').join('/')}，将尝试播放器抓取；若失败请手动切到该清晰度再下`;
    } else if (qualities.every((q) => q.mode === 'dash') && !hasAudio) {
      loginHint = '仅发现视频轨、未发现音轨，下载时可能无声';
    }

    return {
      qualities,
      maxQn,
      maxLabel,
      loginHint,
      debug: {
        skippedSabr,
        skippedCipher,
        skippedDrm,
        metaHeights,
        hiddenHd,
        viaPlayer,
        hlsCount: hlsBundle?.variants?.length || 0,
        hlsMaster: hlsBundle?.masterUrl ? true : false
      }
    };
  }

  async function estimateDownloadSize(aid, cid, qn) {
    const videoId = String(aid || cid || '');
    try {
      const sd = await ensureStreams(videoId);
      let picked;
      try {
        picked = pickStreamsForQn(sd, qn);
      } catch (_) {
        return { sizeBytes: 0, sizeLabel: '—', estimateNote: '将通过播放器抓取，体积未知' };
      }
      if (picked.type === 'sniff') {
        return { sizeBytes: 0, sizeLabel: '—', estimateNote: '播放器抓取模式，体积待下载时确定' };
      }
      let bytes = 0;
      if (picked.type === 'durl') {
        bytes = Number(picked.video.contentLength) || 0;
      } else {
        bytes =
          (Number(picked.video?.contentLength) || 0) +
          (Number(picked.audio?.contentLength) || 0);
      }
      if (!bytes) {
        return { sizeBytes: 0, sizeLabel: '—', estimateNote: '该清晰度未提供体积信息' };
      }
      const mb = bytes / 1024 / 1024;
      const sizeLabel = mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
      return { sizeBytes: bytes, sizeLabel, estimateNote: picked.type === 'dash' ? '音视频合计（约）' : '' };
    } catch {
      return { sizeBytes: 0, sizeLabel: '—', estimateNote: '预估失败' };
    }
  }

  function sendProgress(step, percent, extra) {
    reply(null, { type: 'PROGRESS', step, percent, ...(extra || {}) });
  }

  const dlCtrl = {
    paused: false,
    cancelled: false,
    abortController: null,
    controllers: {},
    trackProgress: {},
    pauseWait: null,
    lastProgress: null
  };

  function initDownloadControl() {
    dlCtrl.paused = false;
    dlCtrl.cancelled = false;
    dlCtrl.abortController = null;
    dlCtrl.controllers = {};
    dlCtrl.trackProgress = {};
    dlCtrl.pauseWait = null;
    dlCtrl.lastProgress = null;
  }

  function abortAllControllers() {
    Object.values(dlCtrl.controllers).forEach((c) => c?.abort());
    dlCtrl.abortController?.abort();
  }

  function pauseDownloadControl() {
    if (dlCtrl.cancelled || dlCtrl.paused) return;
    dlCtrl.paused = true;
    const p = dlCtrl.lastProgress || { percent: 0, received: 0, total: 0 };
    sendProgress('paused', p.percent || 0, { received: p.received, total: p.total });
    abortAllControllers();
  }

  function resumeDownloadControl() {
    if (dlCtrl.cancelled || !dlCtrl.paused) return;
    dlCtrl.paused = false;
    if (dlCtrl.pauseWait) {
      dlCtrl.pauseWait.resolve();
      dlCtrl.pauseWait = null;
    }
  }

  function cancelDownloadControl() {
    dlCtrl.cancelled = true;
    dlCtrl.paused = false;
    if (dlCtrl.pauseWait) {
      dlCtrl.pauseWait.resolve();
      dlCtrl.pauseWait = null;
    }
    abortAllControllers();
  }

  function waitWhilePaused() {
    if (!dlCtrl.paused || dlCtrl.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      dlCtrl.pauseWait = { resolve };
    });
  }

  function throwIfCancelled() {
    if (dlCtrl.cancelled) throw new Error('下载已取消');
  }

  async function ensureStreams(videoId) {
    const cache = window.__YT_DL_LAST_STREAMS__;
    if (cache?.videoId === videoId && (cache.formats?.length || cache.adaptiveFormats?.length)) {
      return cache;
    }
    return loadFullStreamingData(videoId);
  }

  function streamUrl(f) {
    const r = resolveFormatUrl(f);
    if (r.url) {
      if (!f.url) f.url = r.url;
      return r.url;
    }
    if (r.kind === 'cipher_need_s') {
      throw new Error('该清晰度需要签名解密（signatureCipher），暂未实现');
    }
    throw new Error('无下载地址');
  }

  /** 去掉 range 分段参数，拿到完整文件 URL */
  function stripMediaRange(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete('range');
      u.searchParams.delete('rn');
      u.searchParams.delete('rbuf');
      return u.toString();
    } catch {
      return url;
    }
  }

  /** 从钩子 + performance 合并播放器已验证的 googlevideo */
  function sniffGoogleVideoUrls(itag) {
    const scored = [];
    const want = itag != null && itag !== '' ? String(itag) : null;

    // 刷新 byItag：历史条目可能 itag=null（旧解析），补全 path itag
    for (const e of gvCapture.all) {
      if (!e.itag) {
        e.itag = extractItagFromUrl(e.url);
        if (e.itag) {
          let list = gvCapture.byItag.get(e.itag);
          if (!list) {
            list = [];
            gvCapture.byItag.set(e.itag, list);
          }
          if (!list.includes(e.url)) list.unshift(e.url);
        }
      }
      if (!e.mime) e.mime = extractMimeFromUrl(e.url);
    }

    // 1) 主动拦截的请求（最准）
    if (want) {
      for (const u of gvCapture.byItag.get(want) || []) {
        scored.push({ url: u, transfer: 9e12 });
      }
      // 再扫 all 一次（防止 byItag 漏）
      for (const e of gvCapture.all) {
        if (String(e.itag) === want) scored.push({ url: e.url, transfer: 9e12 });
      }
    } else {
      for (const e of gvCapture.all) {
        scored.push({ url: e.url, transfer: 9e12 - (Date.now() - e.at) });
      }
    }

    // 2) performance 资源时间线
    try {
      const entries = performance.getEntriesByType('resource') || [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const name = e.name || '';
        if (!/googlevideo\.com\/videoplayback/i.test(name)) continue;
        if (want && !new RegExp('[?&]itag=' + want + '(?:&|$)').test(name)) continue;
        rememberGvUrl(name);
        const transfer = Number(e.transferSize) || Number(e.encodedBodySize) || 0;
        scored.push({ url: stripMediaRange(name), transfer, raw: name });
      }
    } catch (_) {}

    scored.sort((a, b) => b.transfer - a.transfer);
    const out = [];
    const seen = new Set();
    for (const s of scored) {
      if (!s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s.url);
      if (out.length >= 16) break;
    }
    return out;
  }

  function sniffCaptureStats() {
    const itags = [...gvCapture.byItag.keys()];
    const sample = (gvCapture.all || []).slice(0, 3).map((e) => {
      const short = String(e.url || '').slice(0, 90);
      return `itag=${e.itag || '?'} mime=${e.mime || '?'} ${short}`;
    });
    return { total: gvCapture.all.length, itags: itags.slice(0, 20), sample };
  }

  function uniqUrls(list) {
    const seen = new Set();
    const out = [];
    for (const u of list) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    return out;
  }

  function urlHasNParam(url) {
    try {
      return new URL(url).searchParams.has('n');
    } catch {
      return false;
    }
  }

  /** 评分：无 n / VR / 播放器已嗅探到的 itag 优先（带 n 的 mweb 极易 403） */
  function formatDownloadScore(f, opts) {
    hydrateFormatUrl(f);
    opts = opts || {};
    let s = 0;
    const client = f._fromClient || '';
    if (client === 'android_vr' || client === 'android_vr_old') s += 100;
    else if (client === 'tv' || client === 'tv_simply') s += 70;
    else if (client === 'android' || client === 'ios') s += 40;
    else if (client === 'web_safari' || client === 'mweb' || client === 'web_embedded') s += 10;
    if (f.url && !urlHasNParam(f.url)) s += 120;
    if (f.url && urlHasNParam(f.url)) s -= 100;
    if (opts.preferredItag && f.itag === opts.preferredItag) {
      // UI 点的若是 AV1/WebM，不要压过真正可合并的 H.264
      if (/avc1/i.test(f.mimeType || '')) s += 35;
      else if (/av01|vp9|webm/i.test(f.mimeType || '')) s -= 25;
      else s += 15;
    }
    if (opts.preferredClient && client === opts.preferredClient) s += 25;
    try {
      if (f.itag && sniffGoogleVideoUrls(f.itag).length) s += 200;
    } catch (_) {}
    if (/avc1/i.test(f.mimeType || '')) s += 40;
    else if (/av01/i.test(f.mimeType || '')) s -= 60;
    else if (/mp4/i.test(f.mimeType || '') && !/webm|vp9/i.test(f.mimeType || '')) s += 10;
    else if (/webm|vp9/i.test(f.mimeType || '')) s -= 40;
    // 一体流（formats）比纯视频轨更稳
    if (f.audioQuality) s += 50;
    s += codecPrefer(f.mimeType || '');
    return s;
  }

  function pickBestAudio(adaptive, opts) {
    return (adaptive || [])
      .filter((f) => {
        if (!isAudioFormat(f) || hasDrm(f)) return false;
        hydrateFormatUrl(f);
        return canAccess(f);
      })
      .sort((a, b) => {
        const scoreDiff = formatDownloadScore(b, opts) - formatDownloadScore(a, opts);
        if (scoreDiff) return scoreDiff;
        return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
      })[0] || null;
  }

  function listVideoFormatsForQn(sd, qn, opts) {
    const height = Number(qn) || 0;
    const matchH = (f) => formatHeight(f) === height;
    // 含无 url 的 SABR 档：下载靠嗅探，也要知道 itag
    let pool = [...(sd.formats || []), ...(sd.adaptiveFormats || [])].filter((f) => {
      if (!isVideoFormat(f) || hasDrm(f)) return false;
      if (height && !matchH(f)) return false;
      hydrateFormatUrl(f);
      return true;
    });
    if (!pool.length) {
      pool = [...(sd.formats || []), ...(sd.adaptiveFormats || [])].filter((f) => {
        if (!isVideoFormat(f) || hasDrm(f)) return false;
        hydrateFormatUrl(f);
        return true;
      });
    }
    pool.sort((a, b) => {
      const hs = Math.abs(formatHeight(a) - height) - Math.abs(formatHeight(b) - height);
      if (height && hs) return hs;
      // 有可访问 url 的优先
      const au = canAccess(a) ? 1 : 0;
      const bu = canAccess(b) ? 1 : 0;
      if (au !== bu) return bu - au;
      return formatDownloadScore(b, opts) - formatDownloadScore(a, opts);
    });
    return pool;
  }

  function pickStreamsForQn(sd, qn, opts) {
    opts = opts || {};
    const height = Number(qn) || 0;
    let pool = listVideoFormatsForQn(sd, qn, opts);

    // 播放器已请求过的 itag 排最前
    if (pool.length) {
      const sniffed = [];
      const rest = [];
      for (const f of pool) {
        if (f.itag && sniffGoogleVideoUrls(f.itag).length) sniffed.push(f);
        else rest.push(f);
      }
      if (sniffed.length) {
        sniffed.sort((a, b) => formatDownloadScore(b, opts) - formatDownloadScore(a, opts));
        pool = [...sniffed, ...rest];
        log('选流', `优先已播放 itag=[${sniffed.map((f) => f.itag).join(',')}]`);
      }
    }

    // 完全没有 streamingData 档位时：用嗅探到的 itag 伪造成 format
    if (!pool.length) {
      const st = sniffCaptureStats();
      const fake = (st.itags || [])
        .map((itag) => {
          const urls = sniffGoogleVideoUrls(itag);
          if (!urls.length) return null;
          return {
            itag: Number(itag) || itag,
            height,
            qualityLabel: height + 'p',
            url: urls[0],
            mimeType: 'video/mp4',
            _fromClient: 'sniff',
            _clientUA: navigator.userAgent
          };
        })
        .filter(Boolean);
      pool = fake;
    }

    if (!pool.length) {
      // 仍允许继续：下载阶段只靠高度嗅探
      return {
        type: 'sniff',
        video: {
          itag: null,
          height,
          qualityLabel: height + 'p',
          mimeType: 'video/mp4',
          _fromClient: 'sniff'
        },
        audio: null,
        pool: []
      };
    }

    const best = pool[0];
    hydrateFormatUrl(best);
    const hasAccess = canAccess(best);
    log(
      '选流',
      `itag=${best.itag} h=${formatHeight(best)} client=${best._fromClient || 'web'} score=${formatDownloadScore(best, opts)} n=${best.url && urlHasNParam(best.url) ? 'yes' : 'no'} sniff=${best.itag ? sniffGoogleVideoUrls(best.itag).length : 0} access=${hasAccess}`
    );

    if (!hasAccess && !(best.itag && sniffGoogleVideoUrls(best.itag).length)) {
      return { type: 'sniff', video: best, audio: null, pool };
    }

    const isProgressive = (sd.formats || []).some(
      (f) =>
        f.itag === best.itag &&
        (f === best ||
          (f._fromClient || 'web') === (best._fromClient || 'web') ||
          f.url === best.url)
    );
    const alsoAdaptive = (sd.adaptiveFormats || []).some(
      (f) => f.itag === best.itag && (f === best || f.url === best.url)
    );
    if (isProgressive && !alsoAdaptive && hasAccess) {
      return { type: 'durl', video: best, audio: null, pool };
    }

    let audio = pickBestAudio(
      (sd.adaptiveFormats || []).filter((f) => !best._fromClient || f._fromClient === best._fromClient),
      opts
    );
    if (!audio) audio = pickBestAudio(sd.adaptiveFormats, opts);
    if (audio && !sniffGoogleVideoUrls(audio.itag).length) {
      const audioSniffed = (sd.adaptiveFormats || [])
        .filter((f) => isAudioFormat(f) && !hasDrm(f) && sniffGoogleVideoUrls(f.itag).length)
        .map(hydrateFormatUrl)
        .filter((f) => canAccess(f) || sniffGoogleVideoUrls(f.itag).length)[0];
      if (audioSniffed) audio = audioSniffed;
    }
    // 无直链音频时仍走 dash/sniff，下载阶段用嗅探音频 itag
    return { type: hasAccess ? 'dash' : 'sniff', video: best, audio, pool };
  }

  /** 按高度从已捕获 URL 里猜视频/音频 itag（优先 H.264，再 VP9/AV1） */
  function guessItagsForHeight(height) {
    const h = Number(height) || 0;
    // 顺序：avc1 → vp9/webm → av01（合并只需前段；嗅探兜底才碰后两者）
    const videoMap = {
      144: [160, 278, 394],
      240: [133, 242, 395],
      360: [134, 243, 396],
      480: [135, 244, 397],
      720: [136, 298, 247, 302, 398],
      1080: [137, 299, 248, 303, 399],
      1440: [264, 271, 400],
      2160: [266, 313, 401]
    };
    const nearest = Object.keys(videoMap)
      .map(Number)
      .sort((a, b) => Math.abs(a - h) - Math.abs(b - h))[0];
    return {
      video: videoMap[nearest] || videoMap[1080],
      // Opus WebM 优先（249/250/251），再 AAC
      audio: [251, 250, 249, 140, 139, 141]
    };
  }

  function collectSniffUrlsForHeight(height) {
    const guess = guessItagsForHeight(height);
    const videoUrls = [];
    const audioUrls = [];
    for (const it of guess.video) {
      for (const u of sniffGoogleVideoUrls(it)) videoUrls.push(u);
    }
    for (const it of guess.audio) {
      for (const u of sniffGoogleVideoUrls(it)) audioUrls.push(u);
    }

    // 回退：按 mime / 近期捕获分类（修复 itag 在 path、query 解析失败时）
    if (!videoUrls.length || !audioUrls.length) {
      for (const e of gvCapture.all) {
        const mime = (e.mime || extractMimeFromUrl(e.url) || '').toLowerCase();
        const it = Number(e.itag || extractItagFromUrl(e.url));
        if (guess.video.includes(it) || mime.startsWith('video/')) {
          if (!videoUrls.includes(e.url)) videoUrls.push(e.url);
        } else if (guess.audio.includes(it) || mime.startsWith('audio/')) {
          if (!audioUrls.includes(e.url)) audioUrls.push(e.url);
        }
      }
    }

    // 仍无视频：把最近捕获全部当候选（至少能试播过的分片）
    if (!videoUrls.length && gvCapture.all.length) {
      log('嗅探', `itag 未匹配，回退最近 ${Math.min(8, gvCapture.all.length)} 条捕获`);
      for (const e of gvCapture.all.slice(0, 8)) videoUrls.push(e.url);
    }

    return {
      videoUrls: uniqUrls(videoUrls),
      audioUrls: uniqUrls(audioUrls),
      videoItag: guess.video.find((it) => sniffGoogleVideoUrls(it).length) || null,
      audioItag: guess.audio.find((it) => sniffGoogleVideoUrls(it).length) || null
    };
  }

  function expectedBytesFromFormat(format) {
    const fromMeta = Number(format?.contentLength) || 0;
    if (fromMeta > 1024) return fromMeta;
    try {
      const u = resolveFormatUrl(format)?.url || format?.url;
      if (!u) return 0;
      const clen = new URL(u).searchParams.get('clen');
      if (clen && /^\d+$/.test(clen)) return Number(clen) || 0;
    } catch (_) {}
    return 0;
  }

  function collectDownloadCandidates(format) {
    const itag = format?.itag;
    hydrateFormatUrl(format);
    const sniffed = sniffGoogleVideoUrls(itag);
    const resolved = resolveFormatUrl(format);
    const primary = resolved.url ? stripMediaRange(resolved.url) : null;
    const list = [];

    // 只信播放器真实请求过的链
    for (const u of sniffed) list.push(u);

    // 无 n 的 InnerTube 链可作备选；带 n 且无嗅探 → 极易 403，直接丢掉
    if (primary && !urlHasNParam(primary)) {
      list.push(primary);
    } else if (primary && urlHasNParam(primary) && !sniffed.length) {
      log('候选', `itag=${itag} 跳过带 n 的 InnerTube 直链（无播放器命中）`);
    }

    const out = uniqUrls(list);
    log(
      '候选',
      `itag=${itag || '-'} client=${format?._fromClient || '?'} sniff=${sniffed.length} n=${primary && urlHasNParam(primary) ? 'yes' : 'no'} → ${out.length}`
    );
    return out;
  }

  /** 同清晰度多 client/itag 候选地址拼在一起，给 background 轮询 */
  function collectCandidatesFromPool(pool, limit) {
    const urls = [];
    let bestUA = null;
    let bestScore = -Infinity;
    for (const f of (pool || []).slice(0, limit || 5)) {
      const score = formatDownloadScore(f);
      if (f._clientUA && score > bestScore) {
        bestScore = score;
        bestUA = f._clientUA;
      }
      for (const u of collectDownloadCandidates(f)) urls.push(u);
    }
    return { urls: uniqUrls(urls), userAgent: bestUA };
  }

  function heightToYtQuality(h) {
    const n = Number(h) || 0;
    if (n >= 2160) return 'highres';
    if (n >= 1440) return 'hd1440';
    if (n >= 1080) return 'hd1080';
    if (n >= 720) return 'hd720';
    if (n >= 480) return 'large';
    if (n >= 360) return 'medium';
    if (n >= 240) return 'small';
    return 'tiny';
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 点击播放器设置里的清晰度（setPlaybackQuality 常被忽略） */
  async function tryClickPlayerQuality(height) {
    const label = String(height);
    try {
      const settings = document.querySelector('.ytp-settings-button');
      if (!settings) return false;
      settings.click();
      await sleep(250);
      const items = [...document.querySelectorAll('.ytp-menuitem')];
      const qualityEntry = items.find((el) => /质量|Quality|画质/i.test(el.textContent || ''));
      if (qualityEntry) {
        qualityEntry.click();
        await sleep(250);
      }
      const opts = [...document.querySelectorAll('.ytp-menuitem, .ytp-quality-menu .ytp-menuitem')];
      const hit = opts.find((el) => {
        const t = (el.textContent || '').replace(/\s+/g, '');
        return t.includes(label + 'p') || t.includes(label + 'P') || new RegExp(label + '\\s*p', 'i').test(t);
      });
      if (hit) {
        hit.click();
        log('预热', `已点击菜单清晰度含 ${label}`);
        await sleep(400);
        // 关菜单
        document.querySelector('.ytp-settings-button')?.click();
        return true;
      }
      document.querySelector('.ytp-settings-button')?.click();
    } catch (e) {
      log('预热', '点击菜单失败: ' + (e?.message || e));
    }
    return false;
  }

  /**
   * 把播放器切到目标清晰度并播放，直到钩子捕获到对应 googlevideo
   */
  async function warmupPlayerQuality(height, preferItags) {
    const player =
      document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player');
    const q = heightToYtQuality(height);
    const wantItags = (preferItags || []).map(String).filter(Boolean);
    log('预热', `切到 ${q} (${height}P) · 期望 itag=[${wantItags.join(',') || '任意'}]`);

    try {
      if (typeof player?.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(q, q);
      }
      if (typeof player?.setPlaybackQuality === 'function') {
        player.setPlaybackQuality(q);
      }
    } catch (_) {}

    await tryClickPlayerQuality(height);

    try {
      const v = document.querySelector('video.html5-main-video, video');
      if (v) {
        if (v.paused) {
          const p = v.play();
          if (p && typeof p.then === 'function') await p.catch(() => {});
        }
      }
    } catch (_) {}

    const deadline = Date.now() + 9000;
    let lastStats = sniffCaptureStats();
    while (Date.now() < deadline) {
      // 微调进度，逼播放器拉新分片
      try {
        const v = document.querySelector('video.html5-main-video, video');
        if (v && !v.paused) {
          const t = Number(v.currentTime) || 0;
          v.currentTime = t + 0.35;
        }
      } catch (_) {}

      await sleep(450);

      if (wantItags.length) {
        for (const it of wantItags) {
          if (sniffGoogleVideoUrls(it).length) {
            const st = sniffCaptureStats();
            log('预热', `命中 itag=${it} · 捕获总数=${st.total} itags=${st.itags.join(',')}`);
            return true;
          }
        }
      } else if (sniffGoogleVideoUrls(null).length > 0) {
        const st = sniffCaptureStats();
        log('预热', `已捕获 googlevideo · ${st.total} 条 itags=${st.itags.join(',')}`);
        return true;
      }

      const st = sniffCaptureStats();
      if (st.total !== lastStats.total) {
        log(
          '预热',
          `捕获中… ${st.total} 条 itags=${st.itags.join(',') || '无'}` +
            (st.sample?.length ? ` · 样例: ${st.sample[0]}` : '')
        );
        lastStats = st;
      }
    }

    const st = sniffCaptureStats();
    log(
      '预热',
      `超时 · 捕获 ${st.total} 条 itags=[${st.itags.join(',') || '无'}]` +
        (st.sample?.length ? ` · ${st.sample.join(' | ')}` : '')
    );
    return st.total > 0;
  }

  /**
   * 下载 googlevideo：禁止自定义 Origin/Referer 头（会触发 CORS 预检导致失败）
   * 优先用播放器已验证的 URL；支持暂停 Range 续传
   */
  async function fetchMediaOnce(url, onProgress, trackId) {
    let chunks = [];
    let received = 0;
    let total = 0;
    const stallMs = trackId === 'audio' ? 8000 : 20000;

    while (true) {
      throwIfCancelled();
      dlCtrl.abortController = new AbortController();
      dlCtrl.controllers[trackId] = dlCtrl.abortController;

      const headers = {};
      if (received > 0) headers.Range = `bytes=${received}-`;

      let res;
      try {
        res = await fetch(url, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          referrer: 'https://www.youtube.com/',
          referrerPolicy: 'origin-when-cross-origin',
          headers,
          signal: dlCtrl.abortController.signal
        });
      } catch (e) {
        if (dlCtrl.cancelled) throw new Error('下载已取消');
        if (dlCtrl.paused) {
          await waitWhilePaused();
          throwIfCancelled();
          continue;
        }
        throw e;
      }

      if (!res.ok && !(received > 0 && res.status === 206)) {
        throw new Error('HTTP ' + res.status);
      }

      if (received === 0) {
        const cr = res.headers.get('content-range');
        if (cr) {
          const m = cr.match(/\/(\d+)\s*$/);
          if (m) total = parseInt(m[1], 10);
        }
        if (!total) total = parseInt(res.headers.get('content-length') || '0', 10);
      }

      if (!res.body || typeof res.body.getReader !== 'function') {
        const buf = await res.arrayBuffer();
        received = buf.byteLength;
        total = total || received;
        const progress = { received, total, percent: 100 };
        dlCtrl.trackProgress[trackId] = progress;
        dlCtrl.lastProgress = progress;
        if (onProgress) onProgress(progress);
        const minOk = trackId === 'audio' ? 1024 : 50 * 1024;
        if (received < minOk) throw new Error('下载内容过小 (' + received + ' bytes)，疑似空壳');
        return new Blob([buf]);
      }

      const reader = res.body.getReader();
      let needResume = false;
      let lastProgressAt = Date.now();
      let lastReceivedMark = received;
      try {
        while (true) {
          throwIfCancelled();
          // 卡住检测：久无字节增长则中止换链（音频限速时尤为关键）
          if (Date.now() - lastProgressAt > stallMs) {
            try {
              dlCtrl.abortController.abort();
            } catch (_) {}
            throw new Error(
              trackId + ' 下载卡住超时（' + Math.round(stallMs / 1000) + 's 无进度，已中止）'
            );
          }
          let readResult;
          try {
            readResult = await Promise.race([
              reader.read(),
              new Promise((_, rej) =>
                setTimeout(() => rej(new Error('stall')), Math.min(stallMs, 5000))
              )
            ]);
          } catch (e) {
            if (e && e.message === 'stall') {
              if (Date.now() - lastProgressAt > stallMs) {
                try {
                  dlCtrl.abortController.abort();
                } catch (_) {}
                throw new Error(trackId + ' 下载卡住超时');
              }
              continue;
            }
            if (dlCtrl.cancelled) throw new Error('下载已取消');
            if (dlCtrl.paused) {
              needResume = true;
              break;
            }
            throw e;
          }
          const { done, value } = readResult;
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (received > lastReceivedMark) {
            lastReceivedMark = received;
            lastProgressAt = Date.now();
          }
          const progress = {
            received,
            total,
            percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0
          };
          dlCtrl.trackProgress[trackId] = progress;
          dlCtrl.lastProgress = progress;
          if (onProgress) onProgress(progress);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch (_) {}
      }

      if (needResume) {
        await waitWhilePaused();
        throwIfCancelled();
        continue;
      }

      const minOk = trackId === 'audio' ? 1024 : 50 * 1024;
      if (received < minOk) throw new Error('下载内容过小 (' + received + ' bytes)，疑似空壳');
      log('下载', trackId + ' OK ' + (received / 1024 / 1024).toFixed(1) + 'MB');
      if (onProgress) onProgress({ received, total: total || received, percent: 100 });
      return new Blob(chunks, { type: trackId === 'audio' ? 'audio/mp4' : 'video/mp4' });
    }
  }

  /** XHR 兜底（部分环境下 fetch CORS 更严） */
  function fetchMediaXhr(url, onProgress, trackId) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.withCredentials = false;

      const onAbort = () => {
        try {
          xhr.abort();
        } catch (_) {}
        reject(new Error('下载已取消'));
      };
      dlCtrl.abortController = { abort: onAbort, signal: { aborted: false } };
      dlCtrl.controllers[trackId] = dlCtrl.abortController;

      xhr.onprogress = (ev) => {
        if (dlCtrl.cancelled) {
          onAbort();
          return;
        }
        const total = ev.lengthComputable ? ev.total : 0;
        const received = ev.loaded || 0;
        const progress = {
          received,
          total,
          percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0
        };
        dlCtrl.trackProgress[trackId] = progress;
        dlCtrl.lastProgress = progress;
        if (onProgress) onProgress(progress);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const blob = xhr.response;
          const minBytes = trackId === 'audio' ? 1024 : 50 * 1024;
          if (!blob || blob.size < minBytes) {
            reject(new Error('下载内容过小 (' + (blob?.size || 0) + ' bytes)'));
            return;
          }
          if (onProgress) {
            onProgress({ received: blob.size, total: blob.size, percent: 100 });
          }
          resolve(blob);
        } else {
          reject(new Error('HTTP ' + xhr.status));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.onabort = () => reject(new Error(dlCtrl.cancelled ? '下载已取消' : '下载中断'));
      xhr.send();
    });
  }

  async function fetchMedia(urlOrList, onProgress, trackId) {
    const list = uniqUrls(Array.isArray(urlOrList) ? urlOrList : [urlOrList]);
    if (!list.length) throw new Error('无下载地址');

    let lastErr;
    for (let i = 0; i < list.length; i++) {
      const url = list[i];
      log('下载', `${trackId} 尝试 ${i + 1}/${list.length} · ${url.slice(0, 80)}…`);
      try {
        return await fetchMediaOnce(url, onProgress, trackId);
      } catch (e) {
        if (e.message === '下载已取消') throw e;
        lastErr = e;
        log('下载', `fetch 失败: ${e.message}`);
        try {
          return await fetchMediaXhr(url, onProgress, trackId);
        } catch (e2) {
          if (e2.message === '下载已取消') throw e2;
          lastErr = e2;
          log('下载', `xhr 失败: ${e2.message}`);
        }
      }
    }
    const msg = lastErr?.message || '下载失败';
    if (/HTTP 403|HTTP 4/.test(msg)) {
      throw new Error('下载失败。请先播放 5～10 秒后再试');
    }
    throw lastErr || new Error('下载失败');
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 5000);
  }

  async function mergeM4sInPage(videoBlob, audioBlob) {
    if (!videoBlob?.size) throw new Error('视频数据为空');
    if (!audioBlob?.size) throw new Error('音频数据为空');
    const total = videoBlob.size + audioBlob.size;
    if (total > 1.5 * 1024 * 1024 * 1024) throw new Error('文件过大，请改选较低清晰度');

    const vHead = new Uint8Array(await videoBlob.slice(0, 8).arrayBuffer());
    const aHead = new Uint8Array(await audioBlob.slice(0, 8).arrayBuffer());
    const vWebm = vHead[0] === 0x1a && vHead[1] === 0x45 && vHead[2] === 0xdf && vHead[3] === 0xa3;
    const aWebm = aHead[0] === 0x1a && aHead[1] === 0x45 && aHead[2] === 0xdf && aHead[3] === 0xa3;

    log(
      '合并',
      `${vWebm ? 'WebM' : 'MP4'} · ${(videoBlob.size / 1024 / 1024).toFixed(1)}MB+${(audioBlob.size / 1024 / 1024).toFixed(1)}MB`
    );
    sendProgress('merge', 0, { total });
    await new Promise((r) => setTimeout(r, 40));
    const t0 = Date.now();

    if (vWebm) {
      if (!aWebm) {
        throw new Error(
          '视频是 WebM，但音频不是 WebM/Opus（多为 AAC）。无法合成；请重试或改选 H.264 清晰度'
        );
      }
      const webmMux = window.YtWebmMux;
      if (!webmMux?.mergeWebm) throw new Error('WebM 合并库未加载，请刷新页面后重试');
      log('合并', 'WebM remux…');
      const blob = await webmMux.mergeWebm(
        await videoBlob.arrayBuffer(),
        await audioBlob.arrayBuffer(),
        { log }
      );
      log('合并', `WebM 完成 · ${(blob.size / 1024 / 1024).toFixed(1)}MB · ${Date.now() - t0}ms`);
      sendProgress('merge', 100, { total: blob.size });
      return blob;
    }

    const mux = window.YtM4sMux || window.BiliM4sMux;
    if (!mux?.mergeM4s) throw new Error('合并库未加载，请刷新页面后重试');
    if (typeof window.mp4Remux !== 'function') throw new Error('mp4-remux 未加载，请刷新页面后重试');
    log('合并', 'MP4 remux…');
    const blob = await mux.mergeM4s(
      await videoBlob.arrayBuffer(),
      await audioBlob.arrayBuffer(),
      window.mp4Remux
    );
    log('合并', `MP4 完成 · ${(blob.size / 1024 / 1024).toFixed(1)}MB · ${Date.now() - t0}ms`);
    sendProgress('merge', 100, { total });
    return blob;
  }

  function safeFilename(title) {
    return (title || 'youtube').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'youtube';
  }

  /** 文件名带清晰度，如 标题_1080P.mp4 */
  function buildOutName(title, qn, suffix, ext) {
    const base = safeFilename(title);
    const q = Number(qn) || 0;
    const qtag = q > 0 ? `_${q}P` : '';
    return base + qtag + (suffix || '') + (ext || '.mp4');
  }

  /** MP4 合并：H.264(avc1)+AAC；WebM 合并：VP9/AV1 WebM + Opus WebM */
  function isAvc1Video(f) {
    return /avc1/i.test(f?.mimeType || '');
  }

  function isWebmVideo(f) {
    const m = f?.mimeType || '';
    return /webm/i.test(m) && /vp9|vp09|av01|video\//i.test(m);
  }

  function isMp4aAudio(f) {
    const m = f?.mimeType || '';
    return /mp4a|audio\/mp4/i.test(m) && !/webm|opus/i.test(m);
  }

  function isOpusWebmAudio(f) {
    const m = f?.mimeType || '';
    return /opus/i.test(m) || (/audio\/webm/i.test(m) && !/mp4a/i.test(m));
  }

  function briefMime(f) {
    return String(f?.mimeType || '')
      .replace(/; codecs=/i, ' · ')
      .slice(0, 72);
  }

  /** 在 sd 里找可合并的 H.264：先同高度，再 ≤ 目标高度最高档 */
  function findRemuxableVideo(sd, preferHeight, opts) {
    const h = Number(preferHeight) || 0;
    const all = [...(sd.formats || []), ...(sd.adaptiveFormats || [])]
      .filter((f) => isVideoFormat(f) && !hasDrm(f))
      .map(hydrateFormatUrl)
      .filter((f) => isAvc1Video(f) && canAccess(f));
    if (!all.length) return null;
    const scored = (a, b) => {
      const dh = formatHeight(b) - formatHeight(a);
      if (dh) return dh;
      return formatDownloadScore(b, opts) - formatDownloadScore(a, opts);
    };
    const exact = all.filter((f) => formatHeight(f) === h).sort(scored);
    if (exact.length) return exact[0];
    const below = all.filter((f) => !h || formatHeight(f) <= h).sort(scored);
    if (below.length) return below[0];
    return all.sort(scored)[0];
  }

  /** 找目标高度附近的 WebM 视频（可与 Opus 合成 .webm） */
  function findWebmVideo(sd, preferHeight, opts) {
    const h = Number(preferHeight) || 0;
    const all = [...(sd.adaptiveFormats || [])]
      .filter((f) => isVideoFormat(f) && !hasDrm(f))
      .map(hydrateFormatUrl)
      .filter((f) => isWebmVideo(f) && (canAccess(f) || sniffGoogleVideoUrls(f.itag).length));
    if (!all.length) return null;
    const exact = all.filter((f) => formatHeight(f) === h);
    const pool = exact.length ? exact : all;
    return pool.sort((a, b) => {
      const da = Math.abs(formatHeight(a) - h);
      const db = Math.abs(formatHeight(b) - h);
      if (da !== db) return da - db;
      return formatDownloadScore(b, opts) - formatDownloadScore(a, opts);
    })[0];
  }

  function pickRemuxableAudio(sd, preferClient, opts) {
    const list = (sd.adaptiveFormats || [])
      .filter((f) => {
        if (!isAudioFormat(f) || hasDrm(f) || !isMp4aAudio(f)) return false;
        hydrateFormatUrl(f);
        return canAccess(f) || sniffGoogleVideoUrls(f.itag).length;
      })
      .sort((a, b) => {
        const ca = (a._fromClient || '') === preferClient ? 1 : 0;
        const cb = (b._fromClient || '') === preferClient ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return formatDownloadScore(b, opts) - formatDownloadScore(a, opts);
      });
    return list[0] || pickBestAudio(sd.adaptiveFormats, opts);
  }

  function pickOpusAudio(sd, preferClient, opts) {
    const list = (sd.adaptiveFormats || [])
      .filter((f) => {
        if (!isAudioFormat(f) || hasDrm(f) || !isOpusWebmAudio(f)) return false;
        hydrateFormatUrl(f);
        return canAccess(f) || sniffGoogleVideoUrls(f.itag).length;
      })
      .sort((a, b) => {
        const ca = (a._fromClient || '') === preferClient ? 1 : 0;
        const cb = (b._fromClient || '') === preferClient ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
      });
    if (list[0]) return list[0];
    return null;
  }

  async function handleDownload(aid, cid, qn, title, preferred) {
    initDownloadControl();
    try {
      const videoId = String(aid || cid || '');
      if (!videoId) throw new Error('缺少 videoId');
      preferred = preferred || {};
      const requestQn = Number(qn) || 0;

      sendProgress('prepare', 5);
      const opts = {
        preferredItag: preferred.itag || null,
        preferredClient: preferred.client || null
      };

      // HLS 优先（仅当选项本身是 hls，或尚未确认无 HLS）
      if (preferred.mode === 'hls' || preferred.hlsUrl) {
        log('下载', `走 HLS 通路 qn=${requestQn}`);
        return await handleHlsDownload(requestQn, title, preferred.hlsUrl || null);
      }

      // dash/durl 已有直链时不要每次再扫 HLS（省掉一轮 InnerTube）
      if (preferred.mode !== 'dash' && preferred.mode !== 'durl') {
        try {
          const hlsBundle = await loadHlsBundle(videoId);
          const hit = (hlsBundle.variants || []).find((v) => v.height === requestQn);
          if (hit?.url) {
            log('下载', `同清晰度存在 HLS，改走 m3u8 · ${requestQn}P`);
            return await handleHlsDownload(requestQn, title, hit.url);
          }
        } catch (e) {
          log('HLS', '预检跳过: ' + (e?.message || e));
        }
      }

      // 有 android_vr 等直链时跳过 10s 预热（只会抓到无 itag 的垃圾请求）
      const sd0 = await ensureStreams(videoId);
      const previewPool = listVideoFormatsForQn(sd0, requestQn, opts);
      const preferItags = [
        ...previewPool.slice(0, 8).map((f) => f.itag).filter(Boolean),
        ...guessItagsForHeight(requestQn || 360).video
      ];
      const hasDirect = previewPool.some((f) => {
        hydrateFormatUrl(f);
        return canAccess(f) && (f._fromClient === 'android_vr' || f._fromClient === 'android_vr_old' || f._fromClient === 'tv');
      });
      if (hasDirect) {
        log('下载', '已有 VR/TV 直链，跳过播放器预热');
      } else {
        await warmupPlayerQuality(requestQn || 360, preferItags);
      }

      const sd = hasDirect ? sd0 : await loadFullStreamingData(videoId);
      let picked = pickStreamsForQn(sd, requestQn, opts);
      log(
        '下载',
        `${picked.type} qn=${requestQn} itag=${picked.video?.itag} client=${picked.video?._fromClient || '?'} · ${briefMime(picked.video)}`
      );

      // 选轨策略：
      // 1) 已是 WebM + 有 Opus → 走 WebM remux（真 1440P）
      // 2) 非 avc1 且能配对 Opus 的同档 WebM → 改用 WebM
      // 3) 否则降到 H.264 + AAC → MP4
      let containerMode = 'mp4'; // 'mp4' | 'webm'
      if (picked.type !== 'durl') {
        const opus = pickOpusAudio(sd, picked.video?._fromClient, opts);
        if (isWebmVideo(picked.video) && opus) {
          containerMode = 'webm';
          picked.audio = opus;
          log('下载', `WebM 通路 · itag=${picked.video.itag} + Opus ${opus.itag} · ${briefMime(picked.video)}`);
        } else if (!isAvc1Video(picked.video)) {
          const webmHit = findWebmVideo(sd, requestQn, opts);
          const opus2 = opus || pickOpusAudio(sd, webmHit?._fromClient, opts);
          if (webmHit && opus2 && formatHeight(webmHit) === requestQn) {
            containerMode = 'webm';
            hydrateFormatUrl(webmHit);
            const hasAccess = canAccess(webmHit) || sniffGoogleVideoUrls(webmHit.itag).length > 0;
            picked = {
              type: hasAccess && canAccess(webmHit) ? 'dash' : 'sniff',
              video: webmHit,
              audio: opus2,
              pool: [webmHit]
            };
            log(
              '下载',
              `改用 WebM · ${formatHeight(webmHit)}P itag=${webmHit.itag} + Opus ${opus2.itag} · ${briefMime(webmHit)}`
            );
          } else {
            const remuxable = findRemuxableVideo(sd, requestQn, opts);
            if (remuxable) {
              const fromH = formatHeight(picked.video) || requestQn;
              const fromMime = briefMime(picked.video);
              const toH = formatHeight(remuxable);
              const audio = pickRemuxableAudio(sd, remuxable._fromClient, opts);
              hydrateFormatUrl(remuxable);
              const hasAccess = canAccess(remuxable) || sniffGoogleVideoUrls(remuxable.itag).length > 0;
              containerMode = 'mp4';
              picked = {
                type: hasAccess && canAccess(remuxable) ? 'dash' : 'sniff',
                video: remuxable,
                audio,
                pool: [remuxable, ...(picked.pool || []).filter((f) => isAvc1Video(f))]
              };
              if (toH !== fromH) {
                log(
                  '下载',
                  `⚠ ${fromH}P 非 H.264（${fromMime}），无可用 WebM+Opus，已改用 ${toH}P H.264 itag=${remuxable.itag}`
                );
              } else {
                log('下载', `改用 H.264 itag=${remuxable.itag} · ${briefMime(remuxable)}`);
              }
            } else {
              log('下载', `⚠ ${requestQn}P 既无 WebM+Opus 也无 H.264，仍按原轨尝试`);
            }
          }
        } else {
          picked.audio = pickRemuxableAudio(sd, picked.video?._fromClient, opts) || picked.audio;
        }
      }
      log('下载', `容器模式=${containerMode}`);

      sendProgress('prepare', 20);
      const actualQnEarly = formatHeight(picked.video) || requestQn;
      const earlyExt = containerMode === 'webm' ? '.webm' : '.mp4';

      // SABR / 无直链：完全依赖播放器捕获
      if (picked.type === 'sniff') {
        const sniffPack = collectSniffUrlsForHeight(actualQnEarly || 360);
        const fname = buildOutName(title, actualQnEarly || 360, '', earlyExt);
        const vonly = buildOutName(title, actualQnEarly || 360, '_video', earlyExt);
        log(
          '下载',
          `嗅探模式 video=${sniffPack.videoUrls.length} audio=${sniffPack.audioUrls.length} vitag=${sniffPack.videoItag} aitag=${sniffPack.audioItag}`
        );
        if (!sniffPack.videoUrls.length) {
          const st = sniffCaptureStats();
          throw new Error(
            `未捕获到 ${requestQn}P 播放地址（已捕获 itags=[${st.itags.join(',') || '无'}]）。请手动切到 ${requestQn}P 播放 5～10 秒后再下`
          );
        }

        try {
          sendProgress('video', 0);
          const vBlob = await fetchMedia(sniffPack.videoUrls, (p) => {
            sendProgress('video', p.percent, { received: p.received, total: p.total });
          }, 'video');
          if (sniffPack.audioUrls.length) {
            sendProgress('audio', 0);
            try {
              const aBlob = await fetchMedia(sniffPack.audioUrls, (p) => {
                sendProgress('audio', p.percent, { received: p.received, total: p.total });
              }, 'audio');
              sendProgress('merge', 5);
              const merged = await mergeM4sInPage(vBlob, aBlob);
              sendProgress('save', 100);
              saveBlob(merged, fname);
              return { dash: true, via: 'page-sniff', actualQn: actualQnEarly, requestedQn: requestQn };
            } catch (ae) {
              log('下载', '嗅探音频失败，仅视频: ' + (ae.message || ae));
              saveBlob(vBlob, vonly);
              return { dash: true, via: 'page-sniff', videoOnly: true, actualQn: actualQnEarly, requestedQn: requestQn };
            }
          }
          saveBlob(vBlob, vonly);
          return { dash: true, via: 'page-sniff', videoOnly: true, actualQn: actualQnEarly, requestedQn: requestQn };
        } catch (e) {
          if (e.message === '下载已取消') throw e;
          log('下载', '页面嗅探拉取失败 → background: ' + (e.message || e));
        }

        return {
          bgFetch: true,
          dash: true,
          videoUrls: sniffPack.videoUrls,
          audioUrls: sniffPack.audioUrls,
          filename: fname,
          videoOnlyFilename: vonly,
          userAgent: navigator.userAgent,
          itag: sniffPack.videoItag || picked.video?.itag,
          audioItag: sniffPack.audioItag,
          videoExpectedBytes: 0,
          audioExpectedBytes: 0,
          actualQn: actualQnEarly,
          requestedQn: requestQn
        };
      }

      if (picked.type === 'durl') {
        const pack = collectCandidatesFromPool(picked.pool || [picked.video], 5);
        const fname = buildOutName(title, actualQnEarly || 360, '', '.mp4');
        log('下载', `一体流候选 ${pack.urls.length} 条`);
        pack.urls.slice(0, 4).forEach((u, i) => log('候选', `#${i} ${u.slice(0, 160)}`));
        if (!pack.urls.length) {
          throw new Error(
            `未捕获到 ${requestQn}P 的播放地址。请在播放器设置中手动选 ${requestQn}P，播放 5～10 秒后再点下载`
          );
        }

        try {
          sendProgress('download', 0);
          const blob = await fetchMedia(pack.urls, (p) => {
            sendProgress('download', p.percent, { received: p.received, total: p.total });
          }, 'video');
          sendProgress('save', 100);
          saveBlob(blob, fname);
          log('下载', '页面拉取成功 → ' + fname);
          return { dash: false, via: 'page', actualQn: actualQnEarly, requestedQn: requestQn };
        } catch (e) {
          if (e.message === '下载已取消') throw e;
          log('下载', '页面拉取失败 → background: ' + (e.message || e));
        }

        return {
          bgFetch: true,
          urls: pack.urls,
          filename: fname,
          userAgent: pack.userAgent || picked.video?._clientUA || null,
          itag: picked.video?.itag || null,
          videoExpectedBytes: expectedBytesFromFormat(picked.video),
          actualQn: actualQnEarly,
          requestedQn: requestQn
        };
      }

      // DASH：mp4=H.264+AAC；webm=VP9+Opus
      let video = picked.video;
      let audio = picked.audio;
      const useWebm = containerMode === 'webm' || isWebmVideo(video);
      if (useWebm) {
        audio = pickOpusAudio(sd, video?._fromClient, opts) || audio;
        if (!audio || !isOpusWebmAudio(audio)) {
          throw new Error(
            `${requestQn}P WebM 视频缺少 Opus 音频轨，无法合成 .webm。请改选 H.264 清晰度或刷新重试`
          );
        }
        log('下载', `DASH/WebM · video itag=${video?.itag} · audio itag=${audio?.itag} · ${briefMime(video)}`);
      } else {
        audio = pickRemuxableAudio(sd, video?._fromClient, opts) || audio;
        log('下载', `DASH/MP4 · itag=${video?.itag} · ${briefMime(video)}`);
        if (!isAvc1Video(video)) {
          throw new Error(
            `${requestQn}P 无 H.264/MP4 直链（多为 WebM/AV1）。请改选 1080P/720P 等，或刷新后重试`
          );
        }
      }

      const actualQn = formatHeight(video) || requestQn;
      const outExt = useWebm ? '.webm' : '.mp4';
      const fname = buildOutName(title, actualQn, '', outExt);
      const vonly = buildOutName(title, actualQn, '_video', outExt);

      let videoUrls = uniqUrls(collectDownloadCandidates(video));
      const siblings = (picked.pool || [])
        .filter(
          (f) =>
            f &&
            f.itag !== video.itag &&
            formatHeight(f) === formatHeight(video) &&
            (useWebm ? isWebmVideo(f) : isAvc1Video(f))
        )
        .slice(0, 2);
      for (const f of siblings) {
        for (const u of collectDownloadCandidates(f)) videoUrls.push(u);
      }
      videoUrls = uniqUrls(videoUrls);
      let audioUrls = audio ? collectDownloadCandidates(audio) : [];
      if (audio) {
        const audioAlts = (sd.adaptiveFormats || [])
          .filter(
            (f) =>
              isAudioFormat(f) &&
              !hasDrm(f) &&
              (useWebm ? isOpusWebmAudio(f) : isMp4aAudio(f))
          )
          .map(hydrateFormatUrl)
          .filter((f) => canAccess(f) || sniffGoogleVideoUrls(f.itag).length)
          .sort((a, b) => formatDownloadScore(b, opts) - formatDownloadScore(a, opts))
          .slice(0, 3);
        for (const a of audioAlts) {
          for (const u of collectDownloadCandidates(a)) audioUrls.push(u);
        }
      }

      // DASH 直链为空时回退高度嗅探（SABR 常见）
      if (!videoUrls.length) {
        const sniffPack = collectSniffUrlsForHeight(actualQn || 360);
        videoUrls = sniffPack.videoUrls;
        if (!audioUrls.length) audioUrls = sniffPack.audioUrls;
        log('下载', `DASH 无直链 → 嗅探回退 v=${videoUrls.length} a=${audioUrls.length}`);
      }

      const uniqAudio = uniqUrls(audioUrls);
      log(
        '下载',
        `DASH video候选=${videoUrls.length} audio候选=${uniqAudio.length} · 将保存为 ${fname}`
      );

      if (!videoUrls.length) {
        const st = sniffCaptureStats();
        throw new Error(
          `未捕获到 ${actualQn}P 播放地址（钩子 itags=[${st.itags.join(',') || '无'}]）。请手动把播放器切到 ${actualQn}P 并播放几秒后重试`
        );
      }

      // 有无 n 的 VR/TV 直链：音视频都走 background（页面 CORS 常拦 googlevideo）
      const preferBg =
        (video?._fromClient === 'android_vr' ||
          video?._fromClient === 'android_vr_old' ||
          video?._fromClient === 'tv') &&
        videoUrls.some((u) => u && !urlHasNParam(u));

      if (preferBg) {
        log('下载', '直链改 background 下载（视频+音频）');
        return {
          bgFetch: true,
          dash: true,
          videoUrls,
          audioUrls: uniqAudio,
          filename: fname,
          videoOnlyFilename: vonly,
          userAgent: video?._clientUA || null,
          itag: video?.itag || null,
          audioItag: audio?.itag || null,
          videoExpectedBytes: expectedBytesFromFormat(video),
          audioExpectedBytes: expectedBytesFromFormat(audio),
          actualQn,
          requestedQn: requestQn,
          container: useWebm ? 'webm' : 'mp4'
        };
      }

      // 有嗅探地址时先在页面拉（n 已由播放器算好，最不易 403）
      const hasSniff =
        sniffGoogleVideoUrls(video?.itag).length > 0 ||
        (audio && sniffGoogleVideoUrls(audio.itag).length > 0);
      if (hasSniff || videoUrls.some((u) => !urlHasNParam(u))) {
        try {
          sendProgress('video', 0);
          const vBlob = await fetchMedia(videoUrls, (p) => {
            sendProgress('video', p.percent, { received: p.received, total: p.total });
          }, 'video');
          if (uniqAudio.length) {
            log(
              '下载',
              `视频 OK ${(vBlob.size / 1024 / 1024).toFixed(1)}MB，音频改走 background（避免同连接限速）`
            );
            window.__YT_DL_PENDING_VIDEO__ = {
              blob: vBlob,
              filename: fname,
              videoOnlyFilename: vonly,
              at: Date.now()
            };
            return {
              needBgAudio: true,
              audioUrls: uniqAudio,
              filename: fname,
              videoOnlyFilename: vonly,
              userAgent: video?._clientUA || null,
              audioItag: audio?.itag || null,
              videoBytes: vBlob.size,
              audioExpectedBytes: expectedBytesFromFormat(audio),
              actualQn,
              requestedQn: requestQn,
              container: useWebm ? 'webm' : 'mp4'
            };
          }
          sendProgress('save', 100);
          saveBlob(vBlob, vonly);
          return { dash: true, via: 'page', videoOnly: true, actualQn };
        } catch (e) {
          if (e.message === '下载已取消') throw e;
          log('下载', '页面 DASH 失败 → background: ' + (e.message || e));
        }
      }

      return {
        bgFetch: true,
        dash: true,
        videoUrls,
        audioUrls: uniqAudio,
        filename: fname,
        videoOnlyFilename: vonly,
        userAgent: video?._clientUA || null,
        itag: video?.itag || null,
        audioItag: audio?.itag || null,
        videoExpectedBytes: expectedBytesFromFormat(video),
        audioExpectedBytes: expectedBytesFromFormat(audio),
        actualQn,
        requestedQn: requestQn,
        container: useWebm ? 'webm' : 'mp4'
      };
    } finally {
      // bgFetch 时真正下载在 content/background，这里只重置准备态
      initDownloadControl();
    }
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
          const result = await handleDownload(e.data.aid, e.data.cid, e.data.qn, e.data.title, {
            itag: e.data.itag,
            client: e.data.client,
            mode: e.data.mode,
            hlsUrl: e.data.hlsUrl
          });
          reply(id, { type: 'OK', data: result });
          break;
        }
        case 'MERGE_BUFFERS': {
          const vBytes = e.data.videoBuffer?.byteLength || 0;
          const aBytes = e.data.audioBuffer?.byteLength || 0;
          sendProgress('merge', 5, { total: vBytes + aBytes, received: vBytes + aBytes });
          await new Promise((r) => setTimeout(r, 30));

          const vHead = new Uint8Array(e.data.videoBuffer || [], 0, Math.min(4, vBytes));
          const aHead = new Uint8Array(e.data.audioBuffer || [], 0, Math.min(4, aBytes));
          const vWebm = vHead[0] === 0x1a && vHead[1] === 0x45 && vHead[2] === 0xdf && vHead[3] === 0xa3;
          const aWebm = aHead[0] === 0x1a && aHead[1] === 0x45 && aHead[2] === 0xdf && aHead[3] === 0xa3;
          const base = String(e.data.filename || 'youtube').replace(/\.(mp4|webm|m4a|mkv)$/i, '');
          const vName = base + '_video' + (vWebm ? '.webm' : '.mp4');
          const aName = base + '_audio' + (aWebm ? '.webm' : '.m4a');

          try {
            const vBlob = new Blob([e.data.videoBuffer], { type: vWebm ? 'video/webm' : 'video/mp4' });
            const aBlob = new Blob([e.data.audioBuffer], { type: aWebm ? 'audio/webm' : 'audio/mp4' });
            const merged = await mergeM4sInPage(vBlob, aBlob);
            sendProgress('merge', 100, { total: merged.size, received: merged.size });
            reply(id, { type: 'OK', data: { blob: merged, size: merged.size } });
          } catch (mergeErr) {
            // 音视频已到手：分别落盘，避免用户重下几百 MB
            log('合并', '失败 → 分别保存音视频轨（无需重下）: ' + (mergeErr?.message || mergeErr));
            try {
              saveBlob(new Blob([e.data.videoBuffer], { type: vWebm ? 'video/webm' : 'video/mp4' }), vName);
              saveBlob(new Blob([e.data.audioBuffer], { type: aWebm ? 'audio/webm' : 'audio/mp4' }), aName);
              log('合并', `已保存 ${vName} + ${aName}`);
              sendProgress('save', 100);
              reply(id, {
                type: 'OK',
                data: {
                  savedTracks: true,
                  error: String(mergeErr?.message || mergeErr),
                  videoName: vName,
                  audioName: aName
                }
              });
            } catch (saveErr) {
              throw new Error(
                (mergeErr?.message || '合并失败') + '；分轨保存也失败: ' + (saveErr?.message || saveErr)
              );
            }
          }
          break;
        }
        case 'MERGE_PENDING_VIDEO': {
          const pending = window.__YT_DL_PENDING_VIDEO__;
          if (!pending?.blob?.size) throw new Error('没有缓存的视频轨（可能已过期）');
          sendProgress('merge', 5);
          const outName = e.data.filename || pending.filename || 'youtube.mp4';
          const base = String(outName).replace(/\.(mp4|webm|m4a|mkv)$/i, '');
          try {
            log(
              '合并',
              `待合并视频 ${ (pending.blob.size / 1024 / 1024).toFixed(2)}MB + 音频 ${((e.data.audioBuffer?.byteLength || 0) / 1024 / 1024).toFixed(2)}MB`
            );
            const aBlob = new Blob([e.data.audioBuffer], { type: 'audio/mp4' });
            const merged = await mergeM4sInPage(pending.blob, aBlob);
            sendProgress('save', 100);
            saveBlob(merged, outName);
            window.__YT_DL_PENDING_VIDEO__ = null;
            log('下载', `待合并视频 + background 音频 完成 → ${outName} · ${(merged.size / 1024 / 1024).toFixed(2)}MB`);
            reply(id, { type: 'OK', data: { merged: true, size: merged.size, filename: outName } });
          } catch (mergeErr) {
            log('合并', '失败 → 分别保存（无需重下）: ' + (mergeErr?.message || mergeErr));
            const vOnly = pending.videoOnlyFilename || base + '_video.mp4';
            const aName = base + '_audio.m4a';
            try {
              saveBlob(pending.blob, vOnly);
              if (e.data.audioBuffer?.byteLength) {
                saveBlob(new Blob([e.data.audioBuffer], { type: 'audio/mp4' }), aName);
              }
              window.__YT_DL_PENDING_VIDEO__ = null;
              sendProgress('save', 100);
              reply(id, {
                type: 'OK',
                data: {
                  savedTracks: true,
                  error: String(mergeErr?.message || mergeErr),
                  videoName: vOnly,
                  audioName: aName,
                  size: pending.blob.size
                }
              });
            } catch (saveErr) {
              throw new Error(
                (mergeErr?.message || '合并失败') + '；分轨保存也失败: ' + (saveErr?.message || saveErr)
              );
            }
          }
          break;
        }
        case 'SAVE_PENDING_VIDEO': {
          const pending = window.__YT_DL_PENDING_VIDEO__;
          if (e.data.clearOnly) {
            window.__YT_DL_PENDING_VIDEO__ = null;
            reply(id, { type: 'OK', data: { cleared: true } });
            break;
          }
          if (!pending?.blob?.size) throw new Error('没有缓存的视频轨');
          const name = e.data.filename || pending.videoOnlyFilename || 'video.mp4';
          saveBlob(pending.blob, name);
          const keep = !!e.data.keep;
          if (!keep) {
            window.__YT_DL_PENDING_VIDEO__ = null;
            sendProgress('save', 100);
            log('下载', `仅保存视频轨（音频最终失败）→ ${name}`);
          } else {
            log('下载', `视频轨先落盘（保留内存待合并）→ ${name} · ${(pending.blob.size / 1024 / 1024).toFixed(2)}MB`);
          }
          reply(id, {
            type: 'OK',
            data: { videoOnly: !keep, size: pending.blob.size, kept: keep, filename: name }
          });
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

  log('初始化', '页面代理已就绪 (MAIN world · 可下载)');
})();
