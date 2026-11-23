'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http');
const {checkedUrl,publicIp,fetchPublic}=require('../isolation/public-network');
const {SCHEMAS,validate}=require('../isolation/research');
const {validateSpeech,validateRelativeFile}=require('../isolation/voice');
test('public resources reject loopback, metadata, aliases and protocol tricks before any connection',async()=>{
 const original=http.request;let calls=0;http.request=()=>{calls++;throw Error('unexpected network call');};
 try {
  for(const url of ['https://127.0.0.1/','https://127.1/','https://2130706433/','https://0x7f000001/','https://[::1]/','https://[::ffff:127.0.0.1]/','https://[2002:7f00:1::]/','https://169.254.169.254/','https://10.1.2.3/','https://172.16.1.1/','https://192.168.1.1/','https://198.18.0.139/','https://metadata.google.internal/','https://thing.local/','https://localhost/','file:///C:/Windows/win.ini','http://example.com/','https://example.com:8765/','https://owner:credential@example.com/']){
   await assert.rejects(()=>fetchPublic(url),undefined,url);
  }
  assert.equal(calls,0);
 }finally{http.request=original;}
});
test('the resolver rejects non-global address forms but accepts real public address families',()=>{
 for(const ip of ['0.0.0.0','100.64.0.1','198.19.255.255','224.0.0.1','255.255.255.255','192.0.2.1','198.51.100.1','203.0.113.1','fc00::1','fe80::1','2001:db8::1','2001::1','::ffff:8.8.8.8','3fff::1'])assert.equal(publicIp(ip),false,ip);
 for(const ip of ['1.1.1.1','8.8.8.8','34.160.234.206','2606:4700::1111','2001:4860:4860::8888'])assert.equal(publicIp(ip),true,ip);
 assert.equal(checkedUrl('https://api.crossref.org/works').hostname,'api.crossref.org');
 assert.equal(checkedUrl('https://example.com/paper#references').href,'https://example.com/paper');
});
test('pre-cancelled public requests never reach the proxy',async()=>{
 const controller=new AbortController();controller.abort();const original=http.request;let calls=0;http.request=()=>{calls++;throw Error('unexpected connection');};
 try{await assert.rejects(()=>fetchPublic('https://api.crossref.org/works',{signal:controller.signal}));assert.equal(calls,0);}finally{http.request=original;}
});
test('research schemas cannot smuggle URL, method, endpoint or auth fields',()=>{
 assert.doesNotThrow(()=>validate(SCHEMAS.search_works,{query:'microscopy',limit:2}));
 for(const field of ['url','method','headers','authorization','endpoint','__proto__']){
  const value=JSON.parse('{"query":"microscopy","'+field+'":"https://127.0.0.1/"}');
  assert.throws(()=>validate(SCHEMAS.search_works,value));
 }
 assert.throws(()=>validate(SCHEMAS.search_works,{query:'x',limit:26}));
 assert.throws(()=>validate(SCHEMAS.search_works,{query:'x'.repeat(1001)}));
 assert.throws(()=>validate(SCHEMAS.verify_bibtex,{bibtex:'x'.repeat(64001)}));
});
test('speech accepts literal text but exposes no shell, path or profile selector',()=>{
 assert.equal(validateSpeech({text:"A literal 'quote'; $(command) stays speech."}).voice,'zh-CN-XiaoxiaoNeural');
 assert.equal(validateSpeech({text:'方言测试',voice:'zh-CN-liaoning-XiaobeiNeural'}).voice,'zh-CN-liaoning-XiaobeiNeural');
 for(const extra of ['out','path','command','exe','profile','proxy','forceOffline'])assert.throws(()=>validateSpeech({text:'test',[extra]:'bad'}));
 for(const voice of ["x';Start-Process calc;'",'https://127.0.0.1/','zh-CN-XiaoxiaoNeural\n'])assert.throws(()=>validateSpeech({text:'test',voice}));
 for(const rate of ['-51%','+101%','0%','+1%;echo bad'])assert.throws(()=>validateSpeech({text:'test',rate}));
 assert.throws(()=>validateSpeech({text:'x'.repeat(6001)}));
});
test('STT input cannot request an absolute, UNC, alternate stream or parent path',()=>{
 for(const p of ['C:\\secret.wav','C:secret.wav','\\\\host\\share\\a.wav','../a.wav','a\\..\\b.wav','x.wav:stream','/tmp/a.wav'])assert.throws(()=>validateRelativeFile(p),undefined,p);
 assert.doesNotThrow(()=>validateRelativeFile('chats/example/uploads/录音.wav'));
});

