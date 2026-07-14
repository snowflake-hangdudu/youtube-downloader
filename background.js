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
/** transferId -> { buffer, tabId, at } 大文件分块回传暂存 */
const pendingTransfers = new Map();
let transferSeq = 0;
/**
 * Edge/Chrome：content←SW 的 ArrayBuffer structured clone 会变成空对象（已实测 4MB 也是 0B）。
 * 一律用 base64 字符串分块回传。
 */
const TRANSFER_CHUNK = 512 * 1024; // 二进制 512KB → base64 ~680KB / 消息

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

/** 去掉 range 后按 id|itag|clen 去重（旧逻辑 withFullRange 会把同一流变成 2 条候选，断线后白从头下） */
function gvDedupeKey(url) {
  try {
    const u = new URL(stripRangeQuery(url));
    return [
      u.hostname,
      u.searchParams.get('id') || '',
      u.searchParams.get('itag') || '',
      u.searchParams.get('clen') || ''
    ].join('|');
  } catch {
    return String(url);
  }
}

function expandUrls(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const u = stripRangeQuery(raw);
    if (!u) continue;
    const key = gvDedupeKey(u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  // 同高度只保留顺序；勿按 clen 倒序（会把更大的 WebM 排到 MP4 前面）
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

const STALL_NO_BYTE_MS = 45000; // 完全无字节 → 假死
const STALL_SLOW_WINDOW_MS = 20000; // 吞吐窗口
const STALL_SLOW_MIN_BYTES = 32 * 1024; // 窗口内增量不足 → 假死（防滴水连接永不换线）
const EXPECT_RATIO = 0.95; // 有已知体积时至少收满 95%
/** 小分块更贴播放器行为，也更容易在断线后续传单段 */
const CHUNK_SIZE = 2 * 1024 * 1024;
const PARALLEL_WORKERS = 6; // 同时飞行的 Range 数
const PARALLEL_MIN_BYTES = 2 * 1024 * 1024; // 小于此体积走单连接+续传
const MAX_RESUME_ATTEMPTS = 10; // 单次/单分片最大续传次数

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(2) + 'MB';
}

function isAbortErr(e, signal) {
  return e?.name === 'AbortError' || signal?.aborted || /下载已取消|Aborted/i.test(e?.message || '');
}

function isResumableErr(e) {
  const m = e?.message || String(e || '');
  if (/下载已取消|Aborted|HTTP 403|HTTP 401|HTTP 404|非媒体|忽略 Range|无法续传/i.test(m)) {
    return false;
  }
  return true;
}

function concatChunks(chunks, totalSize) {
  const size = totalSize != null ? totalSize : chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function peekMagicU8(u8, n = 8) {
  const len = Math.min(n, u8.byteLength);
  const head = u8.subarray(0, len);
  return Array.from(head)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/** 打到页面调试区（content 监听 YT_DL_BG_LOG） */
function tabLog(tabId, step, msg) {
  if (tabId == null) return;
  chrome.tabs
    .sendMessage(tabId, {
      type: 'YT_DL_BG_LOG',
      step: step || 'bg',
      msg: String(msg)
    })
    .catch(() => {});
}

function resolveExpectedTotal(res, url) {
  let total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
  const cr = res.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+)\s*$/);
  if (m) total = parseInt(m[1], 10) || total;
  if (!total) total = getClen(url) || 0;
  return total;
}

/** 带假死检测的 body 读取；中断时 err.partial = 已收字节 */
async function readBodyWithStall(res, signal, onBytes, stallMs = STALL_NO_BYTE_MS) {
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (onBytes) onBytes(buf.byteLength);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let lastByteAt = Date.now();
  let gotFirstByte = false;
  let windowStart = Date.now();
  let windowBytes = 0;
  let stallReason = null;

  const stallWatch = setInterval(() => {
    if (signal?.aborted || stallReason) return;
    const now = Date.now();
    if (now - lastByteAt > stallMs) {
      stallReason = `无数据>${Math.round(stallMs / 1000)}s`;
      try {
        reader.cancel('stall');
      } catch (_) {}
      return;
    }
    if (gotFirstByte && now - windowStart >= STALL_SLOW_WINDOW_MS) {
      if (windowBytes < STALL_SLOW_MIN_BYTES) {
        stallReason =
          `过慢 ${formatBytes(windowBytes)}/${Math.round(STALL_SLOW_WINDOW_MS / 1000)}s` +
          `（需≥${formatBytes(STALL_SLOW_MIN_BYTES)}）`;
        try {
          reader.cancel('stall');
        } catch (_) {}
        return;
      }
      windowStart = now;
      windowBytes = 0;
    }
  }, 2000);

  const assemble = () => concatChunks(chunks, size);

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      chunks.push(value);
      size += value.length;
      lastByteAt = Date.now();
      if (!gotFirstByte) {
        gotFirstByte = true;
        windowStart = Date.now();
        windowBytes = 0;
      }
      windowBytes += value.length;
      if (onBytes) onBytes(value.length);
    }
  } catch (e) {
    clearInterval(stallWatch);
    if (size > 0) e.partial = assemble();
    throw e;
  } finally {
    clearInterval(stallWatch);
  }

  if (stallReason) {
    const err = new Error(`下载假死（${stallReason}，已收 ${formatBytes(size)}）`);
    if (size > 0) err.partial = assemble();
    throw err;
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  return assemble();
}

