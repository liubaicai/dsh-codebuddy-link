import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpUsage } from '../src/acp-usage.ts';
const row=(id:string,input:number,credit:number)=>({sessionUpdate:'usage_update',used:99999,size:1000000,cost:{amount:123,currency:''},_meta:{'codebuddy.ai/messageId':id,usage:{prompt_tokens:input,completion_tokens:5,prompt_cache_hit_tokens:7,prompt_cache_write_tokens:0},'codebuddy.ai/requestCredits':{r:credit}}});
test('ACP usage counts per-message snapshots once, credits replace request totals',()=>{
 const u=new AcpUsage();u.accept(row('a',10,0.2));u.accept(row('a',10,0.2));
 const e=u.accept(row('b',20,0.3));
 assert.deepEqual(e,[{type:'usage',input:30,output:10,cacheRead:14,cacheWrite:0},{type:'metadata',totalCredits:0.3}]);
 assert.equal(u.accept(row('a',11,0.3))[0]?.type,'usage');
});
test('ACP context and incomplete token counts stay unknown, zero stays real',()=>{
 const u=new AcpUsage();assert.deepEqual(u.accept({sessionUpdate:'usage_update',used:99,size:1000}),[]);
 assert.deepEqual(u.accept({sessionUpdate:'usage_update',_meta:{'codebuddy.ai/messageId':'x',usage:{prompt_tokens:10,completion_tokens:2}}}),[]);
 const r=row('zero',0,0);r._meta.usage.completion_tokens=0;r._meta.usage.prompt_cache_hit_tokens=0;
 assert.deepEqual(u.accept(r),[{type:'usage',input:0,output:0,cacheRead:0,cacheWrite:0},{type:'metadata',totalCredits:0}]);
});
