import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {ChatError} from './client.mjs';

export function replyId(batch,index){const h=createHash('sha256').update(batch+':'+index).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;}
// The listener remains responsive while a registered local runtime handles a batch.
// Reading, transport receipt, model handling and durable acknowledgment remain distinct.
export async function listen(client,room,{signal,duration=1800,interval=2,onEvent=()=>{},onBatch,onSession=async()=>{},sessionId=randomUUID(),loadPrepared=async()=>null,savePrepared=async()=>{},reserveBatch=async()=>{},maxCalls=20,maxReplies=6}={}){
 if(!Number.isFinite(duration)||duration<1||duration>86400||!Number.isFinite(interval)||interval<.01||interval>60)throw new ChatError('Invalid listener bounds');
 const capabilities={persistentListener:true,automaticWake:Boolean(onBatch),interrupt:Boolean(onBatch),reasoning:'external-runtime',acknowledgment:'explicit'};
 await client.roomRequest(room,'/participation/session',{sessionId,capabilities});
 await onSession({sessionId});
 const deadline=Date.now()+duration*1000;let active=null,activeBatch=null,lastBatch=null,lastControl=-1,acknowledgedControl=0,nextHeartbeat=0,taskError=null,failures=0;
 let status='listening',calls=0,replies=0,receivedCursor=0;const seenHumans=new Set();
 const run=async(inbox)=>{
  const controller=new AbortController();active=controller;activeBatch=inbox.batch;status='working';
  try{
   let prepared=await loadPrepared(inbox.batch+':'+inbox.controlRevision);
   if(prepared?.controlRevision!==inbox.controlRevision)prepared=null;
   if(!prepared){
    if(calls>=maxCalls||replies>=maxReplies)throw new ChatError('The runtime response budget is exhausted; preserve the inbox for human direction');
    calls++;
    await reserveBatch(inbox.batch+':'+inbox.controlRevision);
    const result=await onBatch({...inbox,room,sessionId},{signal:controller.signal});
    if(controller.signal.aborted)return;
    if(!result||!Array.isArray(result.messages)||!['handled','follow-up-recorded','no-response-needed'].includes(result.disposition))throw new ChatError('Runtime must return messages and an explicit disposition');
    prepared={...result,controlRevision:inbox.controlRevision};await savePrepared(inbox.batch+':'+inbox.controlRevision,prepared);
   }
   if(controller.signal.aborted||prepared.controlRevision!==inbox.controlRevision)return;
   for(let i=0;i<prepared.messages.length;i++){
    if(controller.signal.aborted)return;
    if(replies>=maxReplies)throw new ChatError('The runtime reply budget is exhausted; preserve the prepared response');
    const message=prepared.messages[i];if(typeof message.body!=='string'||!message.body.trim())throw new ChatError('Runtime returned an empty message');
    replies++;await client.send(room,message.body,replyId(inbox.batch+':'+inbox.controlRevision,i),{...(message.participation||{}),controlRevision:inbox.controlRevision,sessionId});
   }
   if(controller.signal.aborted)return;
   await client.roomRequest(room,'/inbox/ack',{receipt:inbox.receipt,disposition:prepared.disposition});lastBatch=null;
   onEvent({event:'handled',batch:inbox.batch});
  }catch(error){
   if(!controller.signal.aborted)taskError=error;
  }finally{if(active===controller){active=null;activeBatch=null;nextHeartbeat=0;status='listening';}}
 };
 try{
  while(!signal?.aborted&&Date.now()<deadline){
   if(taskError)throw taskError;
   try{
    const inbox=await client.roomRequest(room,'/inbox');failures=0;
    if(inbox.controlRevision!==lastControl){
     const changed=lastControl>=0;lastControl=inbox.controlRevision;
     if(changed){nextHeartbeat=0;lastBatch=null;active?.abort(new ChatError('Human direction changed'));onEvent({event:'control',control:inbox.control,controlRevision:lastControl});}
    }
    receivedCursor=Math.max(receivedCursor,inbox.nextCursor);
    const humanEvents=inbox.events.filter(event=>event.payload?.fromType==='human'&&!seenHumans.has(event.id));
    for(const event of humanEvents)seenHumans.add(event.id);
    if(humanEvents.length){nextHeartbeat=0;onEvent({event:'human-interjection',events:humanEvents});if(active){lastBatch=null;active.abort(new ChatError('A human interjected'));}}
    const controlStatus=inbox.control?.status||'running';
    if(controlStatus!=='running'){active?.abort();status=active?'working':controlStatus==='paused'?'paused':'offline';}
    else if(!active)status='listening';
    if(!active)acknowledgedControl=lastControl;
    if(Date.now()>=nextHeartbeat){await client.roomRequest(room,'/participation/heartbeat',{sessionId,status,controlRevision:acknowledgedControl,receivedCursor});nextHeartbeat=Date.now()+10000;}
    if(controlStatus==='cancelled')break;
    if(controlStatus==='running'&&!active&&inbox.nextCursor>inbox.fromCursor&&lastBatch!==inbox.batch){
     lastBatch=inbox.batch;onEvent({event:'inbox',...inbox});if(onBatch&&inbox.events.length)void run(inbox);else if(onBatch){await client.roomRequest(room,'/inbox/ack',{receipt:inbox.receipt,disposition:'no-response-needed'});lastBatch=null;}
    }
    await sleep(interval*1000,undefined,{signal});
   }catch(error){
    if(signal?.aborted)break;
    if([401,403].includes(error.status)||error.status&&error.status<500&&![409,429].includes(error.status)||++failures>4)throw error;
    await sleep(Math.min(30000,interval*1000*2**failures),undefined,{signal});
   }
  }
 }finally{
  active?.abort();
  await client.roomRequest(room,'/participation/heartbeat',{sessionId,status:'offline',controlRevision:Math.max(acknowledgedControl,0)}).catch(()=>{});
  onEvent({event:'offline',reason:signal?.aborted?'stopped':'session-ended'});
 }
}