function assertDownloadComplete(received, expected) {
  if (received < MIN_BYTES) {
    throw new Error(`下载过小 ${formatBytes(received)}（疑似空壳/错误页）`);
  }
  if (expected > MIN_BYTES && received < expected * EXPECT_RATIO) {
    const pct = Math.round((received / expected) * 100);
    throw new Error(
      `未收满 ${formatBytes(received)}/${formatBytes(expected)}（${pct}%，疑似断流/残片）`
    );
  }
}

function makeProgressTracker(onProgress, total, tabId) {
  let received = 0;
  let lastUi = 0;
  let lastTabPct = -1;
  return {
    add(n) {
      received += n;
      const now = Date.now();
      const percent = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
      if (now - lastUi >= 80 || percent >= 99 || received >= total) {
        lastUi = now;
        onProgress({ received, total, percent });
      }
      if (total && percent - lastTabPct >= 10) {
        lastTabPct = percent;
        tabLog(tabId, 'bg', `收流 ${formatBytes(received)}/${formatBytes(total)} · ${percent}%`);
      }
    },
    get received() {
      return received;
    }
  };
}

/** 拉取 [start, end]（含端点），支持中断后续传 */
async function fetchByteRange(url, start, end, signal, userAgent, tabId, onBytes) {
  const need = end - start + 1;
  const chunks = [];
  let got = 0;
  let tries = 0;

  while (got < need) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    tries += 1;
    if (tries > MAX_RESUME_ATTEMPTS) {
      throw new Error(`Range ${start}-${end} 续传超过 ${MAX_RESUME_ATTEMPTS} 次`);
    }
    const from = start + got;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: mediaHeaders({ Range: `bytes=${from}-${end}` }, userAgent),
        redirect: 'follow',
        credentials: 'omit',
        signal
      });
      if (!res.ok && res.status !== 206) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} · Range ${from}-${end} · ${t.slice(0, 40)}`);
      }
      // 非 0 偏移却回 200 = 忽略 Range；并行分片起始也必须是 206
      if (res.status === 200 && from > 0) {
        throw new Error('服务器忽略 Range，无法续传');
      }
      if (res.status === 206) {
        const cr = res.headers.get('content-range') || '';
        const cm = cr.match(/bytes\s+(\d+)-/i);
        if (cm && Number(cm[1]) !== from) {
          throw new Error(`Range 偏移不符 want=${from} got=${cm[1]}`);
        }
      }
      const type = res.headers.get('content-type') || '';
      if (!looksLikeMedia(type)) {
        throw new Error(`非媒体类型: ${type || '(空)'}`);
      }

      const piece = await readBodyWithStall(res, signal, onBytes);
      if (!piece.byteLength) throw new Error('空分片');
      chunks.push(piece);
      got += piece.byteLength;

      if (got < need) {
        tabLog(
          tabId,
          'bg',
          `Range 续传 ${from}+${formatBytes(piece.byteLength)} · 本段还差 ${formatBytes(need - got)}`
        );
      }
    } catch (e) {
      if (e.partial?.byteLength) {
        chunks.push(e.partial);
        got += e.partial.byteLength;
        delete e.partial;
      }
      if (isAbortErr(e, signal)) throw e;
      if (got > 0 && got < need && isResumableErr(e)) {
        tabLog(
          tabId,
          'bg',
          `Range 中断 @${start + got}（已 ${formatBytes(got)}/${formatBytes(need)}）重试: ${e.message || e}`
        );
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      throw e;
    }
  }

  if (got > need) {
    // 偶发多收：截断
    return concatChunks(chunks, need);
  }
  return concatChunks(chunks, got);
}

async function probeTotalSize(url, userAgent, signal) {
  const fromClen = getClen(url);
  if (fromClen > 0) return fromClen;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: mediaHeaders({ Range: 'bytes=0-0' }, userAgent),
      redirect: 'follow',
      credentials: 'omit',
      signal
    });
    const total = resolveExpectedTotal(res, url);
    try {
      await res.body?.cancel?.();
    } catch (_) {}
    return total || 0;
  } catch (_) {
    return 0;
  }
}

/** 单连接 + 断线 Range 续传（小文件 / 无总长时） */
async function fetchOneSequentialResumable(url, signal, onProgress, userAgent, tabId) {
  const clean = stripRangeQuery(url);
  tabLog(tabId, 'bg', `单连接+续传 GET ${String(clean).slice(0, 140)}`);
  const t0 = Date.now();
  let total = getClen(clean) || 0;
  const chunks = [];
  let received = 0;
  let attempt = 0;
  let lastTabPct = -1;

  const pushProgress = () => {
    const percent = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
    onProgress({ received, total, percent });
    if (total && percent - lastTabPct >= 10) {
      lastTabPct = percent;
      tabLog(tabId, 'bg', `收流 ${formatBytes(received)}/${formatBytes(total)} · ${percent}%`);
    }
  };

  onProgress({ received: 0, total, percent: 0 });

  while (true) {
    attempt += 1;
    if (attempt > MAX_RESUME_ATTEMPTS) {
      throw new Error(`续传超过 ${MAX_RESUME_ATTEMPTS} 次（已收 ${formatBytes(received)}）`);
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const rangeHdr = received > 0 ? { Range: `bytes=${received}-` } : null;
    if (received > 0) {
      tabLog(tabId, 'bg', `续传自 ${formatBytes(received)}` + (total ? `/${formatBytes(total)}` : ''));
    }

    try {
      const res = await fetch(clean, {
        method: 'GET',
        headers: mediaHeaders(rangeHdr, userAgent),
        redirect: 'follow',
        credentials: 'omit',
        signal
      });
      const type = res.headers.get('content-type') || '';
      tabLog(
        tabId,
        'bg',
        `响应 HTTP ${res.status} · type=${type || '(空)'} · cl=${res.headers.get('content-length') || '-'} · cr=${res.headers.get('content-range') || '-'}`
      );
      if (!res.ok && res.status !== 206) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} · ${t.slice(0, 60)}`);
      }
      if (res.status === 200 && received > 0) {
        throw new Error('服务器忽略 Range，无法续传');
      }
      if (!looksLikeMedia(type)) {
        throw new Error(`非媒体类型: ${type || '(空)'}`);
      }

      const expect = resolveExpectedTotal(res, clean);
      if (expect > total) total = expect;

      const piece = await readBodyWithStall(res, signal, (n) => {
        received += n;
        pushProgress();
      });
      chunks.push(piece);
      // received 已在 onBytes 里累加

      if (total && received < total * EXPECT_RATIO) {
        tabLog(
          tabId,
          'bg',
          `连接结束但未收满 ${formatBytes(received)}/${formatBytes(total)}，继续续传`
        );
        continue;
      }
      break;
    } catch (e) {
      if (e.partial?.byteLength) {
        chunks.push(e.partial);
        delete e.partial;
      }
      // onBytes 可能已累加但未入 chunks：统一按 chunks 重算，避免虚高/丢进度
      received = chunks.reduce((s, c) => s + c.byteLength, 0);
      pushProgress();
      if (isAbortErr(e, signal)) throw e;
      if (received > 0 && isResumableErr(e)) {
        tabLog(tabId, 'bg', `中断已收 ${formatBytes(received)}，准备续传: ${e.message || e}`);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw e;
    }
  }

  const body = concatChunks(chunks, received);
  assertDownloadComplete(body.byteLength, total);
  onProgress({ received: body.byteLength, total: total || body.byteLength, percent: 100 });
  tabLog(
    tabId,
    'bg',
    `收齐 ${formatBytes(body.byteLength)}` +
      (total ? `/${formatBytes(total)}` : '') +
      ` · ${Date.now() - t0}ms · magic=${peekMagicU8(body)} · 续传尝试=${attempt}`
  );
  return body.buffer;
}

