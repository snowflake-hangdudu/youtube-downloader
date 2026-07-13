/**
 * MV3 Service Worker
 * 拉取 googlevideo；严禁把空文件 / 错误页当成成功。
 */
chrome.runtime.onInstalled.addListener(() => {
  const v = chrome.runtime.getManifest().version;
  console.log('[YtDL] 已安装 v' + v);
});

const activeFetches = new Map();
const MIN_BYTES = 50 * 1024; // 小于 50KB 视为失败（排除 1B 空壳）
/** tabId -> [{url, itag, at, status}] 播放器真实 googlevideo */
const tabSniff = new Map();

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function log(...args) {
  console.log('[YtDL:bg]', ...args);
}

function stripRangeParams(url) {
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

function extractItagFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    let itag = u.searchParams.get('itag');
    if (itag) return String(itag);
    const m =
      u.pathname.match(/\/itag\/(\d+)/i) ||
      String(rawUrl).match(/[/]itag[/](\d+)/i);
    return m ? String(m[1]) : null;
  } catch {
    const m = String(rawUrl).match(/[/?&]itag[=/](\d+)/i);
    return m ? String(m[1]) : null;
  }
}

function rememberTabGv(tabId, url, status) {
  if (tabId == null || !url || !/googlevideo\.com/i.test(url)) return;
  if (!/\/videoplayback|\/initplayback|\/itag\/\d+|[?&]itag=/i.test(url)) return;
  if (status != null && status !== 200 && status !== 206) return;
  const itag = extractItagFromUrl(url);
  const clean = stripRangeParams(url);
  let list = tabSniff.get(tabId);
  if (!list) {
    list = [];
    tabSniff.set(tabId, list);
  }
  list.unshift({ url: clean, itag, at: Date.now(), status: status || 0 });
  if (list.length > 60) list.length = 60;
}

try {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      rememberTabGv(details.tabId, details.url, details.statusCode);
    },
    { urls: ['*://*.googlevideo.com/*'] }
  );
} catch (e) {
  log('webRequest 监听失败', e?.message || e);
}

function getSniffedForTab(tabId, itag) {
  const list = tabSniff.get(tabId) || [];
  const want = itag != null && itag !== '' ? String(itag) : null;
  const ranked = list
    .filter((e) => !want || String(e.itag) === want)
    .sort((a, b) => {
      const ag = a.status === 200 || a.status === 206 ? 1 : 0;
      const bg = b.status === 200 || b.status === 206 ? 1 : 0;
      if (ag !== bg) return bg - ag;
      return b.at - a.at;
    });
  const out = [];
  const seen = new Set();
  for (const e of ranked) {
    if (!e.url || seen.has(e.url)) continue;
    // 只要成功的（200/206）；status 缺失也保留作兜底
    if (e.status && e.status !== 200 && e.status !== 206) continue;
    seen.add(e.url);
    out.push(e.url);
    if (out.length >= 12) break;
  }
  return out;
}

function abortTab(tabId) {
  const c = activeFetches.get(tabId);
  if (c) {
    try {
      c.abort();
    } catch (_) {}
    activeFetches.delete(tabId);
  }
}

function mediaHeaders(extra, userAgent) {
  return {
    'User-Agent': userAgent || CHROME_UA,
    Referer: 'https://www.youtube.com/',
    Origin: 'https://www.youtube.com/',
    ...(extra || {})
  };
}

function looksLikeMedia(contentType) {
  const t = (contentType || '').toLowerCase();
  if (!t) return true; // 有的节点不回 content-type
  if (t.includes('text/html') || t.includes('text/plain') || t.includes('application/json')) return false;
  return (
    t.includes('video/') ||
    t.includes('audio/') ||
    t.includes('mpegurl') ||
    t.includes('octet-stream') ||
    t.includes('mp4') ||
    t.includes('webm')
  );
}

/** 用 clen 补全 range=0-(clen-1)，部分节点对完整 GET 更友好 */
function withFullRange(url) {
  try {
    const u = new URL(url);
    const clen = u.searchParams.get('clen');
    if (clen && /^\d+$/.test(clen) && Number(clen) > 1024) {
      u.searchParams.set('range', '0-' + (Number(clen) - 1));
      return u.toString();
    }
  } catch (_) {}
  return null;
}

function expandUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const url of urls) {
    for (const u of [url, withFullRange(url)]) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

const MIN_PROBE_BYTES = 512;

async function probeUrl(url, userAgent) {
  const short = String(url).slice(0, 140);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: mediaHeaders({ Range: 'bytes=0-2047' }, userAgent),
      redirect: 'follow',
      credentials: 'omit'
    });
    const type = res.headers.get('content-type') || '';
    const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
    const info = {
      ok:
        (res.ok || res.status === 206) &&
        looksLikeMedia(type) &&
        buf.byteLength >= MIN_PROBE_BYTES,
      status: res.status,
      type,
      sampleBytes: buf.byteLength,
      len: res.headers.get('content-length') || res.headers.get('content-range') || '',
      url: short
    };
    log('probe', JSON.stringify(info));
    return info;
  } catch (e) {
    const info = { ok: false, error: e.message || String(e), name: e.name, url: short };
    log('probe fail', JSON.stringify(info));
    return info;
  }
}

function getClen(url) {
  try {
    const c = new URL(url).searchParams.get('clen');
    if (c && /^\d+$/.test(c)) return Number(c);
  } catch (_) {}
  return 0;
}

function stripRangeQuery(url) {
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

const STALL_MS = 45000; // 长时间无字节 → 判为假死

/** 带假死检测的 body 读取 */
async function readBodyWithStall(res, signal, onBytes, stallMs = STALL_MS) {
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (onBytes) onBytes(buf.byteLength);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let lastByteAt = Date.now();
  let stalled = false;

  const stallWatch = setInterval(() => {
    if (signal?.aborted) return;
    if (Date.now() - lastByteAt > stallMs) {
      stalled = true;
      try {
        reader.cancel('stall');
      } catch (_) {}
    }
  }, 3000);

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      lastByteAt = Date.now();
      if (onBytes) onBytes(value.length);
    }
  } finally {
    clearInterval(stallWatch);
  }

  if (stalled) {
    throw new Error(`下载假死（>${Math.round(stallMs / 1000)}s 无数据）`);
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function fetchOneSequential(url, signal, onProgress, userAgent) {
  const clean = stripRangeQuery(url);
  const res = await fetch(clean, {
    method: 'GET',
    headers: mediaHeaders(null, userAgent),
    redirect: 'follow',
    credentials: 'omit',
    signal
  });

  const type = res.headers.get('content-type') || '';
  if (!res.ok && res.status !== 206) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} · ${String(url).slice(0, 90)} · ${t.slice(0, 60)}`);
  }
  if (!looksLikeMedia(type)) {
    throw new Error(`非媒体类型: ${type || '(空)'} · ${String(url).slice(0, 80)}`);
  }

  const total = parseInt(res.headers.get('content-length') || '0', 10) || getClen(clean) || 0;
  onProgress({ received: 0, total, percent: 0 });

  let received = 0;
  let lastUi = 0;
  const body = await readBodyWithStall(res, signal, (n) => {
    received += n;
    const now = Date.now();
    if (now - lastUi < 100 && received < total) return;
    lastUi = now;
    onProgress({
      received,
      total,
      percent: total ? Math.min(99, Math.round((received / total) * 100)) : 0
    });
  });

  received = body.byteLength;
  if (received < MIN_BYTES) {
    throw new Error(`下载过小 ${received} bytes（疑似空壳/错误页）`);
  }
  onProgress({ received, total: total || received, percent: 100 });
  log('fetch OK', (received / 1024 / 1024).toFixed(2) + 'MB · ' + type);
  return body.buffer;
}

/** 单连接顺序下载（不做 Range 并行分片） */
async function fetchOne(url, signal, onProgress, userAgent) {
  return fetchOneSequential(url, signal, onProgress, userAgent);
}

function waitDownloadComplete(downloadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChange);
      reject(new Error('downloads 超时'));
    }, timeoutMs || 600000);

    function onChange(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChange);
        chrome.downloads.search({ id: downloadId }, (items) => {
          const it = items && items[0];
          resolve(it || { id: downloadId, fileSize: 0 });
        });
      } else if (delta.state?.current === 'interrupted') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChange);
        reject(new Error('downloads 中断: ' + (delta.error?.current || 'unknown')));
      }
    }
    chrome.downloads.onChanged.addListener(onChange);
  });
}

async function downloadsApiSave(url, filename) {
  if (!chrome.downloads?.download) throw new Error('无 downloads 权限');

  const id = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: filename || 'youtube.mp4',
        conflictAction: 'uniquify',
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId == null) {
          reject(new Error(chrome.runtime.lastError?.message || 'downloads.download 失败'));
          return;
        }
        resolve(downloadId);
      }
    );
  });

  log('downloads started', id);
  const item = await waitDownloadComplete(id, 600000);
  const size = Number(item.fileSize) || 0;
  log('downloads done', { id, size, exists: item.exists, mime: item.mime });

  if (size < MIN_BYTES) {
    try {
      chrome.downloads.removeFile(id, () => {});
      chrome.downloads.erase({ id }, () => {});
    } catch (_) {}
    throw new Error(`downloads 文件过小 ${size} bytes（已删除空壳）`);
  }
  return { id, size };
}

async function downloadWithFallback(urls, tabId, filename, sendProgress, userAgent) {
  abortTab(tabId);
  const ac = new AbortController();
  activeFetches.set(tabId, ac);

  const list = expandUrls(urls);
  // 只快速探测前 2 条，避免启动慢
  const probes = [];
  for (const u of list.slice(0, 2)) {
    probes.push(await probeUrl(u, userAgent));
  }

  const ordered = [];
  const seen = new Set();
  probes.forEach((p, i) => {
    if (p.ok && list[i] && !seen.has(list[i])) {
      seen.add(list[i]);
      ordered.push(list[i]);
    }
  });
  list.forEach((u) => {
    if (!seen.has(u)) {
      seen.add(u);
      ordered.push(u);
    }
  });

  let lastErr = null;
  for (let i = 0; i < ordered.length; i++) {
    const url = ordered[i];
    log(`try fetch ${i + 1}/${ordered.length}`, String(url).slice(0, 100));
    try {
      const buffer = await fetchOne(url, ac.signal, sendProgress, userAgent);
      activeFetches.delete(tabId);
      return { mode: 'buffer', buffer, probes, usedIndex: i };
    } catch (e) {
      if (e.name === 'AbortError' || ac.signal.aborted) {
        activeFetches.delete(tabId);
        throw new Error('下载已取消');
      }
      lastErr = e;
      log('fetch fail', e.message || e);
    }
  }

  // 仅对 probe 成功的 URL 尝试 downloads，并校验体积
  const good = [];
  probes.forEach((p, i) => {
    if (p.ok && list[i]) good.push(list[i]);
  });

  for (let i = 0; i < good.length; i++) {
    const url = good[i];
    log(`try downloads ${i + 1}/${good.length}`, String(url).slice(0, 100));
    try {
      sendProgress({ received: 0, total: 0, percent: 5 });
      const saved = await downloadsApiSave(url, filename);
      activeFetches.delete(tabId);
      sendProgress({
        received: saved.size,
        total: saved.size,
        percent: 100
      });
      return { mode: 'downloads', downloadId: saved.id, size: saved.size, probes };
    } catch (e) {
      lastErr = e;
      log('downloads fail', e.message || e);
    }
  }

  activeFetches.delete(tabId);
  const probeSummary = probes
    .map((p, i) => `#${i}:${p.status || p.error || '?'}(${p.sampleBytes || 0}b)`)
    .join(' ');
  throw new Error(
    (lastErr && lastErr.message ? lastErr.message : '全部候选失败') +
      ' | probe: ' +
      probeSummary
  );
}

