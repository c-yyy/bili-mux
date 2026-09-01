// content.js — 注入到 B站视频页
// 运行在 content script 隔离世界，但通过宿主页面的 cookie 罐 + manifest 的
// host_permissions，可以直接带着登录态 fetch api.bilibili.com，从而绕开 CORS。
//
// 流程：
//   1. 从 URL 取 bvid
//   2. 调 view 接口拿 cid / 封面 pic / 分P pages / 标题 title
//   3. 调 nav 接口拿 wbi 密钥 → 给 playurl 请求签名
//   4. 调 playurl 拿 DASH 直链(video/audio 分离) 与 FLV 分段(durl)
//   5. 面板里提供：封面下载 / 视频流+音频流分别保存 / FLV 合并 / 浏览器内合成 MP4
//
// 封面：view.data.pic 是 i0.hdslb.com 静态直链，无 wbi 签名、无防盗链鉴权，
//       chrome.downloads 直接下即可——这是整个项目里最简单的一环。

/* ============================ 工具：MD5 ============================ */
// 标准 MD5 实现（RFC 1321），仅用于 wbi 签名计算。
// 输入按 UTF-8 字节处理，输出小写十六进制摘要（小端 word）。
function md5(str) {
  const utf8 = unescape(encodeURIComponent(str)); // 每个 char 0-255 表示一个字节
  const n = utf8.length;
  const bitLen = n * 8;

  // 填充到 (n+1) ≡ 56 (mod 64)，再追加 8 字节长度
  let total = n + 1;
  while (total % 64 !== 56) total++;
  total += 8;
  const msg = new Uint8Array(total);
  for (let i = 0; i < n; i++) msg[i] = utf8.charCodeAt(i);
  msg[n] = 0x80;
  const lo = bitLen >>> 0;
  const hi = Math.floor(bitLen / 4294967296) >>> 0;
  msg[total - 8] = lo & 0xff; msg[total - 7] = (lo >>> 8) & 0xff;
  msg[total - 6] = (lo >>> 16) & 0xff; msg[total - 5] = (lo >>> 24) & 0xff;
  msg[total - 4] = hi & 0xff; msg[total - 3] = (hi >>> 8) & 0xff;
  msg[total - 2] = (hi >>> 16) & 0xff; msg[total - 1] = (hi >>> 24) & 0xff;

  const K = new Array(64);
  for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) >>> 0;
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rol = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

  for (let chunk = 0; chunk < total; chunk += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const j = chunk + i * 4;
      M[i] = (msg[j] | (msg[j + 1] << 8) | (msg[j + 2] << 16) | (msg[j + 3] << 24)) >>> 0;
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      const t = (B + rol(F, s[i])) >>> 0;
      A = D; D = C; C = B; B = t;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const hex = (x) => {
    let out = '';
    for (let i = 0; i < 4; i++) {
      out += ('0' + ((x >>> (i * 8)) & 0xff).toString(16)).slice(-2);
    }
    return out;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/* ============================ 工具：wbi 签名 ============================ */
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5,
  49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1,
  60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

let _mixinKeyCache = { key: null, ts: 0 };

async function getMixinKey() {
  // 缓存 10 分钟，避免每次下载都打 nav 接口
  if (_mixinKeyCache.key && Date.now() - _mixinKeyCache.ts < 10 * 60 * 1000) {
    return _mixinKeyCache.key;
  }
  const nav = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
    .then(r => r.json());
  const { img_url, sub_url } = nav.data.wbi_img;
  const raw = img_url.split('/').pop().split('.')[0]
    + sub_url.split('/').pop().split('.')[0];
  const mixinKey = MIXIN_TAB.map(i => raw[i]).join('').slice(0, 32);
  _mixinKeyCache = { key: mixinKey, ts: Date.now() };
  return mixinKey;
}

function signWbi(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000);
  const query = Object.entries({ ...params, wts })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v).replace(/[!'()*]/g, '')}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

/* ============================ 工具：文件名清洗 ============================ */
function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'bilibili';
}

/* ============================ 清晰度标签 ============================ */
const QN_LABEL = {
  127: '超清 8K', 120: '4K', 116: '1080P60/高码率', 112: '1080P+',
  80: '1080P', 74: '720P60', 64: '720P', 48: '720P', 32: '480P', 16: '360P'
};

/* ============================ 接口调用 ============================ */
function getBvid() {
  // 提取视频 ID，匹配不到则返回 null 让插件安静退出。
  // 命中后保留 URL 原始大小写——B 站 BV 号按位大小写敏感，av 前缀小写为常规形态。
  // ① 常规视频页：/video/BV1xx411c7mD 或 /video/av170001
  const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
  if (m) return m[1];

  // ② 稍后再看 / 收藏夹 / 播单：/list/watchlater?oid=117149746205974&bvid=BV1xwhN6KEaJ
  //    这类页面 pathname 固定为 /list/xxx，视频 ID 在 query 里，切换下一集时只改 query。
  if (/^\/list\//i.test(location.pathname)) {
    const q = new URLSearchParams(location.search);
    const bv = q.get('bvid');
    if (bv && /^BV[0-9A-Za-z]+$/i.test(bv)) return bv; // 优先 bvid（playurl 只认 bvid）
    const oid = q.get('oid');
    if (oid && /^\d+$/.test(oid)) return 'av' + oid;   // 退化用 aid：view 走 aid=，playurl 内部再换 BV 号
  }
  return null;
}

// 取当前 URL 对应分P的 cid：多P视频点击不同 P 时仅 ?p= 变化、bvid 不变，
// 需据此切到正确的 cid 重新解析流地址；单P视频直接返回 view.cid。
function currentCid(view) {
  const pm = new URLSearchParams(location.search).get('p');
  const p = pm ? parseInt(pm, 10) : 1;
  if (view && view.pages && view.pages.length && p >= 1 && p <= view.pages.length) {
    return view.pages[p - 1].cid;
  }
  return view ? view.cid : null;
}

// 统一构造视频标识参数：老 av 号用 aid=（bvid 参数不接受 av 前缀，否则接口返回 -400），
// BV 号用 bvid=。**仅适用于 view 接口**——view 对 aid/bvid 都接受。
function idParam(bvid) {
  // aid 用字符串原样传：B站 aid 已是 15 位大整数，parseInt 会在超过 2^53 时丢精度
  return /^av\d+$/i.test(bvid)
    ? { aid: bvid.slice(2) }
    : { bvid };
}

// playurl 接口只接受 bvid=，传 aid= 一律 -400（实测：view?aid= 正常，playurl?aid= 报请求错误）。
// 因此 av 号需先经 view 接口换成真正的 BV 号；结果按 aid 缓存，避免重复打接口。
const _avBvCache = new Map();
async function toBvid(id) {
  if (!/^av\d+$/i.test(id)) return id;
  if (_avBvCache.has(id)) return _avBvCache.get(id);
  const d = await fetchView(id);
  if (d && d.bvid) {
    _avBvCache.set(id, d.bvid);
    return d.bvid;
  }
  throw new Error('无法解析该 av 号对应的 BV 号');
}

// 统一取 JSON：风控拦截时 B 站会直接回 HTTP 412（HTML 而非 JSON），
// 直接 r.json() 会抛 SyntaxError，掩盖真实原因，这里转成可读错误。
async function fetchJson(url) {
  const r = await fetch(url, { credentials: 'include' });
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch (_) {
    throw new Error('HTTP ' + r.status + (r.status === 412 ? '（请求被风控拦截，请稍后重试）' : '（非 JSON 响应）'));
  }
}

// 接口返回的图片/CDN 直链可能是 http://，直接用于页面会触发 Mixed Content。
// hdslb/bilivideo CDN 均支持 HTTPS，统一升级避免控制台告警与升级失败。
function toHttps(u) {
  return typeof u === 'string' ? u.replace(/^http:\/\//i, 'https://') : u;
}

async function fetchView(bvid) {
  const base = 'https://api.bilibili.com/x/web-interface/view?' + new URLSearchParams(idParam(bvid));

  async function doFetch(url) {
    const r = await fetch(url, { credentials: 'include' });
    return r.json();
  }

  let j = await doFetch(base);
  if (j.code !== 0 && [-400, -403, -412].includes(j.code)) {
    // 部分视频在风控或签名校验下返回非零，尝试追加 WBI 签名重试一次
    try {
      const mixinKey = await getMixinKey();
      // signWbi 的返回值已包含全部业务参数，不需再拼 base（避免参数重复）
      const query = signWbi(idParam(bvid), mixinKey);
      j = await doFetch(`https://api.bilibili.com/x/web-interface/view?${query}`);
    } catch (_) { /* WBI 重试失败，沿用原始错误 */ }
  }

  if (j.code !== 0) {
    const msgMap = { '-400': '请求参数错误', '-403': '无访问权限(需登录/大会员)',
      '-404': '视频不存在或已删除', '-412': '请求被风控拦截',
      '62002': '稿件不可见', '62004': '稿件审核中', '62012': '仅UP主可见' };
    throw new Error('view 接口错误(' + j.code + '): ' + (msgMap[String(j.code)] || j.message));
  }
  return j.data;
}

async function fetchPlayurl(bvid, cid, fnval, qn) {
  // playurl 只吃 bvid：av 号先换成 BV 号，否则必然 -400
  const bv = await toBvid(bvid);
  const params = { bvid: bv, cid, qn, fnval, fourk: 1 };

  let j = null, lastErr = null;
  // 主路径：WBI 签名接口
  try {
    const mixinKey = await getMixinKey();
    const query = signWbi(params, mixinKey);
    j = await fetchJson(`https://api.bilibili.com/x/player/wbi/playurl?${query}`);
  } catch (e) {
    lastErr = e;
  }
  // 降级：签名接口失败（风控 412 / 签名异常）时退回非签名接口重试一次
  if (!j || j.code !== 0) {
    try {
      const alt = await fetchJson(`https://api.bilibili.com/x/player/playurl?${new URLSearchParams(params)}`);
      if (alt && (alt.code === 0 || !j)) j = alt; // 降级成功或主路径根本没拿到 JSON
    } catch (e) {
      lastErr = e;
    }
  }
  if (!j) throw lastErr || new Error('playurl 请求失败');

  if (j.code !== 0) {
    const msgMap = { '-352': '风控校验失败(请稍后再试)', '-400': '请求参数错误',
      '-403': '无访问权限(需登录/大会员)', '-404': '视频不存在', '-412': '请求被风控拦截' };
    throw new Error('playurl 接口错误(' + j.code + '): ' + (msgMap[String(j.code)] || j.message));
  }
  return j.data;
}

/* ============================ 下载落地 ============================ */
function downloadViaExtension(url, filename) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'bili-download', url, filename }, (resp) => {
      resolve(resp || { ok: false, error: 'no response' });
    });
  });
}

