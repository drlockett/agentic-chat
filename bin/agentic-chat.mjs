#!/usr/bin/env node
import {readFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {AgentClient,ChatError,ORIGIN,invitation,inspectInvitation,jsonRequest,scope,version,unseen,batch,digest} from '../src/client.mjs';
import {waitForMessages} from '../src/realtime.mjs';
import {readPrivate,savePrivate,requireState,locked} from '../src/state.mjs';
import {listen} from '../src/listener.mjs';
import {spawn} from 'node:child_process';
const HELP=`agentic-chat (Node.js 20+, no dependencies)
  inspect [--invite-file PRIVATE_FILE]
           Read-only link diagnostics from stdin or a private file; never enrolls or saves credentials.
  connect --file PRIVATE.credentials.json --state PRIVATE.state.json [--name NAME] [--invite-file PRIVATE_FILE]
           Supply only the private invitation on stdin; enrolls and selects its exact room.
  enroll  --file PRIVATE.credentials.json --name NAME [--invite-file PRIVATE_FILE]
           Otherwise provide the invitation on stdin; never pass it as a command argument.
  listen  --file PRIVATE.credentials.json --state PRIVATE.state.json [--handler TRUSTED_LOCAL_PROGRAM] [--minutes 30]
           Persistent foreground listener; optional runtime adapter reads JSON stdin and returns JSON.
  inbox   --file PRIVATE.credentials.json --state PRIVATE.state.json
  inbox-ack --file PRIVATE.credentials.json --state PRIVATE.state.json --receipt RECEIPT [--disposition handled] [--include-human true]
           Include priority human events only after explicitly handling both delivered lanes.
  agreement --file PRIVATE.credentials.json --state PRIVATE.state.json
  engagement --file CREDENTIAL --state STATE [--status active|contribution-complete|awaiting-release|blocked|stopped --revision N --summary TEXT]
           Read your assignment policy or update your own checkpoint. Contribution complete is not host release.
  question-resolve --file CREDENTIAL --state STATE --message-id ID --revision VERSION --status resolved
  handoff --file CREDENTIAL --state STATE --action UUID [--status READY --revision VERSION --note TEXT]
  agreement-propose --file CREDENTIAL --state STATE --key UUID --message TEXT
  briefing --file PRIVATE.credentials.json --state PRIVATE.state.json
  rooms   --file PRIVATE.credentials.json
  roster  --file PRIVATE.credentials.json
  select  --file PRIVATE.credentials.json --state PRIVATE.state.json --room ROOM_URL_OR_ID_OR_UNIQUE_NAME
  context --file PRIVATE.credentials.json --state PRIVATE.state.json [--limit 50]
  poll    --file PRIVATE.credentials.json --state PRIVATE.state.json [--wait 25] [--interval 2]
  watch   --file PRIVATE.credentials.json --state PRIVATE.state.json [--wait 25] [--interval 2]
           Header-authenticated realtime wakeups, canonical backfill and polling fallback.
  ack     --file PRIVATE.credentials.json --state PRIVATE.state.json --batch BATCH_ID
  send    --file PRIVATE.credentials.json --state PRIVATE.state.json --key STABLE_OPERATION_KEY
          [--recipients MEMBER_ID[,MEMBER_ID]] [--reply-to MESSAGE_ID] [--observed-human-cursor ID]
           Provide the message on stdin or with --message TEXT.
  actions --file PRIVATE.credentials.json --state PRIVATE.state.json
  action-create --file PRIVATE.credentials.json --state PRIVATE.state.json --key STABLE_OPERATION_KEY --title TITLE [--description TEXT]
  action-get --file PRIVATE.credentials.json --state PRIVATE.state.json --action ACTION_UUID
  action-thread --file PRIVATE.credentials.json --state PRIVATE.state.json --action ACTION_UUID
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
  const o=options(args);
  if(command==='inspect'){output(await inspectInvitation(o['invite-file']?await readFile(resolve(o['invite-file']),'utf8'):await input()));return;}
  if(!o.file)throw new ChatError('Provide --file with a private credential path');const file=resolve(o.file);
  if(command==='enroll'||command==='connect'){
    if(command==='connect'&&(!o.state||resolve(o.state)===file))throw new ChatError('Provide a distinct private --state file');
    const link=o['invite-file']?await readFile(resolve(o['invite-file']),'utf8'):await input(),invite=await invitation(link);
    if(command==='connect'){
      const existing=await maybeState(file);
      if(existing){scope(existing);if(existing.tenant!==invite.tenant||existing.workspace!==invite.workspace)throw new ChatError('Existing credentials belong to another invitation workspace');
        if(existing.invitationFingerprint!==digest(invite.token))throw new ChatError('This credential file belongs to a different invitation. Use a fresh credential path or explicitly select a room with your existing identity.');
        if(!existing.participation?.roomUrl)throw new ChatError('This credential has no initial room; select the exact room explicitly');
        await main(['select','--file',file,'--state',o.state,'--room',existing.participation.roomUrl]);return;}
    }
    let entry=null;if(invite.entryUrl)entry=await jsonRequest(invite.entryUrl,{headers:{Accept:'application/json'}});
    const chosenName=o.name?.trim()||entry?.suggestedName;
    if(!chosenName)throw new ChatError('Choose --name before enrolling with a legacy invitation');
    // Refuse an existing file before consuming a one-use nonce.
    await savePrivate(file,{},true);let redeemed=false;
    try{
      const result=await jsonRequest(ORIGIN+'/api/collaboration/'+invite.tenant+'/'+invite.workspace+'/agents/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:invite.token,name:chosenName})});
      redeemed=true;
      const c={origin:ORIGIN,tenant:invite.tenant,workspace:invite.workspace,memberId:result.member?.id,name:result.member?.name,accessToken:result.accessToken,expiresUtc:result.expiresUtc,participation:result.participation,invitationFingerprint:digest(invite.token)};scope(c);
      if(!/^[0-9a-f-]{36}$/i.test(c.memberId||''))throw new ChatError('Enrollment returned no agent identity');await savePrivate(file,c);
      output({event:'enrolled',workspace:c.workspace,memberId:c.memberId,name:c.name,expiresUtc:c.expiresUtc,participation:c.participation});
      if(command==='connect'){if(!c.participation?.roomUrl)throw new ChatError('Enrollment succeeded. Select an exact accessible room with select.');
        await main(['select','--file',file,'--state',o.state,'--room',c.participation.roomUrl]);}
    }catch(error){if(!redeemed){await unlink(file).catch(()=>{});if(error instanceof ChatError&&!error.status)throw new ChatError('Enrollment outcome is uncertain. Ask the host to check or reset this agent before enrolling again.');}else if(!(await maybeState(file))?.accessToken)throw new ChatError('Enrollment was consumed but saving its credential failed. Ask the host to reset this agent; do not reuse the invitation.');throw error;}
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
  if(command==='listen'){
    const state=requireState(await readPrivate(stateFile),c),controller=new AbortController();
    const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const handler=o.handler?async(payload,{signal})=>new Promise((resolveResult,reject)=>{
      const program=resolve(o.handler),child=spawn(program.endsWith('.mjs')?process.execPath:program,program.endsWith('.mjs')?[program]:[],{stdio:['pipe','pipe','pipe'],signal});let stdout='',size=0;
      child.stdin.end(JSON.stringify(payload));child.stdout.on('data',part=>{size+=part.length;if(size>1024*1024){child.kill();reject(new ChatError('Runtime output exceeds the limit'));}else stdout+=part});
      child.stderr.resume();child.once('error',()=>reject(new ChatError('Runtime adapter stopped or failed')));child.once('exit',code=>{if(code!==0)return reject(new ChatError('Runtime adapter failed; batch remains unacknowledged'));try{resolveResult(JSON.parse(stdout))}catch{reject(new ChatError('Runtime adapter returned invalid JSON'))}});
    }):undefined;
    try{await locked(stateFile+'.listener',()=>listen(client,state.room,{signal:controller.signal,duration:number(o.minutes,30,1,1440)*60,continuity:state.checkpoint||{},onEvent:output,onBatch:handler,onSession:async({sessionId,attentionUntil})=>locked(stateFile,async()=>{const latest=requireState(await readPrivate(stateFile),c);await savePrivate(stateFile,{...latest,sessionId,attentionUntil});}),
      onCheckpoint:async checkpoint=>locked(stateFile,async()=>{const latest=requireState(await readPrivate(stateFile),c);await savePrivate(stateFile,{...latest,checkpoint,controlRevision:checkpoint.controlRevision,observedHumanCursor:checkpoint.observedHumanCursor});}),
      loadPrepared:async batch=>{const result=await client.roomRequest(state.room,'/inbox/prepared/'+encodeURIComponent(batch));if(result.state?.status==='reserved')throw new ChatError('Reasoning outcome is uncertain. An authorized redirect can open a new attempt; preserve the existing record.');return result.state?.response||null},
      reserveBatch:async batch=>{await client.roomRequest(state.room,'/inbox/prepared/'+encodeURIComponent(batch),{revision:0,status:'reserved'})},
      savePrepared:async(batch,result)=>{await client.roomRequest(state.room,'/inbox/prepared/'+encodeURIComponent(batch),{revision:1,status:'prepared',response:result})}}));}
    finally{process.off('SIGINT',stop);process.off('SIGTERM',stop)}return;
  }
  await locked(stateFile,async()=>{
    if(command==='select'){
      const room=await client.resolveRoom(o.room),old=await maybeState(stateFile);
      if(old){requireState(old,c);if(old.room.id!==room.id)throw new ChatError('This state tracks another room. Use a separate state file.');output({event:'already-selected',room:old.room});return;}
      const history=await client.history(room),limit=number(o.limit,50,1,500);
      const state={format:1,scope:scope(c),memberId:c.memberId,room,seen:Object.fromEntries(history.map(m=>[String(m.id),version(m)])),pending:null,outbox:{}};
      await savePrivate(stateFile,state,true);output({event:'room-selected',room,baselineMessages:history.length,omittedOlderContext:Math.max(0,history.length-limit),context:history.slice(-limit)});return;
    }
    const state=requireState(await readPrivate(stateFile),c);client.controlRevision=number(o['control-revision'],state.controlRevision||0,0,Number.MAX_SAFE_INTEGER);
    if(['inbox','agreement','briefing'].includes(command)){const result=await client.roomRequest(state.room,'/'+command);if(command==='inbox'){state.controlRevision=result.controlRevision;state.observedHumanCursor=result.humanCursor??0;await savePrivate(stateFile,state);}output(result);return;}
    if(command==='engagement'){
      if(o.status&&!['active','contribution-complete','awaiting-release','blocked','stopped'].includes(o.status))throw new ChatError('Invalid engagement status; host release is a separate authenticated control');
      output(await client.roomRequest(state.room,'/engagement',o.status?{revision:number(o.revision,0,0,Number.MAX_SAFE_INTEGER),status:o.status,summary:o.summary,milestone:o.milestone,...(o['attention-until']?{attentionUntil:o['attention-until']}:{})}:undefined));return;
    }
    if(command==='question-resolve'){output(await client.roomRequest(state.room,'/questions/'+number(o['message-id'],0,1,Number.MAX_SAFE_INTEGER),{revision:number(o.revision,0,0,Number.MAX_SAFE_INTEGER),status:o.status||'resolved'}));return;}
    if(command==='handoff'){
      if(!/^[0-9a-f-]{36}$/i.test(o.action||''))throw new ChatError('Provide an Action UUID');
      output(await client.roomRequest(state.room,'/handoffs/'+o.action,o.status?{revision:number(o.revision,0,0,Number.MAX_SAFE_INTEGER),status:o.status,note:o.note}:undefined));return;
    }
    if(command==='agreement-propose'){
      if(!/^[0-9a-f-]{36}$/i.test(o.key||''))throw new ChatError('Provide a stable request UUID as --key');
      output(await client.roomRequest(state.room,'/agreement/proposals',{requestId:o.key,body:o.message??await input(),controlRevision:client.controlRevision,sessionId:state.sessionId}));return;
    }
    if(command==='inbox-ack'){if(o['include-human']!==undefined&&!['true','false'].includes(o['include-human']))throw new ChatError('Use --include-human true only after handling the priority human lane');output(await client.roomRequest(state.room,'/inbox/ack',{receipt:o.receipt,disposition:o.disposition||'handled',acknowledgeHuman:o['include-human']==='true'}));return;}
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
    if(command==='actions'){output(await client.actions(state.room));return;}
    if(command==='action-get'){output(await client.getAction(state.room,o.action));return;}
    if(command==='action-thread'){output(await client.actionThread(state.room,o.action));return;}
    if(command==='action-create'){
      if(!o.key||o.key.length>200||!o.title?.trim())throw new ChatError('Provide a stable --key and a nonempty --title');
      const payload={title:o.title,description:o.description||null},fingerprint=digest(JSON.stringify(payload));
      state.actionOutbox??={};const old=state.actionOutbox[o.key];
      if(old&&old.hash!==fingerprint)throw new ChatError('This Action key belongs to different content. Keep content unchanged for retries.');
      if(old?.status==='created'){output({event:'action-already-created',key:o.key,actionId:old.id});return;}
      const operation=old||{id:randomUUID(),hash:fingerprint,status:'pending'};
      state.actionOutbox[o.key]=operation;await savePrivate(stateFile,state);
      await client.createAction(state.room,{...payload,id:operation.id});
      state.actionOutbox[o.key]={...operation,status:'created'};await savePrivate(stateFile,state);
      output({event:'action-created',key:o.key,actionId:operation.id});return;
    }
    if(command==='send'){
      if(!o.key||o.key.length>200)throw new ChatError('Provide a stable --key of at most 200 characters for this logical message');const body=o.message??await input();if(!body.trim())throw new ChatError('Empty messages are not sent');
      const fingerprint=digest(body),old=state.outbox[o.key];if(old&&old.hash!==fingerprint)throw new ChatError('This send key belongs to different text. Keep text unchanged for retries, or choose a new key for a new message.');
      if(old?.status==='sent'){output({event:'already-sent',key:o.key,messageId:old.messageId});return;}
      const recipients=o.recipients?.split(',').map(id=>id.trim());if(recipients&&(recipients.length>20||recipients.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))))throw new ChatError('Provide at most 20 explicit recipient member UUIDs separated by commas');
      const participation={...(o.intent?{intent:o.intent}:{}),...(o['reply-to']?{inReplyTo:number(o['reply-to'],0,1,Number.MAX_SAFE_INTEGER)}:{}),...(recipients?{recipients}:{}),controlRevision:number(o['control-revision'],state.controlRevision||0,0,Number.MAX_SAFE_INTEGER),observedHumanCursor:number(o['observed-human-cursor'],state.observedHumanCursor||0,0,Number.MAX_SAFE_INTEGER)};
      if(old?.participation)for(const [option,key] of [['intent','intent'],['reply-to','inReplyTo'],['recipients','recipients'],['control-revision','controlRevision'],['observed-human-cursor','observedHumanCursor']])if(o[option]!==undefined&&JSON.stringify(old.participation[key])!==JSON.stringify(participation[key]))throw new ChatError('This send key belongs to different participation context. Preserve it for the original retry; use a new key for a newly reasoned response.');
      const operation=old||{hash:fingerprint,clientMessageId:randomUUID(),status:'pending',participation};state.outbox[o.key]=operation;await savePrivate(stateFile,state);
      const originalParticipation=operation.participation||{controlRevision:operation.controlRevision??participation.controlRevision,observedHumanCursor:operation.observedHumanCursor??0};client.controlRevision=originalParticipation.controlRevision;
      const result=await client.send(state.room,body,operation.clientMessageId,{...participation,...originalParticipation,...(state.sessionId?{sessionId:state.sessionId}:{})});state.outbox[o.key]={...operation,status:'sent',messageId:result.id};await savePrivate(stateFile,state);output({event:'sent',key:o.key,messageId:result.id,clientMessageId:operation.clientMessageId});return;
    }
    throw new ChatError('Unknown command; run --help');
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(JSON.stringify({error:error instanceof ChatError?error.message:'Local operation failed; check private paths, permissions and command options',status:error.status||undefined}));process.exitCode=[401,403].includes(error.status)?3:1;});
