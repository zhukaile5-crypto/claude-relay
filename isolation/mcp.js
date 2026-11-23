'use strict';

// This process is a trusted, typed broker. Program text is sent to the executor;
// it is never evaluated in this process or in the authenticated model process.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { executeNode, executeNodeSync, closeAll } = require('./executor');
const { createWorkspaceIO } = require('./workspace-io');
const { fetchPublic } = require('./public-network');
const { createResearchBroker } = require('./research');
const { createVoiceService } = require('./voice');

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' }, num = { type: 'integer' };
const tools = [
  ['Read', 'Read a workspace text file, image, or PDF. Paths belong to this account.', object({ file_path: str, offset: num, limit: num }, ['file_path'])],
  ['Write', 'Write a UTF-8 file in this workspace.', object({ file_path: str, content: str }, ['file_path', 'content'])],
  ['Edit', 'Replace an exact string in a workspace file.', object({ file_path: str, old_string: str, new_string: str, replace_all: { type: 'boolean' } }, ['file_path', 'old_string', 'new_string'])],
  ['Glob', 'Find workspace files using a glob pattern.', object({ pattern: str, path: str }, ['pattern'])],
  ['Grep', 'Search workspace text files using a regular expression.', object({ pattern: str, path: str, glob: str }, ['pattern'])],
  ['PowerShell', 'Run Windows PowerShell inside the account execution boundary. No network or desktop access. Use WebFetch for public downloads. timeout is in milliseconds (default 120000, minimum 1000, maximum 1800000).', object({ command: str, description: str, timeout: num }, ['command'])],
  ['WebFetch', 'Fetch a public HTTPS URL. Optionally save its bytes to a workspace path. Private/local networks are unavailable.', object({ url: str, prompt: str, save_path: str }, ['url'])],
  ['TaskCreate', 'Create an item in the live checklist.', object({ subject: str, description: str, activeForm: str }, ['subject'])],
  ['TaskUpdate', 'Update a live checklist item.', object({ taskId: str, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] }, subject: str, description: str, activeForm: str }, ['taskId'])],
  ['TaskList', 'List the live checklist.', object({})],
  ['TaskGet', 'Read a live checklist item.', object({ taskId: str }, ['taskId'])],
  ['Skill', 'Read a protected local skill guide. Available names are in the runtime notes.', object({ skill: str, args: str }, ['skill'])],
  ['SearchPapers', 'Search public scholarly papers. A source label identifies fallback results.', object({ query: str, limit: num }, ['query'])],
  ['VerifyReference', 'Look up or verify a scholarly reference.', object({ operation: { type: 'string', enum: ['lookup_reference', 'verify_reference', 'verify_bibtex', 'citation_neighbours'] }, arguments: { type: 'object' } }, ['operation', 'arguments'])],
  ['SynthesizeSpeech', 'Generate an MP3 narration file from literal text. No sound is played. Use the saved file as slide.audio for video creation.', object({ text: str, voice: str, rate: str, save_path: str }, ['text', 'save_path'])],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

