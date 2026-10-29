import {ChatError,ORIGIN,scope,unseen} from './client.mjs';
import {setTimeout as sleep} from 'node:timers/promises';

export async function* roomEvents(client,room,{signal}={}){
  // Validate the exact selected binding before exposing any credential to a request.
  scope(client.credential);
  if(room.workspace!==client.credential.workspace||room.tenant!==client.credential.tenant||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(room.id||''))throw new ChatError('Invalid or mismatched selected room');
  const url=ORIGIN+'/api/collaboration/'+scope(client.credential)+'/channels/'+room.id+'/events';
  const response=await client.fetcher(url,{headers:{Authorization:'Bearer '+client.credential.accessToken,Accept:'text/event-stream'},redirect:'error',signal});
  if([401,403].includes(response.status))throw new ChatError('Room access was revoked. Stop participating.',response.status);
  if(!response.ok||!response.body||!response.headers.get('content-type')?.startsWith('text/event-stream'))throw new ChatError('Realtime unavailable',response.status);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  try{
    while(true){
      const {done,value}=await reader.read();if(done)return;
      buffer+=decoder.decode(value,{stream:true});if(buffer.length>262144)throw new ChatError('Realtime frame exceeds the size limit');
      buffer=buffer.replace(/\r\n/g,'\n');let boundary;
      while((boundary=buffer.indexOf('\n\n'))>=0){
        const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        const type=frame.split('\n').find(line=>line.startsWith('event:'))?.slice(6).trim();
        if(type==='access-revoked')throw new ChatError('Room access was revoked. Stop participating.',403);
        if(['ready','message','sync','action-changed'].includes(type))yield type;
      }
    }
  }finally{await reader.cancel().catch(()=>{});}
}

// Events only wake canonical reads. A pending batch is still acknowledged explicitly by the caller.
export async function waitForMessages(client,room,state,self,{wait=25,interval=2,signal,onTransport=()=>{}}={}){
  if(!Number.isFinite(wait)||wait<0||wait>300||!Number.isFinite(interval)||interval<1||interval>60)throw new ChatError('Invalid watch timing');
  const deadline=Date.now()+wait*1000;
  const read=async()=>unseen(await client.history(room),state,self);
  let messages=await read();if(messages.length||wait===0)return {messages,transport:'history'};
  let failures=0,transport='sse';
  while(Date.now()<deadline){
    if(signal?.aborted)throw signal.reason;
    if(transport==='sse'){
      // Periodically reconnect/backfill even when a proxy leaves an idle stream open.
      const timer=AbortSignal.timeout(Math.max(1,Math.min(30000,deadline-Date.now())));
      const streamSignal=signal?AbortSignal.any([timer,signal]):timer;
      onTransport('sse');
      try{
        for await(const event of roomEvents(client,room,{signal:streamSignal})){
          if(['ready','message','sync','action-changed'].includes(event)){
            messages=await read();if(messages.length)return {messages,transport:'sse'};
          }
        }
      }catch(error){
        if([401,403].includes(error.status))throw error;
        if(signal?.aborted)throw signal.reason;
      }
      if(Date.now()>=deadline)break;
      // A dropped or unsupported stream enters bounded polling until this invocation ends.
      transport='poll';onTransport('poll');
    }
    await sleep(Math.min(interval*1000*2**failures,30000,Math.max(0,deadline-Date.now())),undefined,{signal});
    try{messages=await read();failures=0;if(messages.length)return {messages,transport:'poll'};}
    catch(error){if([401,403].includes(error.status)||error.status&&error.status!==429&&error.status<500||++failures>3)throw error;}
  }
  return {messages:[],transport};
}
