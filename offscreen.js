// offscreen.js — 在 MV3 Offscreen Document 中运行 ffmpeg.wasm（单线程 core）
//
// 为什么放这里：ffmpeg.wasm 需要 Worker + WASM，Service Worker 不适合跑，
// 而扩展页面（Offscreen Document）可以，且单线程 core 不依赖 SharedArrayBuffer，
// 不需要 B站页面提供 COOP/COEP 响应头。
//
// 为什么不在这里拉流：CDN 按 Sec-Fetch-Site 头拒绝 chrome-extension:// 发起方
// （该头由浏览器按发起源自动设置，属 forbidden header 无法覆盖，已实测验证），
// 故音视频流由 content script 拉取后分块 base64 传入。
//
// 消息协议（方案二·分块消息；二进制载荷一律 base64，消息通道不支持 ArrayBuffer）：
//   入站 bili-mux-init     { type, requestId, filename }        重置会话缓冲
//   入站 bili-mux-chunk    { type, requestId, stream, index, b64 } 累积数据块
//   入站 bili-mux-go       { type, requestId }                  拼装+合成+直接下载
//   出站 bili-mux-result   { type, replyTo, ok, error? }        （成品不回传，offscreen 直接下载）
//   出站 bili-mux-progress { type, replyTo, ratio:0..1 }

let _ff = null;
let _loading = null;
let _replyTo = null;
let _logBuf = [];   // 缓存 ffmpeg 最近日志，用于失败时回显诊断

// chrome.runtime.sendMessage 只支持 JSON 序列化，ArrayBuffer 会被序列化成 {}，
// 因此跨进程二进制载荷一律 base64；这里负责解码入站分块。
function b64ToU8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// 字节数转 MB（保留两位小数），用于日志展示流体积
function mb(bytes) { return (bytes / 1048576).toFixed(2) + ' MB'; }

function getFFmpeg() {
  if (_ff) return Promise.resolve(_ff);
  if (_loading) return _loading;
  _loading = (async () => {
    // 显式给出三个资源路径，避免依赖 corePath.replace() 推导到不存在的文件
    // （@ffmpeg/ffmpeg 默认会推导 workerPath = corePath.replace('ffmpeg-core.js','ffmpeg-core.worker.js')，
    //  本仓库该文件此前缺失，导致 Worker 内容为空 / 拉取 404）
    const base = chrome.runtime.getURL('lib/ffmpeg/');
    const corePath = base + 'ffmpeg-core.js';
    const wasmPath = base + 'ffmpeg-core.wasm';
    const workerPath = base + 'ffmpeg-core.worker.js';
    console.log('[ffmpeg] 加载 corePath   =', corePath);
    console.log('[ffmpeg] 加载 wasmPath   =', wasmPath);
    console.log('[ffmpeg] 加载 workerPath =', workerPath);
    const { createFFmpeg } = self.FFmpeg;
    const inst = createFFmpeg({
      corePath,
      wasmPath,
      workerPath,
      // 单线程核心（@ffmpeg/core-st）只导出 _main；@ffmpeg/ffmpeg 0.11 包装层默认
      // 调 proxy_main（多线程 @ffmpeg/core 的入口），二者不匹配会报
      // "Cannot call unknown function proxy_main"。显式指定 mainName 让 cwrap 调到 _main。
      mainName: 'main',
      log: true,
      progress: (ratio) => {
        // 0.11 包装层传入的是 { ratio, time } 对象（非裸数字），需取出 .ratio；
        // 某些场景 ratio 可能为 NaN（Duration 尚未解析时 a/P），content 侧再兜底。
        const r = (ratio && typeof ratio === 'object') ? ratio.ratio : ratio;
        if (_replyTo != null && typeof r === 'number' && !isNaN(r)) {
          chrome.runtime.sendMessage({ type: 'bili-mux-progress', replyTo: _replyTo, ratio: r }).catch(() => {});
        }
      }
    });
    // 注意：0.11 包装层 createFFmpeg 的 logger 选项会被静默丢弃
    // （minified 代码里是逗号表达式 (t.logger, t.progress)，logger 从未赋给内部处理器），
    // 必须通过 setLogger() 注册才能真正捕获 fferr/ffout，否则失败时拿不到任何 ffmpeg 日志。
    inst.setLogger(({ message }) => {
      _logBuf.push(message);
      // 缓冲放大到 400 行：输入流探测信息在日志头部，5 分钟的合成会产生大量进度行，
      // 80 行会把关键的 "Stream mapping / Duration / codec" 头部信息冲掉，诊断丢包问题时必须保留
      if (_logBuf.length > 400) _logBuf.shift();
    });
    console.log('[ffmpeg] createFFmpeg 已构造，开始 load()…');
    await inst.load();
    _ff = inst;
    console.log('[ffmpeg] core 加载完成');
    return inst;
  })();
  return _loading;
}

