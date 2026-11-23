// 「叫醒 Claude」：电脑睡着时，网页把叫醒请求存在这里；电脑每次定时醒来查一下，有请求就保持清醒。
// 挂在两条路由上：
//   claude-relay.example/        首页：电脑在线就原样转发；隧道连不上（电脑睡着）时直接返回「Claude 在睡觉」页面
//   claude-relay.example/__wake* 叫醒接口
//     POST /__wake            { token } 或 { username, password }  排队叫醒（密码只和存在这里的加盐哈希比对）
//     GET  /__wake/status?token=…        查看有没有排队中的请求、电脑上次来查是什么时候
//     GET  /__wake/poll?key=…            电脑来查：返回有没有请求，并清掉它（key 只有电脑知道）
//     GET  /__wake/preview               预览睡觉页面（测试用，不会叫醒任何东西）
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 账号密码核对：USERS 是 { salt, users: { 账号: sha256(salt \n 账号 \n 密码) } }，由电脑那边生成上传
async function checkPassword(env, username, password) {
  let cfg; try { cfg = JSON.parse(env.USERS || '{}'); } catch { return false; }
  const id = String(username || '').trim().toLowerCase();
  if (!cfg.users || !cfg.users[id]) return false;
  return (await sha256hex(`${cfg.salt}\n${id}\n${password}`)) === cfg.users[id];
}

async function queueWake(env, now) {
  const prev = Number(await env.WAKE.get('requestedAt')) || 0;
  if (now - prev > 60e3) await env.WAKE.put('requestedAt', String(now), { expirationTtl: 24 * 3600 });
  return { ok: true, requestedAt: prev && now - prev <= 60e3 ? prev : now, lastPoll: Number(await env.WAKE.get('lastPoll')) || 0 };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    const now = Date.now();

    // 首页：先找电脑；隧道断了（Cloudflare 530/1033）或连不上，就给睡觉页面
    if (path === '' && !url.pathname.startsWith('/__wake')) {
      try {
        const res = await fetch(req);
        if (res.status !== 530 && res.status !== 502 && res.status !== 503 && res.status !== 504) return res;
      } catch {}
      return sleepPage();
    }
    if (path === '/__wake/preview') return sleepPage();

    if (path === '/__wake' && req.method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      if (body.token) {
        if (body.token !== env.WAKE_TOKEN) return json({ error: 'unauthorized' }, 401);
        return json(await queueWake(env, now));
      }
      // 用账号密码叫醒：同一个 IP 一小时最多错 10 次
      const ip = req.headers.get('cf-connecting-ip') || 'x';
      const failKey = 'fail:' + ip;
      const fails = Number(await env.WAKE.get(failKey)) || 0;
      if (fails >= 10) return json({ error: '尝试次数太多了，过一会儿再试' }, 429);
      if (!(await checkPassword(env, body.username, body.password))) {
        await env.WAKE.put(failKey, String(fails + 1), { expirationTtl: 3600 });
        return json({ error: '账号或密码不对' }, 401);
      }
      // 密码对了：顺便把叫醒密钥给这个设备，以后一点就能叫醒
      return json({ ...(await queueWake(env, now)), token: env.WAKE_TOKEN });
    }

    if (path === '/__wake/status' && req.method === 'GET') {
      if (url.searchParams.get('token') !== env.WAKE_TOKEN) return json({ error: 'unauthorized' }, 401);
      return json({ pending: !!(await env.WAKE.get('requestedAt')), requestedAt: Number(await env.WAKE.get('requestedAt')) || 0,
        lastPoll: Number(await env.WAKE.get('lastPoll')) || 0, now });
    }

    if (path === '/__wake/poll' && req.method === 'GET') {
      if (url.searchParams.get('key') !== env.PC_KEY) return json({ error: 'unauthorized' }, 401);
      const requestedAt = Number(await env.WAKE.get('requestedAt')) || 0;
      await env.WAKE.put('lastPoll', String(now));
      if (requestedAt) await env.WAKE.delete('requestedAt');
      return json({ wake: !!requestedAt, requestedAt, now });
    }

    return json({ error: 'not found' }, 404);
  },
};

