// popup.js — 落地页逻辑
// - 显示版本号
// - "打开 Bilibili"：始终直接新开一个 bilibili 首页标签页
// - 若当前激活标签就是 bilibili 视频页，给出"跳到当前页面板"入口（让 content 展开面板）

const BILI_VIDEO = /^https?:\/\/(www\.|m\.)?bilibili\.com\/video\//;

document.addEventListener('DOMContentLoaded', () => {
  // 版本号
  chrome.runtime.getManifest && (document.getElementById('ver').textContent =
    'v' + (chrome.runtime.getManifest().version || '1.1.0'));

  // 打开 Bilibili（首页）：直接新开一个标签页
  document.getElementById('open').addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'https://www.bilibili.com/' });
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
