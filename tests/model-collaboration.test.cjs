'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {REVIEW_PROMPT,collaborationRequest}=require('../tools/model-collaboration.cjs');
const providerOf=id=>id.startsWith('gpt-')?'openai':'anthropic';
const conv=()=>({messages:[{role:'user',text:'旧任务'},{role:'assistant',turnId:'old-turn',model:'haiku',status:'done'}]});
const review=()=>({action:'review',model:'gpt-6-luna',reviewIndex:1,reviewTurnId:'old-turn'});
test('H9 固定复核提示和保留模型选择，不把客户端任意文本藏进标签',()=>{
 const r=collaborationRequest(conv(),{...review(),message:'任意客户端文本'},{providerOf,model:'gpt-6-luna'});assert.equal(r.kind,'review');assert.equal(r.preserveChoice,true);assert.equal(r.text,REVIEW_PROMPT);assert.doesNotMatch(r.text,/任意客户端/);assert.match(r.text,/除非用户明确要求修改，否则不要修改任何文件/);
});
test('H9 一次性重答必须指向存在的用户与回答，仍保持原对话选择',()=>{
 const r=collaborationRequest(conv(),{retryWithModel:true,fromIndex:0,retryTurnId:'old-turn',model:'gpt-6-luna'},{providerOf,model:'gpt-6-luna'});assert.deepEqual(r,{kind:'retry',preserveChoice:true});
 for(const body of [{retryWithModel:true,model:'gpt-6-luna'},{retryWithModel:true,fromIndex:1,model:'gpt-6-luna'},{retryWithModel:true,fromIndex:0,model:'gpt-6-luna',continue:true}])assert.ok(collaborationRequest(conv(),body,{providerOf,model:'gpt-6-luna'}).error);
});
test('H9 旧复核按钮、同提供方、附加工具或截断组合均拒绝',()=>{
 for(const patch of [{reviewIndex:0},{reviewTurnId:'other'},{fromIndex:0},{attachments:[{path:'a'}]},{tool:'hidden'},{continue:true},{retryWithModel:true}])assert.ok(collaborationRequest(conv(),{...review(),...patch},{providerOf,model:'gpt-6-luna'}).error);
 assert.ok(collaborationRequest(conv(),review(),{providerOf,model:'sonnet'}).error);assert.ok(collaborationRequest(null,review(),{providerOf,model:'gpt-6-luna'}).error);
});
test('H9 普通消息、继续和普通重答不改变原协议',()=>{
 for(const body of [{message:'正常聊天'},{continue:true},{fromIndex:0}])assert.deepEqual(collaborationRequest(conv(),body,{providerOf,model:'haiku'}),{kind:null,preserveChoice:false});
 assert.ok(collaborationRequest(conv(),{action:'auto-review'},{providerOf,model:'haiku'}).error);
});
