// content.js — 注入到 B站播放页（普通视频 / 番剧）
// 运行在 content script 隔离世界，但通过宿主页面的 cookie 罐 + manifest 的
// host_permissions，可以直接带着登录态 fetch api.bilibili.com，从而绕开 CORS。
//
// 两类页面走两条不同的链路，元信息与取流接口都不一样：
//   UGC（/video/*、/list/*）
//     1. 从 URL 取 bvid
//     2. 调 view 接口拿 cid / 封面 pic / 分P pages / 标题 title
//     3. 调 nav 接口拿 wbi 密钥 → 给 playurl 请求签名
//     4. 调 /x/player/wbi/playurl 拿 DASH 直链与 FLV 分段(durl)
//   PGC（番剧 /bangumi/play/ss* 或 ep*）
//     1. 从 URL 取 season_id / ep_id
//     2. 调 /pgc/view/web/season 拿剧集列表（注意成功体是 result 不是 data）
//     3. 调 /pgc/player/web/v2/playurl 拿 DASH 直链（注意在 result.video_info.dash）
//   PUGV（课程 /cheese/play/ss* 或 ep*）—— 与番剧同族，但三处不一样
//     1. 元信息 /pugv/view/web/season → 成功体是 data
//     2. 取流 /pugv/player/web/playurl，且必须显式带 avid + cid，只给 ep_id 会报参数错误
//     3. 返回的 dash 直接在最外层，没有 video_info 这一层
//     三条链路最终都归一化成 { dash: { video, audio } }，下游 UI 与下载逻辑共用。
//
// 5. 面板里提供：选集(PGC) / 封面下载 / 视频流+音频流分别保存 / FLV 合并 / 浏览器内合成 MP4
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
  127: '超清 8K', 126: '杜比视界', 125: 'HDR', 120: '4K',
  116: '1080P60/高码率', 112: '1080P+',
  80: '1080P', 74: '720P60', 64: '720P', 48: '720P', 32: '480P', 16: '360P', 6: '240P 极速'
};

// 这几档不作为默认选中项，但仍列在下拉里供手动选择：
//   HDR / 杜比视界：色域与传输函数不同，拷进普通 MP4 后在 SDR 屏上会明显偏色发灰；
//   8K：体积过大，多数播放器与设备扛不住。
// 之前默认落在 125 上，就是因为下拉按接口返回顺序排、且这几档没被排除。
const QN_NOT_DEFAULT = [125, 126, 127];
// 下拉选项上的附加说明：这几档能用，但多数人的设备/播放器看不出效果甚至更差
const QN_NOTE = { 125: ' · 普通屏偏色', 126: ' · 需杜比视界设备', 127: ' · 体积极大' };

