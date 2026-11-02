import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {main} from '../bin/agentic-chat.mjs';
import {readPrivate,savePrivate,locked} from '../src/state.mjs';
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',member='55555555-5555-4555-8555-555555555555';
const c={origin:'https://nodevertex.com',tenant:'acme',workspace,memberId:member,accessToken:'nvwa_'+'x'.repeat(43)};
test('selection, unacknowledged polling, restart, exact-batch ack and send recovery preserve state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-chat-')),file=join(dir,'test.credentials.json'),state=join(dir,'room.state.json');await savePrivate(file,c,true);
 const originalFetch=globalThis.fetch,originalLog=console.log,logs=[];console.log=value=>logs.push(JSON.parse(value));let messages=[{id:1,revision:1,body:'Earlier context',participantKey:'human'}],failSend=false,posts=[];
 globalThis.fetch=async(url,o)=>{
  if(url.includes('/join?'))return Response.json({participantKey:'collab_'+member.replaceAll('-','')});
  if(url.includes('/messages?')){
   if(o.method==='POST'){const body=JSON.parse(o.body);posts.push(body);if(failSend){failSend=false;throw Error('Lost acknowledgement')}return Response.json({id:50,body:body.body});}
   return Response.json(messages);
  }
  return Response.json({channels:[{id:room,name:'Integration',conversationId:42}]});
 };
 const args=command=>[command,'--file',file,'--state',state];
 try{
  await main([...args('select'),'--room',room]);assert.equal(logs.at(-1).context[0].id,1);
  messages.push({id:2,revision:2,body:'@Builder please review',participantKey:'other-agent',fromType:'agent'},{id:3,revision:3,body:'Human question',participantKey:'human',fromType:'human'});
  await main([...args('poll'),'--wait','0']);const first=logs.at(-1);assert.equal(first.messages.length,2);await main([...args('poll'),'--wait','0']);assert.equal(logs.at(-1).batch,first.batch);
  await assert.rejects(main([...args('ack'),'--batch','wrong']),/stale/);await main([...args('ack'),'--batch',first.batch]);await main([...args('poll'),'--wait','0']);assert.equal(logs.at(-1).event,'idle');
  messages[1]={...messages[1],revision:10,body:'Revised request'};await main([...args('poll'),'--wait','0']);assert.equal(logs.at(-1).messages[0].revision,10);
  failSend=true;await assert.rejects(main([...args('send'),'--key','reply-2-v10','--message','Contract ready']));await main([...args('send'),'--key','reply-2-v10','--message','Contract ready']);assert.equal(posts[0].clientMessageId,posts[1].clientMessageId);
  await main([...args('send'),'--key','reply-2-v10','--message','Contract ready']);assert.equal(posts.length,2);assert.equal(logs.at(-1).event,'already-sent');await assert.rejects(main([...args('send'),'--key','reply-2-v10','--message','Changed text']),/different text/);
  if(process.platform!=='win32'){assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(state)).mode&0o777,0o600);}
  const stored=await readPrivate(state);assert.equal(stored.scope,'acme/'+workspace);assert.ok(!JSON.stringify(stored).includes(c.accessToken));
 }finally{globalThis.fetch=originalFetch;console.log=originalLog;await rm(dir,{recursive:true,force:true});}
});
test('state locks reject concurrent workers and release after failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-lock-')),file=join(dir,'state.json');
 try{await locked(file,async()=>{await assert.rejects(locked(file,async()=>{}),/locked/)});await assert.rejects(locked(file,async()=>{throw Error('fail')}),/fail/);await locked(file,async()=>{});}finally{await rm(dir,{recursive:true,force:true});}
});

test('enrollment saves private credentials without printing the nonce or bearer and refuses an existing destination',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-enroll-')),file=join(dir,'agent.credentials.json'),inviteFile=join(dir,'invitation.txt');
 const nonce='n'.repeat(43),link=`https://nodevertex.com/collaboration/acme/${workspace}/agent#${nonce}`;await import('node:fs/promises').then(fs=>fs.writeFile(inviteFile,link,{mode:0o600}));
 const oldFetch=globalThis.fetch,oldLog=console.log,logs=[];let calls=0;console.log=value=>logs.push(value);
 globalThis.fetch=async(url,o)=>{calls++;assert.equal(o.redirect,'error');assert.equal(JSON.parse(o.body).token,nonce);assert.equal(JSON.parse(o.body).name,'Integration Builder');return Response.json({accessToken:c.accessToken,member:{id:member,name:'Integration Builder'},expiresUtc:'2026-11-28T00:00:00Z'})};
 try{
  const args=['enroll','--file',file,'--name','Integration Builder','--invite-file',inviteFile];await main(args);const saved=await readPrivate(file);assert.equal(saved.memberId,member);assert.equal(saved.accessToken,c.accessToken);assert.ok(!logs.join('').includes(c.accessToken));assert.ok(!logs.join('').includes(nonce));
  await assert.rejects(main(args));assert.equal(calls,1);
 }finally{globalThis.fetch=oldFetch;console.log=oldLog;await rm(dir,{recursive:true,force:true});}
});

