'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { createDrain, taskRequest, localMaintenanceRequest } = require('../tools/maintenance-drain.cjs');
test('M13 屏障先拒绝新任务，原任务结束后才归零', () => {
  const d=createDrain(), release=d.enter(), token='a'.repeat(64);
  assert.equal(d.begin(token),true); assert.equal(d.blocked(),true); assert.equal(d.status(1).running,2);
  release();release();assert.equal(d.status(1).running,1); assert.equal(d.status().running,0);
  assert.equal(d.end('b'.repeat(64)),false); assert.equal(d.end(token),true); assert.equal(d.blocked(),false);
});
test('M13 维护进程失联租约自动结束，其他维护者不能续租', () => {
  let clock=100; const d=createDrain({now:()=>clock,leaseMs:30}); const token='a'.repeat(64);
  assert.equal(d.begin('bad'),false);assert.equal(d.begin(token),true);assert.equal(d.begin('b'.repeat(64)),false);
  clock+=20;assert.equal(d.begin(token),true);clock+=20;assert.equal(d.blocked(),true);clock+=10;assert.equal(d.blocked(),false);
});
test('M13 客户端断开不代表后台写入和语音已结束', async () => {
  const d=createDrain(),res=new EventEmitter(),done=d.trackRequest(res);res.emit('close');assert.equal(d.status().running,1);done();assert.equal(d.status().running,0);
  let resolve;const pending=d.background(new Promise(r=>resolve=r));assert.equal(d.status().running,1);resolve();await pending;assert.equal(d.status().running,0);
});
test('M13 handler先结束时仍等响应流完成，重复finish不减负数', () => {
  const d=createDrain(),res=new EventEmitter(),done=d.trackRequest(res);done();assert.equal(d.status().running,1);res.emit('finish');res.emit('close');assert.equal(d.status().running,0);
});
test('M13 分片上传在请求间隙仍占用，完成或闲置过期后释放', () => {
  let clock=100;const d=createDrain({now:()=>clock,uploadMs:50});const id='a'.repeat(16);d.upload('one',id);
  assert.equal(d.hasUpload('two',id),false);d.begin('b'.repeat(64));assert.equal(d.hasUpload('one',id),true);assert.equal(d.status().running,1);
  d.completeUpload('one',id);assert.equal(d.status().running,0);d.upload('one',id);clock+=50;assert.equal(d.status().running,0);
});
test('M13 新消息、上传、语音受屏障保护，取消和状态仍可用', () => {
  for(const p of ['/api/send','/api/upload','/api/upload-start','/api/upload-part','/api/stt','/api/tts','/api/voice-warm','/api/prewarm'])assert.equal(taskRequest('POST',p),true);
  for(const p of ['/api/stop','/api/state','/api/events'])assert.equal(taskRequest('GET',p),false);
  assert.equal(localMaintenanceRequest({method:'POST',headers:{'content-type':'application/json'}}),true);
  for(const headers of [{'content-type':'text/plain'},{'content-type':'application/json',origin:'http://evil'},{'content-type':'application/json','sec-fetch-site':'cross-site'},{'content-type':'application/json','cf-connecting-ip':'1.1.1.1'}])assert.equal(localMaintenanceRequest({method:'POST',headers}),false);
});