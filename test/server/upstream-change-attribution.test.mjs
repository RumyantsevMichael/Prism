// Acceptance tests for the review-upstream-changes slice (GitHub issue #55).
// A task-start snapshot T lets compare_change_map tell out-of-scope changes that the task made from changes that were already present when the task started.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {conservationStore as store,digest} from '../../dist/server/conservation/conservation-store.mjs';
import {updateChangeMap} from '../../dist/server/conservation/change-map.mjs';
import {compareChangeMap,ANALYSIS_VERSION} from '../../dist/server/conservation/conservation-analysis.mjs';
import {updateReview} from '../../dist/server/review/review-ledger.mjs';
import {callConservationTool,CONSERVATION_TOOLS} from '../../dist/server/conservation/conservation-tools.mjs';
import {assertInput} from '../../dist/server/workflow/artifact-schema.mjs';
import {CHUNKER_VERSION} from '../../dist/native-runtime/versions.mjs';

const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'prism-upstream-test-')));
store.directory=path.join(home,'evidence');
test.after(()=>rm(home,{recursive:true,force:true}));
const degraded={prepare:async()=>({status:'degraded',diagnostics:[{code:'unsupported_runtime',message:'Test without inference'}]})};
const ref=(file,value)=>({path:file,...(value?{selector:{type:'text',value}}:{})});
const deltaPath='docs/plans/task/change-map.json',reviewPath='docs/plans/task/review.json';

// B is the original baseline, T the task-start snapshot after upstream work, and F the result after the task's own edits.
async function scenario(extra={}) {
 const root=await mkdtemp(path.join(home,'project-'));
 const put=async(file,body)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),body);};
 const remove=file=>rm(path.join(root,file));
 for(const [file,body] of Object.entries({'rules.md':'old\n','requirements.md':'Requirement\n','src/legacy.ts':'export const legacy = 1;\n',...extra.base})) await put(file,body);
 const b=await store.capture(root,deltaPath);
 if(extra.analysis) await extra.analysis(root,b);
 const delta=await updateChangeMap({projectRoot:root,deltaPath,expectedRevision:null,scope:['rules.md'],baselineId:b.snapshotId,requirements:[ref('requirements.md')],
  operations:[{op:'insert',entry:{id:'r',kind:'rule',label:'r',action:'REPLACE',before:[ref('rules.md','old')],after:[ref('rules.md','new')],reason:'Satisfy the bound requirement.'}}]});
 // Upstream work after B: a merge from main changes and removes files, and another slice adds its plan.
 await put('src/upstream.ts','export const fromMain = 1;\n');
 await put('docs/plans/other-slice/plan.md','# Sibling plan\n');
 await remove('src/legacy.ts');
 for(const [file,body] of Object.entries(extra.upstream||{})) await put(file,body);
 const t=await store.capture(root);
 return {root,b,t,delta,put,remove};
}
async function finish(s,edit=async()=>{}) {
 await s.put('rules.md','new\n');await edit();
 return store.capture(s.root);
}
async function compare(s,f,startSnapshotId,options={runtime:degraded}) {
 const response=await compareChangeMap({projectRoot:s.root,deltaPath,expectedRevision:s.delta.revision,baselineId:s.b.snapshotId,resultSnapshotId:f.snapshotId,...(startSnapshotId?{startSnapshotId}:{})},options);
 return {response,comparison:await store.get(s.root,response.comparisonId,'comparison')};
}
const byCode=(comparison,code)=>comparison.observations.filter(item=>item.code===code);
const files=(observations)=>observations.map(item=>item.file).sort();
const upstreamFiles=['docs/plans/other-slice/plan.md','src/legacy.ts','src/upstream.ts'];

test('clause 2: without a task-start snapshot every out-of-scope change since B stays an outside_scope failure',async()=>{
 const s=await scenario();const f=await finish(s);
 const {comparison}=await compare(s,f);
 assert.deepEqual(files(byCode(comparison,'outside_scope')),upstreamFiles);
 assert.ok(byCode(comparison,'outside_scope').every(item=>item.severity==='failure'));
 assert.equal(byCode(comparison,'outside_scope_before_start').length,0);
});

test('clause 3: an out-of-scope change already present in T becomes one outside_scope_before_start review check per file',async()=>{
 const s=await scenario();const f=await finish(s);
 const {comparison}=await compare(s,f,s.t.snapshotId);
 assert.equal(byCode(comparison,'outside_scope').length,0);
 const attributed=byCode(comparison,'outside_scope_before_start');
 assert.deepEqual(files(attributed),upstreamFiles);
 assert.ok(attributed.every(item=>item.severity==='review_required'&&typeof item.id==='string'&&item.message.length>0));
});

