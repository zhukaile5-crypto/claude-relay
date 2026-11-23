'use strict';
// Uses only self-created D: inputs and the final, fixed runtime in the real worker.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),manifest=process.argv[2],output=process.argv[3];
if(!manifest||!output?.includes('codex-security-artifacts-'))throw Error('Explicit runtime and managed evidence required');
const {createIsolation}=require('../isolation'),executor=require('../isolation/executor');
const stage=fs.mkdtempSync(path.join(root,'data','tex-compile-'));
const user={id:'alice',workDir:path.join(stage,'alice')};fs.mkdirSync(user.workDir);
const config={users:[user],academicSearch:false,isolation:{enabled:true,runtimeManifest:manifest,privateRoot:path.join(stage,'private'),gptHome:path.join(stage,'gpt')}};
const program=String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const base=process.env.RELAY_WORKSPACE,project=path.join(base,'项目'),main=path.join(project,'正文','论文.tex');
for(const name of ['正文','图片','文献'])fs.mkdirSync(path.join(project,name),{recursive:true});
fs.writeFileSync(path.join(project,'正文','章节.tex'),'\\section{合成章节}SYNTHETIC CHAPTER 42\n');
const py=input.python,cli=input.entry;
const png=cp.spawnSync(py,['-X','utf8','-I','-S','-c',"from PIL import Image; import sys; Image.new('RGB',(24,24),(40,80,160)).save(sys.argv[1])",path.join(project,'图片','图.png')],{windowsHide:true,encoding:'utf8'});
if(png.status!==0)throw Error('PNG fixture failed: '+png.stderr);
const bib='@article{doe2024,author={Doe, Jane and 王, 五},title={Synthetic 中文研究},journal={Synthetic Journal},year={2024},volume={1},pages={1--2}}';
fs.writeFileSync(path.join(project,'文献','参考.bib'),bib);
const results={checks:{},runs:[]};
for(const mode of ['none','pybtex','biber']){
 const bibliography=mode==='biber'?'\\usepackage[backend=biber]{biblatex}\n\\addbibresource{../文献/参考.bib}\n':'';
 const cite=mode==='none'?'':mode==='biber'?'Reference \\cite{doe2024}.\\printbibliography':'Reference \\cite{doe2024}.\\bibliographystyle{plain}\\bibliography{../文献/参考}';
 const source='\\documentclass{ctexart}\n\\usepackage{graphicx,amsmath}\n'+bibliography+'\\begin{document}\n中文隔离编译 SYNTHETIC 42\n\\input{章节.tex}\n\\includegraphics[width=1cm]{../图片/图.png}\n\\[E=mc^2\\]\n'+cite+'\n\\end{document}\n';
 fs.writeFileSync(main,source);
 const before=crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex');
 const compiled=cp.spawnSync(py,['-X','utf8','-I','-S',cli,'--source','项目/正文/论文.tex','--project-root','项目','--output','成果/'+mode+'.pdf','--bibliography',mode],{windowsHide:true,encoding:'utf8',timeout:240000,maxBuffer:3*1024*1024});
 let detail;try{detail=JSON.parse(compiled.stdout.trim());}catch{detail={stdout:compiled.stdout,stderr:compiled.stderr};}
 const row={mode,status:compiled.status,error:compiled.error?.message,result:detail};results.runs.push(row);
 if(compiled.status!==0){const log=path.join(base,'成果',mode+'.compile.log');row.log=fs.existsSync(log)?fs.readFileSync(log,'utf8').slice(-16000):'';throw Object.assign(Error('Compile failed: '+mode),{detail:results});}
 results.checks[mode+'SourceUnchanged']=crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex')===before;
 const pdf=path.join(base,'成果',mode+'.pdf');
 const parsed=cp.spawnSync(py,['-X','utf8','-I','-S','-c',"import sys,json,pymupdf; d=pymupdf.open(sys.argv[1]); print(json.dumps({'pages':len(d),'text':''.join(p.get_text() for p in d)},ensure_ascii=False))",pdf],{windowsHide:true,encoding:'utf8',timeout:30000});
 if(parsed.status!==0)throw Error('PDF parse failed: '+parsed.stderr);
 const content=JSON.parse(parsed.stdout);row.pdf={pages:content.pages,bytes:fs.statSync(pdf).size};
 results.checks[mode+'Pdf']=content.pages>=1&&content.text.includes('SYNTHETIC 42')&&content.text.replace(/\s/g,'').includes('中文隔离编译');
 if(mode!=='none')results.checks[mode+'Bibliography']=content.text.includes('Synthetic Journal');
 results.checks[mode+'Cleanup']=fs.readdirSync(path.dirname(process.env.TEMP)).filter(n=>/^tex-[a-f0-9]+$/.test(n)).length===0;
}
process.stdout.write(JSON.stringify(results));
`;
(async()=>{let iso;const evidence={stage,checks:{}};const started=Date.now();
 try{iso=createIsolation(config,stage);const ctx=iso.context(user);
  const value=await executor.executeNode(ctx,"try{\n"+program+"\n}catch(e){process.stdout.write(JSON.stringify({failure:e.message,detail:e.detail}));process.exitCode=1}",{input:{python:ctx.runtime.python,entry:'C:\\ClaudeRelayRuntime\\tools\\tex\\compile_latex.py'},timeoutMs:600000,maxOutputBytes:100000});
  evidence.execution={exitCode:value.exitCode,stderr:value.stderr,cleanup:value.cleanup,error:value.error};
  evidence.result=JSON.parse(value.stdout.toString());assert.equal(value.exitCode,0,JSON.stringify(evidence.result));
  evidence.checks=evidence.result.checks;assert.ok(Object.values(evidence.checks).every(Boolean));
 }catch(error){evidence.failure=error.message;process.exitCode=1;}
 finally{if(iso)await iso.closeAll();evidence.durationMs=Date.now()-started;fs.writeFileSync(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
})();
