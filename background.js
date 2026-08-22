// background.js — Manifest V3 Service Worker
// 职责极简：接收 content script 转发的下载请求，调用 chrome.downloads 落地；
// 并负责按需创建 Offscreen Document 来承载 ffmpeg.wasm 合成任务。
//
// 不做任何解析逻辑（解析都在 content.js 里，因为 Service Worker 没有 DOM、
// 也无法创建 Object URL 来落地 Blob）。

// 记录每个合成请求对应的发起标签：requestId -> tabId
// 由 content 发起的 bili-mux 带 sender.tab.id；offscreen 回传时用 requestId 查回 tabId，
// 再经 chrome.tabs.sendMessage 定向转发，避免多标签互相串台 / 重复下载。
const _muxTabs = new Map();
// requestId -> resolve(result)：把 offscreen 回传的合成结果桥接到 content→SW 那条消息的
// sendResponse，从而让 SW 在整个合成期间保持存活（return true + 延迟 sendResponse）。
const _muxPending = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // 0) offscreen 就绪信号：offscreen.js 注册好 onMessage 后主动上报，
  //    用于消除「文档刚创建、监听器还没接上就发任务」的竞态（否则首条 bili-mux 会丢失 → 150s 超时）
  if (msg.type === 'bili-offscreen-ready' && sender && !sender.tab) {
    _offscreenReady = true;
    const rs = _offscreenReadyResolvers.splice(0);
    rs.forEach((r) => r());
    console.log('[bili-mux] 收到 offscreen 就绪信号');
    return false;
  }

  // 1) 直链下载：交给 chrome.downloads 落地
  if (msg.type === 'bili-download') {
    const opts = {
      url: msg.url,
      filename: msg.filename || '',   // 已由 content.js 清洗过非法字符
      saveAs: !!msg.saveAs,
      conflictAction: 'uniquify'
    };
    chrome.downloads.download(opts, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, downloadId });
      }
    });
    return true; // 异步回传 sendResponse
  }

  // 2) 浏览器内 MP4 合成：来自 content script（sender.tab 存在）。
  //    关键：必须 return true 并保持 sendResponse 延迟到“确保 offscreen + ffmpeg 合成”整个
  //    链路完成后再调用；否则 MV3 的 Service Worker 会在 ensureOffscreen 的异步阶段被杀死，
  //    表现为 content 端报 “The message port closed before a response was received.”。
  if (msg.type === 'bili-mux' && sender && sender.tab) {
    const tabId = sender.tab.id;
    const requestId = Date.now() + '_' + Math.random().toString(36).slice(2);
    _muxTabs.set(requestId, tabId);

    // 用 Promise 把 offscreen 回传的合成结果桥接到本消息的 sendResponse，
    // 使 SW 在整个合成期间保持存活。
    const resultP = new Promise((resolve) => {
      _muxPending.set(requestId, resolve);
      // 兜底超时：offscreen 长时间无响应时主动结束，避免 SW 端口永久挂起
      setTimeout(() => {
        if (_muxPending.has(requestId)) {
          console.error('[bili-mux] 合成等待 offscreen 超时(150s), requestId =', requestId);
          _muxPending.delete(requestId);
          resolve({ ok: false, error: '合成等待超时（offscreen 无响应，可能是 ffmpeg 加载失败或文档被关闭）' });
        }
      }, 150000);
    });

    console.log('[bili-mux] 收到 bili-mux, requestId =', requestId, 'tabId =', tabId,
      'videoB64', msg.videoB64 && msg.videoB64.length, 'audioB64', msg.audioB64 && msg.audioB64.length);

    ensureOffscreen().then(() => {
      console.log('[bili-mux] offscreen 就绪，转发 bili-mux 给 offscreen, requestId =', requestId);
      return chrome.runtime.sendMessage({
        type: 'bili-mux',
        replyTo: requestId,
        videoB64: msg.videoB64,
        audioB64: msg.audioB64
      });
    }).catch((e) => {
      console.error('[bili-mux] ensureOffscreen / 转发 失败', e && e.message);
      const resolve = _muxPending.get(requestId);
      if (resolve) {
        _muxPending.delete(requestId);
        resolve({ ok: false, error: '创建/转发 Offscreen 失败: ' + (e && e.message || e) });
      }
    });

    // 收尾：拿到结果后既转给发起标签（触发下载），也关闭 content→SW 的初始端口
    resultP.then((result) => {
      console.log('[bili-mux] 合成结束，转发给 content tabId =', tabId, 'ok =', result.ok);
      chrome.tabs.sendMessage(tabId, { type: 'bili-mux-result', routed: true, ...result }).catch(() => {});
      try { sendResponse({ ok: !!result.ok }); } catch (e) {} // 仅确认；mp4 走上面的 tabs 通道，避免重复传大块
      _muxTabs.delete(requestId);
    });

    return true; // 保持端口与 SW 存活，直到 sendResponse 被调用
  }

  // 3) 来自 offscreen 的合成进度/结果（sender.tab 为空 → 来自扩展内部文档，非 content）。
  //    · 进度：直接定向转发给发起标签（pending 仅承载最终结果，不在此 resolve）。
  //    · 结果：resolve 对应 pending Promise；最终转发给 content 由上面的 resultP.then 统一处理，
  //      避免重复发送。
  if ((msg.type === 'bili-mux-result' || msg.type === 'bili-mux-progress') && sender && !sender.tab) {
    const tabId = _muxTabs.get(msg.replyTo);
    console.log('[bili-mux] 收到 offscreen', msg.type, 'replyTo =', msg.replyTo, '映射 tabId =', tabId,
      'ok =', msg.ok);
    if (msg.type === 'bili-mux-result') {
      const resolve = _muxPending.get(msg.replyTo);
      if (resolve) {
        _muxPending.delete(msg.replyTo);
        resolve({ ok: !!msg.ok, mp4B64: msg.mp4B64, error: msg.error });
      } else if (tabId != null) {
        // 兜底：pending 已因超时清理，仍尝试直接转发，避免 content 卡在等待
        chrome.tabs.sendMessage(tabId, { type: 'bili-mux-result', routed: true, ok: !!msg.ok, mp4B64: msg.mp4B64, error: msg.error }).catch(() => {});
      }
    } else if (tabId != null) {
      // 进度直接转发
      chrome.tabs.sendMessage(tabId, { ...msg, routed: true }).catch(() => {});
    }
    return false;
  }
});

