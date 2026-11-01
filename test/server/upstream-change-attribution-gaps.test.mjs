// Review findings t-omission-as-absence and t-recapture-launders-failure for the review-upstream-changes slice.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {conservationStore as store} from '../../dist/server/conservation/conservation-store.mjs';
import {updateChangeMap} from '../../dist/server/conservation/change-map.mjs';
import {compareChangeMap} from '../../dist/server/conservation/conservation-analysis.mjs';

const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'prism-upstream-gaps-')));
store.directory=path.join(home,'evidence');
test.after(()=>rm(home,{recursive:true,force:true}));
const degraded={prepare:async()=>({status:'degraded',diagnostics:[{code:'unsupported_runtime',message:'Test without inference'}]})};
const ref=(file,value)=>({path:file,...(value?{selector:{type:'text',value}}:{})});
const deltaPath='docs/plans/task/change-map.json';

// B holds src/legacy.ts, upstream work removes it and adds src/upstream.ts before T, and the task edits only rules.md.
async function scenario() {
 const root=await mkdtemp(path.join(home,'project-'));
 const put=async(file,body)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),body);};
 for(const [file,body] of Object.entries({'rules.md':'old\n','requirements.md':'Requirement\n','src/legacy.ts':'export const legacy = 1;\n'})) await put(file,body);
 const b=await store.capture(root,deltaPath);
 const delta=await updateChangeMap({projectRoot:root,deltaPath,expectedRevision:null,scope:['rules.md'],baselineId:b.snapshotId,requirements:[ref('requirements.md')],
  operations:[{op:'insert',entry:{id:'r',kind:'rule',label:'r',action:'REPLACE',before:[ref('rules.md','old')],after:[ref('rules.md','new')],reason:'Satisfy the bound requirement.'}}]});
 await rm(path.join(root,'src/legacy.ts'));await put('src/upstream.ts','export const fromMain = 1;\n');
 const t=await store.capture(root);
 await put('rules.md','new\n');
 const f=await store.capture(root);
 const compare=async startSnapshotId=>store.get(root,(await compareChangeMap({projectRoot:root,deltaPath,expectedRevision:delta.revision,baselineId:b.snapshotId,resultSnapshotId:f.snapshotId,startSnapshotId},{runtime:degraded})).comparisonId,'comparison');
 return {root,t,compare};
}
const byCode=(comparison,code)=>comparison.observations.filter(item=>item.code===code).map(item=>item.file).sort();
const variant=async (s,change)=>store.put(s.root,{...s.t.snapshot,...change(s.t.snapshot)});

test('a file that T omits is not attributed and stays an outside_scope failure',async()=>{
 const s=await scenario();
 const omitted=await variant(s,snapshot=>({files:snapshot.files.filter(item=>item.file!=='src/upstream.ts'),omissions:[{file:'src/legacy.ts',reason:'unreadable'},{file:'src/upstream.ts',reason:'unreadable'}],complete:false,unknownOmissions:false}));
 const comparison=await s.compare(omitted);
 assert.deepEqual(byCode(comparison,'outside_scope'),['src/legacy.ts','src/upstream.ts']);
 assert.deepEqual(byCode(comparison,'outside_scope_before_start'),[]);
 assert.equal(comparison.observations.some(item=>item.code==='source_inventory_incomplete'),false);
});

test('a file that T excludes is not attributed and stays an outside_scope failure',async()=>{
 const s=await scenario();
 const excluded=await variant(s,snapshot=>({exclusions:[...snapshot.exclusions,'src/legacy.ts']}));
 const comparison=await s.compare(excluded);
 assert.deepEqual(byCode(comparison,'outside_scope'),['src/legacy.ts']);
 assert.deepEqual(byCode(comparison,'outside_scope_before_start'),['src/upstream.ts']);
});

test('an incomplete T with unknown omissions reports source_inventory_incomplete as B and F do',async()=>{
 const s=await scenario();
 const incomplete=await variant(s,()=>({complete:false,unknownOmissions:true}));
 const comparison=await s.compare(incomplete);
 assert.ok(comparison.observations.some(item=>item.code==='source_inventory_incomplete'&&item.severity==='failure'));
});

test('each outside_scope_before_start observation names its T, and a different T gives different observation IDs',async()=>{
 const s=await scenario();
 const first=await s.compare(s.t.snapshotId);
 const other=await variant(s,snapshot=>({diagnostics:[...snapshot.diagnostics,{code:'recaptured',message:'A later capture'}]}));
 const second=await s.compare(other);
 const attributed=comparison=>comparison.observations.filter(item=>item.code==='outside_scope_before_start');
 assert.ok(attributed(first).length>0);
 assert.ok(attributed(first).every(item=>item.startSnapshotId===s.t.snapshotId));
 assert.ok(attributed(second).every(item=>item.startSnapshotId===other));
 const ids=new Set(attributed(first).map(item=>item.id));
 assert.equal(attributed(second).some(item=>ids.has(item.id)),false);
});