function relative(context, name) {
  if (typeof name !== 'string' || name.length > 4096 || name.includes('\0')) throw Error('Invalid workspace path');
  let result = path.isAbsolute(name) ? path.relative(context.workspaceRoot, name) : name;
  if (path.isAbsolute(name) && context.executionRoot) {
    const viaView = path.relative(context.executionRoot, name);
    if (!path.isAbsolute(viaView) && !viaView.split(/[\\/]/).includes('..')) result = viaView;
  }
  if (path.isAbsolute(result) || result.split(/[\\/]/).includes('..') || result.includes(':')) throw Error('Path is outside this account');
  return result || '.';
}
// 这个运行环境里 PowerShell 的路径命令在工作区上会报拒绝访问，有时操作其实成功了。
// 原始 stderr 和退出码原样保留，只附加说明，让模型先核对结果再下结论。
const SHELL_ACCESS_NOTE = 'PowerShell path cmdlets report Access is denied in this runtime even when the path is fine, and some commands succeed despite it. This message alone does not prove failure: check the real result with Read or Glob before reporting. Use Read/Write/Edit/Glob/Grep tools, or [IO.File] / [IO.Directory] inside PowerShell.';
function shellResult(output, timeout) {
  let value; try { value = JSON.parse(output); } catch { return output; }
  if (value && /Access is denied|UnauthorizedAccess|拒绝访问/i.test(String(value.stderr || ''))) value.note = SHELL_ACCESS_NOTE;
  if (value && timeout && /ETIMEDOUT/.test(String(value.error || ''))) value.note = 'Stopped after ' + timeout + ' ms. The timeout parameter is in milliseconds; raise it if the command needs longer.';
  return value;
}
function text(value, isError = false) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }; }
function validate(name, args) {
  const schema = tools.find(t => t.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid tool request');
  for (const key of Object.keys(args)) {
    const field = schema.properties[key];
    if (!field || (field.type === 'integer' ? !Number.isSafeInteger(args[key]) : typeof args[key] !== field.type)) throw Error('Invalid tool field: ' + key);
    if (field.enum && !field.enum.includes(args[key])) throw Error('Invalid tool field: ' + key);
    if (typeof args[key] === 'string' && (args[key].length > 1000000 || args[key].includes('\0'))) throw Error('Tool field too large');
  }
  for (const key of schema.required) if (!(key in args)) throw Error('Missing tool field: ' + key);
}

const PROGRAM = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.cwd();
function target(p){const x=path.resolve(root,p),r=path.relative(root,x);if(path.isAbsolute(r)||r.split(/[\\/]/).includes('..'))throw Error('Outside workspace');return x;}
if(input.type==='shell'){
 const r=cp.spawnSync(input.exe,input.args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:input.timeout,maxBuffer:6*1024*1024});
 process.stdout.write(JSON.stringify({exitCode:r.status,stdout:r.stdout||'',stderr:r.stderr||'',error:r.error?.message}));
}else if(input.type==='edit'){
 const file=target(input.file),before=fs.readFileSync(file,'utf8');
 if(!input.old)throw Error('old_string must not be empty');
 const parts=before.split(input.old);if(parts.length===1)throw Error('String not found');if(!input.all&&parts.length!==2)throw Error('String is not unique');
 const after=input.all?parts.join(input.new):before.replace(input.old,()=>input.new);fs.writeFileSync(file,after);process.stdout.write('Updated '+input.file);
}else if(input.type==='pdf'){
 const r=cp.spawnSync(input.python,['-X','utf8','-I','-S','-c','import pymupdf,sys; d=pymupdf.open(sys.argv[1]); print("\\n".join(p.get_text() for p in d)[:180000])',target(input.file)],{windowsHide:true,encoding:'utf8',timeout:45000,maxBuffer:1500000});if(r.status!==0)throw Error(r.stderr||'PDF read failed');process.stdout.write(r.stdout);
}else{
 const base=target(input.base),out=[],seen=new Set();
 function glob(p){return new RegExp('^'+p.replace(/[.+^$()|{}\[\]\\]/g,'\\$&').replace(/\*\*/g,'\u0001').replace(/\*/g,'[^/]*').replace(/\?/g,'.').replace(/\u0001/g,'.*')+'$','i');}
 const filter=input.glob?glob(input.glob):null,expression=input.type==='grep'?new RegExp(input.pattern,'i'):glob(input.pattern);
 let count=0;function walk(dir,depth){if(depth>20||out.length>=500||count>20000)return;let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
 for(const e of entries){if(++count>20000)break;const f=path.join(dir,e.name),rel=path.relative(base,f).replace(/\\/g,'/');if(e.isSymbolicLink())continue;if(e.isDirectory()){if(!['.git','node_modules','.venv','.tools'].includes(e.name))walk(f,depth+1);continue;}if(!e.isFile())continue;
 if(input.type==='glob'){if(expression.test(rel)||expression.test(e.name))out.push(path.relative(root,f));}
 else if(!filter||filter.test(rel)||filter.test(e.name)){try{if(fs.statSync(f).size>2000000)continue;const content=fs.readFileSync(f,'utf8');if(content.includes('\0'))continue;content.split(/\r?\n/).forEach((line,i)=>{if(out.length<500&&expression.test(line))out.push({path:path.relative(root,f),line:i+1,text:line.slice(0,2000)});});}catch{}}
 }}walk(base,0);process.stdout.write(JSON.stringify({matches:out,truncated:out.length>=500||count>20000}));
}`;

function createBroker(context, { researchConfig } = {}) {
  const io = createWorkspaceIO({ executeNode, executeNodeSync });
  const research = researchConfig ? createResearchBroker(researchConfig) : null;
  let voice;
  const tasks = new Map(); let nextTask = 1;
  async function program(input, signal, timeoutMs = 60000) {
    const r = await executeNode(context, PROGRAM, { input, signal, timeoutMs, maxOutputBytes: 8 * 1024 * 1024 });
    if (r.exitCode !== 0 || r.cancelled) throw Error(r.error || r.stderr || 'Execution failed');
    return r.stdout.toString('utf8');
  }
  return { tools, async call(name, args, signal) {
    if (name === 'Bash') throw Error('Git Bash is unavailable in this Windows isolation runtime. Use PowerShell with Windows syntax; Bash command text is never automatically converted or run on the host.');
    validate(name, args);
    if (name === 'Read') {
      const file = relative(context, args.file_path), ext = path.extname(file).toLowerCase();
      if (['.png','.jpg','.jpeg','.gif','.webp'].includes(ext)) {
        const bytes = await io.readBytes(context, file, { limitBytes: 20 * 1024 * 1024, signal });
        return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/' + (['.jpg','.jpeg'].includes(ext) ? 'jpeg' : ext.slice(1)) }] };
      }
      if (ext === '.pdf') return text(await program({ type: 'pdf', file, python: context.runtime.python }, signal));
      const value = (await io.readBytes(context, file, { limitBytes: 4 * 1024 * 1024, signal })).toString('utf8');
      const offset = Math.max(1, args.offset || 1), limit = Math.min(5000, Math.max(1, args.limit || 2000));
      return text(value.split(/\r?\n/).slice(offset - 1, offset - 1 + limit).map((s,i) => `${offset+i}: ${s}`).join('\n'));
    }
    if (name === 'Write') { const file = relative(context, args.file_path); const rows = await io.batch(context, [{ type: 'writeText', path: file, text: args.content, parents: true }]); if (!rows[0].ok) throw Error(rows[0].error.message); return text('Wrote ' + file); }
    if (name === 'Edit') return text(await program({ type: 'edit', file: relative(context, args.file_path), old: args.old_string, new: args.new_string, all: !!args.replace_all }, signal));
    if (name === 'Glob' || name === 'Grep') return text(await program({ type: name.toLowerCase(), base: relative(context, args.path || '.'), pattern: args.pattern, glob: args.glob }, signal));
    if (name === 'PowerShell') {
      const timeout = Math.min(1800000, Math.max(1000, args.timeout || 120000));
      const exe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      return text(shellResult(await program({ type: 'shell', exe, args: ['-NoProfile','-NonInteractive','-Command',"$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n"+args.command], timeout }, signal, timeout + 10000), timeout));
    }
    if (name === 'WebFetch') {
      const result = await fetchPublic(args.url, { signal, maxBytes: args.save_path ? 20 * 1024 * 1024 : 2 * 1024 * 1024 });
      if (args.save_path) { const file = relative(context, args.save_path); const written = await io.writeFromStream(context, file, Readable.from([result.bytes]), { parents: true, signal }); return text({ url: result.url, status: result.status, saved: file, bytes: result.bytes.length, written }); }
      return text({ url: result.url, status: result.status, content: result.bytes.toString('utf8').slice(0, 120000) });
    }
    if (name === 'SynthesizeSpeech') {
      const file = relative(context, args.save_path);
      if (path.extname(file).toLowerCase() !== '.mp3') throw Error('Speech output must use the .mp3 extension');
      voice ||= createVoiceService({ executeNode, desktopHost: context.desktopHost, privateRoot: path.join(context.controlRoot, 'speech'), offlineProfile: context.runtime.ttsOfflineProfile });
      const generated = await voice.synthesize(context, { text: args.text, ...(args.voice === undefined ? {} : { voice: args.voice }), ...(args.rate === undefined ? {} : { rate: args.rate }) }, { signal });
      const written = await io.writeFromStream(context, file, Readable.from([generated.audio]), { parents: true, signal });
      return text({ saved: file, source: generated.source, format: generated.format, bytes: generated.audio.length, onlineUnavailable: !!generated.onlineUnavailable, written });
    }
    if (name === 'TaskCreate') { if (tasks.size >= 100) throw Error('Checklist limit reached'); const id = String(nextTask++); tasks.set(id, { ...args, id, status: 'pending' }); return text(`Task #${id} created: ${args.subject}`); }
    if (name === 'TaskUpdate') { const task = tasks.get(args.taskId); if (!task) throw Error('Unknown task'); if (args.status === 'deleted') tasks.delete(args.taskId); else Object.assign(task, args); return text(`Task #${args.taskId} updated`); }
    if (name === 'TaskList') return text([...tasks.values()]);
    if (name === 'TaskGet') { if (!tasks.has(args.taskId)) throw Error('Unknown task'); return text(tasks.get(args.taskId)); }
    if (name === 'Skill') { const guide = context.runtime.skills?.[args.skill.replace(/^.*:/, '')]; if (!guide) throw Error('Unknown skill. Available: ' + Object.keys(context.runtime.skills || {}).join(', ')); return text(fs.readFileSync(guide, 'utf8').slice(0, 150000)); }
    if (name === 'SearchPapers') { if (!research) throw Error('Research is disabled'); return research.callTool('search_works', args, { signal }); }
    if (name === 'VerifyReference') { if (!research) throw Error('Research is disabled'); return research.callTool(args.operation, args.arguments, { signal }); }
    throw Error('Unknown tool');
  } };
}

