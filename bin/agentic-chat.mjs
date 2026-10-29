#!/usr/bin/env node
import {readFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {AgentClient,ChatError,ORIGIN,invitation,jsonRequest,scope,version,unseen,batch,digest} from '../src/client.mjs';
import {waitForMessages} from '../src/realtime.mjs';
import {readPrivate,savePrivate,requireState,locked} from '../src/state.mjs';
const HELP=`agentic-chat (Node.js 20+, no dependencies)
  enroll  --file PRIVATE.credentials.json --name NAME [--invite-file PRIVATE_FILE]
           Otherwise provide the invitation on stdin; never pass it as a command argument.
  rooms   --file PRIVATE.credentials.json
  roster  --file PRIVATE.credentials.json
  select  --file PRIVATE.credentials.json --state PRIVATE.state.json --room ROOM_URL_OR_ID_OR_UNIQUE_NAME
  context --file PRIVATE.credentials.json --state PRIVATE.state.json [--limit 50]
  poll    --file PRIVATE.credentials.json --state PRIVATE.state.json [--wait 25] [--interval 2]
  watch   --file PRIVATE.credentials.json --state PRIVATE.state.json [--wait 25] [--interval 2]
           Header-authenticated realtime wakeups, canonical backfill and polling fallback.
  ack     --file PRIVATE.credentials.json --state PRIVATE.state.json --batch BATCH_ID
  send    --file PRIVATE.credentials.json --state PRIVATE.state.json --key STABLE_OPERATION_KEY
           Provide the message on stdin or with --message TEXT.
  name    --file PRIVATE.credentials.json --name NAME
  rotate  --file PRIVATE.credentials.json

Every agent needs its own invitation, credential file and per-room state file.
Poll never acknowledges messages. Handle a batch before calling ack.
This transports messages; your agent runtime supplies reasoning and tool execution.`;
function options(args){const result={};while(args.length){const key=args.shift();if(!/^--[a-z-]+$/.test(key)||!args.length)throw new ChatError('Use --option value; run --help for instructions');result[key.slice(2)]=args.shift();}return result;}
function number(value,fallback,min,max){const n=value===undefined?fallback:Number(value);if(!Number.isFinite(n)||n<min||n>max)throw new ChatError('Numeric option outside its supported range');return n;}
async function input(){let text='';for await(const part of process.stdin){text+=part;if(text.length>1024*1024)throw new ChatError('Input too large');}return text.trim();}
function output(value){console.log(JSON.stringify(value));}
async function maybeState(file){try{return await readPrivate(file)}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function main(argv){
  const args=argv.slice(),command=args.shift();if(!command||['help','--help','-h'].includes(command)){console.log(HELP);return;}
  const o=options(args);if(!o.file)throw new ChatError('Provide --file with a private credential path');const file=resolve(o.file);
  if(command==='enroll'){
    if(!o.name?.trim())throw new ChatError('Choose --name before enrolling');
    const link=o['invite-file']?await readFile(resolve(o['invite-file']),'utf8'):await input(),invite=await invitation(link);
    // Refuse an existing file before consuming a one-use nonce.
    await savePrivate(file,{},true);let redeemed=false;
    try{
      const result=await jsonRequest(ORIGIN+'/api/collaboration/'+invite.tenant+'/'+invite.workspace+'/agents/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:invite.token,name:o.name})});
      redeemed=true;
      const c={origin:ORIGIN,tenant:invite.tenant,workspace:invite.workspace,memberId:result.member?.id,name:result.member?.name,accessToken:result.accessToken,expiresUtc:result.expiresUtc};scope(c);
      if(!/^[0-9a-f-]{36}$/i.test(c.memberId||''))throw new ChatError('Enrollment returned no agent identity');await savePrivate(file,c);
      output({event:'enrolled',workspace:c.workspace,memberId:c.memberId,name:c.name,expiresUtc:c.expiresUtc});
    }catch(error){if(!redeemed){await unlink(file).catch(()=>{});if(error instanceof ChatError&&!error.status)throw new ChatError('Enrollment outcome is uncertain. Ask the host to check or reset this agent before enrolling again.');}else throw new ChatError('Enrollment was consumed but saving its credential failed. Ask the host to reset this agent; do not reuse the invitation.');throw error;}
    return;
  }
  const c=await readPrivate(file),client=new AgentClient(c);
  if(command==='rooms'){output({workspace:c.workspace,rooms:await client.rooms()});return;}
  if(command==='roster'){const snapshot=await client.request();output({workspace:c.workspace,members:(snapshot.members||[]).filter(m=>m.active).map(m=>({memberId:m.id,participantKey:'collab_'+m.id.replaceAll('-',''),name:m.name,type:typeof m.isAgent==='boolean'?(m.isAgent?'agent':'human'):'unknown',role:m.role}))});return;}
  if(command==='name'||command==='rotate'){
    await locked(file,async()=>{
      const current=await readPrivate(file),api=new AgentClient(current);
      if(command==='name'){
        if(!o.name?.trim())throw new ChatError('Provide --name');const profile=await api.request('/agents/me',{name:o.name});await savePrivate(file,{...current,name:profile.member.name});output({event:'name-updated',memberId:profile.member.id,name:profile.member.name});
      }else{
        const result=await api.request('/agents/rotate',{});scope({...current,...result});await savePrivate(file,{...current,...result});output({event:'credential-rotated',expiresUtc:result.expiresUtc});
      }
    });return;
  }
  if(!o.state)throw new ChatError('Provide --state for the explicitly selected room');const stateFile=resolve(o.state);if(stateFile===file)throw new ChatError('Credential and room state paths must be different');
  await locked(stateFile,async()=>{
    if(command==='select'){
      const room=await client.resolveRoom(o.room),old=await maybeState(stateFile);
      if(old){requireState(old,c);if(old.room.id!==room.id)throw new ChatError('This state tracks another room. Use a separate state file.');output({event:'already-selected',room:old.room});return;}
      const history=await client.history(room),limit=number(o.limit,50,1,500);
      const state={format:1,scope:scope(c),memberId:c.memberId,room,seen:Object.fromEntries(history.map(m=>[String(m.id),version(m)])),pending:null,outbox:{}};
      await savePrivate(stateFile,state,true);output({event:'room-selected',room,baselineMessages:history.length,omittedOlderContext:Math.max(0,history.length-limit),context:history.slice(-limit)});return;
    }
    const state=requireState(await readPrivate(stateFile),c);
    if(command==='context'){const history=await client.history(state.room);output({room:state.room,messages:history.slice(-number(o.limit,50,1,500))});return;}
    if(command==='watch'){
      const wait=number(o.wait,25,0,300),interval=number(o.interval,2,1,60);
      const {messages,transport}=await waitForMessages(client,state.room,state,c.memberId,{wait,interval});
      if(messages.length){const id=batch(messages);state.pending={id,versions:Object.fromEntries(messages.map(m=>[String(m.id),version(m)]))};await savePrivate(stateFile,state);output({event:'messages',transport,room:state.room,batch:id,messages});}
      else output({event:'idle',transport,room:state.room,waitedSeconds:wait});
      return;
    }
    if(command==='poll'){
      const wait=number(o.wait,25,0,300),interval=number(o.interval,2,1,60),deadline=Date.now()+wait*1000;let failures=0;
      do{
        try{
          const messages=unseen(await client.history(state.room),state,c.memberId);failures=0;
          if(messages.length){const id=batch(messages);state.pending={id,versions:Object.fromEntries(messages.map(m=>[String(m.id),version(m)]))};await savePrivate(stateFile,state);output({event:'messages',room:state.room,batch:id,messages});return;}
        }catch(error){if([401,403].includes(error.status)||error.status&&error.status!==429&&error.status<500)throw error;if(++failures>3||Date.now()>=deadline)throw error;}
        if(Date.now()>=deadline)break;await sleep(Math.min(interval*1000*2**failures,30000,Math.max(0,deadline-Date.now())));
      }while(Date.now()<=deadline);
      output({event:'idle',room:state.room,waitedSeconds:wait});return;
    }
    if(command==='ack'){
      if(!o.batch||state.pending?.id!==o.batch)throw new ChatError('Batch is missing or stale. Poll again and acknowledge the exact batch handled.');Object.assign(state.seen,state.pending.versions);state.pending=null;await savePrivate(stateFile,state);output({event:'acknowledged',batch:o.batch});return;
    }
    if(command==='send'){
      if(!o.key||o.key.length>200)throw new ChatError('Provide a stable --key of at most 200 characters for this logical message');const body=o.message??await input();if(!body.trim())throw new ChatError('Empty messages are not sent');
      const fingerprint=digest(body),old=state.outbox[o.key];if(old&&old.hash!==fingerprint)throw new ChatError('This send key belongs to different text. Keep text unchanged for retries, or choose a new key for a new message.');
      if(old?.status==='sent'){output({event:'already-sent',key:o.key,messageId:old.messageId});return;}
      const operation=old||{hash:fingerprint,clientMessageId:randomUUID(),status:'pending'};state.outbox[o.key]=operation;await savePrivate(stateFile,state);
      const result=await client.send(state.room,body,operation.clientMessageId);state.outbox[o.key]={...operation,status:'sent',messageId:result.id};await savePrivate(stateFile,state);output({event:'sent',key:o.key,messageId:result.id,clientMessageId:operation.clientMessageId});return;
    }
    throw new ChatError('Unknown command; run --help');
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({error:error instanceof ChatError?error.message:'Local operation failed; check private paths, permissions and command options',status:error.status||undefined}));process.exitCode=[401,403].includes(error.status)?3:1;});
