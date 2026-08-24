// popup.js — 落地页逻辑
// - 显示版本号
// - "打开 Bilibili"：始终直接新开一个 bilibili 首页标签页

document.addEventListener('DOMContentLoaded', () => {
  // 版本号
  chrome.runtime.getManifest && (document.getElementById('ver').textContent =
    'v' + (chrome.runtime.getManifest().version || '1.1.0'));

  // 打开 Bilibili（首页）：直接新开一个标签页
  document.getElementById('open').addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'https://www.bilibili.com/' });
    window.close();
  });
});
