// Review finding review-correctness-1/upstream-copy-blames-scope: an upstream copy of a function that an in-scope file holds must not move a detector failure onto the in-scope file.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,mkdir,rm,appendFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {conservationStore as store,digest} from '../../dist/server/conservation/conservation-store.mjs';
import {updateChangeMap} from '../../dist/server/conservation/change-map.mjs';
import {compareChangeMap,ANALYSIS_VERSION} from '../../dist/server/conservation/conservation-analysis.mjs';
import {CHUNKER_VERSION} from '../../dist/native-runtime/versions.mjs';

const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'prism-upstream-review-')));
store.directory=path.join(home,'evidence');
test.after(()=>rm(home,{recursive:true,force:true}));
const degraded={prepare:async()=>({status:'degraded',diagnostics:[{code:'unsupported_runtime',message:'Test without inference'}]})};
const ref=(file,value)=>({path:file,...(value?{selector:{type:'text',value}}:{})});
const deltaPath='docs/plans/task/change-map.json';
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

test('an upstream copy of a function in a changed in-scope file keeps the in-scope observations of a comparison without T',async()=>{
 const root=await mkdtemp(path.join(home,'project-'));
 const put=async(file,body)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),body);};
 for(const [file,body] of Object.entries({'rules.md':'old\n','requirements.md':'Requirement\n','src/trace.mjs':lockOwner})) await put(file,body);
 const b=await store.capture(root,deltaPath);await functionAnalysis(root,b);
 const scope=['rules.md','src/trace.mjs'];
 const delta=await updateChangeMap({projectRoot:root,deltaPath,expectedRevision:null,scope,baselineId:b.snapshotId,requirements:[ref('requirements.md')],
  operations:[{op:'insert',entry:{id:'r',kind:'rule',label:'r',action:'REPLACE',before:[ref('rules.md','old')],after:[ref('rules.md','new')],reason:'Satisfy the bound requirement.'}}]});
 // A merge from main adds a copy of readLockOwner outside the scope.
 await put('src/data.mjs',lockOwner);
 const t=await store.capture(root);
 // The task edits only in-scope files.
 await put('rules.md','new\n');await appendFile(path.join(root,'src/trace.mjs'),'// note\n');
 const f=await store.capture(root);await functionAnalysis(root,f);
 const run=async startSnapshotId=>store.get(root,(await compareChangeMap({projectRoot:root,deltaPath,expectedRevision:delta.revision,baselineId:b.snapshotId,resultSnapshotId:f.snapshotId,...(startSnapshotId?{startSnapshotId}:{})},{runtime:degraded})).comparisonId,'comparison');
 const without=await run(),withT=await run(t.snapshotId);
 const inScope=comparison=>comparison.observations.filter(item=>item.file&&scope.includes(item.file)).map(item=>`${item.code}:${item.file}:${item.severity}`).sort();
 assert.deepEqual(inScope(withT),inScope(without));
 assert.equal(withT.observations.some(item=>item.severity==='failure'),false,`T leaves only review checks: ${JSON.stringify(withT.observations.filter(item=>item.severity==='failure').map(item=>[item.code,item.file]))}`);
});