// 在 content script 内触发 Blob 落地。
// 注意：B站页面沙箱未设 allow-downloads，程序化 <a download>（脱离用户手势窗口时）
// 会被拦截（"Download is disallowed... sandboxed"）。大文件/耗时任务请改用
// saveViaOffscreen 走 offscreen 文档下载；此函数仅保留给紧贴用户手势的小文件场景。
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

// 经 offscreen 文档落地文件：content 的 <a download> 被页面沙箱拦截
// （allow-downloads 未设置，合成/合并耗时数分钟早已脱离用户手势窗口），
// 而 offscreen.html 是普通扩展页面（chrome-extension://）不受此限制。
// 协议：bili-save-init（确保 offscreen 就绪）→ bili-save-chunk × N → bili-save-go。
// 每块 16MB 原始数据（base64 后约 21.3MB，低于 64MiB 单消息上限），逐块 await 形成流控。
// 返回 bili-save-go 的响应（含 converted 标记：FLV 是否已转封装为 MP4）。
async function saveViaOffscreen(bytes, filename, mime) {
  const requestId = 'save_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const sendMsg = (payload) => new Promise((res, rej) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
      res(resp);
    });
  });
  await sendMsg({ type: 'bili-save-init', requestId, filename, mime });
  const CHUNK = 16 * 1048576;
  const n = Math.max(1, Math.ceil(bytes.length / CHUNK));
  for (let i = 0; i < n; i++) {
    const piece = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
    let bin = '';
    for (let j = 0; j < piece.length; j += 0x8000) {
      bin += String.fromCharCode.apply(null, piece.subarray(j, j + 0x8000));
    }
    await sendMsg({ type: 'bili-save-chunk', requestId, index: i, b64: btoa(bin) });
  }
  const goResp = await sendMsg({ type: 'bili-save-go', requestId });
  if (goResp && goResp.ok === false) throw new Error(goResp.error || 'offscreen 落地失败');
  return goResp || {};
}

// 单独保存 DASH 音视频流（.m4s）：走 content 内 fetch（带页面 Referer 通过 CDN 鉴权），
// 落地经 saveViaOffscreen 交给 offscreen 文档——fetch 是异步的，等拉完早已脱离用户
// 手势窗口，content 的 <a download> 会被页面沙箱拦截（allow-downloads 未设置）。
// 关键点：chrome.downloads.download 发起的下载没有“来源页面”，不会带 Referer，
// 而 B站媒体 CDN 直链（bilivideo.com / *.edge.mountaintoys.cn 等边缘节点）会校验 Referer，
// 缺失则返回 403 的 HTML 错误页 —— 于是浏览器把下载命名成 xxx.html 并报“已被禁止”。
// 在 content script 里 fetch 时，浏览器会自动带上当前页 Referer（no-referrer-when-downgrade），
// 走通鉴权，再把字节交给 offscreen 落地，文件名即我们指定的 .m4s。
async function downloadStream(url, filename) {
  const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer-when-downgrade' });
  if (!r.ok) throw new Error('流拉取失败: HTTP ' + r.status);
  const bytes = new Uint8Array(await r.arrayBuffer());
  await saveViaOffscreen(bytes, filename, 'video/mp4');
  return { ok: true };
}

