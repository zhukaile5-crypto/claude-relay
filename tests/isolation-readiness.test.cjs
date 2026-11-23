'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const gate=require('../tools/check-isolation.cjs');
const {check,REQUIRED,RECEIPT_SCHEMA,requiredFingerprintFiles,configurationProjection,configurationFingerprint,hashFile}=gate;
function syntheticCodex(directory) {
 fs.mkdirSync(path.join(directory,'bin'),{recursive:true});
 const exe=path.join(directory,'bin','codex.exe');fs.writeFileSync(exe,'SYNTHETIC_CODEX');
 fs.writeFileSync(path.join(directory,'codex-package.json'),JSON.stringify({layoutVersion:1,variant:'codex',version:'1.2.3',target:'x86_64-pc-windows-msvc',entrypoint:'bin/codex.exe'}));
 return exe;
}
function fixture(t) {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'relay-readiness-'));
 t.after(()=>{const real=fs.realpathSync.native(temp);assert.equal(path.dirname(real).toLowerCase(),fs.realpathSync.native(os.tmpdir()).toLowerCase());assert.ok(path.basename(real).startsWith('relay-readiness-'));fs.rmSync(real,{recursive:true,force:true});});
 const bin=path.join(temp,'bin'),tools=path.join(temp,'tools'),skill=path.join(temp,'skill'),work=path.join(temp,'work');
 for(const dir of [bin,tools,skill,work])fs.mkdirSync(dir);
 const component=path.join(bin,'synthetic.exe'),pth=path.join(bin,'python314._pth'),dll=path.join(bin,'python314.dll'),engineDll=path.join(bin,'xetex.dll'),script=path.join(tools,'entry.py'),skillDoc=path.join(skill,'SKILL.md'),skillScript=path.join(skill,'helper.py');
 for(const [file,value] of [[component,'SYNTHETIC_COMPONENT'],[pth,'.\nLib'],[dll,'SYNTHETIC_DLL'],[engineDll,'SYNTHETIC_ENGINE_DLL'],[script,'print(42)\n'],[skillDoc,'Synthetic guide'],[skillScript,'print(7)\n']])fs.writeFileSync(file,value);
 const runtime={...Object.fromEntries(['desktopHost','nodePath','codexPath','claudePath','python','gpuPython','evePython','ffmpeg','ffprobe','gitBash','libreOffice','pandoc'].map(k=>[k,component])),whisperModel:bin,xlsxScript:script,tools:{entry:script},skills:{fixture:skillDoc},pathDirs:[bin]};
 runtime.codexPath=syntheticCodex(path.join(temp,'codex'));
 const manifest=path.join(temp,'manifest.json');fs.writeFileSync(manifest,JSON.stringify(runtime));
 const receiptPath=path.join(temp,'receipt.json'),config={users:[{id:'synthetic',workDir:work,password:'SYNTHETIC_PASSWORD_SECRET'}],secret:'SYNTHETIC_SIGNING_SECRET',openaiApiKey:'SYNTHETIC_API_SECRET',isolation:{enabled:false,runtimeManifest:manifest,receipt:receiptPath,privateRoot:path.join(temp,'private'),gptHome:path.join(temp,'gpt')}};
 const receipt={schema:RECEIPT_SCHEMA,completedAt:new Date().toISOString(),configurationFingerprint:configurationFingerprint(config,runtime),checks:Object.fromEntries(REQUIRED.map(k=>[k,{passed:true}])),fingerprints:requiredFingerprintFiles(config,runtime).map(file=>({path:file,sha256:hashFile(file)}))};
 const save=()=>fs.writeFileSync(receiptPath,JSON.stringify(receipt));save();
 return {temp,bin,work,component,pth,dll,engineDll,script,skillScript,manifest,runtime,config,receipt,receiptPath,save};
}
test('readiness stays false without completed acceptance and reports actual enabled state',()=>{
 const report=check({openaiApiKey:'SYNTHETIC',isolation:{enabled:true}},path.join(os.tmpdir(),'synthetic-absent-'+crypto.randomUUID()+'.json'));
 assert.equal(report.isolationEnabled,true);assert.equal(report.readyToEnableIsolation,false);assert.ok(report.remainingRequirements.length);
});
test('complete receipt binds every source and direct runtime entry without including secrets',t=>{
 const f=fixture(t),files=requiredFingerprintFiles(f.config,f.runtime);
 assert.equal(check(f.config).readyToEnableIsolation,true);
 for(const file of ['isolation/executor-sync.js','url-capability.js','workspace-path.js','upload-stream.js','bounded-jobs.js','tools/check-isolation.cjs'])assert.ok(files.includes(fs.realpathSync.native(path.resolve(__dirname,'..',file))),file);
 for(const file of [f.pth,f.dll,f.engineDll,f.script,f.skillScript,process.execPath])assert.ok(files.some(p=>p.toLowerCase()===fs.realpathSync.native(file).toLowerCase()),file);
 const serialized=JSON.stringify(configurationProjection(f.config,f.runtime))+JSON.stringify(f.receipt);
 for(const secret of ['SYNTHETIC_API_SECRET','SYNTHETIC_PASSWORD_SECRET','SYNTHETIC_SIGNING_SECRET'])assert.ok(!serialized.includes(secret));
 const changedSecrets={...f.config,openaiApiKey:'REPLACEMENT_SYNTHETIC_SECRET',secret:'OTHER_SECRET'};
 assert.equal(configurationFingerprint(changedSecrets,f.runtime),configurationFingerprint(f.config,f.runtime));
});
test('missing direct entry coverage, altered scripts and new interpreter path files fail closed',t=>{
 const f=fixture(t),full=f.receipt.fingerprints;
 for(const file of [path.resolve(__dirname,'../isolation/executor-sync.js'),f.component,f.pth,f.engineDll,f.skillScript]){
  f.receipt.fingerprints=full.filter(i=>i.path.toLowerCase()!==fs.realpathSync.native(file).toLowerCase());f.save();
  assert.equal(check(f.config).readyToEnableIsolation,false,path.basename(file));
 }
 f.receipt.fingerprints=full;f.save();fs.appendFileSync(f.script,'# changed');
 assert.ok(check(f.config).remainingRequirements.some(r=>r.includes('验收后文件已变化')));
 fs.writeFileSync(f.script,'print(42)\n');const added=path.join(f.bin,'python._pth');fs.writeFileSync(added,'unexpected');
 assert.ok(check(f.config).remainingRequirements.some(r=>r.includes('版本指纹未覆盖')));
});
test('every acceptance gate, receipt version and configuration binding are required',t=>{
 const f=fixture(t);
 f.receipt.checks.parentDeath.passed=false;f.save();assert.equal(check(f.config).readyToEnableIsolation,false);
 f.receipt.checks.parentDeath.passed=true;f.receipt.schema=1;f.save();assert.equal(check(f.config).readyToEnableIsolation,false);
 f.receipt.schema=RECEIPT_SCHEMA;delete f.receipt.configurationFingerprint;f.save();assert.equal(check(f.config).readyToEnableIsolation,false);
});