test('authentication denial stops polling after one request without changing the pending checkpoint',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-denied-')),file=join(dir,'agent.credentials.json'),state=join(dir,'room.state.json');await savePrivate(file,c,true);
 await savePrivate(state,{scope:'acme/'+workspace,memberId:member,room:{id:room,tenant:'acme',workspace,conversationId:42},seen:{'1':'1:false'},pending:null,outbox:{}},true);
 const before=await readPrivate(state),oldFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{status:403})};
 try{await assert.rejects(main(['poll','--file',file,'--state',state,'--wait','25']),e=>e.status===403);assert.equal(calls,1);assert.deepEqual(await readPrivate(state),before);}finally{globalThis.fetch=oldFetch;await rm(dir,{recursive:true,force:true});}
});

test('Action creation recovers uncertain results with the same UUID and refuses changed retry content',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-actions-')),file=join(dir,'agent.credentials.json'),state=join(dir,'room.state.json');await savePrivate(file,c,true);
 await savePrivate(state,{scope:'acme/'+workspace,memberId:member,room:{id:room,tenant:'acme',workspace,conversationId:42,parentId:null},seen:{},pending:null,outbox:{}},true);
 const oldFetch=globalThis.fetch,oldLog=console.log,posts=[];console.log=()=>{};
 globalThis.fetch=async(url,o)=>{assert.ok(url.endsWith('/channels/'+room+'/actions'));posts.push(JSON.parse(o.body));if(posts.length===1)throw Error('Lost response');return Response.json({action:{id:posts.at(-1).id}})};
 const args=['action-create','--file',file,'--state',state,'--key','follow-up-1','--title','Review'];
 try{
  await assert.rejects(main(args));assert.equal((await readPrivate(state)).actionOutbox['follow-up-1'].status,'pending');
  await main(args);assert.equal(posts[0].id,posts[1].id);await main(args);assert.equal(posts.length,2);
  await assert.rejects(main([...args.slice(0,-1),'Changed']),/different content/);
 }finally{globalThis.fetch=oldFetch;console.log=oldLog;await rm(dir,{recursive:true,force:true});}
});

test('one entry link enrolls the suggested identity and selects the exact room without leaking secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-connect-')),file=join(dir,'credential'),state=join(dir,'state'),inviteFile=join(dir,'invite');
 const nonce='n'.repeat(43),link=`https://nodevertex.com/collaboration/acme/${workspace}/agent/entry/${nonce}`,roomUrl=`https://nodevertex.com/collaboration/acme/${workspace}?channel=${room}`;
 await import('node:fs/promises').then(fs=>fs.writeFile(inviteFile,link,{mode:0o600}));const oldFetch=globalThis.fetch,oldLog=console.log,logs=[];let enrolls=0;console.log=value=>logs.push(value);
 globalThis.fetch=async(url,o)=>{
  if(url===link){assert.equal(o.headers.Authorization,undefined);return Response.json({suggestedName:'Maya',roomUrl});}
  if(url.endsWith('/agents/enroll')){enrolls++;assert.equal(JSON.parse(o.body).name,'Maya');assert.equal(JSON.parse(o.body).token,nonce);return Response.json({accessToken:c.accessToken,member:{id:member,name:'Maya'},participation:{roomUrl}});}
  if(url.includes('/messages?'))return Response.json([]);
  return Response.json({channels:[{id:room,name:'Selected',conversationId:42}]});
 };
 try{const args=['connect','--file',file,'--state',state,'--invite-file',inviteFile];await main(args);assert.equal((await readPrivate(state)).room.id,room);await main(args);assert.equal(enrolls,1);await import('node:fs/promises').then(fs=>fs.writeFile(inviteFile,link.replace(nonce,'m'.repeat(43))));await assert.rejects(main(args),/different invitation/);assert.equal(enrolls,1);assert.ok(!logs.join('').includes(nonce));assert.ok(!logs.join('').includes(c.accessToken));}
 finally{globalThis.fetch=oldFetch;console.log=oldLog;await rm(dir,{recursive:true,force:true});}
});

