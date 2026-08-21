// popup.js — 落地页逻辑
// - 显示版本号
// - "打开 B站视频页"：新开/聚焦一个 bilibili 视频页
// - 若当前激活标签就是 bilibili 视频页，给出"跳到当前页面板"入口（让 content 展开面板）

const BILI_VIDEO = /^https?:\/\/(www\.|m\.)?bilibili\.com\/video\//;
// chrome.tabs.query 的 url 只接受 string 或 string[]（match pattern），不接受正则，
// 故单独提供一组合法的 match pattern 用于查询已有视频页标签。
const BILI_VIDEO_URLS = [
  'https://www.bilibili.com/video/*',
  'https://bilibili.com/video/*',
  'https://m.bilibili.com/video/*'
];

document.addEventListener('DOMContentLoaded', () => {
  // 版本号
  chrome.runtime.getManifest && (document.getElementById('ver').textContent =
    'v' + (chrome.runtime.getManifest().version || '1.0.0'));

  // 打开 B站视频页
  document.getElementById('open').addEventListener('click', async () => {
    const url = 'https://www.bilibili.com/video/';
    const tabs = await chrome.tabs.query({ url: BILI_VIDEO_URLS });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
  });

  // 当前页若是视频页，提供直达面板按钮
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const t = tabs[0];
    if (t && BILI_VIDEO.test(t.url || '')) {
      const link = document.getElementById('cur');
      link.hidden = false;
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        chrome.tabs.sendMessage(t.id, { type: 'bili-open-panel' }, () => {
          // 忽略 content 未注入时的报错
          if (chrome.runtime.lastError) {}
        });
        window.close();
      });
    }
  });
});