test('added bibliography and compiler code roots bind nested scripts and DLLs',t=>{
 const f=fixture(t),codeRoot=path.join(f.temp,'owned-code'),nested=path.join(codeRoot,'modules');
 fs.mkdirSync(nested,{recursive:true});const script=path.join(nested,'processor.py'),dll=path.join(nested,'engine.dll');
 fs.writeFileSync(script,'print(42)\n');fs.writeFileSync(dll,'SYNTHETIC_ENGINE');
 f.runtime.codeRoots=[codeRoot];fs.writeFileSync(f.manifest,JSON.stringify(f.runtime));
 f.receipt.fingerprints=requiredFingerprintFiles(f.config,f.runtime).map(file=>({path:file,sha256:hashFile(file)}));f.save();
 assert.equal(check(f.config).readyToEnableIsolation,true);
 const full=f.receipt.fingerprints;f.receipt.fingerprints=full.filter(item=>item.path!==fs.realpathSync.native(dll));f.save();
 assert.equal(check(f.config).readyToEnableIsolation,false);
 f.receipt.fingerprints=full;f.save();fs.appendFileSync(script,'# changed');
 assert.equal(check(f.config).readyToEnableIsolation,false);
});
test('account paths, ids and private homes cannot change under an existing receipt',t=>{
 const f=fixture(t),second=path.join(f.temp,'second');fs.mkdirSync(second);
 const variations=[
  {...f.config,users:[{id:'changed',workDir:f.work}]},
  {...f.config,users:[{id:'synthetic',workDir:second}]},
  {...f.config,isolation:{...f.config.isolation,privateRoot:path.join(f.temp,'other-private')}},
  {...f.config,isolation:{...f.config.isolation,gptHome:path.join(f.temp,'other-gpt')}},
 ];
 for(const config of variations)assert.ok(check(config).remainingRequirements.includes('账号或执行路径与验收配置不一致。'));
 const reordered={...f.config,users:[...f.config.users].reverse()};
 assert.equal(configurationFingerprint(reordered,f.runtime),configurationFingerprint(f.config,f.runtime));
});
test('absolute executable overrides must be bound and fingerprinted',t=>{
 const f=fixture(t),override=syntheticCodex(path.join(f.temp,'override-codex'));
 const config={...f.config,claudePath:override,codexPath:override};
 assert.equal(check(config).readyToEnableIsolation,false);
 f.receipt.configurationFingerprint=configurationFingerprint(config,f.runtime);f.save();
 assert.ok(check(config).remainingRequirements.some(r=>r.includes('版本指纹未覆盖')));
 for(const file of require('../tools/codex-fingerprints.cjs').enumerateCodexFilesSync(override))f.receipt.fingerprints.push({path:file,sha256:hashFile(file)});
 f.save();assert.equal(check(config).readyToEnableIsolation,true);
});
test('academic research binds the switch and trusted service root config without retaining its contents',t=>{
 const f=fixture(t),research=path.join(f.temp,'mcp-servers.json'),config={...f.config,academicSearch:true};
 for(const relative of gate.SOURCE_FILES){const file=path.join(f.temp,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'SYNTHETIC_SERVICE_SOURCE:'+relative);}
 fs.writeFileSync(research,JSON.stringify({synthetic:'SYNTHETIC_RESEARCH_SECRET'}));
 assert.notEqual(configurationFingerprint(config,f.runtime,f.temp),configurationFingerprint(f.config,f.runtime,f.temp));
 f.receipt.configurationFingerprint=configurationFingerprint(config,f.runtime,f.temp);
 f.receipt.fingerprints=requiredFingerprintFiles(config,f.runtime,f.temp).map(file=>({path:file,sha256:hashFile(file)}));f.save();
 assert.equal(check(config,undefined,f.temp).readyToEnableIsolation,true);
 assert.equal(configurationProjection(config,f.runtime,f.temp).researchConfig,fs.realpathSync.native(research).replace(/\\/g,'/').toLowerCase());
 assert.ok(!(JSON.stringify(configurationProjection(config,f.runtime,f.temp))+JSON.stringify(f.receipt)).includes('SYNTHETIC_RESEARCH_SECRET'));
 assert.equal(check(config).readyToEnableIsolation,false);
 assert.equal(check({...config,academicSearch:false},undefined,f.temp).readyToEnableIsolation,false);
 const full=f.receipt.fingerprints;f.receipt.fingerprints=full.filter(item=>item.path!==fs.realpathSync.native(research));f.save();
 assert.ok(check(config,undefined,f.temp).remainingRequirements.some(reason=>reason.includes('版本指纹未覆盖')));
 f.receipt.fingerprints=full;f.save();fs.appendFileSync(research,' ');
 assert.ok(check(config,undefined,f.temp).remainingRequirements.some(reason=>reason.includes('验收后文件已变化')));
});
test('redirected or non-directory workspace roots and malformed fingerprints fail closed',t=>{
 const f=fixture(t),link=path.join(f.temp,'link');fs.symlinkSync(f.work,link,'junction');
 const linked={...f.config,users:[{id:'synthetic',workDir:link}]};assert.equal(check(linked).readyToEnableIsolation,false);
 const fileRoot={...f.config,users:[{id:'synthetic',workDir:f.component}]};assert.equal(check(fileRoot).readyToEnableIsolation,false);
 f.receipt.fingerprints.push(null);f.save();assert.equal(check(f.config).readyToEnableIsolation,false);
});
test('production startup checks readiness before constructing isolation, with no disabled-path dependency',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8'),start=source.indexOf('// Activation is explicit;'),end=source.indexOf('\nfunction workOperation',start);
 assert.ok(start>=0&&end>start);
 function run(enabled,ready){const calls=[],context={console:{log(){}},config:{isolation:{enabled}},ROOT:'synthetic-root',__dirname:'synthetic-code-root',require(name){calls.push(name);if(name==='./tools/check-isolation.cjs')return {check:(config,receipt,serviceRoot,sourceRoot)=>{assert.equal(receipt,undefined);assert.equal(serviceRoot,'synthetic-root');assert.equal(sourceRoot,'synthetic-code-root');return {readyToEnableIsolation:ready,remainingRequirements:['SYNTHETIC_BLOCK']};}};if(name==='./isolation')return {createIsolation:()=>({ok:true})};throw Error('Unexpected dependency');}};let error;let blocked;try{vm.runInContext(source.slice(start,end)+';globalThis.__blocked=isolationBlocked;globalThis.__iso=isolation;',vm.createContext(context));blocked=context.__blocked;}catch(e){error=e;}return {calls,error,blocked,iso:context.__iso};}
 assert.deepEqual(run(false,false).calls,[]);
 const rejected=run(true,false);assert.equal(rejected.error,undefined);assert.deepEqual(rejected.calls,['./tools/check-isolation.cjs']);assert.deepEqual([...rejected.blocked],['SYNTHETIC_BLOCK']);
 for(const use of [()=>rejected.iso.launchClaude({}),()=>rejected.iso.launchCodex({}),()=>rejected.iso.context({}),()=>rejected.iso.io.batchSync({},[]),()=>rejected.iso.io.batch({},[]),()=>rejected.iso.snapshot({},'x')])assert.throws(use,error=>error.code==='ISOLATION_BLOCKED'&&error.statusCode===503);
 const accepted=run(true,true);assert.equal(accepted.error,undefined);assert.deepEqual(accepted.calls,['./tools/check-isolation.cjs','./isolation']);
});
