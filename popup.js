// popup.js — 落地页逻辑
// - 显示版本号
// - "打开 Bilibili"：新开/聚焦一个 bilibili 标签页（首页）
// - 若当前激活标签就是 bilibili 视频页，给出"跳到当前页面板"入口（让 content 展开面板）

const BILI_VIDEO = /^https?:\/\/(www\.|m\.)?bilibili\.com\/video\//;
// chrome.tabs.query 的 url 只接受 string 或 string[]（match pattern），不接受正则，
// 故单独提供一组合法的 match pattern 用于查询已有 bilibili 标签页（含首页与视频页）。
const BILI_URLS = [
  'https://www.bilibili.com/*',
  'https://bilibili.com/*',
  'https://m.bilibili.com/*'
];

document.addEventListener('DOMContentLoaded', () => {
  // 版本号
  chrome.runtime.getManifest && (document.getElementById('ver').textContent =
    'v' + (chrome.runtime.getManifest().version || '1.1.0'));

  // 打开 Bilibili（首页）：已存在 bilibili 标签页则聚焦，否则新开一个
  document.getElementById('open').addEventListener('click', async () => {
    const url = 'https://www.bilibili.com/';
    const tabs = await chrome.tabs.query({ url: BILI_URLS });
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
