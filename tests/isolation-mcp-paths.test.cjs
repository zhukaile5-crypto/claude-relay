'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {relative,tools,validate,createBroker}=require('../isolation/mcp');
test('MCP accepts only the bound workspace and its trusted execution view',()=>{
 const ctx={workspaceRoot:path.resolve(__dirname,'synthetic-work'),executionRoot:path.join(os.tmpdir(),'synthetic-execution-view')};
 assert.equal(relative(ctx,'outputs/a.txt'),'outputs/a.txt');
 assert.equal(relative(ctx,path.join(ctx.workspaceRoot,'outputs','a.txt')),path.join('outputs','a.txt'));
 assert.equal(relative(ctx,path.join(ctx.executionRoot,'outputs','a.txt')),path.join('outputs','a.txt'));
 assert.throws(()=>relative(ctx,path.join(ctx.executionRoot+'-other','secret')));
 assert.throws(()=>relative(ctx,path.join(ctx.executionRoot,'..','another-account','secret')));
 assert.throws(()=>relative(ctx,'..\\other-account\\secret'));assert.throws(()=>relative(ctx,'data.txt:secret'));
});

test('only the supported Windows shell is advertised and legacy Bash is never reinterpreted',async()=>{
 assert.ok(tools.some(tool=>tool.name==='PowerShell'));
 assert.ok(!tools.some(tool=>tool.name==='Bash'));
 assert.doesNotThrow(()=>validate('PowerShell',{command:'Write-Output 42'}));
 const broker=createBroker({});
 await assert.rejects(broker.call('Bash',{command:'SYNTHETIC_COMMAND_MUST_NOT_EXECUTE'}),/Git Bash is unavailable.*never automatically converted or run on the host/);
});