// 根据文件头猜测输入容器：B站 DASH 视频可能是 fMP4（avc/hevc）或 WebM（vp9/av1），
// 音频均为 fMP4 封装的 aac（写 .m4a）。用正确的扩展名让 ffmpeg 正确识别格式。
function probeVideoExt(buf) {
  const b = new Uint8Array(buf);
  // WebM / Matroska 以 EBML 头 0x1A45DFA3 开头
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'webm';
  return 'mp4';
}

function send(msg) {
  console.log('[ffmpeg] 发送', msg.type, 'ok =', msg.ok, 'err =', msg.error && String(msg.error).slice(0, 80));
  chrome.runtime.sendMessage(msg).catch((e) => console.error('[ffmpeg] sendMessage 失败', e && e.message));
}

// 串行化所有 mux 调用：防止并发合成在共享实例上同时 run（会导致
// "ffmpeg.wasm can only run one command at a time"）
let _muxLock = Promise.resolve();

async function mux(videoBuf, audioBuf) {  // 入参为 Uint8Array（已由监听器解码）
  // 串行化：等待上一次 mux 结束后再开始
  const prev = _muxLock;
  let release;
  _muxLock = new Promise((r) => { release = r; });
  await prev;

  const ff = await getFFmpeg();
  try {
    return await muxOnce(ff, videoBuf, audioBuf);
    // 成功时保留实例复用：run() 成功 → FFMPEG_END 已收到 → running 已复位为 false，
    // MEMFS 已由 muxOnce 内 unlink 清理。实例可直接用于下次合成。
    // 不调 exit()：销毁后重建会触发 createFFmpegCore 的内部缓存问题，
    // 导致新实例的 running 标志仍为 true → 第二次合成报 "can only run one command at a time"。
  } catch (e) {
    // 失败时才销毁实例：running 可能卡在 true，重建是唯一可靠的复位方式
    try { ff.exit(); } catch (_) {}
    _ff = null;
    _loading = null;
    throw e;
  } finally {
    release();
  }
}

