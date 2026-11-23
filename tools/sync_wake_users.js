// 把账号的加盐密码哈希上传到 Cloudflare 叫醒小程序（睡觉页面用账号密码叫醒时核对用；密码本身不上传）。
// 改了 config.json 里的账号或密码后运行一次：node tools/sync_wake_users.js
// 需要 data/cloudflare_api_token.txt（Cloudflare API 令牌，权限：Workers 脚本编辑）。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const cfgFile = path.join(ROOT, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
if (!cfg.wake.salt) { cfg.wake.salt = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2)); }
const users = {};
for (const u of cfg.users) users[u.id] = crypto.createHash('sha256').update(`${cfg.wake.salt}\n${u.id}\n${u.password}`).digest('hex');
const tmp = path.join(ROOT, 'wake-worker', '.users.json');
fs.writeFileSync(tmp, JSON.stringify({ USERS: JSON.stringify({ salt: cfg.wake.salt, users }) }));
try {
  const token = fs.readFileSync(path.join(ROOT, 'data', 'cloudflare_api_token.txt'), 'utf8').trim();
  const out = execFileSync('npx', ['--yes', 'wrangler@4.20.0', 'secret', 'bulk', '.users.json'], {
    cwd: path.join(ROOT, 'wake-worker'), shell: true, encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: cfg.wake.cfAccountId },
  });
  console.log(out.split('\n').filter((l) => /secret|success/i.test(l)).join('\n'));
  console.log(`已上传 ${Object.keys(users).length} 个账号的密码哈希：${Object.keys(users).join('、')}`);
} finally { fs.rmSync(tmp, { force: true }); }
