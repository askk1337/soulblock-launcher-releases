import {createHash,createPublicKey,verify} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
function canonical(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return'['+v.map(canonical).join(',')+']';return'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'}
function document(bytes){if(!Buffer.isBuffer(bytes)||bytes.length>2*1024*1024)throw Error('Invalid metadata size');const doc=JSON.parse(bytes);if(!doc?.signed||!Array.isArray(doc.signatures)||!Number.isSafeInteger(doc.signed.version)||doc.signed.version<1)throw Error('Invalid metadata document');return doc}
function role(doc,root,name,now){
 const policy=root.signed.roles[name],accepted=new Set();if(!policy||!Number.isSafeInteger(policy.threshold)||policy.threshold<1||!Array.isArray(policy.keyids))throw Error('Invalid role policy');
 if(!Number.isFinite(Date.parse(doc.signed.expires))||Date.parse(doc.signed.expires)<=now)throw Error('Expired metadata');
 const message=Buffer.from(canonical(doc.signed));
 for(const signature of doc.signatures){
  const k=root.signed.keys[signature.keyid];if(!policy.keyids.includes(signature.keyid)||!k||k.keytype!=='ed25519'||k.scheme!=='ed25519'||!/^[a-f0-9]{64}$/.test(k.keyval?.public||'')||!/^[a-f0-9]{128}$/.test(signature.sig||''))continue;
  const publicKey=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:Buffer.from(k.keyval.public,'hex').toString('base64url')},format:'jwk'});
  if(verify(null,message,publicKey,Buffer.from(signature.sig,'hex')))accepted.add(signature.keyid);
 }
 if(accepted.size<policy.threshold)throw Error('Metadata signature threshold failed');
}
function bound(bytes,doc,entry){if(!entry||entry.version!==doc.signed.version||entry.length!==bytes.length||entry.hashes?.sha256!==hash(bytes))throw Error('Metadata binding failed')}
export function validatePublicMetadata({bootstrapBytes,rootBytes,targetsBytes,snapshotBytes,timestampBytes,pins,now=Date.now()}){
 for(const [name,bytes]of [['bootstrap',bootstrapBytes],['root',rootBytes],['targets',targetsBytes]])if(!/^[a-f0-9]{64}$/.test(pins[name]||'')||hash(bytes)!==pins[name])throw Error('Offline approval pin mismatch');
 const bootstrap=document(bootstrapBytes),root=document(rootBytes),targets=document(targetsBytes),snapshot=document(snapshotBytes),timestamp=document(timestampBytes);
 if(bootstrap.signed._type!=='root'||bootstrap.signed.version!==1||root.signed._type!=='root'||root.signed.version!==2||targets.signed._type!=='targets'||snapshot.signed._type!=='snapshot'||timestamp.signed._type!=='timestamp')throw Error('Wrong metadata role');
 role(root,bootstrap,'root',now);role(root,root,'root',now);role(targets,root,'targets',now);role(snapshot,root,'snapshot',now);role(timestamp,root,'timestamp',now);
 bound(targetsBytes,targets,snapshot.signed.meta?.['targets.json']);bound(snapshotBytes,snapshot,timestamp.signed.meta?.['snapshot.json']);
 if(Date.parse(timestamp.signed.expires)>now+25*3600000||timestamp.signed.version!==snapshot.signed.version)throw Error('Invalid freshness policy');
 return{root,timestamp,version:timestamp.signed.version,expires:timestamp.signed.expires};
}
export function validateCurrentTimestamp(bytes,root,now=Date.now()){
 const doc=document(bytes);if(doc.signed._type!=='timestamp')throw Error('Wrong current role');
 // Expired but correctly signed previous metadata still sets the version floor.
 const expires=Date.parse(doc.signed.expires);if(!Number.isFinite(expires))throw Error('Invalid previous expiry');role(doc,root,'timestamp',Math.min(now,expires-1));return doc.signed.version;
}