async function muxOnce(ff, videoBuf, audioBuf) {
  _logBuf = [];
  const vExt = probeVideoExt(videoBuf);
  const vName = 'inv.' + vExt;
  const aName = 'ina.mp4';   // 参考实现把音频也按 mp4 容器命名，确保 ffmpeg 正确识别 aac
  console.log('[ffmpeg] 探测视频容器 =', vExt, 'video', mb(videoBuf.length), 'audio', mb(audioBuf.length));
  await ff.FS('writeFile', vName, videoBuf);
  await ff.FS('writeFile', aName, audioBuf);
  console.log('[ffmpeg] 已写入 MEMFS，开始合成（-c copy + genpts，不加 +faststart 以兼容 B站 fMP4 输入）…');
  try {
    // 对齐参考实现 bilibili-helper：先视频后音频，-vcodec/-acodec copy（等价 -c copy）。
    // 关键修复 —— 加 -fflags +genpts：B站 fMP4 流的时间戳存在非单调 DTS（日志中的
    // "Non-monotonous DTS in output stream" 警告），mp4 封装器遇到非单调 DTS 会直接丢弃
    // 数据包，导致 -c copy 输出只剩输入的 1/6 左右（167MB 输入只出 24MB）。
    // genpts 让 ffmpeg 重新生成 PTS，规避封装器丢包。
    // -map 显式选取「输入0的视频 + 输入1的音频」，避免误选多余流。
    // 不加 -movflags +faststart（+faststart 在「从 fMP4 复制」时可能失败导致无输出并静默返回）。
    await ff.run(
      '-fflags', '+genpts', '-i', vName,
      '-fflags', '+genpts', '-i', aName,
      '-map', '0:v:0', '-map', '1:a:0',
      '-vcodec', 'copy', '-acodec', 'copy',
      '-y', 'out.mp4'
    );
  } catch (e) {
    const tail = _logBuf.slice(-20).join('\n');
    throw new Error('ffmpeg 执行异常: ' + (e && e.message || e) + (tail ? ('\n' + tail) : ''));
  }
  // 0.11 的 run 在 ffmpeg 失败时常不抛错而直接返回，需手动确认输出存在，否则抛出真实日志
  let size = 0;
  try { size = ff.FS('stat', 'out.mp4').size; } catch (e) { size = 0; }
  if (!size) {
    const tail = _logBuf.slice(-25).join('\n');
    let dir = '';
    try { dir = 'MEMFS 根目录: ' + ff.FS('readdir', '/').join(', '); } catch (e) {}
    throw new Error('ffmpeg 未生成 out.mp4（合成失败）。' + dir + '\nffmpeg 日志：\n' + (tail || '(无日志，请确认核心已正常加载)'));
  }
  // 体积合理性检查：-c copy 不重编码，输出应≈输入视频+音频（仅容器开销差异）。
  // 若输出明显偏小（< 输入的 90%），说明 ffmpeg 丢了大量数据包（如非单调 DTS 丢包），
  // 此时产出的文件是残缺的，必须报失败并回显日志，而不是让用户拿到坏文件。
  const inputTotal = videoBuf.length + audioBuf.length;
  if (size < inputTotal * 0.9) {
    const tail = _logBuf.slice(-30).join('\n');
    throw new Error(
      '合成输出体积异常：输入 ' + mb(inputTotal) + '，输出仅 ' + mb(size) +
      '（不足 90%），疑似 ffmpeg 丢包（时间戳问题）。请查看日志。\nffmpeg 日志尾：\n' + tail
    );
  }
  const data = ff.FS('readFile', 'out.mp4'); // Uint8Array（可能是大池上的视图）
  console.log('[ffmpeg] 合成完成，out.mp4 =', mb(data.length), '（输入合计', mb(inputTotal), '）');
  // 释放 MEMFS，避免多次合成后内存堆积
  try { ff.FS('unlink', vName); ff.FS('unlink', aName); ff.FS('unlink', 'out.mp4'); } catch (e) {}
  // 拷贝成精确长度的 Uint8Array 再返回（readFile 返回的视图可能基于更大的池）
  return new Uint8Array(data);
}

// 方案二（分块消息）会话状态：requestId -> { filename, video:Uint8Array[], audio:Uint8Array[] }
// content 拉流后分块 base64 传入，go 时拼装成完整 Uint8Array 交给 mux。
const _sessions = new Map();

// bili-save 会话状态：requestId -> { filename, mime, chunks:Uint8Array[] }
// FLV 合并 / 分离流保存走此通道：content 拼好字节后分块传入，go 时拼装并触发下载。
// 与 _sessions 分开，避免与合成会话互相干扰。
const _saveSessions = new Map();