// 文件名用的短标签。QN_LABEL 里含「/」等非法文件名字符（例如 1080P60/高码率），
// 直接拼进文件名会被 sanitize 替换成下划线，这里另备一份干净的写法。
const QN_FILE_TAG = {
  127: '8K', 126: 'DolbyVision', 125: 'HDR', 120: '4K',
  116: '1080P60', 112: '1080PPlus',
  80: '1080P', 74: '720P60', 64: '720P', 48: '720P', 32: '480P', 16: '360P', 6: '240P'
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

/* ============================ PGC（番剧 / 影视）接口 ============================ */
// 番剧走的是与 UGC 完全不同的一条链路，三处容易踩空的地方：
//   ① 元信息：GET /pgc/view/web/season?season_id=|ep_id= —— 成功体是 result（不是 data）；
//   ② 取流：  GET /pgc/player/web/v2/playurl —— v2 把老接口的 result 整体塞进了
//              video_info，所以 DASH 在 result.video_info.dash 而非 result.dash；
//   ③ 会员专享剧集返回 code = -10403（不会体现成 dash 缺失，必须单独翻译）。
// 课程（/cheese/play/*）走的是 PUGV 分支，与番剧同族但字段名和端点都不同，见 fetchPgcSeason。
// URL 形态：/bangumi/play/ss109700（整季入口）、/bangumi/play/ep321808（单集）、
//          /cheese/play/ss20821（课程主页）、/cheese/play/ep712007（单课时）。
function getPgcId() {
  const m = location.pathname.match(/\/(bangumi|cheese)\/play\/(ss\d+|ep\d+)/i);
  if (!m) return null;
  const raw = m[2];
  return {
    site: /cheese/i.test(m[1]) ? 'pugv' : 'pgc',
    kind: /^ss/i.test(raw) ? 'season_id' : 'ep_id',
    id: raw.slice(2),
    raw: raw
  };
}

async function fetchPgcSeason(ref) {
  const isPugv = ref.site === 'pugv';
  // 番剧：/pgc/view/web/season → 成功体是 result
  // 课程：/pugv/view/web/season → 成功体是 data（三处「顶层字段不一致」之一，别混用）
  const base = isPugv
    ? 'https://api.bilibili.com/pugv/view/web/season?'
    : 'https://api.bilibili.com/pgc/view/web/season?';
  const key = ref.kind === 'ep_id' ? 'ep_id' : 'season_id';
  const j = await fetchJson(base + key + '=' + encodeURIComponent(ref.id));
  if (j.code !== 0) {
    const map = {
      '-400': '请求参数错误', '-403': '无访问权限（请先登录）',
      '-404': isPugv ? '课程不存在或未购买' : '番剧不存在或无权限（可能需登录 / 该地区不可观看）',
      '-412': '请求被风控拦截', '-352': '风控校验失败'
    };
    throw new Error('season 接口错误(' + j.code + '): ' + (map[String(j.code)] || j.message));
  }
  return j.result || j.data || {};
}

// 剧集列表在不同页面类型下埋在三层不同结构里：顶层 episodes、sections[].episodes、
// 以及新版 modules[].data.episodes（含 modules[].data.sections[].episodes）。
// 只认一种会表现为「番剧页里选集是空的」，所以全收一遍再按 ep_id 去重。
function flatEpisodes(season) {
  const out = [];
  const push = (e) => {
    if (!e) return;
    // 部分新版 modules 结构里剧集主键叫 ep_id，统一补成 id，后续各处只用 id
    if (e.id == null && e.ep_id != null) e.id = e.ep_id;
    if (e.id != null) out.push(e);
  };
  (season.episodes || []).forEach(push);
  (season.sections || []).forEach((s) => (s.episodes || []).forEach(push));
  (season.modules || []).forEach((m) => {
    const d = m.data || {};
    (d.episodes || []).forEach(push);
    (d.sections || []).forEach((s) => (s.episodes || []).forEach(push));
  });
  const seen = new Set();
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

function pgcPlayurlError(j, site) {
  const c = String(j.code);
  const map = {
    // 同一个码在两条业务线里含义不同：番剧是大会员，课程是没买课
    '-10403': site === 'pugv' ? '该课时需要购买课程后才能观看' : '该集需要大会员权益（或尚未登录）',
    '-404': site === 'pugv' ? '课时不存在或未购买' : '剧集不存在或无权限（可能需登录 / 该地区不可观看）',
    '-403': '接口鉴权失败，请刷新页面后重试',
    '-400': '请求参数错误', '-412': '请求被风控拦截', '-352': '风控校验失败'
  };
  return (map[c] || j.message || '未知错误') + '（code ' + c + '）';
}

async function fetchPgcPlayurl(ep, seasonId, fnval, qn, site) {
  const params = { ep_id: ep.id, qn, fnval, fnver: 0, fourk: 1 };
  // 课程（PUGV）的取流接口必须显式带 avid + cid，只给 ep_id 会报参数错误
  if (site === 'pugv') {
    if (ep.aid) params.avid = ep.aid;
    if (ep.cid) params.cid = ep.cid;
  } else if (seasonId) {
    params.season_id = seasonId;
  }
  // 番剧用 v2 端点；课程只有 /pugv/player/web/playurl 这一个
  const root = site === 'pugv'
    ? 'https://api.bilibili.com/pugv/player/web/playurl?'
    : 'https://api.bilibili.com/pgc/player/web/v2/playurl?';
  const build = (p) => root + p;
  let j = null, lastErr = null;
  // PGC 取流是否强制 WBI 签名一直在变（yt-dlp 目前不带签名，部分客户端带），
  // 因此先按无签名打一次，失败再补带签名重试——两种口径都覆盖，不必跟着接口轮换返工。
  try { j = await fetchJson(build(new URLSearchParams(params))); } catch (e) { lastErr = e; }
  if (!j || j.code !== 0) {
    try {
      const mixinKey = await getMixinKey();
      const r = await fetchJson(build(signWbi(params, mixinKey)));
      if (r && r.code === 0) return r.result || {};
      if (r) j = r;
    } catch (e) { lastErr = e; }
  }
  if (!j) throw lastErr || new Error((site === 'pugv' ? 'pugv' : 'pgc') + ' playurl 请求失败');
  if (j.code !== 0) throw new Error(pgcPlayurlError(j, site));
  return j.result || j.data || {};
}

// 文件名标题：番剧的 episodes[].title 通常是「5」这种纯数字串（集数），
// long_title 是副标题；但课程的 title 本身就是小节名，不能拼成「第XXX集」。
function pgcEpTitle(season, ep, list) {
  const name = season.title || season.season_title || '番剧';
  const long = (ep.long_title || ep.longTitle || '').trim();
  const t = String(ep.title == null ? '' : ep.title).trim();
  if (list.length <= 1) return name + (long ? ' ' + long : '');
  const num = /^\d+$/.test(t) ? '第' + t + '集' : (t || '?');
  const sub = long && long !== t ? long : '';
  return name + ' - ' + num + (sub ? ' ' + sub : '');
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
async function downloadViaExtension(url, filename) {
  // 走统一封装：上下文失效时抛出明确错误（而不是静默 resolve 成 "no response"）
  const resp = await sendRuntimeMessage({ type: 'bili-download', url, filename });
  return resp || { ok: false, error: 'no response' };
}

// —— 扩展上下文存活检测 & 统一消息发送 ——
// 「Extension context invalidated」的含义：扩展被更新 / 重载 / 禁用 / 卸载后，
// 已经注入到页面里的 content script 会变成「孤儿」——DOM、定时器、监听器都还在，
// 但它背后的扩展进程已经没了，任何 chrome.* 调用都会抛这个错。
// 典型触发：手动在 chrome://extensions 点刷新、或 Chrome 自动更新了来自商店的扩展。
// 判定方法（同步、可靠）：上下文存活时 chrome.runtime.id 才有值，失效后为 undefined。
function isCtxAlive() {
  return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
}
const CTX_DEAD_RE = /extension context invalidated/i;
function isCtxDeadError(e) {
  return !!(e && (e.ctxDead === true || CTX_DEAD_RE.test((e && e.message) || '')));
}
// 统一的 runtime 消息发送：
//  · 发送前先做上下文自检，失效则抛出 ctxDead 错误（上层据此提示刷新页面，而不是无意义重试）
//  · 端口瞬时关闭等非致命错误自动重试一次（reject 前），避免整条流程因一次抖动失败
function sendRuntimeMessage(payload, retry = 1) {
  return new Promise((res, rej) => {
    let attempt = 0;
    const go = () => {
      if (!isCtxAlive()) return rej(Object.assign(new Error('Extension context invalidated'), { ctxDead: true }));
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          const err = chrome.runtime.lastError;
          if (!err) return res(resp);
          const msg = err.message || '';
          const dead = CTX_DEAD_RE.test(msg);
          if (!dead && attempt < retry) { attempt++; return setTimeout(go, 250); }
          rej(Object.assign(new Error(msg), { ctxDead: dead }));
        });
      } catch (e) {
        // 上下文失效时 Chrome 也可能同步 throw（而非走 lastError）
        if (CTX_DEAD_RE.test((e && e.message) || '')) {
          return rej(Object.assign(new Error(e.message), { ctxDead: true }));
        }
        if (attempt < retry) { attempt++; return setTimeout(go, 250); }
        rej(e);
      }
    };
    go();
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
  const sendMsg = (payload) => sendRuntimeMessage(payload);
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

/* ============================ 多节点容错（CDN 轮换） ============================ */
// B站 playurl 对每条流返回 baseUrl + backupUrl（多个备用 CDN 节点）。
// 早期实现只取 [0]，一旦主节点出问题（证书无效 / 连接失败 / 5xx / 传输停滞），
// 整次下载就直接失败，用户只能干瞪眼。这里改为依次尝试全部节点。
//
// 需要说明的限制：fetch 失败时浏览器只抛 TypeError('Failed to fetch')，
// JS 层面拿不到 ERR_CERT_DATE_INVALID 这类具体网络错误码（那属于 DevTools 展示层），
// 因此只能按「网络层失败」统一归类，在文案里列出最常见的本地成因引导自查。
function hostOf(u) {
  try { return new URL(u).host; } catch (e) { return String(u).slice(0, 40); }
}

// 把底层网络错误翻译成人话；tried 为已尝试的节点数
function netError(e, tried) {
  const msg = (e && e.message) || '';
  const suffix = tried > 1 ? `（已尝试 ${tried} 个 CDN 节点）` : '';
  // Failed to fetch = TLS/连接层被浏览器拒绝（证书、代理、断网都会表现成这一句）
  if (!msg || /Failed to fetch|NetworkError|network error|ERR_/i.test(msg)) {
    return new Error(
      `网络层失败${suffix}。所有节点都失败时通常是本地环境问题：` +
      `① 系统日期时间不正确会让 HTTPS 证书校验通不过；` +
      `② 安全软件或代理的 HTTPS 扫描证书未被浏览器信任`
    );
  }
  return new Error(msg + suffix);
}

// 依次尝试每个节点拉取单条流；onRetry(attempt, total, host) 用于把换节点动作反馈到 UI
async function fetchStreamWithFallback(urls, onProgress, stallMs = 60000, onRetry = null) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) throw new Error('无可用直链');
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      const node = hostOf(list[i]);
      console.warn('[bili-mux] 上一节点失败，切换到备用节点', node, lastErr && lastErr.message);
      if (onRetry) onRetry(i, list.length, node);
    }
    try {
      return await fetchStream(list[i], onProgress, stallMs);
    } catch (e) {
      lastErr = e;
      // 4xx = 签名过期 / 资源不存在，换节点结果一样，没必要继续试
      if (/HTTP 4\d\d/.test(e.message || '')) throw e;
    }
  }
  throw netError(lastErr, list.length);
}

