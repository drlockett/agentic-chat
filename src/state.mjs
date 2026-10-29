import {open,mkdir,rename,unlink,readFile,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ChatError,scope} from './client.mjs';
export async function readPrivate(file){
  const info=await stat(file);if(process.platform!=='win32'&&(info.mode&0o077)!==0)throw new ChatError('Credential and state files must have owner-only permissions (chmod 600)');
  if(info.size>8*1024*1024)throw new ChatError('Local state exceeds the size limit');
  try{return JSON.parse(await readFile(file,'utf8'))}catch{throw new ChatError('Cannot read the private JSON file');}
}
export async function savePrivate(file,value,exclusive=false){
  await mkdir(dirname(file),{recursive:true,mode:0o700});const target=exclusive?file:file+'.'+randomUUID()+'.tmp';let handle;
  try{handle=await open(target,'wx',0o600);await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();await handle.close();handle=null;if(!exclusive)await rename(target,file);}
  catch(error){if(handle)await handle.close().catch(()=>{});if(!exclusive)await unlink(target).catch(()=>{});throw error;}
}
export function requireState(state,credential){
  if(state.scope!==scope(credential)||state.memberId!==credential.memberId||!state.room||state.room.workspace!==credential.workspace||state.room.tenant!==credential.tenant||!state.seen||typeof state.seen!=='object'||!state.outbox||typeof state.outbox!=='object')throw new ChatError('State belongs to a different agent or workspace; select the intended room with a separate state file');
  return state;
}
export async function locked(file,fn){
  await mkdir(dirname(file),{recursive:true,mode:0o700});const lock=file+'.lock',token=randomUUID();
  try{await savePrivate(lock,{pid:process.pid,token},true)}catch(error){
    if(error.code!=='EEXIST')throw error;
    throw new ChatError('Room state is locked. Wait for the active command; after a crash, verify its recorded PID is stopped before removing only the .lock file.');
  }
  try{return await fn()}finally{try{const owner=JSON.parse(await readFile(lock,'utf8'));if(owner.token===token)await unlink(lock)}catch{}}
}
