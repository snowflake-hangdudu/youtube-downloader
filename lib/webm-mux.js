/**
 * 纯 JS 合并两路 WebM（YouTube DASH：VP9/AV1 视频 + Opus 音频 → 可播 .webm）
 * 无损 remux：不解码。无 FFmpeg。
 *
 * 用法：YtWebmMux.mergeWebm(videoBuf, audioBuf, { log })
 */
(function (global) {
  'use strict';

  const ID = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    SeekHead: 0x114d9b74,
    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    Duration: 0x4489,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackUID: 0x73c5,
    TrackType: 0x83,
    CodecID: 0x86,
    Cluster: 0x1f43b675,
    Timecode: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    Cues: 0x1c53bb6b,
    Void: 0xec
  };

  /** Element ID：整段字节即 ID（含长度标记位），不能按 size vint 剥位 */
  function readId(u8, offset) {
    if (offset >= u8.length) throw new Error('WebM ID 越界');
    const b0 = u8[offset];
    if (b0 === 0) throw new Error('WebM ID 非法');
    let length = 1;
    let mask = 0x80;
    while (length <= 4 && !(b0 & mask)) {
      length++;
      mask >>= 1;
    }
    if (length > 4 || offset + length > u8.length) throw new Error('WebM ID 长度非法');
    let value = 0;
    for (let i = 0; i < length; i++) value = value * 256 + u8[offset + i];
    return { length, value, end: offset + length };
  }

  function readVint(u8, offset) {
    if (offset >= u8.length) throw new Error('WebM vint 越界');
    const b0 = u8[offset];
    if (b0 === 0) throw new Error('WebM vint 非法');
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(b0 & mask)) {
      length++;
      mask >>= 1;
    }
    if (length > 8 || offset + length > u8.length) throw new Error('WebM vint 长度非法');
    let value = b0 & (mask - 1);
    for (let i = 1; i < length; i++) value = value * 256 + u8[offset + i];
    const maxData = Math.pow(2, 7 * length) - 1;
    return { length, value, unknown: value === maxData, end: offset + length };
  }

  function writeVint(value, minLen) {
    if (!Number.isFinite(value) || value < 0) throw new Error('WebM vint 值非法');
    let length = 1;
    while (length <= 8 && value >= Math.pow(2, 7 * length)) length++;
    if (minLen && length < minLen) length = minLen;
    if (length > 8) throw new Error('WebM vint 过大');
    const bytes = new Uint8Array(length);
    let v = value;
    for (let i = length - 1; i >= 0; i--) {
      bytes[i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    bytes[0] |= 1 << (8 - length);
    return bytes;
  }

  function writeId(id) {
    if (id <= 0xff) return Uint8Array.of(id);
    if (id <= 0xffff) return Uint8Array.of((id >> 8) & 0xff, id & 0xff);
    if (id <= 0xffffff) return Uint8Array.of((id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
    return Uint8Array.of((id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff);
  }

  function concatBytes(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function encodeElement(id, data) {
    const idb = writeId(id);
    const body = data instanceof Uint8Array ? data : concatBytes(data);
    return concatBytes([idb, writeVint(body.length), body]);
  }

  function readElement(u8, offset, forceEnd) {
    const idv = readId(u8, offset);
    const size = readVint(u8, idv.end);
    const dataStart = size.end;
    let dataEnd;
    if (size.unknown) {
      dataEnd = forceEnd != null ? forceEnd : u8.length;
    } else {
      dataEnd = dataStart + size.value;
      if (dataEnd > u8.length) throw new Error('WebM 元素越界 id=0x' + idv.value.toString(16));
    }
    return {
      id: idv.value,
      start: offset,
      dataStart,
      dataEnd,
      end: dataEnd,
      data: u8.subarray(dataStart, dataEnd)
    };
  }

  function walkChildren(u8, start, end, fn) {
    let o = start;
    while (o < end) {
      if (o + 1 >= end) break;
      try {
        const el = readElement(u8, o, end);
        fn(el);
        o = el.end;
      } catch (_) {
        break;
      }
    }
  }

  function parseWebm(buf, label) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 4 || u8[0] !== 0x1a || u8[1] !== 0x45 || u8[2] !== 0xdf || u8[3] !== 0xa3) {
      throw new Error((label || '文件') + ' 不是 WebM（缺 EBML 头）');
    }
    const ebml = readElement(u8, 0);
    if (ebml.id !== ID.EBML) {
      throw new Error(
        (label || '文件') +
          ' EBML 头异常 id=0x' +
          ebml.id.toString(16) +
          '（期望 1a45dfa3）'
      );
    }

    let segment = null;
    walkChildren(u8, ebml.end, u8.length, (el) => {
      if (el.id === ID.Segment && !segment) segment = el;
    });
    if (!segment) throw new Error((label || '文件') + ' 无 Segment');

    const info = { raw: null, timecodeScale: 1000000, duration: 0 };
    const trackEntries = [];
    const clusters = [];

    walkChildren(u8, segment.dataStart, segment.dataEnd, (el) => {
      if (el.id === ID.Info) {
        info.raw = el.data;
        walkChildren(u8, el.dataStart, el.dataEnd, (c) => {
          if (c.id === ID.TimecodeScale) {
            let v = 0;
            for (let i = c.dataStart; i < c.dataEnd; i++) v = v * 256 + u8[i];
            info.timecodeScale = v || 1000000;
          } else if (c.id === ID.Duration) {
            const dv = new DataView(u8.buffer, u8.byteOffset + c.dataStart, c.dataEnd - c.dataStart);
            if (c.dataEnd - c.dataStart === 4) info.duration = dv.getFloat32(0);
            else if (c.dataEnd - c.dataStart === 8) info.duration = dv.getFloat64(0);
          }
        });
      } else if (el.id === ID.Tracks) {
        walkChildren(u8, el.dataStart, el.dataEnd, (c) => {
          if (c.id === ID.TrackEntry) {
            const meta = { raw: elRawSlice(u8, c), number: 1, type: 0, codec: '' };
            walkChildren(u8, c.dataStart, c.dataEnd, (t) => {
              if (t.id === ID.TrackNumber) {
                let v = 0;
                for (let i = t.dataStart; i < t.dataEnd; i++) v = v * 256 + u8[i];
                meta.number = v;
              } else if (t.id === ID.TrackType) {
                meta.type = u8[t.dataStart];
              } else if (t.id === ID.CodecID) {
                meta.codec = String.fromCharCode.apply(null, u8.subarray(t.dataStart, t.dataEnd));
              }
            });
            trackEntries.push(meta);
          }
        });
      } else if (el.id === ID.Cluster) {
        let tc = 0;
        // Timecode 通常是 Cluster 第一个子元素
        walkChildren(u8, el.dataStart, Math.min(el.dataStart + 32, el.dataEnd), (c) => {
          if (c.id === ID.Timecode && tc === 0) {
            let v = 0;
            for (let i = c.dataStart; i < c.dataEnd; i++) v = v * 256 + u8[i];
            tc = v;
          }
        });
        clusters.push({
          timecode: tc,
          raw: u8.subarray(el.start, el.end),
          dataStart: el.dataStart,
          dataEnd: el.dataEnd,
          start: el.start,
          end: el.end,
          u8
        });
      }
    });

    return { u8, ebml, segment, info, trackEntries, clusters };
  }

  function elRawSlice(u8, el) {
    return u8.subarray(el.start, el.end);
  }

  function readTrackNumberFromBlock(data) {
    return readVint(data, 0);
  }

  function rewriteBlockTrack(blockData, newTrack) {
    const tn = readTrackNumberFromBlock(blockData);
    const newTn = writeVint(newTrack);
    const out = new Uint8Array(newTn.length + (blockData.length - tn.length));
    out.set(newTn, 0);
    out.set(blockData.subarray(tn.length), newTn.length);
    return out;
  }

  function remapCluster(cluster, newTrackNumber, log) {
    const src = cluster.u8;
    const parts = [];
    let changed = 0;
    walkChildren(src, cluster.dataStart, cluster.dataEnd, (el) => {
      if (el.id === ID.SimpleBlock || el.id === ID.Block) {
        const rewritten = rewriteBlockTrack(el.data, newTrackNumber);
        parts.push(encodeElement(el.id, rewritten));
        changed++;
      } else if (el.id === ID.BlockGroup) {
        const kids = [];
        walkChildren(src, el.dataStart, el.dataEnd, (c) => {
          if (c.id === ID.Block) {
            kids.push(encodeElement(ID.Block, rewriteBlockTrack(c.data, newTrackNumber)));
            changed++;
          } else {
            kids.push(src.subarray(c.start, c.end));
          }
        });
        parts.push(encodeElement(ID.BlockGroup, concatBytes(kids)));
      } else {
        parts.push(src.subarray(el.start, el.end));
      }
    });
    if (log && changed) log('WebM mux', `Cluster@${cluster.timecode} 重映射 ${changed} blocks → track ${newTrackNumber}`);
    return encodeElement(ID.Cluster, concatBytes(parts));
  }

  function rewriteTrackEntry(entryRaw, newNumber, newUid) {
    const u8 = entryRaw;
    // entryRaw 含 TrackEntry 整元素；取其 data 重写子字段
    const el = readElement(u8, 0);
    if (el.id !== ID.TrackEntry) throw new Error('期望 TrackEntry');
    const kids = [];
    walkChildren(u8, el.dataStart, el.dataEnd, (c) => {
      if (c.id === ID.TrackNumber) {
        kids.push(encodeElement(ID.TrackNumber, writeUnsigned(newNumber)));
      } else if (c.id === ID.TrackUID) {
        kids.push(encodeElement(ID.TrackUID, writeUnsigned(newUid)));
      } else {
        kids.push(u8.subarray(c.start, c.end));
      }
    });
    return encodeElement(ID.TrackEntry, concatBytes(kids));
  }

  function writeUnsigned(n) {
    if (n < 0x100) return Uint8Array.of(n);
    if (n < 0x10000) return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
    if (n < 0x1000000) return Uint8Array.of((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    return Uint8Array.of((n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }

  function writeFloat64(n) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, n);
    return new Uint8Array(buf);
  }

  function buildInfo(videoInfo, maxDurationTicks) {
    const u8 = videoInfo.raw;
    if (!u8) {
      return encodeElement(ID.Info, concatBytes([
        encodeElement(ID.TimecodeScale, writeUnsigned(videoInfo.timecodeScale || 1000000)),
        encodeElement(ID.Duration, writeFloat64(maxDurationTicks))
      ]));
    }
    // Info.raw 是 Info 的 data 部分
    const kids = [];
    let hasDuration = false;
    const tmp = encodeElement(ID.Info, u8); // wrap to walk — actually raw is data only
    walkChildren(
      (() => {
        // walk directly on data
        return u8;
      })(),
      0,
      u8.length,
      (c) => {
        if (c.id === ID.Duration) {
          hasDuration = true;
          kids.push(encodeElement(ID.Duration, writeFloat64(maxDurationTicks)));
        } else {
          kids.push(u8.subarray(c.start, c.end));
        }
      }
    );
    if (!hasDuration) kids.push(encodeElement(ID.Duration, writeFloat64(maxDurationTicks)));
    return encodeElement(ID.Info, concatBytes(kids));
  }

  function pickVideoTrack(entries) {
    return entries.find((t) => t.type === 1) || entries[0];
  }

  function pickAudioTrack(entries) {
    return entries.find((t) => t.type === 2) || entries[0];
  }

  /**
   * @param {ArrayBuffer|Uint8Array} videoBuffer
   * @param {ArrayBuffer|Uint8Array} audioBuffer
   * @param {{ log?: Function }} opts
   * @returns {Blob}
   */
  function mergeWebm(videoBuffer, audioBuffer, opts) {
    opts = opts || {};
    const log = typeof opts.log === 'function' ? opts.log : function () {};
    const t0 = Date.now();

    const v = parseWebm(videoBuffer, '视频');
    const a = parseWebm(audioBuffer, '音频');
    log(
      'WebM mux',
      `解析完成 · 视频 ${(v.u8.length / 1048576).toFixed(1)}MB clusters=${v.clusters.length} tracks=${v.trackEntries.map((t) => t.codec || t.type).join(',')}` +
        ` · 音频 ${(a.u8.length / 1048576).toFixed(1)}MB clusters=${a.clusters.length} tracks=${a.trackEntries.map((t) => t.codec || t.type).join(',')}`
    );

    const vTrack = pickVideoTrack(v.trackEntries);
    const aTrack = pickAudioTrack(a.trackEntries);
    if (!vTrack) throw new Error('视频 WebM 无视频轨');
    if (!aTrack) throw new Error('音频 WebM 无音频轨');

    const videoNum = 1;
    const audioNum = 2;
    const vEntry = rewriteTrackEntry(vTrack.raw, videoNum, 0x11);
    const aEntry = rewriteTrackEntry(aTrack.raw, audioNum, 0x22);
    log('WebM mux', `Tracks · video#${videoNum} ${vTrack.codec} · audio#${audioNum} ${aTrack.codec}`);

    const mergedClusters = [];
    for (const c of v.clusters) {
      const needRemap = vTrack.number !== videoNum;
      mergedClusters.push({
        timecode: c.timecode,
        bytes: needRemap ? remapCluster(c, videoNum, null) : c.raw,
        src: 'v'
      });
    }
    for (const c of a.clusters) {
      mergedClusters.push({
        timecode: c.timecode,
        bytes: remapCluster(c, audioNum, null),
        src: 'a'
      });
    }
    mergedClusters.sort((x, y) => x.timecode - y.timecode || (x.src === 'v' ? -1 : 1));
    log(
      'WebM mux',
      `交织 Clusters=${mergedClusters.length} · 时间戳 ${mergedClusters[0]?.timecode}→${mergedClusters[mergedClusters.length - 1]?.timecode}`
    );

    const last = mergedClusters[mergedClusters.length - 1];
    const maxDur = Math.max(
      v.info.duration || 0,
      a.info.duration || 0,
      (last ? last.timecode : 0) + 1
    );

    const ebmlBytes = v.u8.subarray(v.ebml.start, v.ebml.end);
    const infoBytes = buildInfo(v.info, maxDur);
    const tracksBytes = encodeElement(ID.Tracks, concatBytes([vEntry, aEntry]));

    let bodyLen = infoBytes.length + tracksBytes.length;
    for (const c of mergedClusters) bodyLen += c.bytes.length;
    const parts = [ebmlBytes, writeId(ID.Segment), writeVint(bodyLen), infoBytes, tracksBytes];
    for (const c of mergedClusters) parts.push(c.bytes);
    const blob = new Blob(parts, { type: 'video/webm' });

    log(
      'WebM mux',
      `完成 · ${(blob.size / 1048576).toFixed(1)}MB · ${Date.now() - t0}ms · durationTicks≈${maxDur}`
    );
    if (blob.size < 1024) throw new Error('WebM 合并结果过小');
    return blob;
  }

  function isWebmBuffer(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
  }

  global.YtWebmMux = { mergeWebm, isWebmBuffer, parseWebm };
})(typeof window !== 'undefined' ? window : globalThis);