/** 小分块池 + 多 worker 并行（比「4 等分大切片」更抗断线、更贴近播放器） */
async function fetchOneParallel(url, signal, onProgress, userAgent, tabId, total) {
  const clean = stripRangeQuery(url);
  const segments = [];
  for (let start = 0; start < total; start += CHUNK_SIZE) {
    const end = Math.min(total - 1, start + CHUNK_SIZE - 1);
    segments.push({ start, end, i: segments.length, buf: null });
  }
  const workers = Math.min(PARALLEL_WORKERS, segments.length);
  tabLog(
    tabId,
    'bg',
    `分块并行 ${segments.length} 段×${formatBytes(CHUNK_SIZE)} · 并发 ${workers} · 总计 ${formatBytes(total)}`
  );
  const t0 = Date.now();
  const tracker = makeProgressTracker(onProgress, total, tabId);
  onProgress({ received: 0, total, percent: 0 });

  let cursor = 0;
  let doneCount = 0;
  let failErr = null;

  async function worker(wid) {
    while (!failErr) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const idx = cursor++;
      if (idx >= segments.length) return;
      const seg = segments[idx];
      try {
        const buf = await fetchByteRange(
          clean,
          seg.start,
          seg.end,
          signal,
          userAgent,
          tabId,
          (n) => tracker.add(n)
        );
        if (buf.byteLength !== seg.end - seg.start + 1) {
          throw new Error(
            `块#${seg.i} 长度不符 ${formatBytes(buf.byteLength)} ≠ ${formatBytes(seg.end - seg.start + 1)}`
          );
        }
        seg.buf = buf;
        doneCount += 1;
        if (doneCount === 1 || doneCount === segments.length || doneCount % 5 === 0) {
          tabLog(
            tabId,
            'bg',
            `块进度 ${doneCount}/${segments.length} · w${wid} 完成 #${seg.i} ${formatBytes(buf.byteLength)}`
          );
        }
      } catch (e) {
        if (isAbortErr(e, signal)) throw e;
        failErr = e;
        throw e;
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
  } catch (e) {
    if (isAbortErr(e, signal)) throw e;
    // 已完成的块保留不了给外层（回退单连接），打日志便于对照
    tabLog(
      tabId,
      'bg',
      `并行中断 · 已完成块 ${doneCount}/${segments.length} · ${e.message || e}`
    );
    throw e;
  }

  const buffers = segments.map((s) => s.buf);
  const body = concatChunks(buffers, total);
  assertDownloadComplete(body.byteLength, total);
  onProgress({ received: body.byteLength, total, percent: 100 });
  tabLog(
    tabId,
    'bg',
    `并行收齐 ${formatBytes(body.byteLength)}/${formatBytes(total)} · ${Date.now() - t0}ms · magic=${peekMagicU8(body)}`
  );
  log('fetch OK parallel', formatBytes(body.byteLength) + ' · ' + segments.length + ' chunks');
  return body.buffer;
}

/** 入口：大文件并行，小文件/未知体积单连接+续传 */
async function fetchOne(url, signal, onProgress, userAgent, tabId) {
  const clean = stripRangeQuery(url);
  let total = 0;
  try {
    total = await probeTotalSize(clean, userAgent, signal);
  } catch (e) {
    if (isAbortErr(e, signal)) throw e;
  }

  if (total >= PARALLEL_MIN_BYTES) {
    try {
      return await fetchOneParallel(url, signal, onProgress, userAgent, tabId, total);
    } catch (e) {
      if (isAbortErr(e, signal)) throw e;
      tabLog(tabId, 'bg', `并行失败，回退单连接+续传: ${e.message || e}`);
      return fetchOneSequentialResumable(url, signal, onProgress, userAgent, tabId);
    }
  }
  return fetchOneSequentialResumable(url, signal, onProgress, userAgent, tabId);
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
  const uaChain = [];
  if (userAgent) uaChain.push(userAgent);
  if (!userAgent || userAgent !== CHROME_UA) uaChain.push(CHROME_UA);

  tabLog(
    tabId,
    'bg',
    `开始 · 原始 ${(urls || []).length} 条 → 去重 ${list.length} 条 · UA链=${uaChain.length}` +
      ` · 首UA=${String(uaChain[0] || 'default').slice(0, 40)}`
  );

  // 只快速探测前 2 条
  const probes = [];
  for (const u of list.slice(0, 2)) {
    const p = await probeUrl(u, uaChain[0] || null);
    probes.push(p);
    tabLog(
      tabId,
      'probe',
      `#${probes.length - 1} ${p.ok ? 'OK' : 'FAIL'} status=${p.status || p.error || '?'} sample=${p.sampleBytes || 0}b · ${String(u).slice(0, 120)}`
    );
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
  tabLog(
    tabId,
    'bg',
    `候选顺序 ${ordered.length} 条 · clen=[${ordered.map((u) => formatBytes(getClen(u) || 0)).join(', ')}]`
  );

  let lastErr = null;
  for (let i = 0; i < ordered.length; i++) {
    const url = ordered[i];
    for (let ui = 0; ui < uaChain.length; ui++) {
      const ua = uaChain[ui];
      log(`try fetch ${i + 1}/${ordered.length} ua${ui}`, String(url).slice(0, 100));
      tabLog(
        tabId,
        'bg',
        `尝试候选 ${i + 1}/${ordered.length}` +
          (uaChain.length > 1 ? ` · UA#${ui}` : '') +
          ` · clen=${formatBytes(getClen(url) || 0)}`
      );
      try {
        const buffer = await fetchOne(url, ac.signal, sendProgress, ua, tabId);
        activeFetches.delete(tabId);
        tabLog(tabId, 'bg', `候选 #${i} 成功 · ${formatBytes(buffer.byteLength)}`);
        return { mode: 'buffer', buffer, probes, usedIndex: i };
      } catch (e) {
        if (e.name === 'AbortError' || ac.signal.aborted) {
          activeFetches.delete(tabId);
          throw new Error('下载已取消');
        }
        lastErr = e;
        log('fetch fail', e.message || e);
        tabLog(tabId, 'bg', `候选 #${i} UA#${ui} 失败: ${e.message || e}`);
        // 403/忽略 Range 换 UA；纯 network 也允许换 UA 再试同一 URL
        if (/HTTP 403|HTTP 401|忽略 Range/i.test(e.message || '') && ui < uaChain.length - 1) {
          continue;
        }
        if (isResumableErr(e) && ui < uaChain.length - 1) {
          tabLog(tabId, 'bg', '同 URL 换 UA 再试');
          continue;
        }
        break;
      }
    }
  }

  // 仅对 probe 成功的 URL 尝试 downloads，并校验体积
  const good = [];
  probes.forEach((p, i) => {
    if (p.ok && list[i]) good.push(list[i]);
  });

  if (good.length) {
    tabLog(tabId, 'bg', `fetch 全挂 → chrome.downloads 兜底 ${good.length} 条`);
  }

  for (let i = 0; i < good.length; i++) {
    const url = good[i];
    log(`try downloads ${i + 1}/${good.length}`, String(url).slice(0, 100));
    tabLog(tabId, 'bg', `downloads API ${i + 1}/${good.length}`);
    try {
      sendProgress({ received: 0, total: 0, percent: 5 });
      const saved = await downloadsApiSave(url, filename);
      activeFetches.delete(tabId);
      sendProgress({
        received: saved.size,
        total: saved.size,
        percent: 100
      });
      tabLog(tabId, 'bg', `downloads 成功 · id=${saved.id} · ${formatBytes(saved.size)}`);
      return { mode: 'downloads', downloadId: saved.id, size: saved.size, probes };
    } catch (e) {
      lastErr = e;
      log('downloads fail', e.message || e);
      tabLog(tabId, 'bg', `downloads 失败: ${e.message || e}`);
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
      const buf = await fetchOne(url, ac.signal, () => {}, userAgent, tabId);
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

function pruneTransfers() {
  const now = Date.now();
  for (const [k, v] of pendingTransfers) {
    if (now - (v.at || 0) > 15 * 60 * 1000) pendingTransfers.delete(k);
  }
}

function storeTransfer(buffer, tabId) {
  pruneTransfers();
  const id = 't' + Date.now() + '_' + ++transferSeq;
  const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
  pendingTransfers.set(id, { buffer: ab, tabId, at: Date.now() });
  return id;
}

/** ArrayBuffer → base64（分段 fromCharCode，避免大 apply 爆栈） */
function abToBase64(ab) {
  const u8 = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
  const step = 0x8000;
  let s = '';
  for (let i = 0; i < u8.length; i += step) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + step, u8.length)));
  }
  return btoa(s);
}

/**
 * 不向 content 直传 ArrayBuffer（本环境会丢成空对象）。
 * 只回传 chunked 元数据，content 再按片取 base64。
 */
function respondWithBuffer(sendResponse, buffer, extra = {}) {
  const { tabId, ...rest } = extra;
  const ab = buffer instanceof ArrayBuffer ? buffer : null;
  const size = ab ? ab.byteLength : 0;
  if (!ab || size <= 0) {
    sendResponse({ ok: false, error: '空 buffer', ...rest });
    return;
  }
  const transferId = storeTransfer(ab, tabId);
  const chunkSize = TRANSFER_CHUNK;
  const chunks = Math.ceil(size / chunkSize);
  if (tabId != null) {
    tabLog(
      tabId,
      'bg',
      `回传 base64 分块 · ${formatBytes(size)} · ${chunks}×${formatBytes(chunkSize)} · id=${transferId}`
    );
  }
  log('respond base64-chunked', transferId, formatBytes(size), chunks);
  sendResponse({
    ok: true,
    mode: 'chunked',
    encoding: 'base64',
    transferId,
    size,
    chunkSize,
    chunks,
    ...rest
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'YT_DL_BG_ABORT') {
    const tabId = sender.tab?.id ?? msg.tabId;
    if (tabId != null) abortTab(tabId);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'YT_DL_BG_GET_CHUNK') {
    const ent = pendingTransfers.get(msg.transferId);
    if (!ent?.buffer) {
      sendResponse({ ok: false, error: 'transfer 不存在或已释放' });
      return;
    }
    const chunkSize = Number(msg.chunkSize) || TRANSFER_CHUNK;
    const index = Number(msg.index) || 0;
    const start = index * chunkSize;
    if (start >= ent.buffer.byteLength) {
      sendResponse({ ok: false, error: 'chunk index 越界' });
      return;
    }
    const end = Math.min(ent.buffer.byteLength, start + chunkSize);
    const slice = ent.buffer.slice(start, end);
    try {
      const data = abToBase64(slice);
      sendResponse({
        ok: true,
        index,
        encoding: 'base64',
        data,
        byteLength: slice.byteLength
      });
    } catch (e) {
      sendResponse({ ok: false, error: 'base64 编码失败: ' + (e.message || e) });
    }
    return;
  }

  if (msg.type === 'YT_DL_BG_RELEASE') {
    if (msg.transferId) pendingTransfers.delete(msg.transferId);
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
        respondWithBuffer(sendResponse, result.buffer, {
          tabId,
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
        respondWithBuffer(sendResponse, result.buffer, {
          tabId,
          filename: msg.filename || 'youtube.mp4',
          usedIndex: result.usedIndex,
          probes: result.probes
        });
      })
      .catch((e) => {
        const error = e?.message || String(e);
        log('FETCH ERR', error);
        tabLog(tabId, 'bg', `FETCH ERR: ${error}`);
        sendResponse({ ok: false, error });
      });

    return true;
  }
});
