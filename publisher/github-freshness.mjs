import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const REPO='askk1337/soulblock-launcher-releases';
const API='https://api.github.com/repos/'+REPO;
const UPLOAD='https://uploads.github.com/repos/'+REPO;
const hash=b=>createHash('sha256').update(b).digest('hex');

// This publisher can update only snapshot/timestamp assets on the explicitly
// selected live release. Approved roots, targets, installers and game files
// are never changed by this online service.
export async function publishSignedFreshness({directory,githubToken,releaseId,tag,fetcher=fetch}){
 if(!Number.isSafeInteger(releaseId)||releaseId<1||!/^v\d+\.\d+\.\d+$/.test(tag)||typeof githubToken!=='string'||!githubToken)throw Error('Invalid publication configuration');
 const policy=JSON.parse(readFileSync(path.join(directory,'freshness.json'),'utf8'));
 const metadata=path.join(directory,'metadata'),approved=JSON.parse(readFileSync(path.join(metadata,policy.targets),'utf8'));
 if(!Object.hasOwn(approved.signed.targets,'SoulBlockLauncher-'+tag.slice(1)+'-setup.exe'))throw Error('Release installer not approved');
 const timestamp=readFileSync(path.join(metadata,'timestamp.json')),stamp=JSON.parse(timestamp),version=stamp.signed.meta['snapshot.json'].version;
 if(!Number.isSafeInteger(version)||version<1)throw Error('Invalid snapshot version');
 const snapshotName=version+'.snapshot.json',snapshot=readFileSync(path.join(metadata,snapshotName));
 if(hash(snapshot)!==stamp.signed.meta['snapshot.json'].hashes.sha256)throw Error('Snapshot binding changed');
 async function call(address,method='GET',body,type='application/json'){
  const r=await fetcher(address,{method,headers:{Authorization:'Bearer '+githubToken,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'SoulBlock-Publisher-Freshness','Content-Type':type},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!r.ok)throw Error('Publisher transport HTTP '+r.status);return r.json();
 }
 const release=await call(API+'/releases/'+releaseId),latest=await call(API+'/releases/latest');
 if(release.id!==releaseId||latest.id!==releaseId||release.tag_name!==tag||release.draft||release.prerelease)throw Error('Configured publisher release is not live/latest');
 const assets=[];
 for(let page=1;page<=30;page++){
  const rows=await call(API+'/releases/'+releaseId+'/assets?per_page=100&page='+page);if(!Array.isArray(rows))throw Error('Invalid asset index');assets.push(...rows);if(rows.length<100)break;if(page===30)throw Error('Publisher asset index capacity reached');
 }
 const find=name=>{const rows=assets.filter(a=>a.name===name);if(rows.length>1)throw Error('Ambiguous publisher asset');return rows[0]};
 const exact=(asset,bytes)=>asset&&asset.state==='uploaded'&&asset.size===bytes.length&&asset.digest==='sha256:'+hash(bytes);
 for(const name of [policy.root,policy.targets])if(!exact(find(name),readFileSync(path.join(metadata,name))))throw Error('Live offline approval does not match');
 async function upload(name,bytes){
  const old=find(name);if(old){if(!exact(old,bytes))throw Error('Immutable publisher asset differs');return old;}
  const asset=await call(UPLOAD+'/releases/'+releaseId+'/assets?name='+encodeURIComponent(name),'POST',bytes);
  if(asset.name!==name||!Number.isSafeInteger(asset.id)||!exact(asset,bytes))throw Error('Uploaded publisher digest mismatch');assets.push(asset);return asset;
 }
 await upload(snapshotName,snapshot);
 const current=find('timestamp.json');
 if(exact(current,timestamp))return{updated:false,version:stamp.signed.version,expires:stamp.signed.expires};
 const pending=await upload('timestamp.pending.'+hash(timestamp).slice(0,16)+'.json',timestamp);
 async function rename(asset,name){
  if(!Number.isSafeInteger(asset.id)||asset.id<1||!/^timestamp(?:\.pending\.[a-f0-9]{16}|\.retired\.\d+)?\.json$/.test(asset.name)||!/^timestamp(?:\.retired\.\d+)?\.json$/.test(name))throw Error('Refusing non-freshness asset mutation');
  const result=await call(API+'/releases/assets/'+asset.id,'PATCH',{name});if(result.id!==asset.id||result.name!==name||result.digest!==asset.digest||result.size!==asset.size)throw Error('Renamed publisher digest mismatch');Object.assign(asset,result);return result;
 }
 if(current)await rename(current,'timestamp.retired.'+current.id+'.json');
 try{await rename(pending,'timestamp.json');}
 catch(error){
  // Preserve availability if GitHub rejects the second rename. If it actually
  // committed but its response was lost, the name conflict preserves the new
  // valid timestamp and the next invocation observes it without duplicating it.
  if(current)try{await rename(current,'timestamp.json');}catch{}
  throw error;
 }
 return{updated:true,version:stamp.signed.version,expires:stamp.signed.expires};
}