// 依次 fetch 多个直链分段，拼接成一个 Blob（FLV 容器可直接二进制拼接）
// onRatio(ratio): ratio∈[0,1]，基于各分段 GET 响应 Content-Length 累计算出；
//   若某分段拿不到长度则退回按分段数计比例。用 ReadableStream 读字节以驱动平滑进度。
let netBytesTotal = 0; // 本工具下载字节累计（用于实时网络速率统计）
async function fetchAndConcat(urls, onRatio) {
  const chunks = [];
  let downloaded = 0, totalSize = 0;
  for (let i = 0; i < urls.length; i++) {
    // 直链自带签名鉴权（upsig/deadline），无需 Cookie；部分 CDN 节点不允许 credentials
    // 跨域（Access-Control-Allow-Credentials 为空会被浏览器拦），故显式 omit。
    const r = await fetch(urls[i], { credentials: 'omit', referrerPolicy: 'no-referrer-when-downgrade' });
    if (!r.ok) throw new Error('分段 ' + (i + 1) + ' 拉取失败: HTTP ' + r.status);
    const cl = Number(r.headers.get('content-length')) || 0;
    totalSize += cl;
    const reader = r.body.getReader();
    const segs = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      segs.push(value);
      received += value.length;
      netBytesTotal += value.length;
      if (onRatio && totalSize > 0) onRatio((downloaded + received) / totalSize);
    }
    downloaded += received;
    chunks.push(...segs);
    if (onRatio) onRatio(totalSize > 0 ? downloaded / totalSize : (i + 1) / urls.length);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  // 返回 Uint8Array（而非 Blob）：落地统一走 saveViaOffscreen，由其分块传给 offscreen
  return out;
}

