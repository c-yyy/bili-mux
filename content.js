// content.js — 注入到 B站视频页
// 运行在 content script 隔离世界，但通过宿主页面的 cookie 罐 + manifest 的
// host_permissions，可以直接带着登录态 fetch api.bilibili.com，从而绕开 CORS。
//
// 流程：
//   1. 从 URL 取 bvid
//   2. 调 view 接口拿 cid / 封面 pic / 分P pages / 标题 title
//   3. 调 nav 接口拿 wbi 密钥 → 给 playurl 请求签名
//   4. 调 playurl 拿 DASH 直链(video/audio 分离) 与 FLV 分段(durl)
//   5. 面板里提供：封面下载 / 视频流+音频流分别保存 / FLV 合并下载 / 分P批量
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
  // 提取 /video/ 之后的 ID（兼容老 av 链接），匹配不到则返回 null 让插件安静退出。
  // 命中后保留 URL 原始大小写——B 站 BV 号按位大小写敏感，av 前缀小写为常规形态。
  const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
  return m ? m[1] : null;
}

async function fetchView(bvid) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: 'include' });
  const j = await r.json();
  if (j.code !== 0) throw new Error('view 接口错误: ' + j.message);
  return j.data;
}

async function fetchPlayurl(bvid, cid, fnval, qn) {
  const mixinKey = await getMixinKey();
  const query = signWbi({ bvid, cid, qn, fnval, fourk: 1 }, mixinKey);
  const r = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, { credentials: 'include' });
  const j = await r.json();
  if (j.code !== 0) throw new Error('playurl 接口错误: ' + j.message);
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

// 在 content script 内触发 Blob 落地（用于 FLV 合并文件）
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

// 单独保存 DASH 音视频流（.m4s）：走 content 内 fetch + Blob 落地，
// 复用与 fetchStream / fetchAndConcat 完全一致的请求参数（omit credentials + 保留 Referer）。
// 关键点：chrome.downloads.download 发起的下载没有“来源页面”，不会带 Referer，
// 而 B站媒体 CDN 直链（bilivideo.com / *.edge.mountaintoys.cn 等边缘节点）会校验 Referer，
// 缺失则返回 403 的 HTML 错误页 —— 于是浏览器把下载命名成 xxx.html 并报“已被禁止”。
// 在 content script 里 fetch 时，浏览器会自动带上当前页 Referer（no-referrer-when-downgrade），
// 走通鉴权，再拿 Blob 用 downloadBlob 落地，文件名即我们指定的 .m4s。
async function downloadStream(url, filename) {
  const r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer-when-downgrade' });
  if (!r.ok) throw new Error('流拉取失败: HTTP ' + r.status);
  const blob = await r.blob();
  downloadBlob(blob, filename);
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
  return new Blob([out], { type: 'video/x-flv' });
}

