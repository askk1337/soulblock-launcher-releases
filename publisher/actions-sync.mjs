import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {validatePublicMetadata,validateCurrentTimestamp} from './public-metadata.mjs';
import {publishSignedFreshness} from './github-freshness.mjs';
const config=JSON.parse(readFileSync(new URL('./release.json',import.meta.url),'utf8'));
const token=process.env.GITHUB_TOKEN;
if(process.env.GITHUB_REPOSITORY!=='askk1337/soulblock-launcher-releases'||typeof token!=='string'||!token)throw Error('Repository-scoped workflow required');
if(config.schema!==1||config.source!=='https://origin-api.soulblock.ru/publisher/dragonring-07/metadata/'||!Number.isSafeInteger(config.releaseId)||!/^v\d+\.\d+\.\d+$/.test(config.tag))throw Error('Invalid publisher configuration');
async function get(address,authenticated=false){
 const r=await fetch(address,{headers:authenticated?{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}:{Accept:'application/json'},redirect:authenticated?'error':'follow',signal:AbortSignal.timeout(25000)});
 if(!r.ok)throw Error('Metadata transport HTTP '+r.status);
 if(!authenticated){const u=new URL(r.url);if(u.protocol!=='https:'||!['origin-api.soulblock.ru','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw Error('Unapproved metadata destination')}
 const reader=r.body.getReader(),chunks=[];let size=0;try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw Error('Metadata exceeds bound');chunks.push(value)}}finally{await reader.cancel()};return Buffer.concat(chunks);
}
const api='https://api.github.com/repos/askk1337/soulblock-launcher-releases';
const live=JSON.parse(await get(api+'/releases/latest',true));
if(live.id!==config.releaseId||live.tag_name!==config.tag||live.draft||live.prerelease){console.log(JSON.stringify({updated:false,reason:'configured-release-not-live'}));process.exit(0)}
const names=['1.root.json',config.policy.root,config.policy.targets,'timestamp.json'];
const files=new Map(await Promise.all(names.map(async name=>{if(!/^(?:timestamp|\d+\.(?:root|targets))\.json$/.test(name))throw Error('Invalid metadata name');return[name,await get(config.source+name)]})));
const stamp=JSON.parse(files.get('timestamp.json')),version=stamp.signed?.meta?.['snapshot.json']?.version;
if(!Number.isSafeInteger(version)||version<1||version>2_000_000_000)throw Error('Invalid snapshot version');
files.set(version+'.snapshot.json',await get(config.source+version+'.snapshot.json'));
const checked=validatePublicMetadata({bootstrapBytes:files.get('1.root.json'),rootBytes:files.get(config.policy.root),targetsBytes:files.get(config.policy.targets),timestampBytes:files.get('timestamp.json'),snapshotBytes:files.get(version+'.snapshot.json'),pins:config.pins});
const previous=await get('https://github.com/askk1337/soulblock-launcher-releases/releases/download/'+config.tag+'/timestamp.json');
if(checked.version<validateCurrentTimestamp(previous,checked.root))throw Error('Freshness rollback refused');
const directory=mkdtempSync(path.join(os.tmpdir(),'sb-publisher-public-'));mkdirSync(path.join(directory,'metadata'));writeFileSync(path.join(directory,'freshness.json'),JSON.stringify(config.policy));
for(const[name,bytes]of files)writeFileSync(path.join(directory,'metadata',name),bytes);
console.log(JSON.stringify(await publishSignedFreshness({directory,githubToken:token,releaseId:config.releaseId,tag:config.tag})));
