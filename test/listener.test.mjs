import test from 'node:test';import assert from 'node:assert/strict';
import {listen,replyId} from '../src/listener.mjs';
const room={id:'room'};
test('resident listener notices human pause during reasoning and acknowledges only after yielding',async()=>{
 const controller=new AbortController(),heartbeats=[];let reads=0,started=false,interrupted=false,handled=false;
 const client={roomRequest:async(r,path,body)=>{
  if(path==='/inbox'){reads++;return {batch:'one',receipt:'proof',fromCursor:0,nextCursor:1,events:[{id:1}],controlRevision:reads<2?0:1,control:{status:reads<2?'running':'paused'}};}
  if(path==='/participation/heartbeat'){heartbeats.push(body);if(body.status==='paused'){assert.ok(interrupted);controller.abort();}}
  if(path==='/inbox/ack')handled=true;
  return {};
 },send:async()=>assert.fail('An obsolete response must not publish')};
 await listen(client,room,{signal:controller.signal,duration:2,interval:.01,onBatch:async(_, {signal})=>{started=true;await new Promise(resolve=>signal.addEventListener('abort',()=>{interrupted=true;resolve()},{once:true}));return {messages:[{body:'Obsolete'}],disposition:'handled'};}});
 assert.ok(started);assert.ok(interrupted);assert.equal(handled,false);assert.ok(heartbeats.some(h=>h.status==='paused'&&h.controlRevision===1));
});
test('prepared responses and stable publication IDs are reused before explicit inbox acknowledgment',async()=>{
 const controller=new AbortController(),sent=[];let modelCalls=0,acked=false;
 const client={roomRequest:async(r,path,body)=>{
  if(path==='/inbox')return {batch:'one',receipt:'proof',fromCursor:0,nextCursor:1,events:[{id:1}],controlRevision:2,control:{status:'running'}};
  if(path==='/inbox/ack'){acked=true;controller.abort();}return {};
 },send:async(...args)=>sent.push(args)};
 await listen(client,room,{signal:controller.signal,duration:2,interval:.01,onBatch:async()=>{modelCalls++;throw Error('Must use prepared response')},loadPrepared:async()=>({messages:[{body:'[answer] Evidence is ready.'}],controlRevision:2,disposition:'handled'})});
 assert.equal(modelCalls,0);assert.equal(sent.length,1);assert.equal(sent[0][2],replyId('one:2',0));assert.equal(sent[0][3].controlRevision,2);assert.ok(acked);
});
test('authentication denial stops the resident listener without acknowledging',async()=>{
 const client={roomRequest:async(r,path)=>{if(path==='/inbox')throw Object.assign(Error('revoked'),{status:403});return {};}};
 await assert.rejects(listen(client,room,{duration:1,interval:.01}),e=>e.status===403);
});

test('a human interjection aborts active reasoning before a replacement batch is handled',async()=>{
 const controller=new AbortController();let reads=0,aborted=false,calls=0,handled=false;
 const client={roomRequest:async(r,path)=>{
  if(path==='/inbox'){reads++;return {batch:reads<2?'a':'b',receipt:'proof',fromCursor:0,nextCursor:reads<2?1:2,events:reads<2?[{id:1}]:[{id:1},{id:2,payload:{fromType:'human'}}],controlRevision:0,control:{status:'running'}};}
  if(path==='/inbox/ack'){handled=true;controller.abort();}return {};
 },send:async()=>{assert.ok(aborted);}};
 await listen(client,room,{signal:controller.signal,duration:2,interval:.01,onBatch:async(_, {signal})=>{
  if(++calls===1){await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve()},{once:true}));return {messages:[],disposition:'handled'};}
  return {messages:[{body:'[answer] Responding to the human.'}],disposition:'handled'};
 }});assert.ok(aborted);assert.ok(handled);assert.equal(calls,2);
});
