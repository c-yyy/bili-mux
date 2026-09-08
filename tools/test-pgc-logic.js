// 纯逻辑冒烟测试：从 content.js 中抽出不依赖 DOM 的函数直接验证。
// 只覆盖 PGC 解析的三个关键纯函数 flatEpisodes / getPgcId / pgcEpTitle，
// 不做真实网络请求，也不模拟 DOM——那部分只能在真实浏览器里验。
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

// 按函数名抽取源码：从 `function name(` 起做花括号配平，取到函数体结束
function grab(name) {
  const head = 'function ' + name + '(';
  const i = SRC.indexOf(head);
  if (i < 0) throw new Error('未找到函数 ' + name);
  let depth = 0, j = SRC.indexOf('{', i);
  if (j < 0) throw new Error(name + ' 没有函数体');
  for (let k = j; k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}') { depth--; if (depth === 0) return SRC.slice(i, k + 1); }
  }
  throw new Error(name + ' 花括号未配平');
}

const sandbox = {};
const code = [grab('getPgcId'), grab('flatEpisodes'), grab('pgcEpTitle'), grab('hostOf')].join('\n');
const factory = new Function('location', code + '\nreturn { getPgcId, flatEpisodes, pgcEpTitle, hostOf };');

let pass = 0, fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + '\n       实际: ' + a + '\n       期望: ' + e); }
}

const loc = { pathname: '/bangumi/play/ss109700' };
const api = factory(loc);

console.log('[ getPgcId ]');
loc.pathname = '/bangumi/play/ss109700';
eq('整季 URL', api.getPgcId(), { site: 'pgc', kind: 'season_id', id: '109700', raw: 'ss109700' });
loc.pathname = '/bangumi/play/ep321808';
eq('单集 URL', api.getPgcId(), { site: 'pgc', kind: 'ep_id', id: '321808', raw: 'ep321808' });
loc.pathname = '/video/BV1xx411c7mD';
eq('普通视频页不匹配', api.getPgcId(), null);
loc.pathname = '/bangumi/index/';
eq('番剧索引页不匹配', api.getPgcId(), null);
loc.pathname = '/bangumi/play/ss109700?spm_id_from=333';
eq('带 query 仍能解析', api.getPgcId(), { site: 'pgc', kind: 'season_id', id: '109700', raw: 'ss109700' });
loc.pathname = '/cheese/play/ss20821';
eq('课程整季 URL', api.getPgcId(), { site: 'pugv', kind: 'season_id', id: '20821', raw: 'ss20821' });
loc.pathname = '/cheese/play/ep712007';
eq('课程单课时 URL', api.getPgcId(), { site: 'pugv', kind: 'ep_id', id: '712007', raw: 'ep712007' });
loc.pathname = '/cheese/index';
eq('课程首页不匹配', api.getPgcId(), null);

console.log('[ flatEpisodes ]');
// 真实 season 响应里剧集散在三层结构：顶层 episodes、sections、新版 modules[].data
const season = {
  episodes: [
    { id: 1, aid: 111, bvid: 'BV1a', cid: 9001, title: '1', long_title: '启程' },
    { id: 2, aid: 112, bvid: 'BV1b', cid: 9002, title: '2', long_title: '伙伴' }
  ],
  sections: [{ title: 'PV', episodes: [{ id: 3, title: 'PV1', long_title: '预告' }] }],
  modules: [
    { data: { episodes: [{ id: 4, title: '4', long_title: '决战' }] } },
    { data: { sections: [{ episodes: [{ id: 5, title: '5' }] }] } }
  ]
};
const list = api.flatEpisodes(season);
eq('三层结构全部收集', list.map((e) => e.id), [1, 2, 3, 4, 5]);
eq('重复项按 id 去重', api.flatEpisodes({ episodes: [{ id: 7 }, { id: 7 }] }).length, 1);
eq('新版 ep_id 主键补齐为 id', api.flatEpisodes({ modules: [{ data: { episodes: [{ ep_id: 42 }] } }] })[0].id, 42);
eq('空对象不炸', api.flatEpisodes({}), []);
eq('残留结构中无剧集', api.flatEpisodes({ episodes: null, modules: [{ data: {} }] }), []);