test('clause 4: an out-of-scope file that differs between T and F stays an outside_scope failure',async()=>{
 const s=await scenario({base:{'src/gone.ts':'export const gone = 1;\n'}});
 const f=await finish(s,async()=>{
  await s.put('src/upstream.ts','export const fromMain = 2;\n');
  await s.put('src/task-helper.ts','export const helper = 1;\n');
  await s.remove('src/gone.ts');
  await s.put('src/legacy.ts','export const legacy = 2;\n');
 });
 const {comparison}=await compare(s,f,s.t.snapshotId);
 assert.deepEqual(files(byCode(comparison,'outside_scope')),['src/gone.ts','src/legacy.ts','src/task-helper.ts','src/upstream.ts']);
 assert.ok(byCode(comparison,'outside_scope').every(item=>item.severity==='failure'));
 assert.deepEqual(files(byCode(comparison,'outside_scope_before_start')),['docs/plans/other-slice/plan.md']);
});

test('clause 5: files inside the scope keep their judgment against B whatever T holds',async()=>{
 // T already holds part of the task's in-scope edit, so a comparison against T would hide it.
 const s=await scenario({upstream:{'rules.md':'new\nextra\n'}});
 const f=await finish(s,async()=>{await s.put('rules.md','new\nextra\n');});
 const inScope=comparison=>comparison.observations.filter(item=>item.file==='rules.md'||item.file===undefined).map(item=>item.id).sort();
 const without=(await compare(s,f)).comparison,withT=(await compare(s,f,s.t.snapshotId)).comparison;
 assert.ok(without.observations.some(item=>item.file==='rules.md'));
 assert.deepEqual(inScope(withT),inScope(without));
 assert.deepEqual(withT.measurements,without.measurements);
 assert.deepEqual(withT.growth,without.growth);
 assert.deepEqual(withT.units,without.units);
});

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
// A retained analysis whose units are the functions of each .mjs file, so that the comparison runs the detectors.
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

test('clause 6: detector findings do not name a file that T attributes to work before the task',async()=>{
 const s=await scenario({base:{'src/trace.mjs':lockOwner,'src/facts.mjs':lockOwner},upstream:{'src/data.mjs':lockOwner},analysis:functionAnalysis});
 const f=await finish(s);await functionAnalysis(s.root,f);
 const without=(await compare(s,f)).comparison;
 assert.ok(byCode(without,'duplication_introduced').some(item=>item.file==='src/data.mjs'),'the control comparison runs the detectors');
 const withT=(await compare(s,f,s.t.snapshotId)).comparison;
 assert.equal(withT.observations.some(item=>item.file==='src/data.mjs'&&item.code!=='outside_scope_before_start'),false);
 assert.deepEqual(files(byCode(withT,'outside_scope_before_start')),['docs/plans/other-slice/plan.md','src/data.mjs','src/legacy.ts','src/upstream.ts']);
});

test('clause 7: the response and the retained comparison name the task-start snapshot, or null without one',async()=>{
 const s=await scenario();const f=await finish(s);
 const withT=await compare(s,f,s.t.snapshotId);
 assert.equal(withT.response.startSnapshotId,s.t.snapshotId);
 assert.equal(withT.comparison.startSnapshotId,s.t.snapshotId);
 const page=await callConservationTool('get_conservation_evidence',{projectRoot:s.root,evidenceId:withT.response.comparisonId});
 assert.equal(page.startSnapshotId,s.t.snapshotId);
 const without=await compare(s,f);
 assert.equal(without.response.startSnapshotId,null);
 assert.equal(without.comparison.startSnapshotId,null);
});

test('clause 1: the compare_change_map tool takes an optional startSnapshotId and keeps B as the only accepted baseline',async()=>{
 const schema=CONSERVATION_TOOLS.find(tool=>tool.name==='compare_change_map').inputSchema;
 assert.deepEqual(schema.properties.startSnapshotId,{type:'string',pattern:'^[a-f0-9]{64}$'});
 assert.equal(schema.required.includes('startSnapshotId'),false);
 assert.match(CONSERVATION_TOOLS.find(tool=>tool.name==='compare_change_map').description,/startSnapshotId/);
 const s=await scenario();const f=await finish(s);
 const input={projectRoot:s.root,deltaPath,expectedRevision:s.delta.revision,baselineId:s.b.snapshotId,resultSnapshotId:f.snapshotId};
 // The published schema accepts the field; the comparison itself runs in-process without native inference.
 assert.doesNotThrow(()=>assertInput(schema,{...input,startSnapshotId:s.t.snapshotId}));
 await assert.rejects(callConservationTool('compare_change_map',{...input,baselineId:s.t.snapshotId,startSnapshotId:s.t.snapshotId}),error=>error.code==='validation_failed'&&/original baseline/.test(error.message));
});

