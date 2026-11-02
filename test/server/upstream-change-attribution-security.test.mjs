// Review finding review-security-2/attributed-member-hides-task-copy: a task copy of an upstream function into an in-scope file must stay a detector finding when T attributes the upstream file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {conservationStore as store,digest} from '../../dist/server/conservation/conservation-store.mjs';
import {updateChangeMap} from '../../dist/server/conservation/change-map.mjs';
import {compareChangeMap,ANALYSIS_VERSION} from '../../dist/server/conservation/conservation-analysis.mjs';
import {CHUNKER_VERSION} from '../../dist/native-runtime/versions.mjs';

const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'prism-upstream-security-')));
store.directory=path.join(home,'evidence');
test.after(()=>rm(home,{recursive:true,force:true}));
const degraded={prepare:async()=>({status:'degraded',diagnostics:[{code:'unsupported_runtime',message:'Test without inference'}]})};
const ref=(file,value)=>({path:file,...(value?{selector:{type:'text',value}}:{})});
const key={initiative:'task',slice:'task'};
const lockOwner=`function readLockOwner(lockPath) {
  const text = readFileSync(lockPath, "utf8");
  const owner = JSON.parse(text);
  if (!owner.pid) return null;
  if (owner.token.length !== 36) return null;
  const alive = processState(owner.pid);
  if (!alive) return null;
  const age = Date.now() - owner.createdAt;
  if (age > LOCK_STALE_MS) return null;
  return { pid: owner.pid, token: owner.token };
}
`;
async function functionAnalysis(root,snapshot) {
 const units=[];
 for(const file of snapshot.snapshot.files.filter(item=>item.file.endsWith('.mjs'))) {
  const text=(await store.bytes(root,file)).toString('utf8');
  for(const match of text.matchAll(/function (\w+)\([^)]*\) \{[\s\S]*?\n\}/g)) {
   const startLine=text.slice(0,match.index).split('\n').length,endLine=startLine+match[0].split('\n').length-1;
   units.push({id:`${file.file}#${match[1]}`,file:file.file,domain:'code',kind:'function',name:match[1],selector:match[1],range:{startLine,endLine},span:{start:match.index,end:match.index+match[0].length},sourceHash:file.hash,contentHash:digest(match[0]),isExported:false});
  }
 }
 const record={kind:'analysis',schemaVersion:1,project:root,snapshotId:snapshot.snapshotId,units,edges:[],unresolvedReferences:[],fileCoverage:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,true])),diagnostics:[],tokenCounts:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,1])),structureCounts:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,{sections:0,paragraphs:0,listItems:0,links:0}])),versions:{extractor:CHUNKER_VERSION,metrics:ANALYSIS_VERSION,tokenizer:'fixture'}};
 await store.link(root,snapshot.snapshotId,await store.put(root,record));
}

test('a task copy of an upstream function into an in-scope file stays a detector finding with T',async()=>{
 const root=await mkdtemp(path.join(home,'project-'));
 const put=async(file,body)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),body);};
 for(const [file,body] of Object.entries({'rules.md':'old\n','requirements.md':'Requirement\n','src/trace.mjs':'export const x = 1;\n'})) await put(file,body);
 const b=await store.capture(root,key);await functionAnalysis(root,b);
 const scope=['rules.md','src/trace.mjs'];
 const delta=await updateChangeMap({projectRoot:root,...key,expectedRevision:null,scope,baselineId:b.snapshotId,requirements:[ref('requirements.md')],
  operations:[{op:'insert',entry:{id:'r',kind:'rule',label:'r',action:'REPLACE',before:[ref('rules.md','old')],after:[ref('rules.md','new')],reason:'Satisfy the bound requirement.'}}]});
 // A merge from main adds readLockOwner outside the scope.
 await put('src/a.mjs',lockOwner);
 const t=await store.capture(root);
 // The task copies readLockOwner into an in-scope file.
 await put('rules.md','new\n');await put('src/trace.mjs','export const x = 1;\n'+lockOwner);
 const f=await store.capture(root);await functionAnalysis(root,f);
 const withT=await store.get(root,(await compareChangeMap({projectRoot:root,...key,expectedRevision:delta.revision,baselineId:b.snapshotId,resultSnapshotId:f.snapshotId,startSnapshotId:t.snapshotId},{runtime:degraded})).comparisonId,'comparison');
 assert.equal(withT.observations.some(item=>item.code==='duplication_introduced'),true,`The task's new copy is reported: ${JSON.stringify(withT.observations.map(item=>[item.code,item.file,item.severity]))}`);
});
