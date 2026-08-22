// offscreen.js — 在 MV3 Offscreen Document 中运行 ffmpeg.wasm（单线程 core）
//
// 为什么放这里：ffmpeg.wasm 需要 Worker + WASM，Service Worker 不适合跑，
// 而扩展页面（Offscreen Document）可以，且单线程 core 不依赖 SharedArrayBuffer，
// 不需要 B站页面提供 COOP/COEP 响应头。
//
// 消息协议（均由 background 中转；二进制载荷一律 base64，消息通道不支持 ArrayBuffer）：
//   入站 bili-mux        { type, replyTo, videoB64:string, audioB64:string }
//   出站 bili-mux-result { type, replyTo, ok, mp4B64?:string, error? }
//   出站 bili-mux-progress { type, replyTo, ratio:0..1 }

let _ff = null;
let _loading = null;
let _replyTo = null;
let _logBuf = [];   // 缓存 ffmpeg 最近日志，用于失败时回显诊断

// chrome.runtime.sendMessage 只支持 JSON 序列化，ArrayBuffer 会被序列化成 {}，
// 因此跨进程二进制载荷一律 base64；这里负责解码入站、编码出站。
function b64ToU8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function u8ToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
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
      if (_logBuf.length > 80) _logBuf.shift();
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
  console.log('[ffmpeg] 发送', msg.type, 'ok =', msg.ok, 'mp4B64 =', msg.mp4B64 && msg.mp4B64.length, 'err =', msg.error && String(msg.error).slice(0, 80));
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
  console.log('[ffmpeg] 已写入 MEMFS，开始合成（-vcodec copy -acodec copy，不加 +faststart 以兼容 B站 fMP4 输入）…');
  try {
    // 对齐参考实现 bilibili-helper：先视频后音频，-vcodec/-acodec copy（等价 -c copy），
    // 不加 -movflags +faststart（+faststart 在「从 fMP4 复制」时可能失败导致无输出并静默返回）。
    await ff.run('-i', vName, '-i', aName, '-vcodec', 'copy', '-acodec', 'copy', '-y', 'out.mp4');
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
  const data = ff.FS('readFile', 'out.mp4'); // Uint8Array（可能是大池上的视图）
  console.log('[ffmpeg] 合成完成，out.mp4 =', mb(data.length));
  // 释放 MEMFS，避免多次合成后内存堆积
  try { ff.FS('unlink', vName); ff.FS('unlink', aName); ff.FS('unlink', 'out.mp4'); } catch (e) {}
  // 拷贝成精确长度的 Uint8Array 再返回（readFile 返回的视图可能基于更大的池）
  return new Uint8Array(data);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'bili-mux') {
    // base64 长度 → 实际字节数 ≈ len * 3 / 4
    const b64Mb = (s) => s ? mb(Math.floor(s.length * 3 / 4)) : '0 MB';
    console.log('[ffmpeg] 收到 bili-mux, replyTo =', msg.replyTo,
      'video', b64Mb(msg.videoB64), 'audio', b64Mb(msg.audioB64));
    _replyTo = msg.replyTo;
    mux(b64ToU8(msg.videoB64 || ''), b64ToU8(msg.audioB64 || ''))
      .then((mp4) => send({ type: 'bili-mux-result', replyTo: msg.replyTo, ok: true, mp4B64: u8ToB64(mp4) }))
      .catch((e) => {
        const errMsg = String((e && e.message) || e);
        const tail = _logBuf.slice(-15).join('\n');
        console.error('[ffmpeg] 合成失败:', errMsg, '\n--- ffmpeg 日志尾 ---\n' + tail);
        send({ type: 'bili-mux-result', replyTo: msg.replyTo, ok: false, error: errMsg + (tail ? ('\n' + tail) : '') });
      })
      .finally(() => { _replyTo = null; });
  }
});

// 就绪信号：本文件的 onMessage 已注册后，主动通知 background 可以安全派发任务，
// 消除「文档刚创建、监听器还没接上就发消息」的竞态（否则首条 bili-mux 会丢失 → 150s 超时）。
chrome.runtime.sendMessage({ type: 'bili-offscreen-ready' }).catch(() => {});
console.log('[ffmpeg] offscreen 就绪信号已发出');
