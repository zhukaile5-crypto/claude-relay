// PreToolUse 钩子：这个网页只是 Claude 的中转，两个账号的 Claude 都只在自己的工作文件夹里读写。
// 用法（写在各账号工作文件夹的 .claude/settings.json 里）：node memory_guard.js guest|owner
// 检查，命中就以退出码 2 拦下（stderr 会回给 Claude）：
//   1. 工具参数里出现禁区（另一个账号的文件夹、本机 Claude Code 会话记录、服务配置、机主的研究资料……，按文字匹配）
//   2. 读写文件的工具（Read/Write/Edit/Glob/Grep…）的目标必须在当前账号的工作文件夹里
const path = require('path');
const profile = process.argv[2] || 'guest';

const COMMON = [
  'users/user/.claude', '~/.claude', '$home/.claude', '$env:userprofile/.claude', '%userprofile%/.claude', 'userprofile/.claude',
  '.claude/projects', '.claude.json', '.claude/settings', 'claude云端传输', 'memory_guard',
  'd:/ebs与smlm', 'd:/eve_data', 'users/user/desktop', 'users/user/documents', 'users/user/downloads',
];
const BLOCKED = {
  guest: [...COMMON, 'claude_for_owner'],
  owner: [...COMMON, 'claude_for_friend', 'projects/d--claude-for-friend', 'data/users/friend'],
}[profile] || COMMON;
// 机主账号可以只读使用的共享部分：访客账号那边的工具箱和技能（目录联接也挂在机主自己的文件夹里），
// 以及机主全局 Claude 配置里的技能和插件（pptx、docx 等技能要运行其中的脚本）
const HOME = require('os').homedir().replace(/\\+/g, '/').toLowerCase();
const SHARED = profile === 'owner' ? [
  'd:/claude_for_friend/.venv', 'd:/claude_for_friend/.tools', 'd:/claude_for_friend/.pylib', 'd:/claude_for_friend/.claude/skills',
  HOME + '/.claude/skills', HOME + '/.claude/plugins',
] : [];
const SHARED_ALIASES = profile === 'owner' ? ['~/.claude/skills', '~/.claude/plugins', '$home/.claude/skills', '$home/.claude/plugins', 'claude_for_friend/.venv', 'claude_for_friend/.tools', 'claude_for_friend/.pylib', 'claude_for_friend/.claude/skills'] : [];
// 读写文件的工具及其路径参数
const PATH_TOOLS = { Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'], NotebookEdit: ['notebook_path'], NotebookRead: ['notebook_path'], Glob: ['path', 'pattern'], Grep: ['path'], LS: ['path'] };
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep', 'LS']);

const deny = (msg) => { process.stderr.write(msg); process.exit(2); };
const norm = (s) => s.replace(/\\+/g, '/').replace(/\/{2,}/g, '/').toLowerCase();

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(raw); } catch { process.exit(0); }
  const input = ev.tool_input || {}, tool = ev.tool_name || '', cwd = ev.cwd || process.cwd();
  const strings = [];
  (function collect(v) {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x);
  })(input);
  let text = norm(strings.join('\n'));
  for (const s of [...SHARED, ...SHARED_ALIASES]) text = text.split(s).join('<shared>');
  if (BLOCKED.some((b) => text.includes(b))) deny('这里只能使用当前账号工作文件夹里的文件，不能访问电脑上的其他位置。需要的文件请让用户作为附件上传。');

  const root = norm(path.resolve(cwd));
  for (const key of PATH_TOOLS[tool] || []) {
    const v = input[key];
    if (!v) continue;
    if (key === 'pattern' && !/^([a-z]:|[\\/]|~)/i.test(v)) continue; // 相对的 glob 模式本来就在工作文件夹里
    const abs = norm(path.resolve(cwd, v.replace(/^~/, HOME).replace(/[*?[{].*$/, '') || '.'));
    const inside = (r) => abs === r || abs.startsWith(r + '/');
    if (!inside(root) && !(READ_TOOLS.has(tool) && SHARED.some(inside))) deny(`只能读写工作文件夹（${path.resolve(cwd)}）里的文件。需要的文件请让用户作为附件上传；要交付的文件放到这次对话的 outputs 文件夹。`);
  }
  process.exit(0);
});
