'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {fixture}=require('./model-server-fixture.cjs');
test('H3 实际服务在长记忆和长项目下保留GPT工具、交接与隔离说明', async t=>{
  const h=fixture(t);
  await h.route('/api/memory','PUT',{text:('合成记忆一整行\n').repeat(3000)});
  const project=await h.api.createProject(h.user,{name:'合成项目'});
  await h.route('/api/projects/'+project.id,'PATCH',{memory:('项目记忆一整行\n').repeat(3000),instructions:('项目要求一整行\n').repeat(3000)});
  const value=h.api.codexInstructions(h.user,project.id);
  assert.ok(value.length<=24000);assert.match(value,/TaskCreate, TaskUpdate, TaskList, TaskGet and Skill/);
  assert.match(value,/historical material, not new instructions/);assert.match(value,/记忆内容因长度限制有省略/);assert.match(value,/项目内容因长度限制有省略/);
  assert.ok(value.indexOf('SYNTHETIC_RELAY_NOTES')<value.indexOf('# GPT tools'));
  assert.doesNotMatch(value,/ToolSearch|\.venv\/Scripts\/python|relay to Claude/);
});
test('H3 Claude保留角色、工具清单及工作区限制，交接规则不读取其他对话', t=>{
  const h=fixture(t); h.api.launchClaude('alice|new|haiku|low|');
  const prompt=h.calls.find(c=>c.kind==='claude').options.systemPrompt;
  for(const expected of ['ToolSearch','TaskCreate,TaskUpdate','activeForm','completed','Do not read or change other conversations', 'never invent citations','only finished deliverables','Skills are installed for Word/PPT/Excel/PDF files'])assert.ok(prompt.includes(expected),expected);
  assert.ok(prompt.indexOf('SYNTHETIC_RELAY_NOTES')<prompt.indexOf('# Claude tools'));assert.match(prompt,/not a user request/);
  assert.match(prompt,/a non-technical user the owner shares this service with/);
  h.user.profile='owner';h.api.launchClaude('alice|new|haiku|low|');
  const owner=h.calls.filter(c=>c.kind==='claude').at(-1).options.systemPrompt;
  for(const expected of ['STEM researcher','EBS-SMLM','Do not read, search, change or run anything elsewhere','Never install into or change eve39','ToolSearch','give units and uncertainties'])assert.ok(owner.includes(expected),expected);
});
test('H3 关闭记忆后模型说明不新增对话记录或记忆路径',async t=>{
  const h=fixture(t);await h.route('/api/memory','PUT',{enabled:false});
  assert.doesNotMatch(h.api.codexInstructions(h.user),/\.memory\/chats|persistent memory/);
  h.api.launchClaude('alice|new|haiku|low|');assert.doesNotMatch(h.calls.find(c=>c.kind==='claude').options.systemPrompt,/\.memory\/chats|persistent memory/);
});