console.log('[ pgcEpTitle ]');
const ep5 = list.find((e) => e.id === 5);
eq('无副标题', api.pgcEpTitle({ title: '某部番剧' }, ep5, list), '某部番剧 - 第5集');
eq('有副标题', api.pgcEpTitle({ title: '某部番剧' }, list[0], list), '某部番剧 - 第1集 启程');
eq('单条目(电影)不拼集数', api.pgcEpTitle({ title: '某电影' }, { title: 'HD', long_title: '' }, [{ id: 1 }]), '某电影');
eq('缺 season.title 有兜底', api.pgcEpTitle({}, list[0], list), '番剧 - 第1集 启程');
// 课程：episodes[].title 不是纯数字，而是「1. 课程介绍」这类小节名，不能拼成「第X集」
const courseList = [
  { id: 1, title: '1. 课程介绍', aid: 100, cid: 200 },
  { id: 2, title: '2. 环境搭建', aid: 101, cid: 201 }
];
eq('课程小节名直接当标题', api.pgcEpTitle({ title: '某课程' }, courseList[0], courseList), '某课程 - 1. 课程介绍');
eq('标题与副标题同则不重复', api.pgcEpTitle({ title: '某课程' }, { title: '3', long_title: '3' }, courseList), '某课程 - 第3集');

console.log('[ hostOf ]');
eq('取主机名', api.hostOf('https://upos-sz-mirror08c.bilivideo.com/a.m4s?e=1'), 'upos-sz-mirror08c.bilivideo.com');
eq('非法 URL 不炸', typeof api.hostOf(':::'), 'string');

// 文件名标签表：直接读源码里的常量，避免这里抄一份导致两处不同步
console.log('[ QN_FILE_TAG / 文件名 ]');
const tagSrc = SRC.match(/const QN_FILE_TAG = \{[\s\S]*?\};/);
if (!tagSrc) { fail++; console.log('  FAIL 未找到 QN_FILE_TAG'); }
else {
  const QN_FILE_TAG = new Function(tagSrc[0] + '\nreturn QN_FILE_TAG;')();
  eq('80 → 1080P', QN_FILE_TAG[80], '1080P');
  eq('125 → HDR', QN_FILE_TAG[125], 'HDR');
  eq('126 → DolbyVision', QN_FILE_TAG[126], 'DolbyVision');
  eq('127 → 8K', QN_FILE_TAG[127], '8K');
  // QN_LABEL 里 116 写作「1080P60/高码率」，含斜杠，直接用它会污染文件名
  eq('116 不含文件名非法字符', QN_FILE_TAG[116], '1080P60');

  const illegal = /[\\/:*?"<>|]/;
  const badKey = Object.keys(QN_FILE_TAG).find((k) => illegal.test(QN_FILE_TAG[k]));
  eq('所有标签对文件系统安全', badKey ? QN_FILE_TAG[badKey] : null, null);

  // 复现 content.js 里 baseName 的拼接规则，验证最终文件名形态（不含 qn 代号）
  const sanitizeFn = new Function(grab('sanitize') + '\nreturn sanitize;')();
  const base = (title, qn, id) =>
    `${sanitizeFn(title)}_${QN_FILE_TAG[qn] || qn + 'P'}_${id}`.replace(/_{2,}/g, '_').replace(/_+$/, '');
  // 标题里的「?」被 sanitize 换成下划线后不会留下连续下划线
  eq('UGC 文件名', base('如何做视频?', 80, 'BV1xx411c7mD'),
     '如何做视频_1080P_BV1xx411c7mD');
  eq('PGC 文件名', base('某番剧 - 第5集', 116, 'ep321808'),
     '某番剧 - 第5集_1080P60_ep321808');
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