async function fetchConcatSegments(urls, tabId, sendProgress, userAgent) {
  abortTab(tabId);
  const ac = new AbortController();
  activeFetches.set(tabId, ac);
  const list = (urls || []).filter(Boolean);
  if (!list.length) throw new Error('分片 urls 为空');

  const chunks = [];
  let received = 0;
  for (let i = 0; i < list.length; i++) {
    if (ac.signal.aborted) throw new Error('下载已取消');
    const url = list[i];
    log(`concat ${i + 1}/${list.length}`, String(url).slice(0, 100));
    try {
      const buf = await fetchOne(url, ac.signal, () => {}, userAgent);
      chunks.push(new Uint8Array(buf));
      received += buf.byteLength;
      sendProgress({
        received,
        total: 0,
        percent: Math.min(99, Math.round(((i + 1) / list.length) * 100))
      });
    } catch (e) {
      if (e.name === 'AbortError' || ac.signal.aborted) throw new Error('下载已取消');
      log('concat fail', e.message || e);
      if (i < 2 || chunks.length < 2) throw e;
    }
  }
  activeFetches.delete(tabId);
  if (!chunks.length) throw new Error('全部分片失败');
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  sendProgress({ received: total, total, percent: 100 });
  log('concat OK', (total / 1024 / 1024).toFixed(2) + 'MB · ' + chunks.length + ' segs');
  const isTs = out[0] === 0x47;
  return {
    buffer: out.buffer,
    mime: isTs ? 'video/mp2t' : 'video/mp4',
    ext: isTs ? 'ts' : 'mp4'
  };
}

