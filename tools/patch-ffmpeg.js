#!/usr/bin/env node
/**
 * 修补 lib/ffmpeg/ffmpeg.min.js 内置的远程 CDN 默认值。
 *
 * 背景：Chrome 应用商店会以「Manifest V3 产品包含远程托管代码」为由拒审。
 * @ffmpeg/ffmpeg 的打包产物里有个默认配置模块，把 corePath 指向 unpkg CDN：
 *
 *   497:(e,t,r)=>{
 *     var n = r(306).devDependencies,
 *         o = "https://unpkg.com/@ffmpeg/core@".concat(n["@ffmpeg/core"].substring(1),
 *                                                      "/dist/ffmpeg-core.js");
 *     e.exports = { corePath: o }
 *   }
 *
 * 本项目运行时总是显式传本地 corePath（见 offscreen.js），所以不会真的去下载。
 * 但商店做的是**静态扫描**，包里出现这个 CDN 直链就会被判定违规。
 *
 * 本脚本把它改写成指向包内自带的 ffmpeg-core.js，既消除违规，也让默认值本身安全。
 * 幂等：已修补过再跑不会有变化。
 *
 * 用法：node tools/patch-ffmpeg.js [--verify]
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'lib', 'ffmpeg', 'ffmpeg.min.js');

// 被替换的目标片段（minified 后的确切形态）
const NEEDLE =
  'o="https://unpkg.com/@ffmpeg/core@".concat(n["@ffmpeg/core"].substring(1),"/dist/ffmpeg-core.js")';
// 替换成：指向包内自带的 core（相对 offscreen.html 的路径）
const REPLACEMENT = 'o="lib/ffmpeg/".concat("ffmpeg-core.js")';

// 去掉 sourceMappingURL 注释：.map 文件没有打进商店包，留着会指向一个不存在的外部资源
const MAP_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\n?/g;

function main() {
  if (!fs.existsSync(FILE)) {
    console.error('[patch-ffmpeg] 找不到文件:', FILE);
    process.exit(1);
  }
  const before = fs.readFileSync(FILE, 'utf8');

  const hasCDN = before.includes(NEEDLE);
  const hasMap = MAP_COMMENT.test(before);

  if (!hasCDN && !hasMap) {
    console.log('[patch-ffmpeg] 已是修补状态，无需改动');
    return verify(before);
  }

  let after = before;
  if (hasCDN) {
    if (before.split(NEEDLE).length - 1 !== 1) {
      console.error('[patch-ffmpeg] 匹配到多处 CDN 片段，请人工确认后再替换');
      process.exit(1);
    }
    after = after.replace(NEEDLE, REPLACEMENT);
    console.log('[patch-ffmpeg] 已把默认 corePath 从 unpkg CDN 改为包内 ffmpeg-core.js');
  }
  if (hasMap) {
    after = after.replace(MAP_COMMENT, '\n');
    console.log('[patch-ffmpeg] 已移除 sourceMappingURL 注释');
  }

  fs.writeFileSync(FILE, after, 'utf8');
  console.log(`[patch-ffmpeg] 写入完成：${before.length} → ${after.length} 字节`);
  return verify(after);
}

/** 校验：确保包内不再有任何「会被加载」的远程代码 URL */
function verify(src) {
  const RemoteStart = /https?:\/\//gi;
  const hits = new Set();
  let m;
  while ((m = RemoteStart.exec(src)) !== null) {
    hits.add(src.slice(m.index, m.index + 90).split(/[\s"'`,)]/)[0]);
  }
  const list = [...hits];
  if (list.length === 0) {
    console.log('[patch-ffmpeg] 校验通过：ffmpeg.min.js 中已无任何 http(s) 链接');
    return 0;
  }
  console.log('[patch-ffmpeg] 仍存在链接：');
  list.forEach((u) => console.log('   ', u));
  return 0;
}

if (process.argv.includes('--verify')) {
  process.exit(verify(fs.readFileSync(FILE, 'utf8')));
}
process.exit(main());