// 单个直链的流式拉取（带进度），用于「合成 MP4」时拉取视频/音频流。
// 用 credentials:'omit' —— B站媒体 CDN 直链自带签名鉴权、无需 Cookie，
// 且多数 CDN 节点不允许 credentials 跨域（会导致 CORS 失败 / 卡死）。
// 与 FLV 合并（fetchAndConcat）使用同一套参数，是验证可用的路径。
//
// 超时策略：不用「总时长」硬超时——大文件下载耗时久会被误杀，表现为
// "BodyStreamBuffer was aborted"。改用「停滞」超时：只要持续收到字节就不中断，
// 仅当 stallMs 内没有任何数据到达才判定卡死并中止。
async function fetchStream(url, onProgress, stallMs = 60000) {
  const ctrl = new AbortController();
  let timer = null;
  const arm = () => { // 每收到一个分块重置计时
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), stallMs);
  };
  arm();
  try {
    const r = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer-when-downgrade',
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('直链 HTTP ' + r.status);
    const cl = Number(r.headers.get('content-length')) || 0;
    const reader = r.body.getReader();
    const segs = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); // 收到数据，重置停滞计时
      segs.push(value);
      received += value.length;
      netBytesTotal += value.length;
      // onProgress(received, total)：total 为 Content-Length，缺失时为 0
      if (onProgress) onProgress(received, cl);
    }
    let total = 0;
    for (const s of segs) total += s.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const s of segs) { out.set(s, off); off += s.length; }
    if (onProgress) onProgress(total, total);
    return out.buffer; // 精确长度的 ArrayBuffer
  } catch (e) {
    // 区分「停滞超时中止」与真实网络错误，给出可读提示
    if (ctrl.signal.aborted) throw new Error('下载停滞超时（' + Math.round(stallMs / 1000) + 's 无数据到达），可重试或改用 FLV 合并');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ============================ 面板 UI（Shadow DOM 隔离样式） ============================ */
const STYLE = `
  :host { all: initial; }
  .panel { position: fixed; left: 0; top: 0; z-index: 2147483647; width: 340px;
    background: #fff; border: 3px solid #000; box-shadow: 6px 6px 0 #000; border-radius: 10px;
    padding: 14px; box-sizing: border-box; overflow-y: auto; overflow-x: hidden;
    max-height: calc(100vh - 16px);
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 13px; color: #1a1a1a;
    transform-origin: top left; opacity: 0; transform: translateY(-10px) scale(.96);
    pointer-events: none; visibility: hidden;
    transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s; }
  .panel::-webkit-scrollbar { width: 10px; }
  .panel::-webkit-scrollbar-thumb { background: #fb7299; border: 2px solid #000; border-radius: 6px; }
  .panel::-webkit-scrollbar-track { background: #eee; }
  .panel.show { opacity: 1; transform: none; pointer-events: auto; visibility: visible;
    transition: opacity .18s ease, transform .18s ease; }
  .title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .title { font-weight: 700; font-size: 14px; line-height: 1.4; word-break: break-all; flex: 1; min-width: 0; }
  .close-btn { flex: none; width: 28px; height: 28px; padding: 0; line-height: 1; font-size: 18px; font-weight: 700;
    background: #fff; color: #1a1a1a; border: 2px solid #000; border-radius: 6px; box-shadow: 2px 2px 0 #000; cursor: pointer; }
  .close-btn:active { transform: translate(1px,1px); box-shadow: 1px 1px 0 #000; }
  .subtitle { font-size: 11px; color: #6b6b6b; margin: -2px 0 8px 0; line-height: 1.55; word-break: break-all;
    font-variant-numeric: tabular-nums; }
  .subtitle .id { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #1a1a1a; }
  .subtitle .hint { color: #6b6b6b; }
  .cover { width: 100%; border: 2px solid #000; border-radius: 6px; margin-bottom: 10px; display: none; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  button.act { flex: 1 1 auto; background: #fff; border: 2px solid #000; border-radius: 6px; padding: 7px 8px; cursor: pointer; font-weight: 600; box-shadow: 2px 2px 0 #000; font-size: 13px; color: #1a1a1a; }
  button.act:active { transform: translate(1px,1px); box-shadow: 1px 1px 0 #000; }
  button.act.primary { background: #fb7299; color: #fff; }
  button.act:disabled { opacity: .5; cursor: not-allowed; }
  select { width: 100%; padding: 6px; border: 2px solid #000; border-radius: 6px; margin-bottom: 8px; font-size: 13px; }
  .pages { border-top: 2px dashed #000; padding-top: 8px; margin-top: 4px; display: none; }
  .pages.show { display: block; }
  .pg { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .pg input { accent-color: #fb7299; }
  .pg span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { color: #fb7299; font-weight: 600; min-height: 16px; margin-top: 4px; }
  .status-row { display: flex; align-items: center; gap: 6px; }
  .btn-retry { background: none; border: none; cursor: pointer; padding: 2px; display: flex; align-items: center;
    color: #fb7299; transition: transform .25s ease; flex-shrink: 0; }
  .btn-retry:hover { transform: rotate(180deg); }
  .btn-retry svg { width: 18px; height: 18px; display: block; }
  .flvbox { display: none; margin-top: 6px; }
  .pbar { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
  .pbar .pl { width: 64px; flex: none; color: #1a1a1a; }
  .pbar .track { flex: 1; height: 10px; background: #eee; border: 2px solid #000; border-radius: 6px; overflow: hidden; }
  .pbar .fill { height: 100%; width: 0%; background: #fb7299; transition: width .2s ease; }
  .pbar .pv { width: 40px; text-align: right; flex: none; font-variant-numeric: tabular-nums; }
  .fmt-help { font-size: 11px; color: #6b6b6b; line-height: 1.55; margin-top: 8px;
    border-top: 2px dashed #000; padding-top: 8px; word-break: break-all; }
  .fmt-help b { color: #1a1a1a; }
  .panel-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px;
    border-top: 2px dashed #000; padding-top: 8px; }
  .panel-footer .footer-left { display: flex; align-items: center; gap: 6px; }
  .panel-footer .footer-logo { width: 24px; height: 24px; border-radius: 6px; display: block; }
  .panel-footer .footer-name { font-size: 12px; font-weight: 700; color: #1a1a1a; }
  .panel-footer .footer-right { display: flex; align-items: center; gap: 8px; }
  .panel-footer .ver { font-size: 11px; color: #888; font-variant-numeric: tabular-nums; }
  .panel-footer a { display: inline-flex; align-items: center; color: #1a1a1a; }
  .panel-footer a:hover { color: #fb7299; }
  .panel-footer svg { width: 14px; height: 14px; display: block; }
  .resbox { margin-top: 8px; border-top: 2px dashed #000; padding-top: 8px; }
  .resbox .res-title { font-size: 11px; font-weight: 700; color: #1a1a1a; margin-bottom: 6px; }
  .res-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .res-cell { background: #fafafa; border: 2px solid #000; border-radius: 6px; padding: 6px 8px; }
  .res-cell .rk { font-size: 10px; color: #666; }
  .res-cell .rv { font-size: 14px; font-weight: 700; color: #fb7299; font-variant-numeric: tabular-nums; }
`;

// 自有图标：粉色下载箭头（与扩展图标同款设计，站内工具栏里以粉色描边区别于 B站灰标）
const ICON_SVG = `<svg viewBox="0 0 1024 1024" width="20" height="20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M832 448h-192V0H384v448H192v64l320 320 320-320V448zM896 896H128v128h768v-128z" fill="#fb7299"/></svg>`;

// 重试/刷新图标（解析失败时显示在状态文字旁）
const REFRESH_SVG = `<svg viewBox="0 0 1024 1024" width="18" height="18" xmlns="http://www.w3.org/2000/svg"><path d="M369.777778 160.568889a42.666667 42.666667 0 0 1-42.666667 42.666667H128a42.666667 42.666667 0 1 1 0-85.333334h199.111111a42.666667 42.666667 0 0 1 42.666667 42.666667" fill="#fb7299"/><path d="M327.111111 402.346667a42.666667 42.666667 0 0 1-42.666667-42.666667v-199.111111a42.666667 42.666667 0 1 1 85.333334 0v199.111111a42.666667 42.666667 0 0 1-42.666667 42.666667" fill="#fb7299"/><path d="M512.014222 938.652444h-0.753778a424.533333 424.533333 0 0 1-294.272-124.913777c-80.583111-80.583111-124.956444-187.733333-124.956444-301.696 0-113.976889 44.373333-221.112889 124.970667-301.696l73.088-73.116445a42.680889 42.680889 0 0 1 60.359111 60.344889l-73.102222 73.102222a339.057778 339.057778 0 0 0-99.982223 241.351111A339.128889 339.128889 0 0 0 277.333333 753.422222a339.640889 339.640889 0 0 0 235.406223 99.911111 42.680889 42.680889 0 0 1-0.725334 85.333334M654.222222 863.473778v-0.014222a42.666667 42.666667 0 0 1 42.666667-42.666667h199.111111a42.666667 42.666667 0 0 1 0 85.333333H696.888889a42.666667 42.666667 0 0 1-42.666667-42.666666" fill="#fb7299"/><path d="M696.888889 621.681778a42.666667 42.666667 0 0 1 42.666667 42.666666v199.111112a42.666667 42.666667 0 0 1-85.333334 0v-199.111112a42.666667 42.666667 0 0 1 42.666667-42.666666" fill="#fb7299"/><path d="M703.715556 899.285333a42.638222 42.638222 0 0 1-30.165334-72.832l73.130667-73.102222c133.077333-133.091556 133.077333-349.653333 0-482.730667A339.100444 339.100444 0 0 0 505.315556 170.666667a42.666667 42.666667 0 1 1 0-85.333334c113.976889 0 221.112889 44.387556 301.681777 124.970667 166.357333 166.343111 166.357333 436.387556 0 602.730666l-73.130667 73.102223a42.638222 42.638222 0 0 1-30.15111 8.148444z" fill="#fb7299"/></svg>`;

function buildPanel(host) {
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${STYLE}</style>
    <div class="panel" id="panel">
      <div class="title-row">
        <div class="title" id="title">解析中…</div>
        <button class="close-btn" id="btn-close" type="button" aria-label="关闭">×</button>
      </div>
      <div class="subtitle" id="subtitle"></div>
      <img class="cover" id="cover" alt="封面"/>
      <div class="row">
        <button class="act primary" id="btn-cover">下载封面</button>
      </div>
      <div class="row">
        <button class="act" id="btn-flvm">兼容下载（低码率）</button>
      </div>
      <div class="flvbox" id="flvbox">
        <div class="pbar"><span class="pl">下载 FLV</span><div class="track"><div class="fill" id="pb-f"></div></div><span class="pv" id="pct-f">0%</span></div>
      </div>
      <label style="display:block;font-weight:600;margin-bottom:4px;">DASH 清晰度（音视频分离）</label>
      <select id="qn"></select>
      <div class="row">
        <button class="act" id="btn-video">下载视频流</button>
        <button class="act" id="btn-audio">下载音频流</button>
      </div>
      <div class="row">
        <button class="act primary" id="btn-mux">高级下载（高码率）</button>
      </div>
      <div class="flvbox" id="muxbox">
        <div class="pbar"><span class="pl">合成 MP4</span><div class="track"><div class="fill" id="pb-m"></div></div><span class="pv" id="pct-m">0%</span></div>
      </div>
      <div class="status-row"><div class="status" id="status"></div><button class="btn-retry" id="btn-retry" style="display:none;" title="重新解析" aria-label="重新解析"></button></div>
      <div class="resbox">
        <div class="res-title">实时资源占用</div>
        <div class="res-grid">
          <div class="res-cell"><div class="rk">内存</div><div class="rv" id="res-mem">—</div></div>
          <div class="res-cell"><div class="rk">网络</div><div class="rv" id="res-net">0.0 MB/s</div></div>
        </div>
      </div>
      <div class="fmt-help"><b>兼容下载</b>：HTTP-FLV 流，音视频单文件封装，码率低、体积小、下载快，成功率极高。<br><b>高级下载</b>：DASH 流，音视频分离，支持原画及 4K 高码率，有小概率失败。</div>
      <div class="panel-footer">
        <div class="footer-left"><img class="footer-logo" id="footer-logo" alt="Bili-Mux"/><span class="footer-name">哔哩喵</span></div>
        <div class="footer-right"><span class="ver" id="panel-ver">v1.1.3</span>
        <a href="https://github.com/c-yyy/bili-mux" target="_blank" rel="noopener" title="GitHub 仓库" aria-label="GitHub 仓库"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.26 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg></a></div>
      </div>
    </div>`;
  return root;
}

// 把触发按钮注入到 B站 .video-toolbar-left-main 容器的末尾，并克隆容器内参考元素的
// 样式，使它与“点赞/投币/收藏/分享”等其它元素视觉一致。
function injectToolbarStyle() {
  if (document.getElementById('bili-mux-style')) return;
  const style = document.createElement('style');
  style.id = 'bili-mux-style';
  style.textContent = `
    .bili-mux-item { display: inline-flex !important; align-items: center; gap: 4px;
      box-sizing: border-box; user-select: none; cursor: pointer;
      border: 2px solid transparent; border-radius: 6px; background: transparent;
      transition: transform .18s ease, filter .18s ease, border-color .18s ease, background .18s ease; }
    .bili-mux-item svg { width: 20px; height: 20px; display: block; flex: none; }
    .bili-mux-item .bili-mux-label { font-size: 13px; line-height: 1; color: #fb7299; }
    .bili-mux-item:hover { color: #fb7299 !important;
      transform: translateY(-2px) scale(1.06);
      filter: drop-shadow(0 3px 5px rgba(251,114,153,.45));
      border-color: #fb7299; background: rgba(251,114,153,.12); }
    .bili-mux-item:hover svg { animation: bili-mux-bob .85s ease-in-out infinite; }
    @keyframes bili-mux-bob {
      0% { transform: translateY(-2px); }
      60% { transform: translateY(3px); }
      100% { transform: translateY(-2px); }
    }
  `;
  document.head.appendChild(style);
}

// 播放器工具栏容器：视频页为 .video-toolbar-left-main；稍后再看 / 收藏夹 / 播单（/list/*）
// 是同一播放器组件的变体布局，class 可能有出入，这里按优先级兜底，取第一个命中的容器。
const TOOLBAR_SELECTORS = [
  '.video-toolbar-left-main',
  '.video-toolbar-left',
  '[class*="toolbar-left-main"]',
  '[class*="toolbar-left"]'
];
function findToolbar() {
  for (const sel of TOOLBAR_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function injectToggle(togglePanel) {
  const toolbar = findToolbar();
  if (!toolbar) return false;
  if (document.getElementById('bili-mux-toggle')) return true;

  const btn = document.createElement('div');
  btn.id = 'bili-mux-toggle';
  btn.className = 'bili-mux-item';
  btn.setAttribute('role', 'button');
  btn.setAttribute('title', '哔哩喵 (Bili-Mux)');
  btn.innerHTML = ICON_SVG + '<span class="bili-mux-label">保存</span>';

  // 克隆容器里第一个元素的 computed style，让本按钮与兄弟元素同字体/颜色/间距
  // （cursor 除外：克隆来的 default 会盖掉手型光标，这里强制 pointer）
  const ref = toolbar.children[0];
  if (ref) {
    const cs = getComputedStyle(ref);
    ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
     'padding', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
     'margin', 'textAlign'].forEach((p) => { if (cs[p]) btn.style[p] = cs[p]; });
  }
  // 覆盖克隆来的内边距：给带边框/背景的悬停态留出内部呼吸空间（inline 优先于 CSS）
  btn.style.padding = '5px 9px';
  btn.style.cursor = 'pointer';
  let _toggleLast = 0;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - _toggleLast < 300) return; // 防抖：忽略过密的连续点击
    _toggleLast = now;
    togglePanel();
  });
  toolbar.appendChild(btn);
  return true;
}

// SPA 切换视频 / 页面局部重渲染后，保证按钮不丢
function observeToolbar(togglePanel) {
  injectToolbarStyle();
  if (!injectToggle(togglePanel)) {
    const iv = setInterval(() => {
      if (injectToggle(togglePanel)) {
        clearInterval(iv);
      } else if (!findToolbar()) {
        // 容器尚未出现，继续等待
      }
    }, 1200);
    setTimeout(() => clearInterval(iv), 30000);
  }
  const mo = new MutationObserver(() => {
    if (!document.getElementById('bili-mux-toggle')) injectToggle(togglePanel);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

/* ============================ 主逻辑 ============================ */
// 整段包进 IIFE：main 与 bootstrap 都不外泄到全局
(function () {
function main() {
  if (document.getElementById('bili-mux-host')) return; // 防止重复注入
  let bvid = getBvid();
  if (!bvid) return;

  const host = document.createElement('div');
  host.id = 'bili-mux-host';
  document.body.appendChild(host);
  const root = buildPanel(host);
  const panelEl = root.getElementById('panel');
  // 依据触发按钮（#bili-mux-toggle）的视口坐标，把面板放到其右侧、顶部平齐；
  // 若右侧放不下则翻到按钮左侧。面板为 fixed，正好吃 getBoundingClientRect 的视口坐标。
  function positionPanelToButton() {
    const btn = document.getElementById('bili-mux-toggle');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const gap = 8;
    const panelW = panelEl.offsetWidth || 340;
    let left = r.right + gap;
    if (left + panelW > window.innerWidth - 8) left = r.left - gap - panelW; // 右侧放不下→翻到左侧
    if (left < 8) left = 8;
    // 垂直方向：保证面板不超出视口底部；页面高度不足时让面板内部滚动而非被截断
    const top = r.top < 8 ? 8 : r.top;
    const avail = window.innerHeight - top - 8;
    panelEl.style.left = left + 'px';
    panelEl.style.top = top + 'px';
    panelEl.style.maxHeight = Math.max(140, avail) + 'px';
  }
  const closePanel = () => panelEl.classList.remove('show');
  const togglePanel = () => {
    const willShow = !panelEl.classList.contains('show');
    if (willShow) positionPanelToButton();
    panelEl.classList.toggle('show');
  };
  // 点击面板 / 触发按钮以外区域时关闭卡片。用 composedPath 穿透 Shadow DOM 判断真实点击目标。
  document.addEventListener('click', (e) => {
    if (!panelEl.classList.contains('show')) return;
    const path = (e.composedPath && e.composedPath()) || [];
    const toggle = document.getElementById('bili-mux-toggle');
    if (host && path.indexOf(host) !== -1) return;        // 点击面板内部
    if (toggle && path.indexOf(toggle) !== -1) return;    // 点击触发按钮
    closePanel();
  }, true);
  // 按 Esc 关闭，避免鼠标够不到关闭区域时的尴尬
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelEl.classList.contains('show')) closePanel();
  });
  // 打开期间随页面滚动/缩放保持与按钮对齐（left/top 无过渡，不会闪烁）
  window.addEventListener('scroll', () => {
    if (panelEl.classList.contains('show')) positionPanelToButton();
  }, { passive: true });
  window.addEventListener('resize', () => {
    if (panelEl.classList.contains('show')) positionPanelToButton();
  });

  const $ = (id) => root.getElementById(id);
  const elTitle = $('title'), elCover = $('cover'), elQn = $('qn'),
    elStatus = $('status');

  let viewData = null;     // view 接口结果
  let dashData = null;     // playurl DASH 结果
  let flvData = null;      // playurl FLV 结果
  let _gen = 0;            // URL 变化世代号：防止快速切换时旧请求回写新数据
  let _lastBvid = bvid;    // 上次解析的视频 ID
  let _lastSearch = location.search; // 上次 URL query（含 ?p=）
  const _ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '1.1.3';
  const elVer = $('panel-ver');
  if (elVer) elVer.textContent = 'v' + _ver;
  // 底部栏扩展图标（需 manifest web_accessible_resources 放行）
  const elLogo = $('footer-logo');
  if (elLogo) elLogo.src = chrome.runtime.getURL('icons/icon128.png');
  // 重试按钮
  const btnRetry = $('btn-retry');
  if (btnRetry) { btnRetry.innerHTML = REFRESH_SVG; btnRetry.addEventListener('click', () => { btnRetry.style.display = 'none'; init(); }); }
  console.info('%c bili-mux %c v' + _ver + ' %c 加载成功 ',
    'padding: 2px 6px; border-radius: 3px 0 0 3px; color: #fff; background: #fb7299; font-weight: bold;',
    'padding: 2px 6px; color: #fff; background: #FF9999; font-weight: bold;',
    'padding: 2px 6px; border-radius: 0 3px 3px 0; color: #fff; background: #4CAF50; font-weight: bold;');
  console.log('[bili-mux] content script 注入成功，bvid =', bvid);

  function setStatus(t) { elStatus.textContent = t || ''; }

  // —— 实时资源占用 ——
  // 稳定版 Chrome 不暴露整机/进程级 CPU、GPU，面板只保留可真实获取的两项：
  //   内存：本扩展 content script 的 JS 堆占用（performance.memory，真实值）；
  //   网络：本工具下载字节累计实测速率。
  let netSpeed = 0;
  let _lastNetT = performance.now(), _lastNetBytes = netBytesTotal;
  function renderRes() {
    const mem = $('res-mem'), net = $('res-net');
    if (mem) {
      const heap = (performance && performance.memory) ? performance.memory.usedJSHeapSize / 1048576 : null;
      mem.textContent = (heap == null) ? '—' : heap.toFixed(0) + ' MB';
    }
    if (net) net.textContent = (netSpeed / 1048576).toFixed(1) + ' MB/s';
  }
  renderRes();
  setInterval(() => {
    const now = performance.now();
    const dt = (now - _lastNetT) / 1000;
    netSpeed = dt > 0 ? (netBytesTotal - _lastNetBytes) / dt : 0;
    _lastNetBytes = netBytesTotal; _lastNetT = now;
    renderRes();
  }, 1000);

  // 更新某条进度条：which = 'v' | 'a' | 'm' | 'f'
  function setBar(which, ratio) {
    const fill = $('pb-' + which), pct = $('pct-' + which);
    if (!fill) return;
    if (typeof ratio !== 'number' || isNaN(ratio)) ratio = 0; // 兜底：ffmpeg 可能传 NaN/对象
    if (ratio < 0) { fill.style.width = '100%'; fill.style.opacity = '.4'; pct.textContent = '…'; }
    else {
      ratio = Math.min(1, Math.max(0, ratio)); // 钳制：部分分段无 Content-Length 时比例可能越界
      fill.style.width = Math.round(ratio * 100) + '%'; fill.style.opacity = '1'; pct.textContent = Math.round(ratio * 100) + '%';
    }
  }

  // 统一的点击节流/防抖：忽略 debounceMs 内的重复点击；上一次还在执行时禁止重入
  // （避免双击触发多次下载或重入导致状态错乱）。执行期间按钮置灰。
  function guarded(btn, fn, debounceMs = 400) {
    if (!btn) return;
    let last = 0;
    btn.addEventListener('click', async () => {
      const now = Date.now();
      if (now - last < debounceMs) return; // 防抖：过密的连续点击忽略
      last = now;
      if (btn._busy) return;               // 节流：上次未结束则忽略
      btn._busy = true;
      const prev = btn.disabled;
      btn.disabled = true;
      try { await fn(); }
      catch (e) { setStatus('出错了: ' + (e && e.message)); }
      finally { btn._busy = false; btn.disabled = prev; }
    });
  }


  // 把触发按钮注入 B站播放器工具栏（容器末尾），SPA 切换后自动补回
  observeToolbar(togglePanel);
  // 监听 URL 变化（SPA 切换视频 / 切换分P），重新解析封面与下载相关流
  watchUrl();

  // SPA 切换视频 / 点击其它 P：URL（bvid 或 ?p=）变化后重新解析封面与下载相关流。
  // 包装 history API + 监听 popstate/hashchange + 轮询兜底（B站 SPA 走 pushState，
  // 个别异步渲染路径可能漏捕获，1.5s 轮询足够轻量且可靠）。
  function resetPanelForNewVideo() {
    elTitle.textContent = '解析中…';
    elCover.style.display = 'none';
    $('muxbox').style.display = 'none';
    $('flvbox').style.display = 'none';
    setStatus('');
  }

  function onUrlChange() {
    const newBvid = getBvid();
    const newSearch = location.search;
    if (newBvid === _lastBvid && newSearch === _lastSearch) return; // 无变化
    _lastBvid = newBvid;
    _lastSearch = newSearch;
    if (!newBvid) {
      // 离开视频页（例如回到首页）：不销毁面板 DOM，仅收起，等待下次进入视频页
      closePanel();
      return;
    }
    bvid = newBvid;
    resetPanelForNewVideo();
    init();
  }

  function watchUrl() {
    const _ps = history.pushState, _rs = history.replaceState;
    history.pushState = function () {
      const r = _ps.apply(this, arguments);
      onUrlChange();
      return r;
    };
    history.replaceState = function () {
      const r = _rs.apply(this, arguments);
      onUrlChange();
      return r;
    };
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);
    setInterval(onUrlChange, 1500); // 轮询兜底
  }

  async function init() {
    const myGen = ++_gen; // 本次解析世代号；若期间发生 URL 变化，旧请求回写会被丢弃
    if (btnRetry) btnRetry.style.display = 'none';
    try {
      viewData = await fetchView(bvid);
      if (myGen !== _gen) return;
      // view 会回传真实 BV 号，先入缓存：av 号链接下 playurl 可直接复用，不必再打一次 view
      if (viewData && viewData.bvid) _avBvCache.set(bvid, viewData.bvid);
      elTitle.textContent = viewData.title;
      // 副标题：URL 中的视频 ID（BVID / 老格式 avid）+ 封面右键操作提示
      $('subtitle').innerHTML = '<span class="id">' + bvid + '</span> <span class="hint">（封面图可右键复制或保存）</span>';
      if (viewData.pic) {
        elCover.src = toHttps(viewData.pic);
        elCover.style.display = 'block';
      }
      // 默认拿当前分P（?p=）对应的 cid 的 playurl
      await loadPlayurl(currentCid(viewData));
      if (myGen !== _gen) return;
    } catch (e) {
      if (myGen !== _gen) return; // 已被新导航取代，静默
      elTitle.textContent = '解析失败';
      setStatus(e.message);
      if (btnRetry) btnRetry.style.display = '';
    }
  }

  async function loadPlayurl(cid) {
    dashData = await fetchPlayurl(bvid, cid, 16, 80); // DASH
    // 填充清晰度下拉
    elQn.innerHTML = '';
    (dashData.dash.video || []).forEach((v) => {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = `${QN_LABEL[v.id] || v.id} (${Math.round(v.bandwidth / 1000)}kbps)`;
      elQn.appendChild(o);
    });
    // FLV 分段（用于合并下载）：qn 拉到最高，拿到 durl 能提供的最佳画质
    try { flvData = await fetchPlayurl(bvid, cid, 0, 120); } catch (e) { flvData = null; }
  }

  function pickVideoUrls() {
    const qn = Number(elQn.value);
    const list = dashData.dash.video || [];
    let pick = list.find(v => v.id === qn) || list[0];
    return [pick.baseUrl, ...(pick.backupUrl || [])].filter(Boolean).map(toHttps);
  }
  function pickAudioUrls() {
    const list = dashData.dash.audio || [];
    let pick = list[0];
    return [pick.baseUrl, ...(pick.backupUrl || [])].filter(Boolean).map(toHttps);
  }

  // 关闭卡片（右上角 ×）
  guarded($('btn-close'), closePanel);

  // 封面下载
  guarded($('btn-cover'), async () => {
    if (!viewData || !viewData.pic) return setStatus('暂无封面');
    setStatus('封面下载中…');
    const r = await downloadViaExtension(toHttps(viewData.pic), `${sanitize(viewData.title)}_封面.jpg`);
    setStatus(r.ok ? '封面已提交下载' : ('封面下载失败: ' + (r.error || '')));
  });

  // DASH 视频 / 音频 分别保存：两份独立 m4s，留给用户自行合成
  guarded($('btn-video'), async () => {
    if (!dashData) return setStatus('请先等待解析');
    const url = pickVideoUrls()[0];
    setStatus('视频流下载中…');
    try {
      await downloadStream(url, `${sanitize(viewData.title)}_${elQn.value}_video.m4s`);
      setStatus('视频流已保存（.m4s）— 可在下载目录用本地 ffmpeg 合成');
    } catch (e) {
      setStatus('视频流下载失败: ' + (e && e.message) + '（可改用 FLV 合并或浏览器内合成）');
    }
  });
  guarded($('btn-audio'), async () => {
    if (!dashData) return setStatus('请先等待解析');
    setStatus('音频流下载中…');
    try {
      await downloadStream(pickAudioUrls()[0], `${sanitize(viewData.title)}_audio.m4s`);
      setStatus('音频流已保存（.m4s）— 可在下载目录用本地 ffmpeg 合成');
    } catch (e) {
      setStatus('音频流下载失败: ' + (e && e.message) + '（可改用 FLV 合并或浏览器内合成）');
    }
  });

  // 浏览器内合成 MP4：按顺序拉取视频流 → 音频流（不并行），再分块 base64 传给
  // offscreen 里的 ffmpeg.wasm 封装成单个 MP4；成品由 offscreen 直接下载。
  //
  // 注意：chrome.runtime.sendMessage 只支持 JSON 序列化，ArrayBuffer 会被序列化成 {}
  // （对端 new Uint8Array({}) 得到 0 字节，ffmpeg 报 "moov atom not found"）。
  // 因此所有跨进程二进制载荷一律 base64 编码传输。
  // 字节数转 MB（保留两位小数），用于日志展示流体积
  function mb(bytes) { return (bytes / 1048576).toFixed(2) + ' MB'; }
  let _muxResolver = null;
  guarded($('btn-mux'), async () => {
    if (!dashData) return setStatus('请先等待解析');
    $('muxbox').style.display = 'block';
    setBar('m', 0);
    let vBuf = null, aBuf = null;
    // 拉流进度回调：把「已接收/总体积 + 百分比」写到进度条下方的状态栏，
    // 例如「拉取视频流 (29.25 MB) 23%」。total 为 0（无 Content-Length）时只显示已接收量。
    const fetchStatus = (label, barOffset, barSpan) => (received, total) => {
      const pct = total > 0 ? ' ' + Math.round(received / total * 100) + '%' : '';
      const size = total > 0 ? mb(total) : mb(received);
      setStatus(label + ' (' + size + ')' + pct);
      setBar('m', barOffset + (total > 0 ? received / total : 0) * barSpan);
    };
    try {
      // 顺序拉取：先视频（进度 0→50%），再音频（50%→100%），不并行
      console.log('[bili-mux] mux: 开始拉取视频流', String(pickVideoUrls()[0]).slice(0, 60) + '…');
      vBuf = await fetchStream(pickVideoUrls()[0], fetchStatus('拉取视频流', 0, 0.5));
      console.log('[bili-mux] mux: 视频流拉取完成', mb(vBuf.byteLength));
      console.log('[bili-mux] mux: 开始拉取音频流', String(pickAudioUrls()[0]).slice(0, 60) + '…');
      aBuf = await fetchStream(pickAudioUrls()[0], fetchStatus('拉取音频流', 0.5, 0.5));
      console.log('[bili-mux] mux: 音频流拉取完成', mb(aBuf.byteLength));
    } catch (e) {
      // 拉流失败：给出明确提示，不进入等待、不乱回退，避免按钮卡死
      setStatus('拉取流失败: ' + (e && e.message) + '（可改用 FLV 合并或分离下载）');
      $('muxbox').style.display = 'none';
      return;
    }
    setStatus('准备传输…');
    setBar('m', 0);
    console.log('[bili-mux] mux: 分块传输 video', mb(vBuf.byteLength), 'audio', mb(aBuf.byteLength));

    // 方案二（分块消息）：offscreen 无法直接拉流——CDN 按 Sec-Fetch-Site 头拒绝
    // chrome-extension:// 发起方（该头由浏览器按发起源自动设置，属 forbidden header，
    // Referer/Origin/Range 各种组合均无法绕过，已用探测按钮实测验证），
    // 故由 content 拉流后分块 base64 传给 offscreen 合成。
    // 单条 chrome.runtime 消息上限 64MiB，base64 膨胀 4/3，故每块取 16MB 原始数据
    // （编码后约 21.3MB），留足余量。成品由 offscreen 直接 chrome.downloads 下载，
    // 不回传 content，彻底避开回程 64MiB 限制。
    const RAW_CHUNK = 16 * 1048576;
    const requestId = 'mux_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    // 带回调的 sendMessage 封装：lastError 转 reject，便于 await 做流控
    const sendMsg = (payload) => new Promise((res, rej) => {
      chrome.runtime.sendMessage(payload, () => {
        chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res();
      });
    });
    const sendChunks = async (stream, buf, label) => {
      const bytes = new Uint8Array(buf);
      const n = Math.max(1, Math.ceil(bytes.length / RAW_CHUNK));
      for (let i = 0; i < n; i++) {
        const piece = bytes.subarray(i * RAW_CHUNK, (i + 1) * RAW_CHUNK);
        let bin = '';
        for (let j = 0; j < piece.length; j += 0x8000) {
          bin += String.fromCharCode.apply(null, piece.subarray(j, j + 0x8000));
        }
        await sendMsg({ type: 'bili-mux-chunk', requestId, stream, index: i, b64: btoa(bin) });
        setStatus(`传输${label} ${i + 1}/${n}`);
        setBar('m', (i + 1) / n);
      }
    };
    try {
      const filename = `${sanitize(viewData.title)}_${elQn.value}.mp4`;
      // init：background 记录 tabId 映射并确保 offscreen 就绪后才回复，
      // 必须 await，否则分块可能先于 offscreen 监听器注册而丢失
      await sendMsg({ type: 'bili-mux-init', requestId, filename });
      await sendChunks('video', vBuf, '视频流');
      vBuf = null; // 尽早释放，降低内存峰值
      await sendChunks('audio', aBuf, '音频流');
      aBuf = null;
      // go：触发拼装 + 合成 + offscreen 直接下载；不 await（其 sendResponse 要等合成结束），
      // 结果经 bili-mux-result 异步消息回传（下方 runtime 监听处理）
      sendMsg({ type: 'bili-mux-go', requestId }).catch((e) => {
        console.error('[bili-mux] mux: go 失败', e && e.message);
      });
    } catch (e) {
      setStatus('传输失败: ' + (e && e.message) + '（可改用 FLV 合并或分离下载）');
      $('muxbox').style.display = 'none';
      return;
    }
    setStatus('浏览器内合成中…');
    setBar('m', 0); // 交给 offscreen 的合成进度（0→1）接管
    // 等待 background 定向转发的合成结果（下方 runtime 监听 resolve），期间按钮保持置灰；
    // 大文件合成耗时久，超时放宽到 600s（与 background 侧一致）
    await new Promise((res) => {
      let done = false;
      const finish = () => { if (done) return; done = true; _muxResolver = null; res(); };
      _muxResolver = finish;
      setTimeout(() => {
        if (!done) { console.error('[bili-mux] mux: 等待合成结果超时(600s)'); setStatus('合成等待超时，仍在后台进行可稍候，或点按钮重试 / 改用分离下载'); }
        finish();
      }, 600000);
    });
  });

  // FLV 合并下载（二进制拼接即得可播放文件；offscreen 会自动转封装为 MP4 提升兼容性，失败回退原 FLV）
  guarded($('btn-flvm'), async () => {
    if (!flvData || !flvData.durl || !flvData.durl.length) return setStatus('该视频不支持 FLV 合并（可能仅 DASH）');
    $('flvbox').style.display = 'block';
    setBar('f', 0);
    try {
      const urls = flvData.durl.map(d => toHttps(d.url));
      const bytes = await fetchAndConcat(urls, (ratio) => setBar('f', ratio));
      setBar('f', 1);
      setStatus('转封装为 MP4…');
      const resp = await saveViaOffscreen(bytes, `${sanitize(viewData.title)}.flv`, 'video/x-flv');
      if (resp.converted) setStatus('已转封装为 MP4 并触发下载');
      else if (resp.note) setStatus(resp.note);
      else setStatus('已触发下载');
    } catch (e) { setStatus('FLV 合并失败: ' + e.message); }
  });

  // 来自 background 的定向消息：popup 唤起面板、合成进度、合成结果。
  // 合成相关消息带 routed 标记（由 background 从 offscreen 转发时加上），
  // 以此与 offscreen 的原始广播区分，避免多标签串台 / 重复触发下载。
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    // popup 点击"跳到当前页面板"时展开面板
    if (msg.type === 'bili-open-panel') {
      if (!$('panel').classList.contains('show')) $('panel').classList.add('show');
      return;
    }

    // 仅处理 background 定向转发、带 routed 标记的合成消息（忽略 offscreen 广播原包）
    if ((msg.type === 'bili-mux-progress' || msg.type === 'bili-mux-result') && !msg.routed) return;

    if (msg.type === 'bili-mux-progress') {
      const r = typeof msg.ratio === 'number' ? msg.ratio : 0;
      setBar('m', r);
      setStatus('浏览器内合成中 ' + Math.round(r * 100) + '%');
      return;
    }
    if (msg.type === 'bili-mux-result') {
      if (_muxResolver) { const r = _muxResolver; _muxResolver = null; r(); } // 释放 guarded 锁
      if (msg.ok) {
        // 下载已由 SW 的 chrome.downloads 完成（offscreen 建 blob URL 交给 SW 落地）；
        // content 的 <a download> 因合成耗时脱离用户手势窗口、被页面沙箱拦截，故不走此路。
        console.log('[bili-mux] mux: 合成成功，SW 已发起下载');
        setBar('m', 1);
        setStatus('MP4 已合成并下载');
      } else {
        // 合成失败不再自动把音视频流下载到本地（用户要求）：内存中已拉取的流直接丢弃，
        // 仅在状态栏与控制台给出明确原因；如需原始流可手动点“下载视频流/音频流”。
        const reason = (msg.error || '未知原因').trim();
        console.error('[bili-mux] mux: 浏览器合成失败，原因 =\n' + reason);
        setStatus('浏览器内合成失败。原因: ' + reason + '（详见控制台 [bili-mux] 日志）');
      }
      return;
    }
  });

  init();
}

/* ============================ 引导层 ============================ */
// /list/*（稍后再看 / 收藏夹 / 播单）页面首次进入时 URL 里往往没有 bvid/oid，
// 用户点击列表中的视频后 B 站才用 pushState 补上。若此时主逻辑已因「无 ID」退出，
// 就再没人响应这次 URL 变化 —— 扩展看起来就是「没加载」。
// 因此这里在拿到视频 ID 之前持续监听 URL，一拿到就启动主逻辑。
(function bootstrap() {
  let started = false;
  function tryStart() {
    if (started || !getBvid()) return false;
    started = true;
    main();
    return true;
  }
  if (tryStart()) return;

  const _ps = history.pushState, _rs = history.replaceState;
  history.pushState = function () { const r = _ps.apply(this, arguments); tryStart(); return r; };
  history.replaceState = function () { const r = _rs.apply(this, arguments); tryStart(); return r; };
  window.addEventListener('popstate', tryStart);
  window.addEventListener('hashchange', tryStart);
  const iv = setInterval(() => { if (tryStart()) clearInterval(iv); }, 500);
  setTimeout(() => clearInterval(iv), 5 * 60 * 1000); // 最多等 5 分钟，避免长期空转
})();
})();
