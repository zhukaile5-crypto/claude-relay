'use strict';
// No real model/API: a local Responses fixture records the exact advertised
// tools of the installed Codex executable and returns one fixed text answer.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const root = fs.mkdtempSync(path.join(path.resolve(process.argv[2]), 'gpt-tool-gating-'));
const codex = 'C:/Users/user/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe';
const mcp = path.join(root, 'fixture-mcp.cjs');
function fixtureMcp() {
  const rl = require('node:readline').createInterface({ input: process.stdin });
  rl.on('line', line => {
    let q; try { q = JSON.parse(line); } catch { return; }
    if (q.id === undefined) return;
    let result;
    if (q.method === 'initialize') result = { protocolVersion: q.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-fixture', version: '1' } };
    else if (q.method === 'tools/list') result = { tools: [{ name: 'fixture_ping', description: 'Return a fixed synthetic marker; no file, network or process access.', annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
    else if (q.method === 'tools/call') result = { content: [{ type: 'text', text: 'SYNTHETIC_MCP_OK' }] };
    else if (q.method === 'resources/list') result = { resources: [] };
    else if (q.method === 'resources/templates/list') result = { resourceTemplates: [] };
    else result = {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\n');
  });
}
fs.writeFileSync(mcp, '(' + fixtureMcp.toString() + ')();');
const variants = [
  { name: 'shell_and_image_disabled', lines: [] },
  { name: 'strict_third_party_code_mode', lines: ['code_mode_only = true', 'code_mode_only_strict_3p_tools = true', 'code_mode = true'] },
  { name: 'code_mode_exclude_builtin_namespaces', lines: ['code_mode_only = true', 'code_mode_only_strict_3p_tools = true', '[features.code_mode]', 'enabled = true', 'excluded_tool_namespaces = ["functions", "collaboration", "clock"]'] },
  { name: 'strict_policy_native_patch', isolated: true, lines: ['code_mode_only = true', 'code_mode_only_strict_3p_tools = true', '[features.code_mode]', 'enabled = true', 'excluded_tool_namespaces = ["functions", "collaboration", "clock"]'] },
  { name: 'separate_profile_file', profile: true, lines: ['code_mode_only = true', 'code_mode_only_strict_3p_tools = true', '[features.code_mode]', 'enabled = true', 'excluded_tool_namespaces = ["functions", "collaboration", "clock"]'] },
  { name: 'separate_profile_with_base', profile: true, base: true, lines: ['code_mode_only = true', 'code_mode_only_strict_3p_tools = true', '[features.code_mode]', 'enabled = true', 'excluded_tool_namespaces = ["functions", "collaboration", "clock"]'] },
  { name: 'isolated_profile_over_legacy_base', profile: true, base: true, isolated: true, legacy: true, lines: ['code_mode_only = true', 'code_mode_only_strict_3p_tools = true', '[features.code_mode]', 'enabled = true', 'excluded_tool_namespaces = ["functions", "collaboration", "clock"]'] },
];
const summaries = [];
const emit = (res,type,data) => res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
async function run(variant) {
  const dir = path.join(root,variant.name), home = path.join(dir,'home'), cwd = path.join(dir,'trusted');
  for(const p of [home,cwd,path.join(cwd,'temp')])fs.mkdirSync(p,{recursive:true});
  const outside = path.join(dir,'private','canary.txt');
  fs.mkdirSync(path.dirname(outside),{recursive:true}); fs.writeFileSync(outside,'SYNTHETIC_PRIVATE_UNCHANGED\n');
  const patchPath = p=>p.replace(/\\/g,'/');
  const forced = [
    ['functions','shell',{command:['echo','SYNTHETIC_UNEXPECTED']}],
    ['functions','shell_command',{command:'echo SYNTHETIC_UNEXPECTED'}],
    ['functions','write_stdin',{session_id:999999,chars:''}],
    ['collaboration','spawn_agent',{}],
    ['functions','spawn_agent',{}],
    ['functions','process',{}],['functions','browser',{}],['functions','computer_use',{}],['functions','image_generation',{}],
  ];
  let requests = 0, tools = [], bodies = [];
  const server = http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
    if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});return res.end('{"object":"list","data":[]}');}
    try {
      let raw=Buffer.concat(chunks);if(req.headers['content-encoding']==='zstd')raw=zlib.zstdDecompressSync(raw);
      const body=JSON.parse(raw);requests++;bodies.push(body);
      tools.push(...(body.tools||[]),...(body.input||[]).filter(x=>x.type==='additional_tools').flatMap(x=>x.tools||[]));
      let item;
      if (requests === 1) item={id:'tool_introspection',type:'custom_tool_call',call_id:'call_introspection',name:'exec',namespace:'functions',status:'completed',input:'text({names:ALL_TOOLS.map(t=>t.name),types:{apply_patch:typeof tools.apply_patch,exec_command:typeof tools.exec_command,view_image:typeof tools.view_image},globals:{require:typeof require,process:typeof process,fetch:typeof fetch}});'};
      else if (requests === 2) item={id:'tool_mcp',type:'custom_tool_call',call_id:'call_mcp',name:'exec',namespace:'functions',status:'completed',input:'const t=ALL_TOOLS.find(t=>t.name.includes("fixture_ping"));text(t?await tools[t.name]({}):"MCP_MISSING");'};
      else if (requests === 3) item={id:'tool_direct_patch',type:'custom_tool_call',call_id:'call_direct_patch',name:'apply_patch',namespace:'functions',status:'completed',input:'*** Begin Patch\n*** End Patch'};
      else if (requests === 4) item={id:'tool_direct_image',type:'function_call',call_id:'call_direct_image',name:'view_image',namespace:'functions',status:'completed',arguments:JSON.stringify({path:path.join(cwd,'SYNTHETIC_NONEXISTENT_IMAGE.png')})};
      else if (requests === 5) item={id:'tool_direct_shell',type:'function_call',call_id:'call_direct_shell',name:'exec_command',namespace:'functions',status:'completed',arguments:JSON.stringify({cmd:'echo SYNTHETIC_DIRECT_SHELL_UNEXPECTED',yield_time_ms:1000,max_output_tokens:100})};
      else if (variant.isolated && requests < 15) { const [namespace,name,args]=forced[requests-6]; item={id:'tool_direct_'+requests,type:'function_call',call_id:'call_direct_'+namespace+'_'+name,name,namespace,status:'completed',arguments:JSON.stringify(args)}; }
      else if (variant.isolated && requests === 15) item={id:'patch_own',type:'custom_tool_call',call_id:'call_patch_own',name:'apply_patch',namespace:'functions',status:'completed',input:'*** Begin Patch\n*** Add File: '+patchPath(path.join(cwd,'native-own.txt'))+'\n+SYNTHETIC_OWN_OK\n*** End Patch'};
      else if (variant.isolated && requests === 16) item={id:'patch_outside',type:'custom_tool_call',call_id:'call_patch_outside',name:'apply_patch',namespace:'functions',status:'completed',input:'*** Begin Patch\n*** Update File: '+patchPath(outside)+'\n@@\n-SYNTHETIC_PRIVATE_UNCHANGED\n+SYNTHETIC_PRIVATE_UNEXPECTED\n*** End Patch'};
      else if (variant.isolated && requests === 17) item={id:'patch_config',type:'custom_tool_call',call_id:'call_patch_config',name:'apply_patch',namespace:'functions',status:'completed',input:'*** Begin Patch\n*** Update File: '+patchPath(path.join(home,'config.toml'))+'\n@@\n-model_provider = "mock"\n+model_provider = "SYNTHETIC_CONFIG_UNEXPECTED"\n*** End Patch'};
      else if (variant.isolated && requests >= 18 && requests <= 21) { const [namespace,name,args]=[
        ['functions','list_mcp_resources',{}],['functions','list_mcp_resource_templates',{}],
        ['functions','read_mcp_resource',{server:'SYNTHETIC_UNREGISTERED',uri:'synthetic://none'}],['clock','curr_time',{}]
      ][requests-18]; item={id:'tool_aux_'+requests,type:'function_call',call_id:'call_aux_'+name,name,namespace,status:'completed',arguments:JSON.stringify(args)}; }
      else item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'SYNTHETIC_SCHEMA_CAPTURE_COMPLETE',annotations:[]}]};
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
      emit(res,'response.created',{response:{id:'resp_fixture',object:'response',status:'in_progress',output:[]}});
      emit(res,'response.output_item.added',{output_index:0,item:{...item,status:'in_progress'}});
      emit(res,'response.output_item.done',{output_index:0,item});
      emit(res,'response.completed',{response:{id:'resp_fixture',object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0}}}});res.end();
    } catch(e){res.writeHead(500);res.end(JSON.stringify({error:{message:e.message,type:'server_error'}}));}
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const config = [
    'model_provider = "mock"','model = "gpt-6.1-terra"','approval_policy = "never"',...(variant.isolated?['default_permissions = "isolated"']:['sandbox_mode = "read-only"']),'web_search = "disabled"','allow_login_shell = false',
    ...(variant.isolated?['[windows]','sandbox = "mxc"','[permissions.isolated.filesystem]','":root" = "deny"','":minimal" = "read"',JSON.stringify(patchPath(cwd))+' = "write"','[permissions.isolated.network]','enabled = false']:[]),
    '[analytics]','enabled = false','[feedback]','enabled = false','[agents]','enabled = false',
    '[features]','shell_tool = false','view_image = false','apps = false','plugins = false','hooks = false','multi_agent = false','multi_agent_v2 = false','shell_snapshot = false','memories = false','workspace_dependencies = false','computer_use = false','browser_use = false','image_generation = false','goals = false','sleep_tool = false','remote_plugin = false','skill_mcp_dependency_install = false','skip_host_skill_discovery = true', ...variant.lines,
    '[model_providers.mock]','name = "Synthetic local fixture"','base_url = "http://127.0.0.1:'+server.address().port+'/v1"','wire_api = "responses"','env_key = "SYNTHETIC_PROVIDER_TOKEN"','requires_openai_auth = false','request_max_retries = 0','stream_max_retries = 0',
    '[mcp_servers.fixture]','command = '+JSON.stringify(process.execPath),'args = ['+JSON.stringify(mcp)+']','enabled_tools = ["fixture_ping"]','startup_timeout_sec = 10','required = true','[mcp_servers.fixture.tools.fixture_ping]','approval_mode = "approve"',
  ].join('\n');
  fs.writeFileSync(path.join(home,'config.toml'),config);
  if (variant.profile) { fs.renameSync(path.join(home,'config.toml'),path.join(home,'synthetic.config.toml')); if(variant.base)fs.writeFileSync(path.join(home,'config.toml'),variant.legacy?'approval_policy="never"\nsandbox_mode="workspace-write"\nmodel_reasoning_summary="detailed"\n[windows]\nsandbox="unelevated"\n[sandbox_workspace_write]\nnetwork_access=true\n':''); }
  const env = {SystemRoot:process.env.SystemRoot,SystemDrive:process.env.SystemDrive,COMSPEC:process.env.COMSPEC,PATH:process.env.PATH,LOCALAPPDATA:process.env.LOCALAPPDATA,USERPROFILE:cwd,APPDATA:cwd,TEMP:path.join(cwd,'temp'),TMP:path.join(cwd,'temp'),CODEX_HOME:home,SYNTHETIC_PROVIDER_TOKEN:'SYNTHETIC_NOT_A_REAL_KEY',NO_PROXY:'127.0.0.1,localhost'};
  const child=spawn(codex,['exec','--json','--strict-config','--ignore-rules','--skip-git-repo-check',...(variant.profile?[...(variant.base?[]:['--ignore-user-config']),'-p','synthetic']:[]),'-C',cwd,'-'],{cwd,env,windowsHide:true});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill(),40000);child.stdin.end('Synthetic local tool-schema capture; reply with the supplied fixed message.');
  const exitCode=await new Promise(r=>child.on('close',r));clearTimeout(timer);server.closeAllConnections();await new Promise(r=>server.close(r));
  fs.writeFileSync(path.join(dir,'tool-schemas.json'),JSON.stringify(tools,null,2));fs.writeFileSync(path.join(dir,'request-bodies.json'),JSON.stringify(bodies,null,2));fs.writeFileSync(path.join(dir,'stderr.txt'),stderr);fs.writeFileSync(path.join(dir,'stdout.jsonl'),stdout);
  const flat=tools.flatMap(t=>t.type==='namespace'?(t.tools||[]).map(x=>({namespace:t.name,...x})):[t]);
  const outputs=[...new Map(bodies.flatMap(b=>(b.input||[]).filter(i=>/call_output/.test(i.type||''))).map(i=>[i.call_id,i])).values()];
  const result={name:variant.name,exitCode,requests,tools:[...new Map(flat.map(t=>({namespace:t.namespace,type:t.type,name:t.name})).map(t=>[JSON.stringify(t),t])).values()],outputs,stderr:stderr.slice(-3000),dir,files:{own:fs.existsSync(path.join(cwd,'native-own.txt'))?fs.readFileSync(path.join(cwd,'native-own.txt'),'utf8'):null,outsideUnchanged:fs.readFileSync(outside,'utf8')==='SYNTHETIC_PRIVATE_UNCHANGED\n',configUnchanged:fs.readFileSync(path.join(home,variant.profile?'synthetic.config.toml':'config.toml'),'utf8')===config}};
  if (variant.isolated) {
    const out=id=>JSON.stringify(outputs.find(o=>o.call_id===id)?.output);
    result.checks={completed:exitCode===0&&requests===22,mcp:out('call_mcp').includes('SYNTHETIC_MCP_OK'),own:result.files.own==='SYNTHETIC_OWN_OK\n',outsideDenied:result.files.outsideUnchanged&&out('call_patch_outside').includes('os error 5'),configDenied:result.files.configUnchanged&&out('call_patch_config').includes('os error 5'),disabledDirectCalls:['call_direct_image','call_direct_shell',...forced.map(([n,t])=>'call_direct_'+n+'_'+t)].every(id=>out(id)?.includes('unsupported call:'))};
    if (!Object.values(result.checks).every(Boolean)) process.exitCode=1;
  }
  summaries.push(result);console.log(JSON.stringify(result));
}
(async()=>{for(const v of variants.filter(v=>!process.argv[3]||v.name===process.argv[3]))await run(v);const result=path.join(root,'summary.json');fs.writeFileSync(result,JSON.stringify(summaries,null,2));console.log(JSON.stringify({result}));})().catch(e=>{console.error(e);process.exitCode=1});