function sleepPage() {
  return new Response(SLEEP_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Claude-Sleep': '1' } });
}

const SLEEP_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Claude 在睡觉</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='40' fill='%23d97757'/%3E%3C/svg%3E">
<style>
:root{--bg:#faf9f5;--text:#141413;--muted:#75736c;--line:rgba(31,30,29,.15);--field:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#262624;--text:#faf9f5;--muted:#a39f96;--line:rgba(255,255,255,.15);--field:#30302e}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;padding:24px}
.w{width:min(340px,100%)}
svg{width:120px;height:90px;margin:0 auto 22px;display:block;shape-rendering:crispEdges}
h1{font:400 26px/1.3 Georgia,"Songti SC",serif;margin:0 0 10px}p{color:var(--muted);margin:0 0 22px}
button{border:0;border-radius:12px;padding:12px 26px;background:#d97757;color:#fff;font:inherit;font-weight:500;width:100%;margin-top:6px}
button:disabled{opacity:.6}button.ghost{background:transparent;color:var(--muted);box-shadow:inset 0 0 0 1px var(--line)}
input{width:100%;height:46px;border-radius:12px;border:1px solid var(--line);background:var(--field);color:var(--text);padding:0 14px;font:inherit;margin-bottom:8px;outline:0}
small{display:block;color:var(--muted);font-size:13px;margin-top:18px}.err{color:#c0503a;font-size:14px;min-height:1.4em;margin:4px 0}
.z{animation:z 2s infinite}@keyframes z{0%{opacity:0;transform:translate(0,0)}50%{opacity:1}100%{opacity:0;transform:translate(2px,-3px)}}
</style></head><body><div class="w">
<svg viewBox="0 -4 18 13"><g fill="#d97757"><rect x="2" y="0" width="12" height="7"/><rect x="0" y="3" width="2" height="2"/><rect x="14" y="3" width="2" height="2"/>
<rect x="3" y="7" width="1" height="2"/><rect x="5" y="7" width="1" height="2"/><rect x="10" y="7" width="1" height="2"/><rect x="12" y="7" width="1" height="2"/></g>
<g fill="#141413"><rect x="4" y="3" width="1" height="1"/><rect x="11" y="3" width="1" height="1"/></g>
<g class="z" fill="#d97757"><rect x="15" y="-3" width="2" height="1"/><rect x="16" y="-2" width="1" height="1"/><rect x="15" y="-1" width="2" height="1"/></g></svg>
<h1>Claude 在睡觉</h1><p id="msg">那台电脑现在在睡觉，可以把它叫醒</p>
<form id="login" style="display:none" autocomplete="on" onsubmit="return false">
<input id="un" placeholder="账号" autocomplete="username" autocapitalize="none" spellcheck="false">
<input id="pw" type="password" placeholder="密码" autocomplete="current-password">
</form>
<div class="err" id="err"></div>
<button id="wake">叫醒 Claude</button><button class="ghost" onclick="location.reload()">再试一次</button>
<small id="seen"></small></div>
<script>
const $ = (id) => document.getElementById(id);
// 北京时间直接用 UTC+8 算（有的内置浏览器不支持时区参数）
const bj = () => new Date(Date.now() + 8 * 3600e3);
const bjHour = () => bj().getUTCHours();
// 预计醒来时间：下一个 15 分钟巡检点；北京时间 1–8 点不巡检，就是 8:00
function nextPatrol() { const d = bj(); if (night()) return '8:00'; const m = (Math.floor(d.getUTCMinutes() / 15) + 1) * 15; const h = (d.getUTCHours() + (m === 60 ? 1 : 0)) % 24; return h + ':' + String(m % 60).padStart(2, '0'); }
const night = () => bjHour() >= 1 && bjHour() < 8;
const ago = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前'; };
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
async function token() {
  const t = ls.get('relayWakeToken'); if (t) return t;
  try { const r = await caches.match('/__wake_token'); return r ? await r.text() : null; } catch (e) { return null; }
}
function render(st) {
  if (st.pending) {
    $('login').style.display = 'none'; $('err').textContent = '';
    $('wake').disabled = true; $('wake').textContent = '正在叫它…';
    $('msg').innerHTML = night() ? '现在是北京时间深夜（1–8 点），<br>电脑 8:00 会醒来，到时自动进入' : '已经叫它了，预计北京时间 <b>' + nextPatrol() + '</b> 前醒来，<br>醒了会自动进入';
  }
  if (st.lastPoll) $('seen').textContent = '电脑上次醒来巡检：' + ago(Date.now() - st.lastPoll);
}
async function refresh() {
  const t = await token();
  if (!t) { $('login').style.display = ''; $('msg').innerHTML = '那台电脑现在在睡觉。<br>输入账号和密码就能把它叫醒'; const u = ls.get('lastUser'); if (u) $('un').value = u; return; }
  try { render(await (await fetch('/__wake/status?token=' + encodeURIComponent(t), { cache: 'no-store' })).json()); } catch (e) {}
}
$('wake').onclick = async () => {
  const t = await token();
  const body = t ? { token: t } : { username: $('un').value.trim(), password: $('pw').value };
  if (!t && (!body.username || !body.password)) { $('err').textContent = '请输入账号和密码'; return; }
  $('wake').disabled = true; $('err').textContent = '';
  try {
    const r = await fetch('/__wake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('出错了 ' + r.status));
    if (d.token) { ls.set('relayWakeToken', d.token); ls.set('lastUser', body.username); }
    render({ pending: true, lastPoll: d.lastPoll });
  } catch (e) { $('wake').disabled = false; $('err').textContent = e.message || '没叫成功，过一会儿再试试'; }
};
setInterval(async () => {
  try { const r = await fetch('/api/state', { cache: 'no-store' }); if (r.status < 500) return location.replace('/'); } catch (e) {} // 电脑醒了：去首页（预览页面也不会原地反复刷新）
  refresh();
}, 20000);
refresh();
</script></body></html>`;