/** 向页面推进度；节流避免消息风暴，0%/100% 必达 */
function makeThrottledProgress(tabId, step) {
  let last = 0;
  let lastPct = -1;
  return (p) => {
    const now = Date.now();
    const pct = Number(p?.percent) || 0;
    // 0%、100%、百分比跳变：立即推；否则约 80ms 节流
    const must = pct <= 0 || pct >= 100 || Math.abs(pct - lastPct) >= 1;
    if (!must && now - last < 80) return;
    last = now;
    lastPct = pct;
    chrome.tabs
      .sendMessage(tabId, {
        type: 'YT_DL_BG_PROGRESS',
        step: step || 'download',
        percent: p.percent,
        received: p.received,
        total: p.total
      })
      .catch(() => {});
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'YT_DL_BG_ABORT') {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (tabId != null) abortTab(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'YT_DL_GET_SNIFFED') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, urls: [] });
      return;
    }
    const urls = getSniffedForTab(tabId, msg.itag);
    const any = getSniffedForTab(tabId, null);
    sendResponse({
      ok: true,
      urls,
      any,
      itags: [...new Set((tabSniff.get(tabId) || []).map((e) => e.itag).filter(Boolean))]
    });
    return;
  }

  if (msg.type === 'YT_DL_BG_FETCH_CONCAT') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: '无 tabId' });
      return true;
    }
    const urls = (msg.urls || []).filter(Boolean);
    if (!urls.length) {
      sendResponse({ ok: false, error: 'urls 为空' });
      return true;
    }
    const pushProgress = makeThrottledProgress(tabId, msg.step || 'download');
    fetchConcatSegments(urls, tabId, pushProgress, msg.userAgent || null)
      .then((result) => {
        let filename = msg.filename || 'youtube.mp4';
        if (result.ext === 'ts' && /\.mp4$/i.test(filename)) {
          filename = filename.replace(/\.mp4$/i, '.ts');
        }
        sendResponse({
          ok: true,
          mode: 'buffer',
          buffer: result.buffer,
          filename,
          mime: result.mime
        });
      })
      .catch((e) => {
        const error = e?.message || String(e);
        log('CONCAT ERR', error);
        sendResponse({ ok: false, error });
      });
    return true;
  }

  if (msg.type === 'YT_DL_BG_FETCH') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: '无 tabId' });
      return true;
    }
    const urls = (msg.urls || []).filter(Boolean);
    if (!urls.length) {
      sendResponse({ ok: false, error: 'urls 为空' });
      return true;
    }

    const pushProgress = makeThrottledProgress(tabId, msg.step || 'download');

    downloadWithFallback(urls, tabId, msg.filename || 'youtube.mp4', pushProgress, msg.userAgent || null)
      .then((result) => {
        if (result.mode === 'downloads') {
          sendResponse({
            ok: true,
            mode: 'downloads',
            downloadId: result.downloadId,
            size: result.size,
            filename: msg.filename || 'youtube.mp4',
            probes: result.probes
          });
          return;
        }
        sendResponse({
          ok: true,
          mode: 'buffer',
          buffer: result.buffer,
          filename: msg.filename || 'youtube.mp4',
          usedIndex: result.usedIndex,
          probes: result.probes
        });
      })
      .catch((e) => {
        const error = e?.message || String(e);
        log('FETCH ERR', error);
        sendResponse({ ok: false, error });
      });

    return true;
  }
});
