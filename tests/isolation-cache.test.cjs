'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const start=source.indexOf('function pipeWorkFile('),end=source.indexOf('\nfunction serveWorkFile(',start);
assert.ok(start>=0&&end>start);
async function setup(t,bytes){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'relay-cache-')),file=path.join(dir,'snapshot.bin');fs.writeFileSync(file,bytes);
 const released=[];
 const ctx={fs,config:{isolation:{enabled:true}},isolation:{releaseSnapshot(name){assert.equal(name,file);fs.rmSync(name,{force:true});released.push(name);}}};
 vm.createContext(ctx);vm.runInContext(source.slice(start,end)+'\nglobalThis.pipe=pipeWorkFile;',ctx);
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-length':bytes.length});ctx.pipe(res,file);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));const absolute=fs.realpathSync.native(dir);assert.equal(path.dirname(absolute).toLowerCase(),fs.realpathSync.native(os.tmpdir()).toLowerCase());assert.ok(path.basename(absolute).startsWith('relay-cache-'));fs.rmSync(absolute,{recursive:true,force:true});});
 return {url:'http://127.0.0.1:'+server.address().port,file,released};
}
async function gone(fixture){for(let n=0;n<100;n++){if(fixture.released.length)break;await new Promise(r=>setTimeout(r,10));}assert.equal(fixture.released.length,1);assert.equal(fs.existsSync(fixture.file),false);}
test('normal download closes its input and releases the private snapshot',async t=>{
 const bytes=Buffer.from('Synthetic Unicode 中文'),f=await setup(t,bytes);
 const response=await fetch(f.url);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);await gone(f);
});
test('client abort destroys the input and releases the private snapshot',async t=>{
 const f=await setup(t,Buffer.alloc(24*1024*1024,42));
 await new Promise((resolve,reject)=>{const req=http.get(f.url,res=>{res.once('data',()=>{res.destroy();req.destroy();resolve();});});req.once('error',e=>e.code==='ECONNRESET'?resolve():reject(e));});
 await gone(f);
});
test('isolated background warming does not create an ownerless preview',()=>{
 const a=source.indexOf('function warmPreviews('),b=source.indexOf('// ---------- 语音',a),calls=[];
 const ctx={config:{isolation:{enabled:true}},isolation:{toPdf(...args){calls.push(args);}},path,PDF_PREVIEW_EXTS:new Set(['.pptx'])};
 vm.createContext(ctx);vm.runInContext(source.slice(a,b)+'\nwarmPreviews({id:"synthetic"},["slides.pptx"]);',ctx);assert.equal(calls.length,0);
});
