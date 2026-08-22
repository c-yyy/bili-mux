// background.js — Manifest V3 Service Worker
// 职责极简：接收 content script 转发的下载请求，调用 chrome.downloads 落地；
// 并负责按需创建 Offscreen Document 来承载 ffmpeg.wasm 合成任务。
//
// 不做任何解析逻辑（解析都在 content.js 里，因为 Service Worker 没有 DOM、
// 也无法创建 Object URL 来落地 Blob）。

// 记录每个合成请求对应的发起标签：requestId -> tabId
// 由 content 发起的 bili-mux-init 带 sender.tab.id；offscreen 回传时用 requestId 查回 tabId，
// 再经 chrome.tabs.sendMessage 定向转发，避免多标签互相串台 / 重复下载。
const _muxTabs = new Map();
// requestId -> resolve(result)：把 offscreen 回传的合成结果桥接到 bili-mux-go 那条消息的
// sendResponse，从而让 SW 在整个合成期间保持存活（return true + 延迟 sendResponse）。
const _muxPending = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // 0) offscreen 就绪信号：offscreen.js 注册好 onMessage 后主动上报，
  //    用于消除「文档刚创建、监听器还没接上就发任务」的竞态（否则首条消息会丢失）
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

  // 2) 浏览器内 MP4 合成 —— 方案二（分块消息）：
  //    offscreen 无法直接拉流（CDN 按 Sec-Fetch-Site 拒绝 chrome-extension:// 发起方，
  //    该头为 forbidden header 无法覆盖，已实测验证），故由 content 拉流后分块 base64
  //    传给 offscreen 合成；成品由 offscreen 直接 chrome.downloads 下载，不回传 content。
  //    协议：bili-mux-init → bili-mux-chunk × N → bili-mux-go → bili-mux-result。

  // 2a) init：content 拉流完成后发起。记录会话并确保 offscreen 就绪后才回复，
  //     保证后续分块到达时 offscreen 监听器已注册（否则分块丢失）。
  if (msg.type === 'bili-mux-init' && sender && sender.tab) {
    const tabId = sender.tab.id;
    _muxTabs.set(msg.requestId, tabId);
    console.log('[bili-mux] 收到 init, requestId =', msg.requestId, 'tabId =', tabId, 'filename =', msg.filename);
    ensureOffscreen().then(() => {
      // offscreen 就绪后再转发 init（offscreen 据此重置会话缓冲），然后回复 content
      return chrome.runtime.sendMessage({ type: 'bili-mux-init', requestId: msg.requestId, filename: msg.filename });
    }).then(() => {
      sendResponse({ ok: true });
    }).catch((e) => {
      console.error('[bili-mux] init 失败:', e && e.message);
      _muxTabs.delete(msg.requestId);
      sendResponse({ ok: false, error: '创建 Offscreen 失败: ' + (e && e.message || e) });
    });
    return true; // 异步 sendResponse
  }

  // 2b) chunk：转发给 offscreen 累积（offscreen 立即 sendResponse 确认，形成流控）
  if (msg.type === 'bili-mux-chunk' && sender && sender.tab) {
    chrome.runtime.sendMessage({
      type: 'bili-mux-chunk',
      requestId: msg.requestId,
      stream: msg.stream,
      index: msg.index,
      b64: msg.b64
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('[bili-mux] chunk 转发失败:', chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true; // 异步 sendResponse
  }

  // 2c) go：所有分块已送达，触发 offscreen 拼装 + ffmpeg 合成 + 直接下载。
  //     必须 return true 并保持 sendResponse 延迟到合成结束，否则 SW 会在合成中途被杀。
  if (msg.type === 'bili-mux-go' && sender && sender.tab) {
    const requestId = msg.requestId;
    console.log('[bili-mux] 收到 go, requestId =', requestId);

    const resultP = new Promise((resolve) => {
      _muxPending.set(requestId, resolve);
      // 兜底超时：大文件合成耗时久，给 600s；offscreen 无响应时主动结束避免端口永久挂起
      setTimeout(() => {
        if (_muxPending.has(requestId)) {
          console.error('[bili-mux] 合成等待 offscreen 超时(600s), requestId =', requestId);
          _muxPending.delete(requestId);
          resolve({ ok: false, error: '合成等待超时（offscreen 无响应，可能是 ffmpeg 加载失败或文档被关闭）' });
        }
      }, 600000);
    });

    chrome.runtime.sendMessage({ type: 'bili-mux-go', requestId }).catch((e) => {
      console.error('[bili-mux] go 转发失败:', e && e.message);
      const resolve = _muxPending.get(requestId);
      if (resolve) {
        _muxPending.delete(requestId);
        resolve({ ok: false, error: '转发 go 到 offscreen 失败: ' + (e && e.message || e) });
      }
    });

    // 收尾：结果转给发起标签（更新 UI），并关闭 go 消息的端口
    resultP.then((result) => {
      const tabId = _muxTabs.get(requestId);
      console.log('[bili-mux] 合成结束, requestId =', requestId, 'ok =', result.ok);
      if (tabId != null) {
        // 结果仅承载状态（下载已由 offscreen 文档 <a download> 完成），转发给 content 更新 UI
        chrome.tabs.sendMessage(tabId, { type: 'bili-mux-result', routed: true, replyTo: requestId, ok: !!result.ok, error: result.error, filename: result.filename }).catch(() => {});
      }
      try { sendResponse({ ok: !!result.ok }); } catch (e) {}
      _muxTabs.delete(requestId);
    });

    return true; // 保持端口与 SW 存活，直到 sendResponse 被调用
  }

  // 3) 来自 offscreen 的合成进度/结果（sender.tab 为空 → 来自扩展内部文档，非 content）。
  //    · 进度：直接定向转发给发起标签（pending 仅承载最终结果，不在此 resolve）。
  //    · 结果：resolve 对应 pending Promise；最终转发给 content 由上面的 resultP.then 统一处理。
  //    注：成品下载由 offscreen 文档自己 <a download> 完成（chrome.downloads 不支持 blob: URL，
  //    content 的 <a download> 又被页面沙箱拦截），SW 只负责转发状态。
  if ((msg.type === 'bili-mux-result' || msg.type === 'bili-mux-progress') && sender && !sender.tab) {
    const tabId = _muxTabs.get(msg.replyTo);
    if (msg.type === 'bili-mux-result') {
      console.log('[bili-mux] 收到 offscreen 结果, replyTo =', msg.replyTo, 'ok =', msg.ok);
      const resolve = _muxPending.get(msg.replyTo);
      if (resolve) {
        _muxPending.delete(msg.replyTo);
        resolve({ ok: !!msg.ok, error: msg.error, filename: msg.filename });
      } else if (tabId != null) {
        // 兜底：pending 已因超时清理，仍尝试直接转发，避免 content 卡在等待
        chrome.tabs.sendMessage(tabId, { type: 'bili-mux-result', routed: true, replyTo: msg.replyTo, ok: !!msg.ok, error: msg.error, filename: msg.filename }).catch(() => {});
      }
    } else if (tabId != null) {
      // 进度直接转发
      chrome.tabs.sendMessage(tabId, { ...msg, routed: true }).catch(() => {});
    }
    return false;
  }

  // 4) 通用文件落地（FLV 合并 / 分离流保存）—— bili-save 协议：
  //    content 的 <a download> 被 B站页面沙箱拦截（allow-downloads 未设置），
  //    故把拼好的字节分块传给 offscreen 文档，由其 <a download> 落地。
  //    协议：bili-save-init → bili-save-chunk × N → bili-save-go。

  // 4a) init：确保 offscreen 就绪后转发（offscreen 据此建会话缓冲），再回复 content
  if (msg.type === 'bili-save-init' && sender && sender.tab) {
    ensureOffscreen().then(() => {
      return chrome.runtime.sendMessage({ type: 'bili-save-init', requestId: msg.requestId, filename: msg.filename, mime: msg.mime });
    }).then(() => {
      sendResponse({ ok: true });
    }).catch((e) => {
      console.error('[bili-mux] save init 失败:', e && e.message);
      sendResponse({ ok: false, error: '创建 Offscreen 失败: ' + (e && e.message || e) });
    });
    return true; // 异步 sendResponse
  }

  // 4b) chunk：转发给 offscreen 累积（offscreen 立即 sendResponse 确认，形成流控）
  if (msg.type === 'bili-save-chunk' && sender && sender.tab) {
    chrome.runtime.sendMessage({
      type: 'bili-save-chunk',
      requestId: msg.requestId,
      index: msg.index,
      b64: msg.b64
    }, () => {
      if (chrome.runtime.lastError) {
        console.error('[bili-mux] save chunk 转发失败:', chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true });
      }
    });
    return true; // 异步 sendResponse
  }

  // 4c) go：分块已齐，offscreen 拼装并触发下载（offscreen 同步完成，直接回传结果）
  if (msg.type === 'bili-save-go' && sender && sender.tab) {
    chrome.runtime.sendMessage({ type: 'bili-save-go', requestId: msg.requestId }, (resp) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(resp || { ok: false, error: 'offscreen 无响应' });
      }
    });
    return true; // 异步 sendResponse
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
    // 回退到 WORKERS（ffmpeg 单线程 core 也会起 Worker），保证 createDocument 不因 reason 非法失败。
    // 另加 BLOBS：成品 MP4 经 offscreen 文档 <a download> 落地，Chrome 要求声明该 reason
    // （"sharing large blobs"），否则程序化下载可能被拦截。
    const reasons = [];
    if (chrome.offscreen.Reason.FFMPEG) reasons.push(chrome.offscreen.Reason.FFMPEG);
    else if (chrome.offscreen.Reason.WORKERS) reasons.push(chrome.offscreen.Reason.WORKERS);
    if (chrome.offscreen.Reason.BLOBS) reasons.push(chrome.offscreen.Reason.BLOBS);
    if (!reasons.length) reasons.push('WORKERS');
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons,
      justification: '在扩展内用 ffmpeg.wasm 将 DASH 音视频流封装为单个 MP4 并下载'
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