/* ===================== Offscreen Document 生命周期 ===================== */
let _offscreenReady = false;
let _offscreenReadyResolvers = [];

// 等待 offscreen 就绪信号（offscreen.js 注册完 onMessage 后上报），带超时
function waitForOffscreenReady(ms) {
  return new Promise((resolve) => {
    if (_offscreenReady) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      const i = _offscreenReadyResolvers.indexOf(finish);
      if (i >= 0) _offscreenReadyResolvers.splice(i, 1);
      resolve();
    };
    _offscreenReadyResolvers.push(finish);
    const t = setTimeout(finish, ms);
  });
}

async function ensureOffscreen() {
  // 已就绪：复核文档是否仍在（防止 offscreen 中途崩溃但标记仍为 true）
  if (_offscreenReady) {
    try {
      if (typeof chrome.offscreen?.hasDocument === 'function' && !(await chrome.offscreen.hasDocument())) {
        _offscreenReady = false;
      }
    } catch (e) { /* 忽略 */ }
    if (_offscreenReady) return true;
  }

  // 若 offscreen 文档已存在但 SW 错过了它的就绪信号（例如 SW 重启而文档残留），
  // 先关掉再重建，确保能收到一次全新的就绪 ping。
  try {
    if (typeof chrome.offscreen?.hasDocument === 'function' && await chrome.offscreen.hasDocument()) {
      console.log('[bili-mux] 检测到已有 offscreen 文档（可能 SW 重启导致信号丢失），先关闭再重建');
      await chrome.offscreen.closeDocument();
    }
  } catch (e) { /* 忽略 */ }

  try {
    // FFMPEG 是专为 ffmpeg.wasm 新增的 reason；部分 Chrome 版本枚举里没有，
    // 回退到 WORKERS（ffmpeg 单线程 core 也会起 Worker），保证 createDocument 不因 reason 非法失败
    const reason = chrome.offscreen.Reason.FFMPEG || chrome.offscreen.Reason.WORKERS;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [reason],
      justification: '在扩展内用 ffmpeg.wasm 将 DASH 音视频流封装为单个 MP4'
    });
    console.log('[bili-mux] Offscreen 文档已创建，等待就绪信号…');
    await waitForOffscreenReady(8000);
    if (!_offscreenReady) throw new Error('offscreen 就绪信号超时（offscreen.js 可能未加载或被 CSP 拦截）');
    console.log('[bili-mux] Offscreen 已就绪');
    return true;
  } catch (e) {
    console.error('[bili-mux] 创建/等待 Offscreen 失败:', e && e.message);
    _offscreenReady = false;
    throw e; // 让上层 catch 回退，而不是静默置就绪导致 content 干等 180s
  }
}
