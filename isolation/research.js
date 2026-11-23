'use strict';
const fs=require('fs');
const {requestPublic}=require('./public-network');
const endpointHosts=new Set(['mcp.consensus.app','research-desk-checker.fly.dev']);
const SCHEMAS={
 search_works:{type:'object',properties:{query:{type:'string',maxLength:1000},limit:{type:'integer',minimum:1,maximum:25}},required:['query'],additionalProperties:false},
 lookup_reference:{type:'object',properties:{ident:{type:'string',maxLength:500}},required:['ident'],additionalProperties:false},
 verify_reference:{type:'object',properties:{title:{type:'string',maxLength:2000},authors:{type:'array',maxItems:100,items:{type:'string',maxLength:200}},year:{type:['string','integer']},doi:{type:'string',maxLength:500},arxiv:{type:'string',maxLength:200}},additionalProperties:false},
 verify_bibtex:{type:'object',properties:{bibtex:{type:'string',maxLength:64000}},required:['bibtex'],additionalProperties:false},
 citation_neighbours:{type:'object',properties:{ident:{type:'string',maxLength:500},refs:{type:'integer',minimum:0,maximum:50},cites:{type:'integer',minimum:0,maximum:25}},required:['ident'],additionalProperties:false}
};
const descriptions={search_works:'Search public scholarly papers by keywords.',lookup_reference:'Look up public scholarly metadata by DOI, arXiv or OpenAlex identifier.',verify_reference:'Check a supplied scholarly reference against public bibliographic metadata.',verify_bibtex:'Check supplied BibTeX entries against public bibliographic metadata.',citation_neighbours:'List references and citing works for a public scholarly paper.'};
function validate(schema,value,label='arguments'){
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid '+label);
  const keys=Object.keys(value);if(keys.some(k=>!Object.hasOwn(schema.properties,k)))throw Error('Unexpected field');
  for(const k of schema.required||[])if(!Object.hasOwn(value,k))throw Error('Missing '+k);
  for(const k of keys)validate(schema.properties[k],value[k],k);return;
 }
 if(Array.isArray(schema.type)){if(!schema.type.some(t=>t==='integer'?Number.isSafeInteger(value):typeof value===t))throw Error('Invalid '+label);if(typeof value==='string'&&value.length>32)throw Error('Field too long');return;}
 if(schema.type==='array'){if(!Array.isArray(value)||value.length>schema.maxItems)throw Error('Invalid '+label);value.forEach(x=>validate(schema.items,x,label));return;}
 if(schema.type==='string'){if(typeof value!=='string'||value.length>(schema.maxLength||2000)||value.includes('\0'))throw Error('Invalid '+label);return;}
 if(schema.type==='integer'){if(!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum)throw Error('Invalid '+label);}
}
function createResearchBroker(configPath, {crossrefFallback=true, transport=requestPublic}={}){
 const config=JSON.parse(fs.readFileSync(configPath,'utf8')),server=config.mcpServers?.['reference-lookup'];
 if(!server||server.type!=='http'||server.headers)throw Error('Unsupported research configuration');
 const u=new URL(server.url);if(!endpointHosts.has(u.hostname)||u.hostname!=='research-desk-checker.fly.dev'||u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443')throw Error('Rejected research endpoint');
 let seq=0,session=null,initialized=null,protocol='2025-03-26';
 async function rpc(method,params,notification=false,signal){
  const id=notification?undefined:++seq,headers={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':protocol};
  if(session)headers['mcp-session-id']=session;
  const r=await transport(u,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params}),maxBytes:500000,timeoutMs:45000,signal});
  if(r.status!==200&&!(notification&&r.status===202))throw Error('Research service HTTP '+r.status);
  if(r.headers['mcp-session-id'])session=r.headers['mcp-session-id'];
  if(notification)return;
  let msg;try{msg=JSON.parse(r.body);}catch{for(const line of r.body.split(/\r?\n/)){if(!line.startsWith('data:'))continue;try{const o=JSON.parse(line.slice(5));if(o.id===id)msg=o;}catch{}}}
  if(!msg||msg.id!==id||msg.jsonrpc!=='2.0')throw Error('Invalid research response');
  if(msg.error)throw Error('Research service error '+String(msg.error.code||''));return msg.result;
 }
 async function initialize(signal){if(!initialized)initialized=(async()=>{const i=await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'claude-relay-research-broker',version:'1'}},false,signal);if(/^\d{4}-\d{2}-\d{2}$/.test(i?.protocolVersion||''))protocol=i.protocolVersion;await rpc('notifications/initialized',{},true,signal);return true;})().catch(e=>{initialized=null;session=null;throw e;});return initialized;}
 return {
  tools:Object.entries(SCHEMAS).map(([name,inputSchema])=>({name,description:descriptions[name],inputSchema})),
  async callTool(name,args,{signal}={}){
   if(!Object.hasOwn(SCHEMAS,name))throw Error('Unknown research tool');
   validate(SCHEMAS[name],args);
   let result,primaryError;
   try{
    await initialize(signal);result=await rpc('tools/call',{name,arguments:args},false,signal);
    if(name!=='search_works'||!crossrefFallback)return result;
    const text=(result.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
    let data;try{data=JSON.parse(text);}catch{}
    if(!result.isError&&!data?.problem)return result;
    primaryError=data?.problem||'Reference service reported an error';
   }catch(e){if(signal?.aborted||name!=='search_works'||!crossrefFallback)throw e;primaryError=e.message;}
   try{
    const fallback=await searchCrossref(args.query,args.limit||10,{signal});
    return {content:[{type:'text',text:JSON.stringify({...fallback,primaryService:'reference-lookup',primaryError})}],isError:false};
   }catch(e){
    if(signal?.aborted)throw e;
    return {content:[{type:'text',text:JSON.stringify({query:args.query,results:[],source:'reference-lookup',primaryError,fallbackError:e.message})}],isError:true};
   }
  }
 };
}
async function searchCrossref(query,limit=10,{signal}={}){
 validate(SCHEMAS.search_works,{query,limit});
 const u=new URL('https://api.crossref.org/works');
 u.searchParams.set('query',query);u.searchParams.set('rows',String(Math.min(limit*3,75)));
 u.searchParams.set('select','DOI,title,author,published,URL,container-title,type');
 const r=await requestPublic(u,{signal,headers:{accept:'application/json','user-agent':'ClaudeRelayResearch/1.0'},timeoutMs:45000,maxBytes:1000000});
 if(r.status!==200)throw Error('Crossref HTTP '+r.status);
 const json=JSON.parse(r.body);if(json.status!=='ok'||!Array.isArray(json.message?.items))throw Error('Invalid Crossref response');
 const results=json.message.items.filter(item=>typeof item.DOI==='string'&&typeof item.title?.[0]==='string'&&item.title[0].trim()).slice(0,limit).map(item=>({doi:item.DOI,title:item.title[0],authors:(item.author||[]).map(a=>[a.given,a.family].filter(Boolean).join(' ')),year:item.published?.['date-parts']?.[0]?.[0]??null,venue:item['container-title']?.[0]||'',url:item.URL||'',type:item.type||'',source:'Crossref'}));
 return {query,source:'Crossref',results,notice:'The primary reference service is temporarily unavailable. Results below are public Crossref metadata; coverage and ranking differ.'};
}
module.exports={createResearchBroker,SCHEMAS,validate,searchCrossref};

