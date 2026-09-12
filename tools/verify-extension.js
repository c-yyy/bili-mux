/**
 * 在真实 Chrome 里加载本扩展做冒烟验证（零第三方依赖，Node 22 自带 fetch / WebSocket）。
 *
 * 检查项：
 *   1. manifest 能否通过 Chrome 自身的校验（loadUnpacked 的 error.message 就是校验结果）
 *   2. Service Worker 是否起来
 *   3. 扩展页能否加载 ffmpeg.min.js（验证打过 CDN 补丁的产物仍然完好）
 *   4. 收紧 web_accessible_resources 后，扩展页自身读取 ffmpeg 运行时是否被拦
 *
 * 用法：node tools/verify-extension.js
 *
 * 已知限制：headless 环境下 Chrome 不允许导航到 chrome-extension:// 页面
 * （会落到 chrome-error://chromewebdata/），因此第 4~6 项在 headless 下必然失败。
 * **真正有价值的是第 2 项**——loadUnpacked 若被拒，Chrome 会把 manifest 校验结果
 * 原样放进 error.message，等于白送一个 manifest 语义检查器（CSP / WAR / 资源路径
 * 写得对不对，只有装载这一步验得出来，静态 `node --check` 抓不到）。
 */
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(__dirname, '..');
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(port, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function newTab(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error(`newTab 失败: ${r.status}`);
  return await r.json();
}

function wsEval(wsUrl, expression, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 求值超时')); }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({
        id: ++id, method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 2) {
        clearTimeout(timer);
        ws.close();
        if (msg.result && msg.result.exceptionDetails) {
          reject(new Error(msg.result.exceptionDetails.text || '页面内抛错'));
        } else {
          resolve(msg.result && msg.result.result && msg.result.result.value);
        }
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('WebSocket 错误')); };
  });
}

/** 导航到指定 URL，返回落地地址与页面报错（CSP 拦截只会出现在 Log/exception 里） */
function navigate(wsUrl, url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const errors = [];
    let seq = 0, navId = null, evalId = null;
    const timer = setTimeout(() => { ws.close(); reject(new Error('导航超时')); }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: ++seq, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({ id: ++seq, method: 'Log.enable' }));
      navId = ++seq;
      ws.send(JSON.stringify({ id: navId, method: 'Page.navigate', params: { url } }));
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Log.entryAdded') {
        const e = m.params.entry;
        if (e.level === 'error' || e.level === 'warning') errors.push(`[${e.level}] ${e.text}`);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push('[exception] ' + (m.params.exceptionDetails.text || ''));
      }
      if (m.id === navId) {
        setTimeout(() => {
          evalId = ++seq;
          ws.send(JSON.stringify({ id: evalId, method: 'Runtime.evaluate',
            params: { expression: 'location.href', returnByValue: true } }));
        }, 2500);
      }
      if (evalId && m.id === evalId) {
        clearTimeout(timer); ws.close();
        resolve({ url: (m.result && m.result.result && m.result.result.value) || '(未知)', errors });
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS 错误')); };
  });
}

async function runChecks() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-mux-verify-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    '--headless=new',
    '--no-first-run',
    '--disable-extensions-except=' + EXT,
    'about:blank',
  ], { detached: true, stdio: 'ignore' });

  const cleanup = async () => {
    try { process.kill(-chrome.pid); } catch { try { chrome.kill(); } catch {} }
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    const ver = await waitReady(PORT);
    console.log('[1] Chrome 就绪:', ver.Browser);

    // —— 装载扩展：失败时的 error.message 就是 Chrome 的 manifest 校验结果 ——
    const loaded = await (async () => {
      const ws = new WebSocket(ver.webSocketDebuggerUrl);
      return await new Promise((resolve, reject) => {
        const t = setTimeout(() => { ws.close(); reject(new Error('loadUnpacked 超时')); }, 20000);
        ws.onopen = () => ws.send(JSON.stringify({
          id: 1, method: 'Extensions.loadUnpacked', params: { path: EXT },
        }));
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          clearTimeout(t); ws.close();
          if (m.error) reject(new Error('装载失败 → ' + (m.error.message || JSON.stringify(m.error))));
          else resolve(m.result);
        };
        ws.onerror = () => { clearTimeout(t); reject(new Error('WS 连接失败')); };
      });
    })();
    const extId = loaded.id;
    console.log('[2] 扩展装载成功 ✓ id =', extId);

    // —— 等 Service Worker 起来 ——
    let swOk = false;
    for (let i = 0; i < 20; i++) {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (list.some((t) => t.type === 'service_worker' && t.url.includes(extId))) { swOk = true; break; }
      await sleep(500);
    }
    console.log(swOk ? '[3] Service Worker 已启动 ✓' : '[3] !! Service Worker 未发现');

    // —— 打开扩展页：先用 about:blank 建标签，再 Page.navigate（PUT new 直接给
    //     chrome-extension:// 会被拦到 chrome-error） ——
    const tab = await newTab('about:blank');
    const targetUrl = `chrome-extension://${extId}/offscreen.html`;
    const nav = await navigate(tab.webSocketDebuggerUrl, targetUrl);
    console.log('[4] 导航到', targetUrl, '→', nav.url, nav.errors.length ? '⚠ 有报错见下' : '无报错');
    nav.errors.forEach((e) => console.log('      ', e));
    const probe = `(() => {
      const hasFFmpeg = typeof window.FFmpeg === 'object' || typeof window.FFmpeg === 'function';
      return { hasFFmpeg, keys: window.FFmpeg ? Object.keys(window.FFmpeg).slice(0, 6) : [], href: location.href };
    })()`;
    const evalRes = await wsEval(tab.webSocketDebuggerUrl, probe);
    console.log('[4] ffmpeg.min.js 加载:', JSON.stringify(evalRes));

    const assetProbe = `(async () => {
      const names = ['lib/ffmpeg/ffmpeg-core.js','lib/ffmpeg/ffmpeg-core.wasm','lib/ffmpeg/ffmpeg-core.worker.js','lib/ffmpeg/046d0074eee1d99a674a.js'];
      const out = {};
      for (const n of names) {
        try {
          const r = await fetch(chrome.runtime.getURL(n), { method: 'GET' });
          out[n] = r.status + '/' + (r.headers.get('content-length') || '?');
        } catch (e) { out[n] = 'ERR ' + e.message; }
      }
      return out;
    })()`;
    const assets = await wsEval(tab.webSocketDebuggerUrl, assetProbe);
    console.log('[6] 扩展页读取 ffmpeg 运行时资源:');
    Object.entries(assets).forEach(([k, v]) => console.log('     ', k, '→', v));

    const allOk = Object.values(assets).every((v) => String(v).startsWith('200'));
    console.log(swOk && evalRes.hasFFmpeg && allOk ? '\n结论: 全部通过 ✓' : '\n结论: 存在失败项，见上');
  } catch (e) {
    console.error('\n验证失败:', e.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

runChecks();
