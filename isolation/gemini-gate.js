'use strict';

// Antigravity (agy) PreToolUse gate for the relay's Gemini runs.
// agy runs as the trusted service user and ships many built-in tools (terminal,
// browser, messaging, scheduling, subagents). This hook allows only:
//   - call_mcp_tool on the relay MCP server (file and program work happens in
//     the isolated worker behind that server);
//   - read_file of the relay tool schema files agy writes before a tool call;
//   - search_web (search results only, like Claude's WebSearch).
// Everything else is denied. agy treats a failing or malformed hook as a denial.
//
// Arguments are checked against an exact key whitelist. agy is a Go program whose
// JSON decoding matches field names case-insensitively and may know more fields
// than we check (read_file also has AbsolutePath), so an extra key such as `path`
// or `AbsolutePath` next to an allowed `Path` must not slip through.
const fs = require('node:fs');
const path = require('node:path');

const RELAY_SERVER = 'relay_relay';
const META = new Set(['toolSummary', 'toolAction']); // agy's own display fields: plain strings only
const SHAPES = {
  call_mcp_tool: { ServerName: 'string', ToolName: 'string', Arguments: 'object' },
  read_file: { Path: 'string', StartLine: 'number', EndLine: 'number' },
  search_web: { query: 'string' },
};
const REQUIRED = { call_mcp_tool: ['ServerName', 'ToolName'], read_file: ['Path'], search_web: ['query'] };

function argsMatchShape(name, args) {
  const shape = SHAPES[name], seen = new Set();
  for (const [key, value] of Object.entries(args)) {
    const folded = key.toLowerCase();
    if (seen.has(folded)) return false; // two spellings of one field
    seen.add(folded);
    if (META.has(key)) { if (typeof value !== 'string') return false; continue; }
    if (!Object.hasOwn(shape, key)) return false;
    const want = shape[key];
    if (want === 'object' ? !value || typeof value !== 'object' || Array.isArray(value) : typeof value !== want) return false;
  }
  return REQUIRED[name].every(key => Object.hasOwn(args, key));
}

function decide(payload, schemaRoot) {
  const call = payload && typeof payload === 'object' ? payload.toolCall : null;
  const name = call && typeof call.name === 'string' ? call.name : '';
  const args = call && call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : null;
  if (!Object.hasOwn(SHAPES, name) || !args || !argsMatchShape(name, args)) return false;
  if (name === 'call_mcp_tool') return args.ServerName === RELAY_SERVER && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(args.ToolName);
  if (name === 'read_file') {
    if (typeof schemaRoot !== 'string' || !path.isAbsolute(schemaRoot) || !path.isAbsolute(args.Path) || /^[\\/]{2}|[~*?<>|"]/.test(args.Path)) return false;
    const file = path.resolve(args.Path), root = path.resolve(schemaRoot);
    return path.dirname(file).toLowerCase() === root.toLowerCase() && /^[A-Za-z][A-Za-z0-9_]{0,63}\.json$/.test(path.basename(file));
  }
  return true; // search_web with only a query
}

// Decisions only (tool name, allow/deny, time); never arguments or paths.
function audit(file, name, allowed) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return;
  try {
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old'); } catch {}
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), tool: String(name).slice(0, 64), decision: allowed ? 'allow' : 'deny' }) + '\n');
  } catch {}
}

function main() {
  const schemaRoot = process.argv[2], auditFile = process.argv[3];
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 4 * 1024 * 1024) process.exit(2); });
  process.stdin.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(input); } catch {}
    const allowed = decide(payload, schemaRoot);
    audit(auditFile, payload?.toolCall?.name || '', allowed);
    process.stdout.write(JSON.stringify(allowed ? { decision: 'allow' }
      : { decision: 'deny', reason: 'Only the relay tools are available here. Use call_mcp_tool with the relay server.' }));
  });
}

if (require.main === module) main();
module.exports = { decide, RELAY_SERVER };
