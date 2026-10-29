import test from 'node:test';import assert from 'node:assert/strict';
import {AgentClient,ChatError} from '../src/client.mjs';import {roomEvents,waitForMessages} from '../src/realtime.mjs';
const credential={origin:'https://nodevertex.com',tenant:'example',workspace:'11111111-1111-4111-8111-111111111111',accessToken:'nvwa_'+'a'.repeat(48)};
const room={tenant:credential.tenant,workspace:credential.workspace,id:'22222222-2222-4222-8222-222222222222',conversationId:42};
function stream(parts){return new Response(new ReadableStream({start(c){for(const p of parts)c.enqueue(new TextEncoder().encode(p));c.close();}}),{headers:{'content-type':'text/event-stream'}})}
test('events use header-only scoped auth, reject redirects, and handle split frames',async()=>{
 let cancelled=false;
 const client=new AgentClient(credential,async(url,init)=>{assert.equal(url,'https://nodevertex.com/api/collaboration/example/'+credential.workspace+'/channels/'+room.id+'/events');assert.equal(init.headers.Authorization,'Bearer '+credential.accessToken);assert.equal(init.redirect,'error');return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: ready\r\ndata: {}\r\n\r\nevent: mess'));c.enqueue(new TextEncoder().encode('age\ndata: {}\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
 const seen=[];for await(const e of roomEvents(client,room)){seen.push(e);if(seen.length===2)break;}assert.deepEqual(seen,['ready','message']);assert.ok(cancelled);
 await assert.rejects(async()=>{for await(const e of roomEvents(client,{...room,workspace:'33333333-3333-4333-8333-333333333333'}))void e;},ChatError);
});
test('ready backfills a race without acknowledging or mutating the checkpoint',async()=>{
 const state={seen:{},pending:null};let reads=0;const client=new AgentClient(credential,async()=>stream(['event: ready\ndata: {}\n\n']));client.history=async()=>++reads===1?[]:[{id:7,body:'after initial read',participantKey:'human'}];
 const result=await waitForMessages(client,room,state,'self',{wait:1});assert.equal(result.transport,'sse');assert.equal(result.messages[0].id,7);assert.deepEqual(state,{seen:{},pending:null});assert.equal(reads,2);
});
test('revocation stops without polling fallback',async()=>{
 let reads=0;const client=new AgentClient(credential,async()=>stream(['event: access-revoked\ndata: {}\n\n']));client.history=async()=>{reads++;return []};
 await assert.rejects(waitForMessages(client,room,{seen:{}},'self',{wait:1}),e=>e.status===403);assert.equal(reads,1);
 const denied=new AgentClient(credential,async()=>new Response('',{status:403}));await assert.rejects(async()=>{for await(const e of roomEvents(denied,room))void e;},e=>e.status===403);
});
test('unsupported realtime falls back to bounded polling and canonical history',async()=>{
 let reads=0;const transports=[];const client=new AgentClient(credential,async()=>new Response('',{status:503}));client.history=async()=>++reads===1?[]:[{id:8,participantKey:'human'}];
 const result=await waitForMessages(client,room,{seen:{}},'self',{wait:2,interval:1,onTransport:t=>transports.push(t)});assert.equal(result.messages[0].id,8);assert.equal(result.transport,'poll');assert.deepEqual(transports,['sse','poll']);
});
test('oversized event frames are rejected and readers close',async()=>{
 const client=new AgentClient(credential,async()=>stream(['x'.repeat(262145)]));await assert.rejects(async()=>{for await(const e of roomEvents(client,room))void e;},/size limit/);
});
