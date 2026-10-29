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