// 在 offscreen 文档内触发 Blob 落地。offscreen.html 是普通扩展页面（chrome-extension://），
// 不受 B站页面沙箱的 allow-downloads 限制，程序化 <a download> 可正常执行。
function saveBlob(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 延迟 revoke：给浏览器足够时间启动下载（立即 revoke 可能导致下载失败）
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// 把分块数组按序拼装成单个 Uint8Array
function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// FLV → MP4 转封装（-c copy 不重编码，秒级完成）。
// FLV 容器兼容性一般（部分播放器 / 设备 / 剪辑软件不支持），转成 MP4 提升兼容性。
// 复用 mux 的串行锁与实例生命周期管理（共享同一个 ffmpeg 实例，避免并发 run）。
// 成功返回转封装后的 MP4 字节；失败（抛错）由调用方回退下载原 FLV。
async function remuxFlv(flvBytes) {
  const prev = _muxLock;
  let release;
  _muxLock = new Promise((r) => { release = r; });
  await prev;
  const ff = await getFFmpeg();
  try {
    await ff.FS('writeFile', 'in.flv', flvBytes);
    console.log('[ffmpeg] FLV 转封装开始，输入', mb(flvBytes.length));
    // -fflags +genpts 规避 FLV 非单调时间戳导致的丢包；-c copy 仅换容器不重编码
    await ff.run('-fflags', '+genpts', '-i', 'in.flv', '-c', 'copy', '-y', 'out.mp4');
    let size = 0;
    try { size = ff.FS('stat', 'out.mp4').size; } catch (e) { size = 0; }
    if (!size) {
      try { ff.FS('unlink', 'in.flv'); } catch (_) {}
      throw new Error('ffmpeg 未生成 out.mp4');
    }
    const data = ff.FS('readFile', 'out.mp4');
    console.log('[ffmpeg] FLV 转封装完成，out.mp4 =', mb(data.length));
    try { ff.FS('unlink', 'in.flv'); ff.FS('unlink', 'out.mp4'); } catch (_) {}
    return new Uint8Array(data);
  } catch (e) {
    // 失败时销毁实例复位（running 可能卡住），下次重建
    try { ff.exit(); } catch (_) {}
    _ff = null;
    _loading = null;
    throw e;
  } finally {
    release();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // ---- bili-save 协议：FLV 合并 / 分离流保存（content 拼好字节分块传入，go 时落地）----

  // save init：建立会话缓冲
  if (msg.type === 'bili-save-init') {
    _saveSessions.set(msg.requestId, { filename: msg.filename || 'download', mime: msg.mime, chunks: [] });
    sendResponse({ ok: true });
    return false;
  }

  // save chunk：解码 base64 后累积（立即 sendResponse 确认，形成流控）
  if (msg.type === 'bili-save-chunk') {
    const s = _saveSessions.get(msg.requestId);
    if (!s) { sendResponse({ ok: false, error: 'save 会话不存在（init 未到达或已清理）' }); return false; }
    try {
      s.chunks.push(b64ToU8(msg.b64 || ''));
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return false;
  }

  // save go：拼装并触发下载。
  // FLV 容器兼容性一般：检测到 FLV（mime 或文件名）时先用 ffmpeg 转封装成 MP4（-c copy 秒级），
  // 转封装失败则回退下载原 FLV。非 FLV 直接下载。
  if (msg.type === 'bili-save-go') {
    const s = _saveSessions.get(msg.requestId);
    if (!s) { sendResponse({ ok: false, error: 'save 会话不存在（分块可能丢失）' }); return false; }
    _saveSessions.delete(msg.requestId);
    (async () => {
      try {
        const bytes = concatChunks(s.chunks);
        const isFlv = s.mime === 'video/x-flv' || /\.flv$/i.test(s.filename || '');
        if (isFlv) {
          try {
            const mp4 = await remuxFlv(bytes);
            const mp4Name = (s.filename || 'download').replace(/\.flv$/i, '.mp4');
            saveBlob(mp4, mp4Name, 'video/mp4');
            console.log('[ffmpeg] save 完成（FLV→MP4）', mb(mp4.length), mp4Name);
            sendResponse({ ok: true, converted: true });
          } catch (e) {
            // 转封装失败：回退下载原 FLV，保证用户至少拿到文件
            console.warn('[ffmpeg] FLV 转封装失败，回退下载原 FLV：', e && e.message);
            saveBlob(bytes, s.filename, s.mime);
            console.log('[ffmpeg] save 完成（原 FLV）', mb(bytes.length), s.filename);
            sendResponse({ ok: true, converted: false, note: 'FLV 转 MP4 失败，已下载原 FLV: ' + (e && e.message || e) });
          }
        } else {
          saveBlob(bytes, s.filename, s.mime);
          console.log('[ffmpeg] save 完成', mb(bytes.length), s.filename);
          sendResponse({ ok: true, converted: false });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true; // 异步 sendResponse（转封装是异步的）
  }

  // ---- bili-mux 协议：DASH 音视频流合成 MP4 ----

  // init：重置会话缓冲（content 拉流完成后、发分块前调用）
  if (msg.type === 'bili-mux-init') {
    _sessions.set(msg.requestId, { filename: msg.filename || 'mux.mp4', video: [], audio: [] });
    console.log('[ffmpeg] 收到 init, requestId =', msg.requestId, 'filename =', msg.filename);
    sendResponse({ ok: true });
    return false;
  }

  // chunk：解码 base64 后按流类型累积（立即 sendResponse 确认，形成流控）
  if (msg.type === 'bili-mux-chunk') {
    const s = _sessions.get(msg.requestId);
    if (!s) { sendResponse({ ok: false, error: '会话不存在（init 未到达或已清理）' }); return false; }
    try {
      const bytes = b64ToU8(msg.b64 || '');
      (msg.stream === 'audio' ? s.audio : s.video).push(bytes);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
    return false;
  }

  // go：拼装 + ffmpeg 合成 + offscreen 文档 <a download> 落地（成品不回传 content）
  if (msg.type === 'bili-mux-go') {
    const requestId = msg.requestId;
    const s = _sessions.get(requestId);
    if (!s) { sendResponse({ ok: false, error: '会话不存在（分块可能丢失）' }); return false; }
    // 立即应答确认收到（同步 sendResponse），关闭本条消息端口；
    // 真正的合成结果经 bili-mux-result 广播回传，background 据此 resolve。
    sendResponse({ ok: true });
    _sessions.delete(requestId); // 尽早释放分块引用

    const videoBuf = concatChunks(s.video);
    const audioBuf = concatChunks(s.audio);
    s.video = s.audio = null;
    console.log('[ffmpeg] 收到 go, requestId =', requestId, 'video', mb(videoBuf.length), 'audio', mb(audioBuf.length));

    _replyTo = requestId;
    mux(videoBuf, audioBuf)
      .then((mp4) => {
        // 下载路径选择（前两条已实测不可行）：
        //   · content 的 <a download>：合成耗时数分钟，脱离用户手势窗口，
        //     被 B站页面沙箱拦截（"allow-downloads is not set"）；
        //   · chrome.downloads.download(blobUrl)：blob: URL 作用域限于创建它的
        //     document，downloads API 跨进程无法访问，官方明确不支持；
        //   · ✅ offscreen 文档自己 <a download> 点击：offscreen.html 是普通扩展
        //     页面（chrome-extension://），非沙箱，无 allow-downloads 限制。
        //     这正是 Chrome 为 offscreen 设计 BLOBS reason 的用途。
        const blob = new Blob([mp4], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = s.filename || 'mux.mp4';
        document.body.appendChild(a);
        a.click();
        a.remove();
        // 延迟 revoke：给浏览器足够时间启动下载（立即 revoke 可能导致下载失败）
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        console.log('[ffmpeg] 合成完成', mb(mp4.length), '，offscreen 已触发下载:', s.filename);
        send({ type: 'bili-mux-result', replyTo: requestId, ok: true });
      })
      .catch((e) => {
        const errMsg = String((e && e.message) || e);
        const tail = _logBuf.slice(-15).join('\n');
        console.error('[ffmpeg] 合成失败:', errMsg, '\n--- ffmpeg 日志尾 ---\n' + tail);
        send({ type: 'bili-mux-result', replyTo: requestId, ok: false, error: errMsg + (tail ? ('\n' + tail) : '') });
      })
      .finally(() => { _replyTo = null; });

    // 合成是异步长任务：结果经 bili-mux-result 广播回传（background 据此 resolve）。
    // 这里不 return true、不 sendResponse：本条 go 消息无需应答，立即关闭端口即可。
    // （若 return true 却不 sendResponse，端口会在监听器返回后关闭，导致 background 的
    //  sendMessage Promise 以 "message port closed" 拒绝，误判为失败。）
    return false;
  }
});

// 就绪信号：本文件的 onMessage 已注册后，主动通知 background 可以安全派发任务，
// 消除「文档刚创建、监听器还没接上就发消息」的竞态（否则首条 bili-mux 会丢失 → 150s 超时）。
chrome.runtime.sendMessage({ type: 'bili-offscreen-ready' }).catch(() => {});
console.log('[ffmpeg] offscreen 就绪信号已发出');
