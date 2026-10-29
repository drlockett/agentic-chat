import {createHash} from 'node:crypto';
export const ORIGIN='https://nodevertex.com';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class ChatError extends Error { constructor(message,status=0){super(message);this.status=status;} }
function trusted(url){return url.origin===ORIGIN&&!url.username&&!url.password;}
export async function invitation(link,fetcher=fetch){
  let url;try{url=new URL(link.trim())}catch{throw new ChatError('Invalid agent invitation URL');}
  if(url.origin==='https://n-v.io'&&!url.username&&!url.password){
    const response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});
    const target=response.headers.get('location');
    if(![301,302,303,307,308].includes(response.status)||!target)throw new ChatError('The short invitation could not be resolved');
    try{url=new URL(target,url)}catch{throw new ChatError('Invalid invitation redirect');}
  }
  const match=/^\/collaboration\/([a-zA-Z0-9_-]+)\/([^/]+)\/agent$/.exec(url.pathname);
  if(!trusted(url)||!match||!UUID.test(match[2])||url.search||!/^#[a-zA-Z0-9_-]{40,128}$/.test(url.hash))throw new ChatError('Use a NodeVertex agent enrollment link, not a human invitation or workspace URL');
  return {origin:ORIGIN,tenant:match[1],workspace:match[2],token:url.hash.slice(1)};
}
export function scope(c){
  if(c.origin!==ORIGIN||! /^[a-zA-Z0-9_-]+$/.test(c.tenant)||!UUID.test(c.workspace)||! /^nvwa_[a-zA-Z0-9_-]{40,128}$/.test(c.accessToken))throw new ChatError('Invalid workspace credential');
  return c.tenant+'/'+c.workspace;
}
export async function jsonRequest(url,options={},fetcher=fetch){
  try{
    const response=await fetcher(url,{...options,redirect:'error',signal:options.signal||AbortSignal.timeout(20000)});
    if(!response.ok)throw new ChatError([401,403].includes(response.status)?'Access denied. Stop participating and ask the host to restore or reset access.':response.status===429?'Rate limited. Back off before retrying.':'Request failed with HTTP '+response.status,response.status);
    if(response.status===204)return null;
    const body=await response.text();if(body.length>8*1024*1024)throw new ChatError('Room response exceeds the client size limit');return JSON.parse(body);
  }catch(error){if(error instanceof ChatError)throw error;throw new ChatError('Transport failed or returned invalid JSON. Retry reads; keep the same send key when retrying a message.');}
}
export class AgentClient{
  constructor(credential,fetcher=fetch){scope(credential);this.credential=credential;this.fetcher=fetcher;this.base=ORIGIN+'/api/collaboration/'+scope(credential);}
  request(path='',body){
    if(path&&!/^\/[a-zA-Z0-9_/?=&%-]+$/.test(path))throw new ChatError('Invalid workspace API path');
    return jsonRequest(this.base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+this.credential.accessToken,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)},this.fetcher);
  }
  async rooms(){
    const snapshot=await this.request();return (snapshot.channels||[]).flatMap(c=>[{id:c.id,name:c.name,conversationId:c.conversationId,private:c.private,parentId:null},...(c.workingThreads||[]).map(t=>({id:t.channelId,name:t.title,conversationId:t.conversationId,private:c.private,parentId:c.id,actionId:t.id}))]);
  }
  async resolveRoom(input){
    if(typeof input!=='string'||!input.trim())throw new ChatError('Provide an explicit room URL, channel ID or unique room name');
    let wanted=input.trim(),action=null;
    if(/^https?:/i.test(wanted)){
      let url;try{url=new URL(wanted)}catch{throw new ChatError('Invalid room URL');}
      const match=/^\/collaboration\/([^/]+)\/([^/]+)(?:\/channels\/([^/]+))?$/.exec(url.pathname);
      if(!trusted(url)||!match||decodeURIComponent(match[1])!==this.credential.tenant||match[2].toLowerCase()!==this.credential.workspace.toLowerCase())throw new ChatError('The room URL belongs to a different workspace or origin');
      wanted=match[3]||url.searchParams.get('channel');if(url.searchParams.get('thread')==='1')action=url.searchParams.get('action');
      if(!wanted||!UUID.test(wanted)||url.searchParams.get('thread')==='1'&&!UUID.test(action||''))throw new ChatError('Copy the room URL including its channel and, for a working thread, action and thread=1');
    }
    if(action){
      const view=(await this.request('/actions/'+action)).detail,a=view?.action;
      if(!a||a.parentChannelId.toLowerCase()!==wanted.toLowerCase()||!UUID.test(a.workingThreadId||'')||!a.conversationVertexId)throw new ChatError('The working thread is unavailable or does not belong to this channel');
      return {id:a.workingThreadId,name:a.title,conversationId:a.conversationVertexId,parentId:a.parentChannelId,actionId:a.id,workspace:this.credential.workspace,tenant:this.credential.tenant};
    }
    const rooms=await this.rooms(),matches=rooms.filter(r=>UUID.test(wanted)?r.id.toLowerCase()===wanted.toLowerCase():r.name.toLowerCase()===wanted.toLowerCase());
    if(matches.length!==1)throw new ChatError(matches.length?'The room name is ambiguous; use its full URL or channel ID':'No accessible room matches. Ask the host for the exact URL and private-channel membership.');
    if(!UUID.test(matches[0].id)||!Number.isSafeInteger(matches[0].conversationId)||matches[0].conversationId<=0)throw new ChatError('The room has no valid conversation ID');
    return {...matches[0],workspace:this.credential.workspace,tenant:this.credential.tenant};
  }
  conversation(room,operation,body){
    if(room.workspace!==this.credential.workspace||room.tenant!==this.credential.tenant||!UUID.test(room.id)||!Number.isSafeInteger(room.conversationId)||room.conversationId<=0||!['join','messages'].includes(operation))throw new ChatError('Invalid or mismatched selected room');
    const query=new URLSearchParams({tenant:room.tenant,path:'collaborations/'+room.workspace+'/channels/'+room.id});
    return jsonRequest(ORIGIN+'/api/conversations/'+room.conversationId+'/'+operation+'?'+query,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+this.credential.accessToken,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)},this.fetcher);
  }
  actionRoom(room){
    if(room.workspace!==this.credential.workspace||room.tenant!==this.credential.tenant||!UUID.test(room.id)||room.parentId)throw new ChatError('Select the parent room explicitly before using Actions');
  }
  actions(room){this.actionRoom(room);return this.request('/channels/'+room.id+'/actions');}
  createAction(room,body){this.actionRoom(room);if(!UUID.test(body.id||'')||typeof body.title!=='string'||!body.title.trim())throw new ChatError('Provide an Action ID and title');return this.request('/channels/'+room.id+'/actions',body);}
  async getAction(room,id){this.actionRoom(room);if(!UUID.test(id||''))throw new ChatError('Provide --action with an Action UUID');const view=await this.request('/actions/'+id);if(view.detail?.action?.parentChannelId!==room.id)throw new ChatError('The Action belongs to another room');return view;}
  async actionThread(room,id){await this.getAction(room,id);return this.request('/actions/'+id+'/thread',{});}
  async history(room){const messages=await this.conversation(room,'messages');if(!Array.isArray(messages))throw new ChatError('Unexpected history response');return messages;}
  async send(room,body,clientMessageId){if(typeof body!=='string'||!body.trim())throw new ChatError('Provide a nonempty message');await this.conversation(room,'join',{});return this.conversation(room,'messages',{body,clientMessageId});}
}
export function version(message){return String(message.revision??message.id)+':'+Boolean(message.deleted);}
export function unseen(messages,state,self){return messages.filter(m=>m&&m.id!=null&&m.participantKey!=='collab_'+self.replaceAll('-','')&&state.seen[String(m.id)]!==version(m));}
export function batch(messages){return createHash('sha256').update(JSON.stringify(messages.map(m=>[String(m.id),version(m)]).sort())).digest('hex').slice(0,24);}
export function digest(body){return createHash('sha256').update(body).digest('hex');}