test('clause 8: a startSnapshotId that is malformed or not a retained snapshot of this project is refused',async()=>{
 const s=await scenario();const f=await finish(s);
 const input={projectRoot:s.root,deltaPath,expectedRevision:s.delta.revision,baselineId:s.b.snapshotId,resultSnapshotId:f.snapshotId};
 await assert.rejects(callConservationTool('compare_change_map',{...input,startSnapshotId:'not-a-hash'}),{code:'validation_failed'});
 await assert.rejects(compareChangeMap({...input,startSnapshotId:'a'.repeat(64)},{runtime:degraded}),{code:'evidence_missing'});
 const comparisonId=(await compareChangeMap(input,{runtime:degraded})).comparisonId;
 await assert.rejects(compareChangeMap({...input,startSnapshotId:comparisonId},{runtime:degraded}),{code:'evidence_missing'});
 const other=await scenario();
 await assert.rejects(compareChangeMap({...input,startSnapshotId:other.t.snapshotId},{runtime:degraded}),{code:'evidence_missing'});
});

async function auditWave(s,f,comparisonId) {
 let revision=null;const coordinator={id:'coordinator',role:'coordinator'},reviewer={id:'reviewer',role:'reviewer'};
 const act=async(actor,operations)=>{const r=await updateReview({projectRoot:s.root,reviewPath,deltaPath,delivery:'delivery',expectedRevision:revision,actor,operations});revision=r.revision;return r;};
 await act(coordinator,[{op:'start_wave',id:'audit',mode:'design-audit',deltaRevision:s.delta.revision,snapshotId:f.snapshotId,comparisonId,lanes:[{id:'main',reviewer:'reviewer',coverage:['rules.md']}]}]);
 const requirement=ref('requirements.md');
 await act(reviewer,[{op:'record_assessment',assessment:{id:'converge',lane:'main',kind:'convergence',reason:'Fixture assessment of the replaced rule.',evidence:[requirement],section:ref('rules.md'),decision:'replace',conceptIds:['r'],coverage:[{requirement,targets:[ref('rules.md','new')]}]}},{op:'submit_lane',lane:'main',status:'CLEAN'}]);
 return {review:operations=>act(reviewer,operations),accept:()=>act(coordinator,[{op:'accept_wave'}])};
}
const manual=(id,observationIds)=>({op:'record_assessment',assessment:{id,lane:'main',kind:'manual',reason:'The files match the merged main branch and the sibling slice plan; the task did not change them.',evidence:[ref('requirements.md')],observationIds}});

test('clause 9: one manual assessment by the assigned reviewer clears every outside_scope_before_start check',async()=>{
 const s=await scenario();const f=await finish(s);
 const {response,comparison}=await compare(s,f,s.t.snapshotId);
 const attributed=byCode(comparison,'outside_scope_before_start').map(item=>item.id);
 assert.equal(attributed.length,3);
 const wave=await auditWave(s,f,response.comparisonId);
 await assert.rejects(wave.accept(),error=>error.code==='gate_blocked'&&attributed.every(id=>error.problems.some(problem=>problem.code==='manual_evidence_missing'&&problem.id===id)));
 const others=comparison.observations.filter(item=>item.severity==='review_required'&&!attributed.includes(item.id)).map(item=>item.id);
 await wave.review([manual('before-start',[...attributed,...others]),{op:'submit_lane',lane:'main',status:'CLEAN'}]);
 await wave.accept();
});

test('clause 10: an outside_scope failure next to attributed files still blocks acceptance and cannot be waived',async()=>{
 const s=await scenario();const f=await finish(s,()=>s.put('src/task-helper.ts','export const helper = 1;\n'));
 const {response,comparison}=await compare(s,f,s.t.snapshotId);
 const failure=byCode(comparison,'outside_scope');
 assert.deepEqual(files(failure),['src/task-helper.ts']);
 const wave=await auditWave(s,f,response.comparisonId);
 await assert.rejects(wave.review([manual('waiver',[failure[0].id])]),error=>error.code==='gate_blocked'&&/cannot waive/.test(error.message));
 await wave.review([manual('before-start',comparison.observations.filter(item=>item.severity==='review_required').map(item=>item.id)),{op:'submit_lane',lane:'main',status:'CLEAN'}]);
 await assert.rejects(wave.accept(),error=>error.code==='gate_blocked'&&error.problems.some(problem=>problem.code==='outside_scope'&&problem.id===failure[0].id)
  &&!error.problems.some(problem=>problem.code==='manual_evidence_missing'));
});
