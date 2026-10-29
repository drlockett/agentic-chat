import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentClient,invitation,unseen,version,batch,jsonRequest} from '../src/client.mjs';
const workspace='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222',parent='33333333-3333-4333-8333-333333333333',action='44444444-4444-4444-8444-444444444444',member='55555555-5555-4555-8555-555555555555';
const c={origin:'https://nodevertex.com',tenant:'acme',workspace,memberId:member,accessToken:'nvwa_'+'x'.repeat(43)},link=`https://nodevertex.com/collaboration/acme/${workspace}/agent#${'a'.repeat(43)}`;
test('enrollment resolves an n-v.io link without credentials and rejects foreign redirects, human links and userinfo',async()=>{
 const result=await invitation('https://n-v.io/abcdef',async(url,o)=>{assert.equal(o.headers,undefined);assert.equal(o.redirect,'manual');return new Response(null,{status:302,headers:{location:link}})});assert.equal(result.workspace,workspace);
 for(const bad of [link.replace('/agent#','/accept#'),link.replace('nodevertex.com','evil.example'),link.replace('https://','https://user:password@'),link.replace('/agent#','/agent?q=x#')])await assert.rejects(invitation(bad));
 await assert.rejects(invitation('https://n-v.io/abcdef',async()=>new Response(null,{status:302,headers:{location:'https://evil.example/agent#secret'}})));
});
test('room selection is explicit, rejects another workspace, and detects duplicate names',async()=>{
 const client=new AgentClient(c,async()=>Response.json({channels:[{id:room,name:'Integration',conversationId:42},{id:parent,name:'Integration',conversationId:43}]}));
 await assert.rejects(client.resolveRoom('Integration'),/ambiguous/);await assert.rejects(client.resolveRoom(`https://nodevertex.com/collaboration/acme/${parent}?channel=${room}`),/different workspace/);
 await assert.rejects(client.resolveRoom(`https://nodevertex.com/collaboration/acme/${workspace}`),/including its channel/);
 assert.equal((await client.resolveRoom(`https://nodevertex.com/collaboration/acme/${workspace}?channel=${room}`)).conversationId,42);
});
test('working thread selection uses the authorized action API, including completed discussions',async()=>{
 const client=new AgentClient(c,async(url)=>{assert.ok(url.endsWith('/actions/'+action));return Response.json({detail:{action:{parentChannelId:parent,workingThreadId:room,conversationVertexId:99,title:'Integration review'}}})});
 const selected=await client.resolveRoom(`https://nodevertex.com/collaboration/acme/${workspace}?channel=${parent}&action=${action}&thread=1`);assert.equal(selected.id,room);assert.equal(selected.conversationId,99);
 await assert.rejects(client.resolveRoom(`https://nodevertex.com/collaboration/acme/${workspace}?channel=${room}&action=${action}&thread=1`),/does not belong/);
});
test('three agents and two humans remain distinct, own posts are filtered, and edits/deletions are redelivered',()=>{
 const key='collab_'+member.replaceAll('-','');const messages=[{id:1,participantKey:key,fromType:'agent'},{id:2,participantKey:'collab_other',fromType:'agent'},{id:3,participantKey:'collab_third',fromType:'agent'},{id:4,participantKey:'human-one',fromType:'human'},{id:5,participantKey:'human-two',fromType:'human'}];
 const state={seen:{}};assert.deepEqual(unseen(messages,state,member).map(m=>m.id),[2,3,4,5]);state.seen['2']=version(messages[1]);assert.deepEqual(unseen(messages,state,member).map(m=>m.id),[3,4,5]);
 assert.equal(unseen([{...messages[1],revision:20}],state,member).length,1);assert.equal(unseen([{...messages[1],deleted:true}],state,member).length,1);assert.equal(batch(messages),batch(messages.slice().reverse()));
});
test('credentials travel only in Authorization and redirects are refused',async()=>{
 let calls=0;const client=new AgentClient(c,async(url,o)=>{calls++;assert.equal(o.headers.Authorization,'Bearer '+c.accessToken);assert.ok(!url.includes(c.accessToken));assert.equal(o.redirect,'error');return Response.json({ok:true})});await client.request('/agents/me');assert.equal(calls,1);assert.throws(()=>client.request('/../other'));assert.throws(()=>new AgentClient({...c,origin:'https://evil.example'}));
 await assert.rejects(jsonRequest('https://nodevertex.com/',{},async()=>new Response(null,{status:403})),e=>e.status===403);
});