// 同上，用于「分离保存」这类整体落地的场景
async function downloadStreamWithFallback(urls, filename, onRetry = null) {
  const list = (urls || []).filter(Boolean);
  if (!list.length) throw new Error('无可用直链');
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      const node = hostOf(list[i]);
      console.warn('[bili-mux] 上一节点失败，切换到备用节点', node, lastErr && lastErr.message);
      if (onRetry) onRetry(i, list.length, node);
    }
    try {
      return await downloadStream(list[i], filename);
    } catch (e) {
      lastErr = e;
      if (/HTTP 4\d\d/.test(e.message || '')) throw e;
    }
  }
  throw netError(lastErr, list.length);
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

// 自有图标：下载箭头。默认与 B站工具栏同款灰 #61666d（不抢眼），
// 悬停时由 CSS 把 path 刷成品牌粉 #fb7299 —— 见 injectToolbarStyle 里的
// `.bili-mux-item:hover svg path`。这里写死 fill 而不是 currentColor，
// 是为了让默认色不受页面/参考元素继承色影响，各页面表现一致。
const ICON_SVG = `<svg viewBox="0 0 1024 1024" width="24" height="24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M512 0a512 512 0 1 0 512 512A512 512 0 0 0 512 0z m256 587.264l-215.04 214.528-2.56 2.56A51.2 51.2 0 0 1 512 819.2a35.328 35.328 0 0 1-12.8 0 16.896 16.896 0 0 1-7.168 0 51.2 51.2 0 0 1-16.384-10.752l-217.088-221.184a51.2 51.2 0 0 1 0-72.192 51.2 51.2 0 0 1 72.192 0L460.8 644.608V256a51.2 51.2 0 0 1 102.4 0v388.608l129.536-129.536A51.2 51.2 0 0 1 768 587.264z" fill="#61666d"/></svg>`;

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
      <div class="pages" id="epbox">
        <label id="ep-label" style="display:block;font-weight:600;margin-bottom:4px;">选集</label>
        <select id="ep-sel"></select>
      </div>
      <div class="row">
        <button class="act primary" id="btn-cover">下载封面</button>
      </div>
      <div class="row" id="row-flvm">
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
        <div class="footer-right"><span class="ver" id="panel-ver">v1.2.2</span>
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
    /* 注入的工具栏项：只保留「与兄弟元素一致的静态外观 + 悬停变色」，
       不做边框、背景、位移、缩放、浮动阴影等任何悬浮期特效——那些会让它看起来
       不像原生工具栏的一部分（视频页 / 番剧页 / 课程页一律如此）。 */
    .bili-mux-item { display: inline-flex !important; align-items: center; gap: 4px;
      box-sizing: border-box; user-select: none; cursor: pointer;
      vertical-align: middle; border: 0; background: transparent; }
    .bili-mux-item svg { width: 24px; height: 24px; display: block; flex: none; }
    .bili-mux-item .bili-mux-label { font-size: 13px; line-height: 1; }
    .bili-mux-item:hover { color: #fb7299 !important;
      border: 0 !important; background: transparent !important;
      transform: none !important; filter: none !important; box-shadow: none !important; }
    .bili-mux-item:hover svg { animation: none !important; }
    /* 图标默认灰 #61666d（写在 ICON_SVG 的 fill 上），悬停时刷成品牌粉。
       用 path 级 fill 覆盖而不是 currentColor：图标色与文字继承色解耦，
       不受工具栏参考元素克隆来的颜色影响，各页面 hover 行为一致。 */
    .bili-mux-item:hover svg path { fill: #fb7299 !important; }

    /* 兜底悬浮按钮：番剧页结构与视频页不同，所有工具栏选择器都没命中时用它，
       保证「保存」入口一定存在（固定在播放器右上角，避开站顶导航）。
       它浮在画面之上、没有兄弟元素可对齐，所以保留静态描边作为视觉边界
       （上面的 :hover 会清掉 .bili-mux-item 的边框，这里用更高优先级还原）。 */
    .bili-mux-float { position: fixed; right: 20px; top: 76px; z-index: 2147483000;
      background: #fff; border: 2px solid #000; border-radius: 8px; padding: 6px 10px;
      box-shadow: 3px 3px 0 #000; }
    .bili-mux-float:hover { border: 2px solid #fb7299 !important; background: #fff !important;
      box-shadow: 3px 3px 0 #fb7299 !important; }
    .bili-mux-float .bili-mux-label { color: #fb7299; }
    /* 浮动兜底按钮没有兄弟元素需要对齐、本身就要显眼，图标常态也用粉色（与文字一致） */
    .bili-mux-float svg path { fill: #fb7299 !important; }
  `;
  document.head.appendChild(style);
}

// 播放器工具栏容器：视频页为 .video-toolbar-left-main；稍后再看 / 收藏夹 / 播单（/list/*）
// 是同一播放器组件的变体布局，class 可能有出入，这里按优先级兜底，取第一个命中的容器。
const TOOLBAR_SELECTORS = [
  '.video-toolbar-left-main',
  '.video-toolbar-left',
  '[class*="toolbar-left-main"]',
  '[class*="toolbar-left"]',
  '.toolbar-left',                 // 番剧页（/bangumi/play/*）的容器，class 上没有 video- 前缀
  '[class*="bangumi-toolbar"]',    // 番剧页另一套命名
  '.video-info-actions'
];
function findToolbar() {
  for (const sel of TOOLBAR_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// 构造统一的触发按钮（工具栏内嵌版与浮动兜底版共用）
function makeToggleBtn(id, extraClass, togglePanel) {
  // 用 span 而不是 div：番剧页 / 课程页的工具栏是 inline-flex 布局，塞一个块级 div
  // 会被撑成整行、破坏兄弟元素（点赞/投币/收藏）的排列。span 配合 .bili-mux-item
  // 的 display:inline-flex 才能与它们同排且等高。
  const btn = document.createElement('span');
  btn.id = id;
  btn.className = 'bili-mux-item' + (extraClass ? ' ' + extraClass : '');
  btn.setAttribute('role', 'button');
  btn.setAttribute('title', '哔哩喵 (Bili-Mux)');
  btn.innerHTML = ICON_SVG + '<span class="bili-mux-label">下載</span>';
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
  return btn;
}

// 当前生效的触发按钮：优先工具栏内的，其次浮动兜底的
function toggleEl() {
  return document.getElementById('bili-mux-toggle') || document.getElementById('bili-mux-float');
}

// 参考元素：工具栏里第一个真正可见、有实际尺寸的兄弟节点。
// 它的 computed style 就是当前页面「工具栏项」的标准样式——视频页 / 番剧页 / 课程页
// 三者各不相同，照着它克隆比维护一套常量靠谱。
function pickRefEl(toolbar) {
  for (const el of Array.from(toolbar.children)) {
    if (el.id === 'bili-mux-toggle' || el.id === 'bili-mux-float') continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.height > 8 && r.width > 4) return el;
  }
  return null;
}

// 运行时二���校正：样式克隆能覆盖大多数情况，但容器若不是 flex（此时 inline-flex 的
// span 走的是行内基线排版，还会叠加行盒本身的偏移），纯 CSS 保证不了像素级对齐。
// 这里直接量一次真实几何位置，用 margin-top 修正差值。
// 多次调用是幂等的：每次都先复位 margin-top 再重测，不会累加。
function alignToRef(btn, ref) {
  const fix = () => {
    if (!btn.isConnected || !ref || !ref.isConnected) return;
    btn.style.marginTop = '';                       // 复位后测量，避免修正量累加
    const rb = ref.getBoundingClientRect();
    const bb = btn.getBoundingClientRect();
    if (!rb.height || !bb.height) return;
    const delta = (rb.top + rb.height / 2) - (bb.top + bb.height / 2);
    if (Math.abs(delta) > 0.5) btn.style.marginTop = delta.toFixed(1) + 'px';
  };
  requestAnimationFrame(fix);
  setTimeout(fix, 400);   // 图片/字体加载完成后布局可能二次变化
  setTimeout(fix, 1500);  // SPA 延迟渲染的重排兜底
}

function injectToggle(togglePanel) {
  const toolbar = findToolbar();
  if (!toolbar) return false;
  if (document.getElementById('bili-mux-toggle')) return true;

  const btn = makeToggleBtn('bili-mux-toggle', '', togglePanel);

  // 克隆参考元素的字体与颜色，让本按钮静态时与其它工具栏项完全一致
  // （图标与文字都用 currentColor / 继承色，idle 灰、hover 粉，跟原生按钮一个行为）
  const ref = pickRefEl(toolbar);
  if (ref) {
    const cs = getComputedStyle(ref);
    ['color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
     'borderRadius', 'whiteSpace'].forEach((p) => { if (cs[p]) btn.style[p] = cs[p]; });
    const r = ref.getBoundingClientRect();
    // 等高：内容由 .bili-mux-item 的 align-items:center 垂直居中，避免落到行基线导致下沉。
    // 上限 64px 是防呆——万一参考元素命中了某个外层大容器，别把一个按钮拉成那么高。
    if (r.height >= 8 && r.height <= 64) btn.style.height = Math.round(r.height) + 'px';
    // 水平沿用参考元素的内边距与外边距（垂直归零交给上面的固定高度 + 内部居中），
    // 这样既不会与相邻按钮挤在一起，行内的呼吸节奏也和它们一致
    btn.style.padding = '0 ' + (parseFloat(cs.paddingRight) || 0) + 'px 0 ' + (parseFloat(cs.paddingLeft) || 0) + 'px';
    btn.style.margin = '0 ' + (parseFloat(cs.marginRight) || 0) + 'px 0 ' + (parseFloat(cs.marginLeft) || 0) + 'px';
  }
  btn.style.flex = '0 0 auto';   // 不被挤压变形
  btn.style.alignSelf = 'center';
  btn.style.cursor = 'pointer';
  toolbar.appendChild(btn);
  if (ref) alignToRef(btn, ref);
  return true;
}

// 番剧页播放器工具栏的容器名与视频页不同；若上面所有选择器都落空（页面改版、AB 实验），
// 退一步挂悬浮按钮，功能完全一致，只是钉在播放器右上角而不是插进工具栏。
function injectFloat(togglePanel) {
  if (document.getElementById('bili-mux-float')) return true;
  (document.body || document.documentElement).appendChild(makeToggleBtn('bili-mux-float', 'bili-mux-float', togglePanel));
  return true;
}

// SPA 切换视频 / 页面局部重渲染后，保证按钮不丢
function observeToolbar(togglePanel) {
  injectToolbarStyle();
  if (!injectToggle(togglePanel)) {
    let waited = 0;
    const iv = setInterval(() => {
      waited += 1200;
      if (injectToggle(togglePanel)) { clearInterval(iv); return; }
      // 等 6s 仍找不到工具栏容器：改用悬浮按钮，避免页面上永远不出现入口
      if (waited >= 6000) { clearInterval(iv); injectFloat(togglePanel); }
    }, 1200);
    setTimeout(() => clearInterval(iv), 30000);
  }
  const mo = new MutationObserver(() => {
    // 已经挂了浮动按钮就不再争夺工具栏位置，免得页面上出现两个入口
    if (document.getElementById('bili-mux-float')) return;
    if (!document.getElementById('bili-mux-toggle')) injectToggle(togglePanel);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

/* ============================ 主逻辑 ============================ */
// 整段包进 IIFE：main 与 bootstrap 都不外泄到全局
(function () {
function main() {
  if (document.getElementById('bili-mux-host')) return; // 防止重复注入
  let pgcRef = getPgcId();          // 番剧/课程页：{ site, kind, id, raw }；普通视频页为 null
  let bvid = pgcRef ? null : getBvid();
  if (!bvid && !pgcRef) return;

  const host = document.createElement('div');
  host.id = 'bili-mux-host';
  document.body.appendChild(host);
  const root = buildPanel(host);
  const panelEl = root.getElementById('panel');
  // 依据触发按钮（#bili-mux-toggle）的视口坐标，把面板放到其右侧、顶部平齐；
  // 若右侧放不下则翻到按钮左侧。面板为 fixed，正好吃 getBoundingClientRect 的视口坐标。
  function positionPanelToButton() {
    const btn = toggleEl();
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
    const toggle = toggleEl();
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

  let viewData = null;     // 当前这条播放项的元信息（UGC 用 view 接口结果；PGC 归一化为同构对象）
  let pgcInfo = null;      // 番剧页专属：{ season, list, ep, seasonId }
  let dashData = null;     // playurl DASH 结果（归一化后统一是 { dash: { video, audio } }）
  let flvData = null;      // playurl FLV 结果
  let _gen = 0;            // URL 变化世代号：防止快速切换时旧请求回写新数据
  let _lastKey = (pgcRef ? pgcRef.raw : (bvid || '')) + '|' + location.search; // 上次 URL 标识（含 path 里的 ss/ep 与 query）
  const _ver = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '1.2.2';
  const elVer = $('panel-ver');
  if (elVer) elVer.textContent = 'v' + _ver;
  // 底部栏扩展图标（需 manifest web_accessible_resources 放行）
  const elLogo = $('footer-logo');
  if (elLogo) elLogo.src = chrome.runtime.getURL('icons/icon128.png');
  // 重试按钮：动作可配置（解析失败→重新解析；下载失败→重跑该下载；
  // 扩展上下文失效→刷新页面，因为孤儿 content script 无法自愈，只有刷新这一条路）
  const btnRetry = $('btn-retry');
  let _retryAction = null;
  function showRetry(action, title) {
    if (!btnRetry) return;
    _retryAction = action;
    const label = title || '重试';
    btnRetry.title = label;
    btnRetry.setAttribute('aria-label', label);
    btnRetry.style.display = '';
  }
  function hideRetry() {
    if (btnRetry) btnRetry.style.display = 'none';
    _retryAction = null;
  }
  if (btnRetry) {
    btnRetry.innerHTML = REFRESH_SVG;
    btnRetry.addEventListener('click', () => { const a = _retryAction; hideRetry(); if (a) a(); });
  }
  console.info('%c bili-mux %c v' + _ver + ' %c 加载成功 ',
    'padding: 2px 6px; border-radius: 3px 0 0 3px; color: #fff; background: #fb7299; font-weight: bold;',
    'padding: 2px 6px; color: #fff; background: #FF9999; font-weight: bold;',
    'padding: 2px 6px; border-radius: 0 3px 3px 0; color: #fff; background: #4CAF50; font-weight: bold;');
  console.log('[bili-mux] content script 注入成功，',
    pgcRef ? ((pgcRef.site === 'pugv' ? '课程 ' : '番剧 ') + pgcRef.raw) : ('bvid = ' + bvid));

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
    $('row-flvm').style.display = '';
    setStatus('');
  }

  function onUrlChange() {
    const newPgc = getPgcId();
    const newBvid = newPgc ? null : getBvid();
    const newSearch = location.search;
    // 番剧的集数藏在 path（ss/ep）里而不是 ?p=，因此把 path 里的 ID 一并计入变化键，
    // 否则「点下一集」只会改 pathname、_lastBvid 不变，面板不会重新解析。
    const newKey = (newPgc ? newPgc.raw : (newBvid || '')) + '|' + newSearch;
    if (newKey === _lastKey) return; // 无变化
    _lastKey = newKey;
    if (!newPgc && !newBvid) {
      // 离开视频/番剧页（例如回到首页）：不销毁面板 DOM，仅收起，等待下次进入
      closePanel();
      return;
    }
    pgcRef = newPgc;
    bvid = newBvid;
    if (!newPgc) pgcInfo = null; // 从番剧切回普通视频，清掉 PGC 上下文
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
    hideRetry();
    try {
      if (pgcRef) await initPgc(myGen);
      else await initUgc(myGen);
      if (myGen !== _gen) return;
      // UGC 默认拿当前分P（?p=）对应的 cid；PGC 的 cid 已在 applyPgcEp 里就绪
      await loadPlayurl(pgcInfo ? viewData.cid : currentCid(viewData));
      if (myGen !== _gen) return;
    } catch (e) {
      if (myGen !== _gen) return; // 已被新导航取代，静默
      elTitle.textContent = '解析失败';
      setStatus(e.message);
      // 扩展上下文失效（扩展被更新/重载）时重试无意义，只能刷新页面重建 content script
      if (isCtxDeadError(e)) showRetry(() => location.reload(), '刷新页面（扩展已更新，需刷新才能继续）');
      else showRetry(() => init(), '重新解析');
      console.error('[bili-mux] 解析失败:', e && e.message);
    }
  }

  // —— UGC（普通视频 / 稍后再看等 /list/* 页）——
  async function initUgc(myGen) {
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
    $('epbox').classList.remove('show'); // 选集下拉只给番剧页用
    $('row-flvm').style.display = '';
  }

  // —— PGC（番剧 / 影视）——
  async function initPgc(myGen) {
    const season = await fetchPgcSeason(pgcRef);
    if (myGen !== _gen) return;
    const list = flatEpisodes(season);
    if (!list.length) throw new Error('该剧集列表为空（可能需要登录，或该地区不可观看）');
    // ss 入口没有指定具体某一集，默认第一集，用户可在「选集」下拉里切；
    // ep 入口则精确定位到那一集。
    let ep = null;
    if (pgcRef.kind === 'ep_id') ep = list.find((e) => String(e.id) === String(pgcRef.id));
    if (!ep) ep = list[0];
    pgcInfo = { site: pgcRef.site, season, list, ep, seasonId: season.season_id || season.seasonId };
    await applyPgcEp(myGen);
  }

  // 把某一集应用到面板：标题 / 封面 / cid / 选集下拉。初始化与手动切集共用。
  async function applyPgcEp(myGen) {
    const ep = pgcInfo.ep;
    let cid = ep.cid;
    if (!cid && (ep.bvid || ep.aid)) {
      // 个别条目在 season 接口里不带 cid：番剧有 bvid、课程只有 aid，分别退回 view 接口取
      const v = await fetchView(ep.bvid || ('av' + ep.aid));
      if (myGen !== undefined && myGen !== _gen) return;
      cid = v && v.cid;
    }
    if (!cid) throw new Error('无法获取该集的 cid（该集数据不完整）');
    const title = pgcEpTitle(pgcInfo.season, ep, pgcInfo.list);
    viewData = { title, pic: ep.cover || pgcInfo.season.cover, cid };
    elTitle.textContent = title;
    const isPugv = pgcInfo.site === 'pugv';
    const selName = isPugv ? '课程目录' : '选集';
    const elEpLabel = $('ep-label');
    if (elEpLabel) elEpLabel.textContent = selName;
    $('subtitle').innerHTML = '<span class="id">ep' + ep.id + '</span> <span class="hint">（' +
      (isPugv ? '课程' : '番剧') + '从上方「' + selName + '」切换 · 封面可右键保存）</span>';
    if (viewData.pic) {
      elCover.src = toHttps(viewData.pic);
      elCover.style.display = 'block';
    }
    const sel = $('ep-sel');
    sel.innerHTML = '';
    pgcInfo.list.forEach((e) => {
      const o = document.createElement('option');
      o.value = e.id;
      const lg = e.long_title || e.longTitle || '';
      o.textContent = '第' + (e.title || '?') + '集' + (lg ? ' · ' + lg : '');
      if (String(e.id) === String(ep.id)) o.selected = true;
      sel.appendChild(o);
    });
    $('epbox').classList.add('show');
  }

  // 统一填充清晰度下拉：UGC 与 PGC 的 dash 结构已在此前归一化
  function fillQn() {
    // 接口返回的 dash.video 顺序不保证，按 id 从高到低排，默认项才可预期
    const list = (dashData.dash.video || []).slice()
      .sort((a, b) => Number(b.id) - Number(a.id));
    elQn.innerHTML = '';
    list.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.id;
      // 选项文案自解释：清晰度名 + 风险提示 + 实际分辨率 + 码率。不放 qn 代号——
      // 同一档位名下可能有多路（1080P / 1080P60 / 1080P+），靠清晰度名本身就能区分，
      // 用户不需要去记 B 站的内部代号。
      const label = QN_LABEL[v.id] || QN_FILE_TAG[v.id] || (v.id + 'P');
      const bits = [];
      if (v.width && v.height) bits.push(`${v.width}x${v.height}`);
      if (v.bandwidth) bits.push(`${Math.round(v.bandwidth / 1000)}kbps`);
      const detail = bits.length ? `（${bits.join(' · ')}）` : '';
      o.textContent = `${label}${QN_NOTE[v.id] || ''}${detail}`;
      elQn.appendChild(o);
    });
    // 默认取「最高的、普通设备能正常看的」那一档
    const pick = list.find((v) => QN_NOT_DEFAULT.indexOf(Number(v.id)) === -1) || list[0];
    if (pick) elQn.value = String(pick.id);
  }

  /* ---------- 下载文件名 ----------
     统一格式：标题_清晰度标签_视频ID[_用途]
       UGC：xxx_1080P_BV1xx411c7mD.mp4
       PGC：番剧名 - 第5集_1080P_ep321808_video.m4s
     ID 能避免不同视频因封面/标题撞名而互相覆盖下载。                       */
  function currentVideoId() {
    if (pgcInfo && pgcInfo.ep) return 'ep' + pgcInfo.ep.id;   // 番剧/课程切过集后要跟着变
    if (viewData && viewData.bvid) return viewData.bvid;      // 规范 BV 号（av 链接会被换成 BV）
    return bvid || 'unknown';
  }
  function qnFileTag() {
    const raw = String(elQn.value || '');
    return raw ? (QN_FILE_TAG[Number(raw)] || raw + 'P') : 'unknown';
  }
  // withQn=false 用于与清晰度无关的产物（封面、FLV 合流）
  function baseName(withQn) {
    const title = sanitize((viewData && viewData.title) || 'bilibili');
    const parts = withQn
      ? [title, qnFileTag(), currentVideoId()]
      : [title, currentVideoId()];
    // sanitize 把「?」「:」等非法字符替换成 _，紧跟着的分隔符会连成一串，这里收一下
    return parts.join('_').replace(/_{2,}/g, '_').replace(/_+$/, '');
  }

  async function loadPlayurl(cid) {
    if (pgcInfo) await loadPlayurlPgc();
    else await loadPlayurlUgc(cid);
    fillQn();
    // 番剧基本不提供 FLV 分段，拿不到就把「兼容下载」整行藏掉，不放一个必然失败的按钮
    const hasFlv = !!(flvData && flvData.durl && flvData.durl.length);
    $('row-flvm').style.display = hasFlv ? '' : 'none';
    // 诊断：打印实际拿到的 CDN 节点数。若恒为 1，说明 backupUrl 没解析出来，容错层会空转
    try {
      const vu = pickVideoUrls(), au = pickAudioUrls();
      console.log('[bili-mux] 可用 CDN 节点 — 视频', vu.length, '个 / 音频', au.length,
        '个\n  首选视频节点:', vu[0]);
    } catch (e) { /* 解析异常不影响主流程 */ }
  }

  async function loadPlayurlUgc(cid) {
    dashData = await fetchPlayurl(bvid, cid, 16, 80); // DASH
    // FLV 分段（用于合并下载）：qn 拉到最高，拿到 durl 能提供的最佳画质
    try { flvData = await fetchPlayurl(bvid, cid, 0, 120); } catch (e) { flvData = null; }
  }

  async function loadPlayurlPgc() {
    const ep = pgcInfo.ep;
    const raw = await fetchPgcPlayurl(ep, pgcInfo.seasonId, 4048, 120, pgcInfo.site);
    // 番剧 v2 把老接口的 result 整体塞进了 video_info；课程直接给 dash。两种形态都兜住
    const vi = raw.video_info || raw;
    dashData = { dash: vi.dash || { video: [], audio: [] } };
    if (!((dashData.dash.video || []).length)) {
      throw new Error('该集没有可取的视频流（会员专享 / 地区限制 / 尚未开播）');
    }
    // 试看片段：非会员拿到的正片被截断，不提示的话用户会以为下载器坏了
    const detail = raw.play_check && raw.play_check.play_detail;
    if (detail && detail !== 'PLAY_WHOLE') setStatus('注意：当前账号只能获取试看片段（会员才能看全集）');
    // FLV 分段：番剧多数不提供，失败静默（外层据此隐藏「兼容下载」）
    flvData = null;
    try {
      const fraw = await fetchPgcPlayurl(ep, pgcInfo.seasonId, 0, 80, pgcInfo.site);
      const fvi = fraw.video_info || fraw;
      if (fvi.durl && fvi.durl.length) flvData = { durl: fvi.durl };
    } catch (e) { /* 番剧无 FLV 属于常态 */ }
  }

  function pickVideoUrls() {
    const qn = Number(elQn.value);
    const list = dashData.dash.video || [];
    let pick = list.find(v => v.id === qn) || list[0];
    if (!pick) return []; // 会员专享 / 未开播等场景可能一条都没有，交给容错层给出可读提示
    // 兼容驼峰与下划线两套字段名：B站不同接口/不同时期返回的键名不一致，
    // 只认一种会导致备用节点整个丢失（表现为「容错层空转，仍然一个节点打到黑」）
    return [pick.baseUrl || pick.base_url, ...(pick.backupUrl || pick.backup_url || [])].filter(Boolean).map(toHttps);
  }
  function pickAudioUrls() {
    const list = dashData.dash.audio || [];
    let pick = list[0];
    if (!pick) return []; // 极少数 PGC 条目没有独立音轨（已是混合流），不应抛 TypeError
    // 兼容驼峰与下划线两套字段名：B站不同接口/不同时期返回的键名不一致，
    // 只认一种会导致备用节点整个丢失（表现为「容错层空转，仍然一个节点打到黑」）
    return [pick.baseUrl || pick.base_url, ...(pick.backupUrl || pick.backup_url || [])].filter(Boolean).map(toHttps);
  }

  // 关闭卡片（右上角 ×）
  guarded($('btn-close'), closePanel);

  // 番剧「选集」下拉：切一集就要重新取一次该集的 playurl（直链按 cid 签发，
  // 且 B站对影视内容的签名有效期更短，不存在「一次拿全季」的接口）。
  const elEp = $('ep-sel');
  if (elEp) elEp.addEventListener('change', async () => {
    if (!pgcInfo) return;
    const ep = pgcInfo.list.find((e) => String(e.id) === String(elEp.value));
    if (!ep) return;
    if (elEp._busy) return;
    elEp._busy = true; elEp.disabled = true;
    setStatus('切换剧集中…');
    try {
      const myGen = ++_gen;
      pgcInfo.ep = ep;
      await applyPgcEp(myGen);
      if (myGen !== _gen) return;
      await loadPlayurl(viewData.cid);
      if (myGen !== _gen) return;
      setStatus('已切换剧集');
    } catch (e) {
      setStatus('切换剧集失败: ' + (e && e.message));
    } finally {
      elEp._busy = false; elEp.disabled = false;
    }
  });

  // 封面下载
  guarded($('btn-cover'), async () => {
    if (!viewData || !viewData.pic) return setStatus('暂无封面');
    hideRetry();
    setStatus('封面下载中…');
    try {
      const r = await downloadViaExtension(toHttps(viewData.pic), `${baseName(false)}_封面.jpg`);
      setStatus(r.ok ? '封面已提交下载' : ('封面下载失败: ' + (r.error || '')));
    } catch (e) {
      failWithRetry('封面下载失败: ' + (e && e.message), 'btn-cover', e, '重试封面下载');
    }
  });

  // DASH 视频 / 音频 分别保存：两份独立 m4s，留给用户自行合成
  guarded($('btn-video'), async () => {
    if (!dashData) return setStatus('请先等待解析');
    hideRetry();
    setStatus('视频流下载中…');
    try {
      await downloadStreamWithFallback(pickVideoUrls(), `${baseName(true)}_video.m4s`,
        (i, n, node) => setStatus(`主节点失败，切换备用节点 ${i + 1}/${n}（${node}）…`));
      setStatus('视频流已保存（.m4s）— 可在下载目录用本地 ffmpeg 合成');
    } catch (e) {
      failWithRetry('视频流下载失败: ' + (e && e.message) + '（可改用 FLV 合并或浏览器内合成）',
        'btn-video', e, '重试视频流下载');
    }
  });
  guarded($('btn-audio'), async () => {
    if (!dashData) return setStatus('请先等待解析');
    hideRetry();
    setStatus('音频流下载中…');
    try {
      await downloadStreamWithFallback(pickAudioUrls(), `${baseName(true)}_audio.m4s`,
        (i, n, node) => setStatus(`主节点失败，切换备用节点 ${i + 1}/${n}（${node}）…`));
      setStatus('音频流已保存（.m4s）— 可在下载目录用本地 ffmpeg 合成');
    } catch (e) {
      failWithRetry('音频流下载失败: ' + (e && e.message) + '（可改用 FLV 合并或浏览器内合成）',
        'btn-audio', e, '重试音频流下载');
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
  // 本标签页的 tabId：Service Worker 被回收/重启时会丢掉内存里的 requestId→tabId 映射，
  // 导致合成结果找不到目标标签回传（content 会干等到 600s 超时）。
  // 把 tabId 一并编进 requestId，SW 重启后也能解析出来，无需任何持久化权限。
  let _tabId = null;
  async function getTabId() {
    if (_tabId != null) return _tabId;
    try {
      const r = await sendRuntimeMessage({ type: 'bili-get-tabid' });
      if (r && typeof r.tabId === 'number') _tabId = r.tabId;
    } catch (e) { /* 取不到就退化：SW 未重启时仍可靠 sender.tab.id 工作 */ }
    return _tabId;
  }
  // 通用失败处理：上下文失效 → 只能刷新页面（孤儿 content script 无法自愈）；
  // 其余情况 → 按钮变成「重试」，点击重跑对应动作（走 guarded，天然防抖/加锁）
  function failWithRetry(text, btnId, e, retryLabel) {
    setStatus(text);
    if (isCtxDeadError(e)) showRetry(() => location.reload(), '刷新页面（扩展已更新，需刷新才能继续）');
    else if (btnId) showRetry(() => $(btnId).click(), retryLabel || '重试');
  }
  function muxFailed(text, e) {
    $('muxbox').style.display = 'none';
    if (_muxResolver) { const r = _muxResolver; _muxResolver = null; r(); } // 释放等待锁
    failWithRetry(text, 'btn-mux', e, '重试高级下载');
    console.error('[bili-mux] mux 失败:', text, e && e.message);
  }
  guarded($('btn-mux'), async () => {
    if (!dashData) return setStatus('请先等待解析');
    hideRetry();
    // 预检：扩展上下文若已失效（被更新/重载），此刻就提示，
    // 不要等用户白拉几百 MB 流、最后才在传输阶段炸掉
    if (!isCtxAlive()) {
      return muxFailed('扩展已更新/重载，本页面需刷新后才能继续（已跳过拉流）',
        Object.assign(new Error('Extension context invalidated'), { ctxDead: true }));
    }
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
      vBuf = await fetchStreamWithFallback(pickVideoUrls(), fetchStatus('拉取视频流', 0, 0.5), 60000,
        (i, n, node) => setStatus(`视频流主节点失败，切换备用节点 ${i + 1}/${n}（${node}）…`));
      console.log('[bili-mux] mux: 视频流拉取完成', mb(vBuf.byteLength));
      console.log('[bili-mux] mux: 开始拉取音频流', String(pickAudioUrls()[0]).slice(0, 60) + '…');
      aBuf = await fetchStreamWithFallback(pickAudioUrls(), fetchStatus('拉取音频流', 0.5, 0.5), 60000,
        (i, n, node) => setStatus(`音频流主节点失败，切换备用节点 ${i + 1}/${n}（${node}）…`));
      console.log('[bili-mux] mux: 音频流拉取完成', mb(aBuf.byteLength));
    } catch (e) {
      // 拉流失败：给出明确提示 + 重试入口（CDN 抖动很常见，值得一键重试），
      // 不进入等待、不乱回退，避免按钮卡死
      return muxFailed('拉取流失败: ' + (e && e.message) + '（可改用 FLV 合并或分离下载）', e);
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
    const tabId = await getTabId();
    // requestId 形如 mux_<tabId>_<ts>_<rand>：SW 重启后可从 requestId 反解目标标签
    const requestId = 'mux_' + (tabId == null ? 'x' : tabId) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    // 统一走 sendRuntimeMessage：上下文失效立即失败（不再瞎重试），瞬时错误自动重试一次
    const sendMsg = (payload) => sendRuntimeMessage(payload);
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
      const filename = `${baseName(true)}.mp4`;
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
      return muxFailed('传输失败: ' + (e && e.message) + '（可改用 FLV 合并或分离下载）', e);
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
        if (!done) {
          // 等待超时：多半是 SW 重启后结果没能回传，或 ffmpeg 卡住；给重试入口而不是干等
          muxFailed('合成等待超时（600s 未回传结果），可点重试 / 改用分离下载', null);
          finish();
        }
      }, 600000);
    });
  });

  // FLV 合并下载（二进制拼接即得可播放文件；offscreen 会自动转封装为 MP4 提升兼容性，失败回退原 FLV）
  guarded($('btn-flvm'), async () => {
    if (!flvData || !flvData.durl || !flvData.durl.length) return setStatus('该视频不支持 FLV 合并（可能仅 DASH）');
    hideRetry();
    $('flvbox').style.display = 'block';
    setBar('f', 0);
    try {
      const urls = flvData.durl.map(d => toHttps(d.url));
      const bytes = await fetchAndConcat(urls, (ratio) => setBar('f', ratio));
      setBar('f', 1);
      setStatus('转封装为 MP4…');
      const resp = await saveViaOffscreen(bytes, `${baseName(false)}.flv`, 'video/x-flv');
      if (resp.converted) setStatus('已转封装为 MP4 并触发下载');
      else if (resp.note) setStatus(resp.note);
      else setStatus('已触发下载');
    } catch (e) {
      failWithRetry('FLV 合并失败: ' + (e && e.message), 'btn-flvm', e, '重试 FLV 合并');
    }
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
        if (!/Extension context invalidated/i.test(reason)) showRetry(() => $('btn-mux').click(), '重试高级下载');
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
    if (started || (!getBvid() && !getPgcId())) return false;
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
