// Service Worker：让网站能「添加到主屏幕」像 App 一样打开；
// 缓存字体和前端库加快打开速度；电脑关机/断网时显示友好的提示页，而不是 502 错误。
const VERSION = 'v8'; // 改了它旧缓存（含首页外壳、字体）会整个作废；只改这个文件的逻辑不用改它
let shellUpdatedAt = 0; // 最近一次发现网上的首页比缓存里的新（网页问起时告诉它）
const STATIC = 'static-' + VERSION;
// 首页 HTML（网页外壳，所有账号都一样，不含个人数据）也存在 STATIC 里：打开时先用它立刻显示，同时在后台更新。
// 电脑睡着时外壳照样秒开，网页自己发现连不上电脑后跳到 /?live=…，那个地址一律走网络，拿到 Cloudflare 的「Claude 在睡觉」页面
const SHELL_KEY = '/';
const isShell = (url) => url.pathname === '/' || url.pathname === '/index.html';
// 比版本号，不比整页：Cloudflare 只给网页导航请求注入统计脚本，同一版本的页面字节也会不同。
const shellBuild = (html) => (/const PAGE_BUILD = '([a-f0-9]{16})'/.exec(html) || [])[1] || html;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(['/', '/favicon.svg?v=3', '/icons/icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== STATIC && k !== 'wake' && k !== 'data').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const OFFLINE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Claude</title>
<style>
:root{--bg:#faf9f5;--text:#141413;--muted:#75736c}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--text:#faf9f5;--muted:#a39f96}}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;padding:24px}
svg{width:120px;height:90px;margin:0 auto 22px;display:block;shape-rendering:crispEdges}
h1{font:400 26px/1.3 Georgia,"Songti SC",serif;margin:0 0 10px}p{color:var(--muted);margin:0 0 26px}
button{border:0;border-radius:12px;padding:12px 26px;background:#d97757;color:#fff;font:inherit;font-weight:500;margin:4px}button:disabled{opacity:.6}button.ghost{background:transparent;color:var(--muted);box-shadow:inset 0 0 0 1px var(--muted)}small{display:block;color:var(--muted);font-size:13px;margin-top:18px}
.z{animation:z 2s infinite}@keyframes z{0%{opacity:0;transform:translate(0,0)}50%{opacity:1}100%{opacity:0;transform:translate(2px,-3px)}}
</style></head><body><div>
<svg viewBox="0 -4 18 13"><g fill="#d97757"><rect x="2" y="0" width="12" height="7"/><rect x="0" y="3" width="2" height="2"/><rect x="14" y="3" width="2" height="2"/>
<rect x="3" y="7" width="1" height="2"/><rect x="5" y="7" width="1" height="2"/><rect x="10" y="7" width="1" height="2"/><rect x="12" y="7" width="1" height="2"/></g>
<g fill="#141413"><rect x="4" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/></g>
<g class="z" fill="#d97757"><rect x="15" y="-3" width="2" height="1"/><rect x="16" y="-2" width="1" height="1"/><rect x="15" y="-1" width="2" height="1"/></g></svg>
<h1>Claude 在睡觉</h1><p id="msg">那台电脑现在在睡觉，<br>可以把它叫醒</p>
<button id="wake">叫醒 Claude</button><button class="ghost" onclick="location.reload()">再试一次</button><small id="seen"></small></div>
<script>
const $ = (id) => document.getElementById(id);
// 北京时间 1–8 点电脑不巡检，叫醒请求会排到 8 点
const bjHour = () => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date()) % 24;
const night = () => bjHour() >= 1 && bjHour() < 8;
const ago = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前'; };
async function token() { try { const r = await caches.match('/__wake_token'); return r ? await r.text() : null; } catch (e) { return null; } }
function render(st) {
  if (st.pending) {
    $('wake').disabled = true; $('wake').textContent = '正在叫它…';
    $('msg').innerHTML = night() ? '现在是北京时间深夜（1–8 点），<br>电脑 8 点后会醒来，到时自动进入' : '电脑每 15 分钟会醒来看一眼，<br>通常 15 分钟内就能用了，到时自动进入';
  }
  if (st.lastPoll) $('seen').textContent = '电脑上次醒来巡检：' + ago(Date.now() - st.lastPoll);
}
async function refresh() {
  const t = await token();
  if (!t) { $('wake').style.display = 'none'; $('msg').innerHTML = '那台电脑现在在睡觉。<br>在这个设备上正常登录过一次之后，这里就能直接叫醒它'; return; }
  try { render(await (await fetch('/__wake/status?token=' + encodeURIComponent(t), { cache: 'no-store' })).json()); } catch (e) {}
}
$('wake').onclick = async () => {
  const t = await token(); if (!t) return;
  $('wake').disabled = true;
  try {
    const r = await fetch('/__wake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    render({ pending: true, lastPoll: d.lastPoll });
  } catch (e) { $('wake').disabled = false; $('msg').textContent = '没叫成功，过一会儿再试试'; }
};
// 每 20 秒看一眼：电脑醒了就自动进入
setInterval(async () => {
  try { const r = await fetch('/api/state', { cache: 'no-store' }); if (r.status < 500) return location.reload(); } catch (e) {}
  refresh();
}, 20000);
refresh();
</script></body></html>`;

// 网页加载完问一句（上面的通知可能在网页脚本跑起来之前就发出去了）
self.addEventListener('message', (e) => {
  // 网页要刷新到新版：先把缓存里的首页换掉，再告诉它可以刷新了
  if (e.data && e.data.type === 'refresh-shell') {
    e.waitUntil(fetch('/', { cache: 'no-store' }).then(async (res) => {
      if (res.status === 200 && !res.headers.get('x-claude-sleep')) {
        const cache = await caches.open(STATIC);
        // 明确刷新时一起换掉旧脚本/样式缓存；页面资源 URL 也带 PAGE_BUILD。
        for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith('/vendor/')) await cache.delete(request);
        await cache.put(SHELL_KEY, res.clone()); shellUpdatedAt = 0;
      }
    }).catch(() => {}).then(() => { if (e.source) e.source.postMessage({ type: 'shell-ready' }); }));
    return;
  }
  if (e.data && e.data.type === 'ask-update' && shellUpdatedAt && Date.now() - shellUpdatedAt < 120e3 && e.source) e.source.postMessage({ type: 'shell-updated' });
});

const offline = () => new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 打开首页：有缓存就先用缓存，后台拿新的存起来（只存正常的 200，睡觉页面不会被当成首页存下）；
  // 第一次还没有缓存时和下面一样联网
  if (req.mode === 'navigate' && isShell(url) && !url.searchParams.has('live')) {
    e.respondWith(caches.open(STATIC).then(async (cache) => {
      const hit = await cache.match(SHELL_KEY);
      const old = hit ? hit.clone().text().catch(() => '') : null;
      const net = fetch(req).then(async (res) => {
        if (res.status === 200 && !res.headers.get('x-claude-sleep')) {
          const fresh = await res.clone().text().catch(() => '');
          await cache.put(SHELL_KEY, res.clone()).catch(() => {});
          // 这次打开用的是缓存里的旧版本、而网上已经有新版本：告诉网页，网页提示「点此刷新」
          const changed = old && fresh && shellBuild(fresh) !== shellBuild(await old);
          shellUpdatedAt = changed ? Date.now() : 0; // 这次打开时缓存已是最新：之前记下的「有新版本」作废
          if (changed) {
            for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'shell-updated' });
          }
        }
        return res;
      });
      if (hit) {
        e.waitUntil(net.catch(() => {}));
        return hit;
      }
      return net.then((res) => (res.status >= 500 && !res.headers.get('x-claude-sleep') ? offline() : res)).catch(() => offline());
    }));
    return;
  }
  // 其他页面和 /?live=…：联网优先；电脑没开（Cloudflare 返回 5xx）或断网时显示提示页
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => (res.status >= 500 && !res.headers.get('x-claude-sleep') ? offline() : res)).catch(() => offline())); // Cloudflare 给的睡觉页面（可以用账号密码叫醒）直接显示
    return;
  }
  // 字体、前端库、图标：先用缓存，同时在后台更新
  if (url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/') || url.pathname === '/favicon.svg') {
    e.respondWith(caches.open(STATIC).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req, { cache: 'no-cache' }).then(async (res) => { if (res.ok) { await cache.put(req, res.clone()); return res; } return hit || res; }).catch(() => hit);
      // CSS 内相对字体等没有版本参数的资源在线时先核对网络，离线仍用缓存。
      if (url.pathname.startsWith('/vendor/') && !url.searchParams.has('build')) return net;
      e.waitUntil(net.then(() => {}).catch(() => {}));
      return hit || net;
    }));
  }
  // 其余（/api、/f 等实时数据）不经过缓存
});