test('manual send retries preserve original human observation and recipient context after later inbox reads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-observation-')),file=join(dir,'credential'),state=join(dir,'state');await savePrivate(file,c,true);
 await savePrivate(state,{scope:'acme/'+workspace,memberId:member,room:{id:room,tenant:'acme',workspace,conversationId:42},seen:{},pending:null,outbox:{},controlRevision:1,observedHumanCursor:10,custom:{preserved:true}},true);
 const originalFetch=globalThis.fetch,originalLog=console.log,posts=[];console.log=()=>{};let fail=true;
 globalThis.fetch=async(url,options)=>{
  if(url.endsWith('/inbox'))return Response.json({controlRevision:2,humanCursor:20});
  if(url.includes('/join?'))return Response.json({});
  if(url.includes('/messages?')){const body=JSON.parse(options.body);posts.push(body);assert.equal(options.headers['X-NodeVertex-Control-Revision'],'1');if(fail){fail=false;throw Error('Lost acknowledgment')}return Response.json({id:50});}
  assert.fail('Unexpected request');
 };
 const args=['send','--file',file,'--state',state,'--key','original-answer','--message','[answer] Original result','--recipients',member];
 try{
  await assert.rejects(main(args));await main(['inbox','--file',file,'--state',state]);assert.equal((await readPrivate(state)).observedHumanCursor,20);
  await assert.rejects(main([...args.slice(0,-1),workspace]),/different participation context/);
  await main(args);assert.equal(posts.length,2);assert.equal(posts[0].clientMessageId,posts[1].clientMessageId);assert.equal(posts[1].participation.observedHumanCursor,10);assert.equal(posts[1].participation.controlRevision,1);assert.deepEqual(posts[1].participation.recipients,[member]);assert.equal((await readPrivate(state)).custom.preserved,true);
 }finally{globalThis.fetch=originalFetch;console.log=originalLog;await rm(dir,{recursive:true,force:true});}
});

test('inspect command needs no credential file and creates no enrollment or local state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-inspect-')),inviteFile=join(dir,'invite'),nonce='i'.repeat(43),link=`https://nodevertex.com/collaboration/acme/${workspace}/agent/entry/${nonce}`;
 const fs=await import('node:fs/promises');await fs.writeFile(inviteFile,link,{mode:0o600});const oldFetch=globalThis.fetch,oldLog=console.log,logs=[];let calls=0;console.log=value=>logs.push(value);
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,link);assert.equal(options.method,undefined);return Response.json({suggestedName:'Maya',token:nonce})};
 try{await main(['inspect','--invite-file',inviteFile]);assert.equal(calls,1);assert.equal(JSON.parse(logs[0]).enrolled,false);assert.ok(!logs.join('').includes(nonce));assert.deepEqual(await fs.readdir(dir),['invite']);}
 finally{globalThis.fetch=oldFetch;console.log=oldLog;await rm(dir,{recursive:true,force:true});}
});

test('manual inbox acknowledgment requires explicit opt-in to handle the priority human lane',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agentic-human-ack-')),file=join(dir,'credential'),state=join(dir,'state');await savePrivate(file,c,true);
 await savePrivate(state,{scope:'acme/'+workspace,memberId:member,room:{id:room,tenant:'acme',workspace,conversationId:42},seen:{},pending:null,outbox:{}},true);
 const originalFetch=globalThis.fetch,originalLog=console.log,acks=[];console.log=()=>{};
 globalThis.fetch=async(url,options)=>{assert.ok(url.endsWith('/inbox/ack'));acks.push(JSON.parse(options.body));return Response.json({acknowledged:true})};
 const args=['inbox-ack','--file',file,'--state',state,'--receipt','signed-proof'];
 try{
  await main(args);assert.equal(acks[0].acknowledgeHuman,false);await main([...args,'--include-human','true']);assert.equal(acks[1].acknowledgeHuman,true);assert.equal(acks[1].receipt,'signed-proof');
  await assert.rejects(main([...args,'--include-human','maybe']),/only after handling/);assert.equal(acks.length,2);
 }finally{globalThis.fetch=originalFetch;console.log=originalLog;await rm(dir,{recursive:true,force:true});}
});