// 单个直链的流式拉取（带进度），用于「合成 MP4」时拉取视频/音频流。
// 用 credentials:'omit' —— B站媒体 CDN 直链自带签名鉴权、无需 Cookie，
// 且多数 CDN 节点不允许 credentials 跨域（会导致 CORS 失败 / 卡死）。
// 与 FLV 合并（fetchAndConcat）使用同一套参数，是验证可用的路径。
async function fetchStream(url, onRatio, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
      segs.push(value);
      received += value.length;
      netBytesTotal += value.length;
      if (onRatio && cl > 0) onRatio(received / cl);
    }
    let total = 0;
    for (const s of segs) total += s.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const s of segs) { out.set(s, off); off += s.length; }
    if (onRatio) onRatio(1);
    return out.buffer; // 精确长度的 ArrayBuffer
  } finally {
    clearTimeout(timer);
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
  .flvbox { display: none; margin-top: 6px; }
  .pbar { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
  .pbar .pl { width: 64px; flex: none; color: #1a1a1a; }
  .pbar .track { flex: 1; height: 10px; background: #eee; border: 2px solid #000; border-radius: 6px; overflow: hidden; }
  .pbar .fill { height: 100%; width: 0%; background: #fb7299; transition: width .2s ease; }
  .pbar .pv { width: 40px; text-align: right; flex: none; font-variant-numeric: tabular-nums; }
  .fmt-help { font-size: 11px; color: #6b6b6b; line-height: 1.55; margin-top: 8px;
    border-top: 2px dashed #000; padding-top: 8px; word-break: break-all; }
  .fmt-help b { color: #1a1a1a; }
  .resbox { margin-top: 8px; border-top: 2px dashed #000; padding-top: 8px; }
  .resbox .res-title { font-size: 11px; font-weight: 700; color: #1a1a1a; margin-bottom: 6px; }
  .res-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .res-cell { background: #fafafa; border: 2px solid #000; border-radius: 6px; padding: 6px 8px; }
  .res-cell .rk { font-size: 10px; color: #666; }
  .res-cell .rv { font-size: 14px; font-weight: 700; color: #fb7299; font-variant-numeric: tabular-nums; }
  .res-note { font-size: 10px; color: #888; margin-top: 6px; line-height: 1.4; }
`;

// 自有图标：粉色下载箭头（与扩展图标同款设计，站内工具栏里以粉色描边区别于 B站灰标）
const ICON_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g fill="#fb7299"><rect x="10.8" y="4.6" width="2.4" height="8.2"/><path d="M6.4 11.4 L12 17 L17.6 11.4 L16.3 10.1 L12 14.4 L7.7 10.1 Z"/><rect x="5" y="18.3" width="14" height="1.8" rx="0.9"/></g></svg>`;

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
        <button class="act" id="btn-pages">分P列表</button>
      </div>
      <div class="row">
        <button class="act" id="btn-flvm">FLV 合并下载（低码率）</button>
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
        <button class="act primary" id="btn-mux">合成 MP4（浏览器内）</button>
      </div>
      <div class="flvbox" id="muxbox">
        <div class="pbar"><span class="pl">合成 MP4</span><div class="track"><div class="fill" id="pb-m"></div></div><span class="pv" id="pct-m">0%</span></div>
      </div>
      <div class="pages" id="pages">
        <div id="pages-list"></div>
        <div class="row"><button class="act primary" id="btn-batch">批量下载选中</button></div>
      </div>
      <div class="status" id="status"></div>
      <div class="fmt-help"><b>FLV 与 DASH 流</b>：<b>FLV 合并</b>取旧版 HTTP-FLV 流（音视频已封装进同一容器），码率较低、体积小、下载快；<b>DASH 流</b>视频与音频分两个文件保存，可拿到原画画质乃至 4K 高码率，文件较大。</div>
      <div class="resbox">
        <div class="res-title">实时资源占用</div>
        <div class="res-grid">
          <div class="res-cell"><div class="rk">内存（本扩展）</div><div class="rv" id="res-mem">—</div></div>
          <div class="res-cell"><div class="rk">网络（本工具下载）</div><div class="rv" id="res-net">0.0 MB/s</div></div>
        </div>
        <div class="res-note">内存为本扩展运行内存；网络为本工具实测下载速率。</div>
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
      box-sizing: border-box; user-select: none; cursor: pointer; }
    .bili-mux-item svg { width: 20px; height: 20px; display: block; flex: none; }
    .bili-mux-item .bili-mux-label { font-size: 13px; line-height: 1; }
    .bili-mux-item:hover { color: #fb7299 !important; }
  `;
  document.head.appendChild(style);
}

function injectToggle(togglePanel) {
  const toolbar = document.querySelector('.video-toolbar-left-main');
  if (!toolbar) return false;
  if (document.getElementById('bili-mux-toggle')) return true;

  const btn = document.createElement('div');
  btn.id = 'bili-mux-toggle';
  btn.className = 'bili-mux-item';
  btn.setAttribute('role', 'button');
  btn.setAttribute('title', '哔哩喵 (Bili-Mux)');
  btn.innerHTML = ICON_SVG + '<span class="bili-mux-label">下载</span>';

  // 克隆容器里第一个元素的 computed style，让本按钮与兄弟元素同字体/颜色/间距
  // （cursor 除外：克隆来的 default 会盖掉手型光标，这里强制 pointer）
  const ref = toolbar.children[0];
  if (ref) {
    const cs = getComputedStyle(ref);
    ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
     'padding', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
     'margin', 'textAlign'].forEach((p) => { if (cs[p]) btn.style[p] = cs[p]; });
  }
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
      } else if (!document.querySelector('.video-toolbar-left-main')) {
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
(function main() {
  if (document.getElementById('bili-mux-host')) return; // 防止重复注入
  const bvid = getBvid();
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
    elStatus = $('status'), elPages = $('pages'),
    elPagesList = $('pages-list');

  let viewData = null;     // view 接口结果
  let dashData = null;     // playurl DASH 结果
  let flvData = null;      // playurl FLV 结果
  const _ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '1.1.0';
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

  async function init() {
    try {
      viewData = await fetchView(bvid);
      elTitle.textContent = viewData.title;
      // 副标题：URL 中的视频 ID（BVID / 老格式 avid）+ 封面右键操作提示
      $('subtitle').innerHTML = '<span class="id">' + bvid + '</span> <span class="hint">（封面图可右键复制或保存）</span>';
      if (viewData.pic) {
        elCover.src = viewData.pic;
        elCover.style.display = 'block';
      }
      // 分P列表
      elPagesList.innerHTML = '';
      (viewData.pages || []).forEach((p) => {
        const div = document.createElement('div');
        div.className = 'pg';
        div.innerHTML = `<input type="checkbox" data-cid="${p.cid}" data-title="${p.part}"/><span title="${p.part}">${p.part}</span>`;
        elPagesList.appendChild(div);
      });
      // 默认拿当前 cid 的 playurl
      await loadPlayurl(viewData.cid);
    } catch (e) {
      elTitle.textContent = '解析失败';
      setStatus(e.message);
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
    return [pick.baseUrl, ...(pick.backupUrl || [])].filter(Boolean);
  }
  function pickAudioUrls() {
    const list = dashData.dash.audio || [];
    let pick = list[0];
    return [pick.baseUrl, ...(pick.backupUrl || [])].filter(Boolean);
  }

  // 关闭卡片（右上角 ×）
  guarded($('btn-close'), closePanel);

  // 封面下载
  guarded($('btn-cover'), async () => {
    if (!viewData || !viewData.pic) return setStatus('暂无封面');
    setStatus('封面下载中…');
    const r = await downloadViaExtension(viewData.pic, `${sanitize(viewData.title)}_封面.jpg`);
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

  // 浏览器内合成 MP4：按顺序拉取视频流 → 音频流（不并行），再交给 offscreen 里的
  // ffmpeg.wasm 封装成单个 MP4；失败回退到分离下载。
  //
  // 注意：chrome.runtime.sendMessage 只支持 JSON 序列化，ArrayBuffer 会被序列化成 {}
  // （对端 new Uint8Array({}) 得到 0 字节，ffmpeg 报 "moov atom not found"）。
  // 因此所有跨进程二进制载荷一律 base64 编码传输。
  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000; // 分块避免 String.fromCharCode 参数过多爆栈
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  function b64ToU8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  let _muxResolver = null;
  guarded($('btn-mux'), async () => {
    if (!dashData) return setStatus('请先等待解析');
    $('muxbox').style.display = 'block';
    setBar('m', 0);
    let vBuf = null, aBuf = null;
    try {
      // 顺序拉取：先视频（进度 0→50%），再音频（50%→100%），不并行
      setStatus('拉取视频流…');
      console.log('[bili-mux] mux: 开始拉取视频流', String(pickVideoUrls()[0]).slice(0, 60) + '…');
      vBuf = await fetchStream(pickVideoUrls()[0], (r) => setBar('m', r * 0.5));
      console.log('[bili-mux] mux: 视频流拉取完成', vBuf.byteLength, '字节');
      setStatus('视频流已拉取，拉取音频流…');
      console.log('[bili-mux] mux: 开始拉取音频流', String(pickAudioUrls()[0]).slice(0, 60) + '…');
      aBuf = await fetchStream(pickAudioUrls()[0], (r) => setBar('m', 0.5 + r * 0.5));
      console.log('[bili-mux] mux: 音频流拉取完成', aBuf.byteLength, '字节');
    } catch (e) {
      // 拉流失败：给出明确提示，不进入等待、不乱回退，避免按钮卡死
      setStatus('拉取流失败: ' + (e && e.message) + '（可改用 FLV 合并或分离下载）');
      $('muxbox').style.display = 'none';
      return;
    }
    setStatus('浏览器内合成中 0%');
    setBar('m', 0); // 交给 offscreen 的合成进度（0→1）接管
    console.log('[bili-mux] mux: 发送 bili-mux 到 background, video', vBuf.byteLength, 'audio', aBuf.byteLength);
    // base64 编码后发送（消息通道不支持 ArrayBuffer）；带 lastError 检查避免静默丢消息
    const payload = { type: 'bili-mux', videoB64: bufToB64(vBuf), audioB64: bufToB64(aBuf) };
    vBuf = aBuf = null; // 尽早释放原始 buffer，base64 期间内存占用翻倍
    chrome.runtime.sendMessage(payload, () => {
      if (chrome.runtime.lastError) console.error('[bili-mux] mux: 发送 bili-mux 失败', chrome.runtime.lastError.message);
    });
    // 等待 background 定向转发的合成结果（下方 runtime 监听 resolve），期间按钮保持置灰；
    // 加 180s 超时保护，避免极端情况下按钮卡死
    await new Promise((res) => {
      let done = false;
      const finish = () => { if (done) return; done = true; _muxResolver = null; res(); };
      _muxResolver = finish;
      setTimeout(() => {
        if (!done) { console.error('[bili-mux] mux: 等待合成结果超时(180s)'); setStatus('合成等待超时，仍在后台进行可稍候，或点按钮重试 / 改用分离下载'); }
        finish();
      }, 180000);
    });
  });

  // FLV 合并下载（无需 ffmpeg，二进制拼接即得可播放文件）
  guarded($('btn-flvm'), async () => {
    if (!flvData || !flvData.durl || !flvData.durl.length) return setStatus('该视频不支持 FLV 合并（可能仅 DASH）');
    $('flvbox').style.display = 'block';
    setBar('f', 0);
    try {
      const urls = flvData.durl.map(d => d.url);
      const blob = await fetchAndConcat(urls, (ratio) => setBar('f', ratio));
      setBar('f', 1);
      downloadBlob(blob, `${sanitize(viewData.title)}.flv`);
      setStatus('FLV 已合并并触发下载');
    } catch (e) { setStatus('FLV 合并失败: ' + e.message); }
  });

  // 分P列表显隐
  guarded($('btn-pages'), () => elPages.classList.toggle('show'));

  // 批量下载选中分P（FLV 合并，逐个顺序执行避免内存峰值）
  guarded($('btn-batch'), async () => {
    const boxes = elPagesList.querySelectorAll('input:checked');
    if (!boxes.length) return setStatus('请先勾选分P');
    setStatus(`批量下载 0/${boxes.length}…`);
    for (let i = 0; i < boxes.length; i++) {
      const cid = boxes[i].dataset.cid;
      const title = boxes[i].dataset.title;
      try {
        const data = await fetchPlayurl(bvid, Number(cid), 0, 80);
        if (data.durl && data.durl.length) {
          const blob = await fetchAndConcat(data.durl.map(d => d.url));
          downloadBlob(blob, `${sanitize(viewData.title)}_${sanitize(title)}.flv`);
        }
      } catch (e) { setStatus(`第 ${i + 1} 个失败: ${e.message}`); }
      setStatus(`批量下载 ${i + 1}/${boxes.length}…`);
      await new Promise(r => setTimeout(r, 800)); // 错开请求
    }
    setStatus('批量下载完成');
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
      if (msg.ok && msg.mp4B64) {
        const mp4 = b64ToU8(msg.mp4B64);
        console.log('[bili-mux] mux: 收到合成结果 ok, mp4 字节 =', mp4.length);
        const blob = new Blob([mp4], { type: 'video/mp4' });
        downloadBlob(blob, `${sanitize(viewData.title)}_${elQn.value}.mp4`);
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
})();
