// 一次性设置 Cloudflare 固定域名隧道：node setup-tunnel.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const TUNNEL_NAME = 'claude-relay';
const CF_HOME = path.join(os.homedir(), '.cloudflared');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));
const fail = (msg) => { console.log('\n✗ ' + msg); rl.close(); process.exit(1); };

function findCloudflared() {
  for (const p of ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe']) if (fs.existsSync(p)) return p;
  const r = spawnSync('where', ['cloudflared'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function cf(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', stdio: opts.inherit ? 'inherit' : 'pipe' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

(async () => {
  console.log('=== 设置公网访问（Cloudflare 固定域名）===\n');
  if (!fs.existsSync(CONFIG_PATH)) fail('没找到 config.json，请先运行一次「启动.bat」');
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const bin = findCloudflared();
  if (!bin) fail('没找到 cloudflared，请先运行：winget install Cloudflare.cloudflared');
  console.log('cloudflared: ' + bin);

  // 1. 登录 Cloudflare（浏览器里选择要用的域名）
  if (!fs.existsSync(path.join(CF_HOME, 'cert.pem'))) {
    console.log('\n第 1 步：登录 Cloudflare。浏览器会打开，登录后点选你要用的域名并授权。');
    await ask('准备好了按回车…');
    if (!cf(bin, ['tunnel', 'login'], { inherit: true }).ok) fail('登录没有完成');
  } else console.log('\n第 1 步：已登录 Cloudflare ✓');

  // 2. 填写域名
  const hostname = (await ask('\n第 2 步：输入要用来访问的网址（例如 claude.你的域名.com）：')).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(hostname)) fail('网址格式不对');

  // 3. 创建隧道（已存在则复用）
  let id = null;
  const list = cf(bin, ['tunnel', 'list', '--output', 'json']);
  try { const t = JSON.parse(list.out.slice(list.out.indexOf('['))).find((x) => x.name === TUNNEL_NAME && !x.deleted_at); if (t) id = t.id; } catch {}
  if (!id) {
    console.log('\n第 3 步：创建隧道 ' + TUNNEL_NAME);
    const r = cf(bin, ['tunnel', 'create', TUNNEL_NAME]);
    console.log(r.out.trim());
    const m = r.out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (!r.ok || !m) fail('创建隧道失败');
    id = m[1];
  } else console.log('\n第 3 步：复用已有隧道 ' + TUNNEL_NAME + ' ✓');
  const cred = path.join(CF_HOME, id + '.json');
  if (!fs.existsSync(cred)) fail('找不到隧道凭证 ' + cred + '。可以在 Cloudflare 后台删除隧道 ' + TUNNEL_NAME + ' 后重新运行本脚本。');

  // 4. 把域名指向隧道
  console.log('\n第 4 步：把 ' + hostname + ' 指向隧道');
  const dns = cf(bin, ['tunnel', 'route', 'dns', '--overwrite-dns', id, hostname]);
  console.log(dns.out.trim());
  if (!dns.ok) fail('设置 DNS 失败，确认这个域名在你刚才授权的 Cloudflare 账号里');

  // 5. 写配置
  fs.mkdirSync(path.join(ROOT, 'cloudflared'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'cloudflared', 'config.yml'), [
    `tunnel: ${id}`,
    `credentials-file: ${cred.replace(/\\/g, '/')}`,
    'ingress:',
    `  - hostname: ${hostname}`,
    `    service: http://localhost:${config.port}`,
    '  - service: http_status:404',
    '',
  ].join('\n'), 'utf8');
  config.tunnel = { enabled: true, name: id, hostname, cloudflaredPath: bin };

  // 6. 公网访问建议用强密码：多账号时逐个检查 users 里的密码，没有 users 时检查旧版单账号的 password
  const accounts = Array.isArray(config.users) && config.users.length ? config.users : [config];
  let changed = false;
  for (const acc of accounts) {
    const pw = String(acc.password || '');
    if (pw.length >= 12) continue;
    const who = acc.id ? `账号 ${acc.id} 的密码` : '当前密码';
    const a = await ask(`\n${who}只有 ${pw.length} 位，放到公网上不够安全。生成一个新的 16 位密码吗？(Y/n) `);
    if (!/^n/i.test(a)) {
      acc.password = crypto.randomBytes(12).toString('base64url');
      changed = true;
      console.log(`新密码：${acc.password}（${acc.id ? `用账号 ${acc.id} 登录的人` : '用户'}需要用新密码重新登录）`);
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  if (changed && config.wake) console.log('改了密码：请再运行一次 node tools\\sync_wake_users.js，「Claude 在睡觉」页面才能用新密码叫醒。');

  console.log(`\n✓ 设置完成！运行「重启服务.bat」后就会自动连上公网，以后每次启动都会自动连上。\n  访问地址：https://${hostname}\n`);
  rl.close();
})();