async function main(file) {
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const broker = createBroker(settings.context, settings);
  const requests = new Map(); let closing = false;
  const send = value => { if (!closing) process.stdout.write(JSON.stringify(value) + '\n'); };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', async line => {
    let message; try { if (line.length > 2500000) throw Error('Request too large'); message = JSON.parse(line); } catch { return; }
    if (message.method === 'notifications/cancelled') { requests.get(message.params?.requestId)?.abort(); return; }
    if (message.id === undefined) return;
    const controller = new AbortController(); requests.set(message.id, controller);
    try {
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'claude-relay-isolation', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: broker.tools };
      else if (message.method === 'tools/call') { try { result = await broker.call(message.params.name, message.params.arguments || {}, controller.signal); } catch (error) { result = text(error.message, true); } }
      else if (message.method === 'ping') result = {};
      else if (['resources/list','resources/templates/list','prompts/list'].includes(message.method)) result = { [message.method.split('/')[0] === 'prompts' ? 'prompts' : message.method.includes('templates') ? 'resourceTemplates' : 'resources']: [] };
      else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Broker request failed' } }); }
    finally { requests.delete(message.id); }
  });
  async function stop() { if (closing) return; closing = true; lines.close(); for (const c of requests.values()) c.abort(); await closeAll(); }
  process.stdin.on('end', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}
if (require.main === module) main(process.argv[2]).catch(() => { process.stderr.write('Relay broker initialization failed\n'); process.exitCode = 1; });
module.exports = { tools, relative, validate, createBroker, shellResult };
