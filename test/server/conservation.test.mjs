import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,mkdir,rm,symlink,chmod,lstat,utimes} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {conservationStore as store,canonical,digest} from '../../dist/server/conservation/conservation-store.mjs';
import {privateDirectory,regularBytes} from '../../dist/server/repository-intelligence/native-semantic-runtime.mjs';
import {updateChangeMap,getChangeMap} from '../../dist/server/conservation/change-map.mjs';
import {compareChangeMap,assessDeltaReadiness,prepareAnalysis,ANALYSIS_VERSION} from '../../dist/server/conservation/conservation-analysis.mjs';
import {updateReview,getReview,checkReviewGate} from '../../dist/server/review/review-ledger.mjs';
import {updateCoordinationState,checkpointPause} from '../../dist/server/workflow/state.mjs';
import {callConservationTool} from '../../dist/server/conservation/conservation-tools.mjs';
import {applyActiveOperations} from '../../dist/server/workflow/active-operations.mjs';
import {writeAtomically} from '../../dist/server/workflow/artifact-store.mjs';
import {CHUNKER_VERSION} from '../../dist/native-runtime/versions.mjs';
const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'prism-conservation-test-')));
store.directory=path.join(home,'evidence');
test.after(()=>rm(home,{recursive:true,force:true}));
const degraded={prepare:async()=>({status:'degraded',diagnostics:[{code:'unsupported_runtime',message:'Test without inference'}]})};
async function fixture(files={}) {
 const root=await mkdtemp(path.join(home,'project-'));
 for(const [file,body] of Object.entries(files)) {await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),body);}
 const deltaPath='plan/slice/change-map.json',reviewPath='plan/slice/review.json';
 const b=await store.capture(root,deltaPath);
 return {root,deltaPath,reviewPath,b,update:args=>updateChangeMap({projectRoot:root,deltaPath,...args})};
}
const ref=(path,value)=>({path,...(value?{selector:{type:'text',value}}:{})});
const entry=(id,action,before,after,extra={})=>({id,kind:'rule',label:id,action,before,after,reason:'Satisfy the bound requirement.',...extra});
async function analysis(root,snapshot,units=[]) {
 const record={kind:'analysis',schemaVersion:1,project:root,snapshotId:snapshot.snapshotId,units,fileCoverage:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,true])),diagnostics:[],tokenCounts:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,1])),structureCounts:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,{sections:0,paragraphs:0,listItems:0,links:0}])),versions:{extractor:CHUNKER_VERSION,metrics:ANALYSIS_VERSION,tokenizer:'fixture'}};
 const id=await store.put(root,record); await store.link(root,snapshot.snapshotId,id); return record;
}
async function compare(f,delta,result) {const response=await compareChangeMap({projectRoot:f.root,deltaPath:f.deltaPath,expectedRevision:delta.revision,baselineId:f.b.snapshotId,resultSnapshotId:result.snapshotId},{runtime:degraded});return store.get(f.root,response.comparisonId,'comparison');}
function privateFunctions(snapshot,text) {
 return [...text.matchAll(/function (\w+)\(\) \{ return \d; \}/g)].map(match=>({id:match[1],file:'code.ts',domain:'code',kind:'function',name:match[1],selector:match[1],span:{start:match.index,end:match.index+match[0].length},sourceHash:snapshot.snapshot.files.find(file=>file.file==='code.ts').hash,contentHash:digest(match[0]),isExported:false}));
}

test('behavior-changing newlines outside declarations cannot pass an empty plan', async () => {
 const original='let x=0,y=0;\nx\n++\ny;\n', changed='let x=0,y=0;\nx ++\ny;\n';
 assert.deepEqual(new Function(original+'return [x,y];')(),[0,1]);
 assert.deepEqual(new Function(changed+'return [x,y];')(),[1,0]);
 const f=await fixture({'script.js':original});await analysis(f.root,f.b);
 const d=await f.update({expectedRevision:null,scope:['script.js'],baselineId:f.b.snapshotId,operations:[]});
 let revision=null;
 const act=async(id,operations)=>{const r=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'dev',expectedRevision:revision,actor:{id,role:id==='coord'?'coordinator':'reviewer'},operations});revision=r.revision;return r;};
 const wave=(id,mode,snapshot,comparisonId)=>({op:'start_wave',id,mode,deltaRevision:d.revision,snapshotId:snapshot.snapshotId,comparisonId,lanes:[{id:'main',reviewer:'reviewer',coverage:['script.js']}]});
 const baseline=await compare(f,d,f.b);
 await act('coord',[wave('audit','design-audit',f.b,await store.put(f.root,baseline))]);
 await act('reviewer',[{op:'submit_lane',lane:'main',status:'CLEAN'}]);await act('coord',[{op:'accept_wave'}]);
 await writeFile(path.join(f.root,'script.js'),changed);const result=await store.capture(f.root);await analysis(f.root,result);
 const compared=await compare(f,d,result);
 assert.ok(compared.observations.some(item=>item.code==='unclassified_unit'&&item.file==='script.js'));
 await act('coord',[wave('implementation','implementation-review',result,await store.put(f.root,compared))]);
 await act('reviewer',[{op:'submit_lane',lane:'main',status:'CLEAN'}]);
 await assert.rejects(act('coord',[{op:'accept_wave'}]),error=>error.code==='gate_blocked'&&error.problems.some(item=>item.code==='manual_evidence_missing'));
 assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'})).ready,false);
});

test('implementation review must cover deleted paths even when the result is empty', async t => {
 for(const unrelated of [false,true]) await t.test(`remaining target: ${unrelated}`,async()=>{
  const f=await fixture({'delete.js':'void 0;\n','requirements.txt':'Remove the obsolete artifact.',...(unrelated?{'unrelated.js':'void 0;\n'}:{})});
  await analysis(f.root,f.b);
  const scope=unrelated?['delete.js','unrelated.js']:['delete.js'];
  const d=await f.update({expectedRevision:null,scope,baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:entry('obsolete','DELETE',[ref('delete.js')],[],{kind:'file'})}]});
  let revision=null;
  const act=async(id,operations)=>{const r=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'dev',expectedRevision:revision,actor:{id,role:id==='coord'?'coordinator':'reviewer'},operations});revision=r.revision;return r;};
  const wave=(id,mode,snapshot,comparisonId,coverage)=>({op:'start_wave',id,mode,deltaRevision:d.revision,snapshotId:snapshot.snapshotId,comparisonId,lanes:[{id:'main',reviewer:'reviewer',coverage}]});
  const baseline=await compare(f,d,f.b);
  await act('coord',[wave('audit','design-audit',f.b,await store.put(f.root,baseline),scope)]);
  await act('reviewer',[{op:'submit_lane',lane:'main',status:'CLEAN'}]);await act('coord',[{op:'accept_wave'}]);
  await rm(path.join(f.root,'delete.js'));const result=await store.capture(f.root);await analysis(f.root,result);
  const compared=await compare(f,d,result),comparisonId=await store.put(f.root,compared);
  assert.deepEqual(compared.observations,[]);
  await assert.rejects(act('coord',[wave('incomplete','implementation-review',result,comparisonId,['unrelated.js'])]),error=>error.code==='validation_failed'&&error.problems.some(item=>item.code==='review_coverage_missing'&&item.file==='delete.js'));
  await assert.rejects(act('coord',[wave('anchors','implementation-review',result,comparisonId,['requirements.txt#1'])]),error=>error.code==='validation_failed'&&/path prefixes/.test(error.message));
  await act('coord',[wave('pending','implementation-review',result,comparisonId,scope)]);
  const blocked=await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'});
  assert.equal(blocked.ready,false);
  assert.match(blocked.problems[0].message,/wave pending has no accepted result, and accepting it now would fail on: lane_result_stale x1/);
  await act('coord',[wave('complete','implementation-review',result,comparisonId,scope)]);
  await act('reviewer',[{op:'submit_lane',lane:'main',status:'CLEAN'}]);await act('coord',[{op:'accept_wave'}]);
  assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'})).ready,true);
 });
});

test('force-adding an ignored file leaves the snapshot unchanged',async()=>{
 const f=await fixture({'.gitignore':'plans/\n','src.js':'void 0;\n','plans/state.json':'{}'});
 const git=(...args)=>promisify(execFile)('git',args,{cwd:f.root});
 await git('init','-q');await git('add','.gitignore','src.js');
 const before=await store.capture(f.root);
 assert.ok(!before.snapshot.files.some(x=>x.file==='plans/state.json'));
 await git('add','-f','plans/state.json');
 await store.assertCurrent(f.root,before.snapshotId);
 assert.equal((await store.capture(f.root)).snapshot.fingerprint,before.snapshot.fingerprint);
});

test('retains dirty source, binary identity and symlinks without following them; corrupt blobs block reads',async()=>{
 const f=await fixture({'a.txt':'dirty untracked','opaque':Buffer.from([0,1,2])});
 await symlink('/does/not/exist',path.join(f.root,'link'));
 const b=await store.capture(f.root);
 assert.equal(b.snapshot.files.find(x=>x.file==='opaque').kind,'opaque');
 assert.equal(b.snapshot.files.find(x=>x.file==='link').kind,'symlink');
 await writeFile(path.join(f.root,'a.txt'),'changed');
 const old=b.snapshot.files.find(x=>x.file==='a.txt');
 assert.equal((await store.bytes(f.root,old)).toString(),'dirty untracked');
 await assert.rejects(store.assertCurrent(f.root,b.snapshotId),error=>error.code==='stale_snapshot'&&error.problems.some(item=>item.code==='file_changed'&&item.file==='a.txt'));
 await writeFile(await store.blobPath(f.root,old.hash),'corrupt');
 await assert.rejects(store.bytes(f.root,old),{code:'evidence_missing'});
});
test('immutable records and source blobs preserve existing bytes under repeated and concurrent publication', async t => {
 for (const kind of ['record','blob']) await t.test(kind, async () => {
  const f=await fixture(), contents='Retain immutable source bytes.\n';
  const evidence={...f.b.snapshot,diagnostics:[{code:'characterization',message:'Retain immutable evidence.'}]};
  const bytes=kind==='record'?canonical(evidence):contents, hash=digest(bytes);
  const {directory}=await store.location(f.root);
  const target=kind==='record'?path.join(directory,'records',`${hash}.json`):await store.blobPath(f.root,hash);
  if (kind==='blob') await writeFile(path.join(f.root,'source.txt'),contents);
  const publish=kind==='record'?()=>store.put(f.root,evidence):async()=>(await store.capture(f.root)).snapshotId;
  const identities=await Promise.all(Array.from({length:8},publish));
  assert.equal(new Set(identities).size,1);
  assert.equal(await readFile(target,'utf8'),bytes);
  if (process.platform!=='win32') assert.equal((await lstat(target)).mode&0o777,0o600);
  await utimes(target,new Date(100000),new Date(100000));
  const before=await lstat(target);
  assert.equal(await publish(),identities[0]);
  const after=await lstat(target);
  assert.equal(after.ino,before.ino);
  assert.equal(after.mtimeMs,before.mtimeMs);
  await writeFile(target,'corrupt bytes');
  await assert.rejects(publish(),{code:'evidence_missing',message:kind==='record'?'Existing immutable evidence is corrupt.':'A retained source blob is corrupt.'});
  assert.equal(await readFile(target,'utf8'),'corrupt bytes');
  await rm(target);
  const other=`${target}.other`;
  await writeFile(other,'Do not replace this source.');
  await symlink(other,target);
  await assert.rejects(publish(),{code:'invalid_path'});
  assert.equal(await readFile(other,'utf8'),'Do not replace this source.');
  await assert.rejects(lstat(`${target}.lock`),{code:'ENOENT'});
 });
});
test('rejects symlink storage ancestors before creating or reading a child',async()=>{
 const outside=await mkdtemp(path.join(home,'outside-')),link=path.join(home,'alias'); await mkdir(path.join(outside,'parent'));await symlink(outside,link);
 await assert.rejects(privateDirectory(path.join(link,'parent','new')),{code:'invalid_path'});
 await assert.rejects(readFile(path.join(outside,'parent','new')),{code:'ENOENT'});
 await writeFile(path.join(outside,'parent','bytes'),'secret');await assert.rejects(regularBytes(path.join(link,'parent','bytes')),{code:'invalid_path'});
});
test('source outputs cannot be claimed retroactively and evidence pages are bounded',async()=>{
 const f=await fixture({'x.txt':'x'}); const target=path.join(f.root,'other/review.md');await mkdir(path.dirname(target));await writeFile(target,'ordinary source');
 await assert.rejects(store.registerSlice(f.root,'other/change-map.json'),{code:'invalid_path'});
 const page=await callConservationTool('get_conservation_evidence',{projectRoot:f.root,evidenceId:f.b.snapshotId,limit:1});assert.equal(page.entries.length,1);
 await assert.rejects(callConservationTool('get_conservation_evidence',{projectRoot:f.root,evidenceId:f.b.snapshotId,limit:101}),{code:'validation_failed'});
});
test('v2 draft readiness requires the baseline, scope and successful exact semantic receipts',async()=>{
 const f=await fixture({'rules.md':'old rule','requirements.md':'Requirement'});
 const base={schemaVersion:2,scope:['rules.md'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],concepts:[entry('new','ADD',[],[ref('rules.md','new rule')],{requirements:[ref('requirements.md')],reuseEvidence:{candidates:[],justification:'Distinct obligation'}})]};
 assert.ok((await assessDeltaReadiness(f.root,base)).some(x=>x.code==='semantic_receipt_missing'));
 const source=f.b.snapshot.files.find(x=>x.file==='rules.md');
 const receipt={kind:'search',schemaVersion:1,project:f.root,snapshotId:f.b.snapshotId,snapshot:f.b.snapshot.fingerprint,query:'overlapping rules',filters:{},limit:10,status:'ready',capabilities:{semanticSearch:true},modelIdentity:'test-model',indexRevision:'test-index',versions:{},coverage:{},diagnostics:[],candidates:[{id:'old',file:'rules.md',selector:'old',span:{start:0,end:8},sourceHash:source.hash}]};
 const receiptId=await store.put(f.root,receipt);const evidence=base.concepts[0].reuseEvidence;evidence.receiptIds=[receiptId];evidence.candidates=[{receiptId,candidateId:'old',reference:ref('rules.md','wrong'),disposition:'REJECT',reason:'Different rule'}];
 assert.ok((await assessDeltaReadiness(f.root,base)).some(x=>x.code==='candidate_disposition_missing'));
 evidence.candidates[0].reference={path:'rules.md',selector:{type:'span',start:0,end:8,sourceHash:source.hash}};
 assert.deepEqual(await assessDeltaReadiness(f.root,base),[]);
 const failedId=await store.put(f.root,{...receipt,status:'degraded',capabilities:{semanticSearch:false}});evidence.receiptIds=[failedId];assert.ok((await assessDeltaReadiness(f.root,base)).some(x=>x.code==='semantic_receipt_invalid'));
 await assert.rejects(f.update({expectedRevision:null,scope:['rules.md'],operations:[{op:'insert',entry:entry('escape','ADD',[],[ref('other.md')])}]}),{code:'validation_failed'});
});
test('incomplete global inventory never becomes ready because another omission is out of scope',async()=>{
 const f=await fixture({'a.txt':'a'});const bad=await store.put(f.root,{...f.b.snapshot,complete:false,unknownOmissions:true,omissions:[{file:'other/big',reason:'limit'}]});
 assert.ok((await assessDeltaReadiness(f.root,{schemaVersion:2,scope:['a.txt'],baselineId:bad,concepts:[]})).some(x=>x.code==='evidence_missing'));
});
test('compares retained DELETE, changed KEEP, missing replacement and source outside scope',async()=>{
 const f=await fixture({'rules.md':'retain\nkeep\nold\n','requirements.md':'Requirement'});
 const delta=await f.update({expectedRevision:null,scope:['rules.md'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],operations:[
 {op:'insert',entry:entry('delete','DELETE',[ref('rules.md','retain')],[])},
 {op:'insert',entry:entry('keep','KEEP',[ref('rules.md')],[ref('rules.md')])},
 {op:'insert',entry:entry('replace','REPLACE',[ref('rules.md','old')],[ref('rules.md','new')])}]});
 await writeFile(path.join(f.root,'rules.md'),'retain\nkeep changed\nold\n');await writeFile(path.join(f.root,'outside.txt'),'extra');
 const result=await store.capture(f.root),observed=await compare(f,delta,result);
 for(const code of ['retained_source','keep_changed','missing_target','outside_scope']) assert.ok(observed.observations.some(x=>x.code===code),code);
 assert.ok(observed.growth.some(x=>x.dimension==='source.bytes'));
 assert.ok(observed.observations.some(x=>x.code==='measurement_unknown'));
});
test('mode-only changes cannot pass KEEP',async()=>{
 const f=await fixture({'a.sh':'echo x\n','requirements.md':'Requirement'});
 const d=await f.update({expectedRevision:null,scope:['a.sh'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],operations:[{op:'insert',entry:entry('keep','KEEP',[ref('a.sh')],[ref('a.sh')])}]});
 const target=path.join(f.root,'a.sh');
 await chmod(target,process.platform==='win32'?0o444:0o755);
 try {const c=await compare(f,d,await store.capture(f.root));assert.ok(c.observations.some(x=>x.code==='keep_changed'));}
 finally {await chmod(target,0o644);}
});
test('review acceptance, exact source gates, concurrent lanes and coordination bypasses',async()=>{
 const f=await fixture();await analysis(f.root,f.b);
 const d=await f.update({expectedRevision:null,scope:['src'],baselineId:f.b.snapshotId,operations:[]});
 const compared=await compareChangeMap({projectRoot:f.root,deltaPath:f.deltaPath,expectedRevision:d.revision,baselineId:f.b.snapshotId,resultSnapshotId:f.b.snapshotId},{runtime:degraded});
 let revision=null;
 const actor=id=>({id,role:id==='coordinator'?'coordinator':id==='delivery'?'delivery':'reviewer'});
 const mutate=async(id,operations)=>{const r=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'delivery',expectedRevision:revision,actor:actor(id),operations});revision=r.revision;return r;};
 const start=(id,mode)=>({op:'start_wave',id,mode,deltaRevision:d.revision,snapshotId:f.b.snapshotId,comparisonId:compared.comparisonId,lanes:[{id:'one',reviewer:'r1',coverage:['src']},{id:'two',reviewer:'r2',coverage:['src']}]});
 await mutate('coordinator',[start('audit','design-audit')]);
 await assert.rejects(mutate('coordinator',[{op:'accept_wave'}]),{code:'gate_blocked'});
 const lanes=[['r1','one'],['r2','two']],sameRevision=revision;
 const simultaneous=await Promise.allSettled(lanes.map(([id,lane])=>updateReview({projectRoot:f.root,reviewPath:f.reviewPath,expectedRevision:sameRevision,actor:actor(id),operations:[{op:'submit_lane',lane,status:'CLEAN'}]})));
 assert.equal(simultaneous.filter(result=>result.status==='fulfilled').length,1);
 revision=simultaneous.find(result=>result.status==='fulfilled').value.revision;
 const retry=simultaneous.findIndex(result=>result.status==='rejected');assert.equal(simultaneous[retry].reason.code,'revision_conflict');
 await mutate(lanes[retry][0],[{op:'submit_lane',lane:lanes[retry][1],status:'CLEAN'}]);await mutate('coordinator',[{op:'accept_wave'}]);
 assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'implementation'})).ready,true);
 const statePath='plan/state.json';
 let state=await updateCoordinationState({projectRoot:f.root,statePath,expectedRevision:null,changes:{activeOperations:[{op:'start',entry:{slice:'slice',activity:'implementation',workers:['delivery'],workspace:f.root,reviewPath:f.reviewPath}}]}});
 // The coordination output must be registered before the next source capture in a real workflow.
 await assert.rejects(updateCoordinationState({projectRoot:f.root,statePath,expectedRevision:state.revision,changes:{active:[]}}),{code:'gate_blocked'});
 await assert.rejects(updateCoordinationState({projectRoot:f.root,statePath,expectedRevision:state.revision,changes:{activeOperations:[{op:'finish',slice:'slice'}]}}),{code:'gate_blocked'});
 state=await updateCoordinationState({projectRoot:f.root,statePath,expectedRevision:state.revision,changes:{activeOperations:[{op:'release',slice:'slice'}]}});assert.equal(state.state.active.length,0);
 await rm(path.join(f.root,statePath));
 await mutate('coordinator',[start('implementation','implementation-review')]);
 await mutate('r1',[{op:'submit_lane',lane:'one',status:'CLEAN'}]);await mutate('r2',[{op:'submit_lane',lane:'two',status:'CLEAN'}]);await mutate('coordinator',[{op:'accept_wave'}]);
 assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'})).ready,true);
 await writeFile(path.join(f.root,'unexpected'),'change');await assert.rejects(checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'}),{code:'stale_snapshot'});
 await rm(path.join(f.root,'unexpected'));
 await mutate('coordinator',[{op:'open_conflict',id:'disagreement',lanes:['one','two'],reason:'Different conclusions'}]);
 assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'})).ready,false);
 await mutate('coordinator',[{op:'record_exchange',reviewer:'r1'}]);await assert.rejects(mutate('r1',[{op:'submit_lane',lane:'one',status:'CLEAN'}]),{code:'gate_blocked'});
 const bytes=await readFile(path.join(f.root,f.reviewPath),'utf8');await assert.rejects(mutate('delivery',[{op:'accept_wave'}]),{code:'gate_blocked'});assert.equal(await readFile(path.join(f.root,f.reviewPath),'utf8'),bytes);
});

test('source spans distinguish declarations and require attribution for gaps and line shifts',async()=>{
 const original='export function one(){return 1;} export function two(){return 2;}\n';
 const f=await fixture({'code.ts':original,'requirements.md':'Requirement'});
 const units=(snapshot,text)=>['one','two',...(text.includes('three')?['three']:[])].map(name=>{const start=text.indexOf(`export function ${name}`),end=text.indexOf('}',start)+1;return {id:name,file:'code.ts',domain:'code',kind:'function',name,selector:name,span:{start,end},sourceHash:snapshot.snapshot.files.find(x=>x.file==='code.ts').hash,contentHash:digest(text.slice(start,end)),isExported:true};});
 await analysis(f.root,f.b,units(f.b,original));
 const one={path:'code.ts',selector:{type:'symbol',value:'one'}};
 const d=await f.update({expectedRevision:null,scope:['code.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],operations:[{op:'insert',entry:{...entry('one','MODIFY',[one],[one]),kind:'function'}}]});
 let text='\n'+original;await writeFile(path.join(f.root,'code.ts'),text);let next=await store.capture(f.root);await analysis(f.root,next,units(next,text));let c=await compare(f,d,next);
 assert.ok(c.observations.some(x=>x.code==='unclassified_unit'&&x.unit.kind==='file'));
 assert.equal(c.observations.some(x=>x.code==='undeclared_public_concept'||x.unit?.selector==='two'),false);
 text=original.replace('return 1','return 3')+'console.log("extra");\nexport function three(){return 3;}';await writeFile(path.join(f.root,'code.ts'),text);next=await store.capture(f.root);await analysis(f.root,next,units(next,text));c=await compare(f,d,next);
 assert.ok(c.observations.some(x=>x.code==='undeclared_public_concept'&&x.unit.selector==='three'));
 assert.ok(c.observations.some(x=>x.code==='unclassified_unit'&&x.message.includes('outside parsed')));
 assert.ok(c.growth.some(x=>x.dimension==='code.publicDeclarationsAdded'));
 assert.equal(c.observations.some(x=>x.unit?.selector==='two'),false);
});
test('consolidation and split observations use exact text without declaring structural list items to be obligations',async()=>{
 const f=await fixture({'rules.md':'# Answers\n\nKeep intros short.\nAvoid repeating questions.\n','requirements.md':'Be direct.'});
 const d=await f.update({expectedRevision:null,scope:['rules.md'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],operations:[{op:'insert',entry:entry('direct','REPLACE',[ref('rules.md','Keep intros short.'),ref('rules.md','Avoid repeating questions.')],[ref('rules.md','Answer directly.')])}]});
 await writeFile(path.join(f.root,'rules.md'),'# Answers\n\nAnswer directly.\n');const result=await store.capture(f.root);const c=await compare(f,d,result);
 assert.equal(c.observations.some(x=>x.code==='retained_source'||x.code==='missing_target'),false);
 assert.equal(c.measurements.find(x=>x.dimension==='planned.consolidations').after,1);
 assert.equal(c.growth.some(x=>x.dimension.startsWith('planned.')),false);
 assert.equal(c.measurements.find(x=>x.dimension==='identified.exceptions').after,0);
 const updated=await f.update({expectedRevision:d.revision,operations:[{op:'update',id:'direct',set:{before:[ref('rules.md','Keep intros short.')],after:[ref('rules.md','Answer directly.'),ref('rules.md','Be brief.')]}}]});
 await writeFile(path.join(f.root,'rules.md'),'Answer directly.\nBe brief.');const split=await compare(f,updated,await store.capture(f.root));assert.equal(split.measurements.find(x=>x.dimension==='planned.splits').after,1);
});
test('legacy delta migration retains bytes and does not fabricate a baseline',async()=>{
 const root=await mkdtemp(path.join(home,'legacy-')),deltaPath='slice/concept-delta.json';await mkdir(path.join(root,'slice'));
 const contents=JSON.stringify({schemaVersion:1,scope:['src'],concepts:[]},null,4);await writeFile(path.join(root,deltaPath),contents);
 const read=await getChangeMap({projectRoot:root,deltaPath});assert.equal(read.ready,false);
 const changed=await updateChangeMap({projectRoot:root,deltaPath,expectedRevision:read.revision,migrate:true,operations:[]});assert.equal(changed.schemaVersion,2);assert.equal(changed.ready,false);
 const migrated=await store.get(root,changed.migrationEvidenceId,'migration');assert.equal(migrated.lines.join('\n'),contents);
});
test('review finding ownership, independent verification, and projection failure preserve authoritative JSON',async()=>{
 const f=await fixture();await analysis(f.root,f.b);const d=await f.update({expectedRevision:null,scope:['src'],baselineId:f.b.snapshotId,operations:[]});const c=await compareChangeMap({projectRoot:f.root,deltaPath:f.deltaPath,expectedRevision:d.revision,baselineId:f.b.snapshotId,resultSnapshotId:f.b.snapshotId},{runtime:degraded});
 let revision=null;const act=async(actor,operations)=>{const r=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'dev',expectedRevision:revision,actor,operations});revision=r.revision;return r;};
 const coordinator={id:'coord',role:'coordinator'},reviewer={id:'reviewer',role:'reviewer'},delivery={id:'dev',role:'delivery'};
 await act(coordinator,[{op:'start_wave',id:'first',mode:'design-audit',deltaRevision:d.revision,snapshotId:f.b.snapshotId,comparisonId:c.comparisonId,lanes:[{id:'main',reviewer:'reviewer',coverage:['src']}]}]);
 await act(reviewer,[{op:'open_finding',lane:'main',localId:'F-1',title:'Gap',severity:'high',affectedPath:'src',evidence:'Missing fact',conditionToClose:'Supply fact'}]);
 const id='design-audit/main/F-1';await assert.rejects(act(delivery,[{op:'set_finding_status',id,status:'VERIFIED',evidence:'Self signoff'}]),{code:'gate_blocked'});
 await act(delivery,[{op:'set_finding_status',id,status:'IN PROGRESS',evidence:'Investigating'},{op:'set_finding_status',id,status:'FIXED',evidence:'Supplied fact'}]);await act(reviewer,[{op:'set_finding_status',id,status:'VERIFIED',evidence:'Checked fact'}]);
 const md=path.join(f.root,'plan/slice/review.md');await rm(md);await mkdir(md);
 const updated=await act(reviewer,[{op:'submit_lane',lane:'main',status:'CLEAN'}]);assert.equal(updated.projectionStale,true);assert.equal((await getReview({projectRoot:f.root,reviewPath:f.reviewPath})).entries[0].status,'VERIFIED');
 await rm(md,{recursive:true});const regenerated=await act(coordinator,[{op:'regenerate_markdown'}]);assert.equal(regenerated.revision,updated.revision);assert.equal(regenerated.projectionStale,false);
});

test('one reviewed justification covers several growth dimensions and convergence requires coverage of every requirement',async()=>{
 const f=await fixture({'rules.md':'# Rules\n\nOld one.\nOld two.\n','requirements.md':'Preserve both constraints.'});
 const requirement=ref('requirements.md');
 const d=await f.update({expectedRevision:null,scope:['rules.md'],baselineId:f.b.snapshotId,requirements:[requirement],growthThresholds:[{dimension:'source.bytes',maximumIncrease:1000}],operations:[{op:'insert',entry:entry('merged','REPLACE',[ref('rules.md','Old one.\n'),ref('rules.md','Old two.\n')],[ref('rules.md','Apply both constraints and explain the result.\n')])}]});
 await writeFile(path.join(f.root,'rules.md'),'# Rules\n\nApply both constraints and explain the result.\n');const result=await store.capture(f.root);
 const c=await compareChangeMap({projectRoot:f.root,deltaPath:f.deltaPath,expectedRevision:d.revision,baselineId:f.b.snapshotId,resultSnapshotId:result.snapshotId},{runtime:degraded});
 assert.ok(c.growth.length>=1);assert.ok(c.growth.some(x=>x.dimension==='source.bytes'&&x.threshold===1000));
 let revision=null;const coord={id:'coordinator',role:'coordinator'},reviewer={id:'reviewer',role:'reviewer'};
 const act=async(actor,operations)=>{const r=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'delivery',expectedRevision:revision,actor,operations});revision=r.revision;return r;};
 await act(coord,[{op:'start_wave',id:'audit',mode:'design-audit',deltaRevision:d.revision,snapshotId:result.snapshotId,comparisonId:c.comparisonId,lanes:[{id:'main',reviewer:'reviewer',coverage:['rules.md']}]}]);
 const convergence={id:'converge',lane:'main',kind:'convergence',reason:'Fixture assessment of combined constraints; no claim of semantic proof.',evidence:[requirement],section:ref('rules.md'),decision:'consolidate',conceptIds:['merged'],coverage:[]};
 await assert.rejects(act(reviewer,[{op:'record_assessment',assessment:convergence}]),{code:'gate_blocked'});
 convergence.coverage=[{requirement,targets:[ref('rules.md','Apply both constraints and explain the result.')]}];
 const observations=await store.get(f.root,c.comparisonId,'comparison');
 await act(reviewer,[{op:'record_assessment',assessment:convergence},{op:'record_assessment',assessment:{id:'unsupported',lane:'main',kind:'manual',reason:'The fixture deliberately uses no structural runtime; source evidence binds the unsupported checks.',evidence:[requirement],observationIds:observations.observations.filter(x=>x.severity==='review_required').map(x=>x.id)}},{op:'submit_lane',lane:'main',status:'CLEAN'}]);
 await assert.rejects(act(coord,[{op:'accept_wave'}]),error=>error.code==='gate_blocked'&&error.problems.some(x=>x.code==='growth_justification_missing'));
 await act(reviewer,[{op:'record_assessment',assessment:{id:'growth',lane:'main',kind:'growth',reason:'The requirement needs the combined explicit wording.',evidence:[requirement],growthIds:c.growth.map(x=>x.id),justification:{dimensions:c.growth.map(x=>x.dimension),conceptIds:['merged'],requirements:[requirement],reason:'Express both constraints.'}}},{op:'submit_lane',lane:'main',status:'CLEAN'}]);
 await act(coord,[{op:'accept_wave'}]);assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'implementation'})).ready,true);
});
test('a reviewer carries unchanged assessments into a correction wave and check_review_gate offers the rest as a skeleton',async()=>{
 const f=await fixture({'rules.md':'# Rules\n\nOld one.\nOld two.\n','requirements.md':'Preserve both constraints.'});
 const requirement=ref('requirements.md');
 const d=await f.update({expectedRevision:null,scope:['rules.md','notes.md'],baselineId:f.b.snapshotId,requirements:[requirement],operations:[{op:'insert',entry:entry('merged','REPLACE',[ref('rules.md','Old one.\n'),ref('rules.md','Old two.\n')],[ref('rules.md','Apply both constraints and explain the result.\n')])}]});
 await writeFile(path.join(f.root,'rules.md'),'# Rules\n\nApply both constraints and explain the result.\n');
 const compareNow=async()=>{const result=await store.capture(f.root);const c=await compareChangeMap({projectRoot:f.root,deltaPath:f.deltaPath,expectedRevision:d.revision,baselineId:f.b.snapshotId,resultSnapshotId:result.snapshotId},{runtime:degraded});return {result,c,full:await store.get(f.root,c.comparisonId,'comparison')};};
 const first=await compareNow();
 let revision=null;const coord={id:'coordinator',role:'coordinator'},reviewer={id:'reviewer',role:'reviewer'};
 const act=async(actor,operations)=>{const r=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'delivery',expectedRevision:revision,actor,operations});revision=r.revision;return r;};
 const wave=(id,{result,c})=>({op:'start_wave',id,mode:'design-audit',deltaRevision:d.revision,snapshotId:result.snapshotId,comparisonId:c.comparisonId,lanes:[{id:'main',reviewer:'reviewer',coverage:['rules.md','notes.md']}]});
 await act(coord,[wave('audit',first)]);
 const gate=await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'implementation'});
 const skeleton=gate.assessmentSkeleton.map(item=>item.assessment);
 assert.equal(gate.carryable,undefined);
 assert.deepEqual(skeleton.filter(item=>item.kind==='manual').flatMap(item=>item.observationIds).sort(),first.full.observations.filter(x=>x.severity==='review_required').map(x=>x.id).sort());
 assert.deepEqual(skeleton.find(item=>item.kind==='growth').growthIds,first.c.growth.map(x=>x.id));
 assert.deepEqual(skeleton.find(item=>item.kind==='convergence').section,{path:'rules.md'});
 assert.deepEqual(skeleton.find(item=>item.kind==='convergence').coverage.map(item=>item.requirement),[requirement]);
 const convergence={id:'converge',lane:'main',kind:'convergence',reason:'Fixture assessment of combined constraints.',evidence:[requirement],section:ref('rules.md'),decision:'consolidate',conceptIds:['merged'],coverage:[{requirement,targets:[ref('rules.md','Apply both constraints and explain the result.')]}]};
 const manual=first.full.observations.filter(x=>x.severity==='review_required').map(x=>({id:`manual-${x.id.slice(0,8)}`,lane:'main',kind:'manual',reason:'The fixture uses no structural runtime.',evidence:[ref(x.file||'rules.md')],observationIds:[x.id]}));
 const growth={id:'growth',lane:'main',kind:'growth',reason:'The requirement needs the combined wording.',evidence:[requirement],growthIds:first.c.growth.map(x=>x.id),justification:{dimensions:first.c.growth.map(x=>x.dimension),conceptIds:['merged'],requirements:[requirement],reason:'Express both constraints.'}};
 await act(reviewer,[convergence,...manual,growth].map(assessment=>({op:'record_assessment',assessment})).concat([{op:'submit_lane',lane:'main',status:'CLEAN'}]));
 await act(coord,[{op:'accept_wave'}]);

 // A correction adds notes.md: rules.md and requirements.md keep their bytes, so the convergence judgment still stands.
 await writeFile(path.join(f.root,'notes.md'),'# Notes\n\nA new note.\n');
 const second=await compareNow();
 // A wave that only fixed findings sits between, so the offer reaches back to the last wave with accepted assessments.
 await act(coord,[wave('findings-only',second),wave('correction',second)]);
 const offered=await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'implementation'});
 assert.equal(gate.correctionScope,undefined);
 // Nothing changed since the findings-only wave, so the correction has no file to re-review.
 assert.deepEqual(offered.correctionScope,{fromWave:'findings-only',deltaChanged:false,lanes:[{lane:'main',changedFiles:[]}]});
 assert.equal(offered.carryable[0].fromWave,'audit');
 assert.ok(offered.carryable[0].ids.includes('converge'));
 assert.ok(offered.assessmentSkeleton.some(item=>item.assessment.kind==='convergence'&&item.assessment.section.path==='notes.md'));
 await assert.rejects(act(coord,[{op:'carry_assessments',lane:'main',fromWave:'audit'}]),{code:'gate_blocked'});
 await assert.rejects(act(reviewer,[{op:'carry_assessments',lane:'main',fromWave:'audit',ids:['missing']}]),{code:'validation_failed'});
 const carried=await act(reviewer,[{op:'carry_assessments',lane:'main',fromWave:'audit'}]);
 assert.ok(carried.carry.carried.includes('correction/converge'));
 assert.deepEqual(carried.carry.carried,offered.carryable[0].ids.map(id=>`correction/${id}`));
 // A file-less observation judges the whole change, so its assessment does not carry once notes.md changed.
 const fileless=new Set(first.full.observations.filter(x=>x.severity==='review_required'&&!x.file&&!x.unit?.file).map(x=>`manual-${x.id.slice(0,8)}`));assert.ok(fileless.size>0);
 assert.ok(carried.carry.notCarried.some(item=>fileless.has(item.id)&&/notes\.md/.test(item.reason)));
 assert.equal(carried.carry.carried.some(id=>fileless.has(id.slice('correction/'.length))),false);
 const stored=(await getReview({projectRoot:f.root,reviewPath:f.reviewPath,section:'assessments',limit:100})).entries.find(item=>item.id==='correction/converge');
 assert.equal(stored.wave,'correction');assert.equal(stored.acceptedBy,'reviewer');assert.equal(stored.author,'reviewer');

 // Changing a cited file stops the carry, and naming that assessment explicitly is refused with the reason.
 await writeFile(path.join(f.root,'rules.md'),'# Rules\n\nApply both constraints and explain the outcome.\n');
 const third=await compareNow();
 await act(coord,[wave('second-correction',third)]);
 // Only rules.md changed since the previous wave, so it is the one file this lane re-reviews.
 assert.deepEqual((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'implementation'})).correctionScope,{fromWave:'correction',deltaChanged:false,lanes:[{lane:'main',changedFiles:['rules.md']}]});
 await assert.rejects(act(reviewer,[{op:'carry_assessments',lane:'main',fromWave:'correction',ids:['correction/converge']}]),error=>error.code==='gate_blocked'&&/rules\.md/.test(error.message));
 const partial=await act(reviewer,[{op:'carry_assessments',lane:'main',fromWave:'correction'}]);
 assert.equal(partial.carry.carried.includes('second-correction/converge'),false);
 assert.ok(partial.carry.notCarried.some(item=>item.id==='correction/converge'&&/rules\.md/.test(item.reason)));
 await assert.rejects(act(coord,[{op:'accept_wave'}]),error=>error.code==='gate_blocked'&&/check_review_gate/.test(error.message));
});
test('manual checks cannot waive mechanically retained deletions',async()=>{
 const f=await fixture({'rules.md':'Must remove.','requirements.md':'Remove obsolete behavior.'});
 const d=await f.update({expectedRevision:null,scope:['rules.md'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],operations:[{op:'insert',entry:entry('obsolete','DELETE',[ref('rules.md','Must remove.')],[])}]});
 const c=await compareChangeMap({projectRoot:f.root,deltaPath:f.deltaPath,expectedRevision:d.revision,baselineId:f.b.snapshotId,resultSnapshotId:f.b.snapshotId},{runtime:degraded});const retained=c.observations.find(x=>x.code==='retained_source');assert.ok(retained);
 const created=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'delivery',expectedRevision:null,actor:{id:'coordinator',role:'coordinator'},operations:[{op:'start_wave',id:'review',mode:'design-audit',deltaRevision:d.revision,snapshotId:f.b.snapshotId,comparisonId:c.comparisonId,lanes:[{id:'main',reviewer:'reviewer',coverage:['rules.md']}]}]});
 await assert.rejects(updateReview({projectRoot:f.root,reviewPath:f.reviewPath,expectedRevision:created.revision,actor:{id:'reviewer',role:'reviewer'},operations:[{op:'record_assessment',assessment:{id:'waiver',lane:'main',kind:'manual',observationIds:[retained.id],reason:'Pretend unsupported.',evidence:[ref('rules.md')]}}]}),error=>error.code==='gate_blocked'&&/cannot waive/.test(error.message));
});

test('review independence and required lanes survive reassignment and correction waves',async()=>{
 const f=await fixture();await analysis(f.root,f.b);
 const d=await f.update({expectedRevision:null,scope:['src'],baselineId:f.b.snapshotId,operations:[]});const c=await compare(f,d,f.b);
 const comparisonId=await store.put(f.root,c);let revision=null;
 const act=async(id,operations)=>{const result=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'original-dev',expectedRevision:revision,actor:{id,role:id==='coord'?'coordinator':'reviewer'},operations});revision=result.revision;return result;};
 const wave=(id,lanes,mode='design-audit')=>({op:'start_wave',id,mode,deltaRevision:d.revision,snapshotId:f.b.snapshotId,comparisonId,lanes:lanes.map(([id,reviewer])=>({id,reviewer,coverage:['src']}))});
 await act('coord',[{op:'assign_delivery',worker:'next-dev'}]);
 for(const reviewer of ['original-dev','next-dev','coord']) await assert.rejects(act('coord',[wave('invalid',[['functional',reviewer]])]),{code:'validation_failed'});
 // An implementation wave before an accepted design audit could never be accepted, so it is refused at the start.
 const unaudited=error=>error.code==='gate_blocked'&&error.problems.some(item=>item.code==='design_audit_missing');
 await assert.rejects(act('coord',[wave('early',[['functional','r1']],'implementation-review')]),unaudited);
 await act('coord',[wave('audit',[['functional','r1'],['security','r2']])]);
 await assert.rejects(act('coord',[wave('early',[['functional','r1']],'implementation-review')]),unaudited);
 await act('r1',[{op:'submit_lane',lane:'functional',status:'CLEAN'}]);await act('r2',[{op:'submit_lane',lane:'security',status:'CLEAN'}]);await act('coord',[{op:'accept_wave'}]);
 await assert.rejects(act('coord',[wave('correction',[['functional','r1']])]),{code:'gate_blocked'});
 await act('coord',[wave('correction',[['functional','r1'],['security','r2']]),{op:'carry_lane',lane:'functional',fromWave:'audit'},{op:'carry_lane',lane:'security',fromWave:'audit'},{op:'accept_wave'}]);
 await act('coord',[wave('implementation',[['functional','r1']],'implementation-review')]);await act('r1',[{op:'submit_lane',lane:'functional',status:'CLEAN'}]);await act('coord',[{op:'accept_wave'}]);
 assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'})).ready,true);
 await act('coord',[wave('new-audit',[['functional','r1'],['security','r2'],['additional','r3']])]);
 await assert.rejects(act('coord',[wave('stale-implementation',[['functional','r1']],'implementation-review')]),unaudited);
 await act('r3',[{op:'open_finding',lane:'additional',localId:'D2',title:'New defect',severity:'high',affectedPath:'src',evidence:'New audit evidence',conditionToClose:'Resolve defect'}]);
 assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'})).ready,false);
});

test('coordination holds review and delta locks until its admitted state is committed',async()=>{
 const f=await fixture();await analysis(f.root,f.b);const d=await f.update({expectedRevision:null,scope:['src'],baselineId:f.b.snapshotId,operations:[]});const c=await compare(f,d,f.b);
 let review=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'dev',expectedRevision:null,actor:{id:'coord',role:'coordinator'},operations:[{op:'start_wave',id:'audit',mode:'design-audit',deltaRevision:d.revision,snapshotId:f.b.snapshotId,comparisonId:await store.put(f.root,c),lanes:[{id:'main',reviewer:'r',coverage:['src']}]}]});
 review=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,expectedRevision:review.revision,actor:{id:'r',role:'reviewer'},operations:[{op:'submit_lane',lane:'main',status:'CLEAN'}]});
 review=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,expectedRevision:review.revision,actor:{id:'coord',role:'coordinator'},operations:[{op:'accept_wave'}]});
 const original=store.assertCurrent.bind(store);let entered,release;const reached=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>release=resolve);
 store.assertCurrent=async(...args)=>{const result=await original(...args);entered();await resume;return result;};
 try {
  const admission=updateCoordinationState({projectRoot:f.root,statePath:'plan/state.json',expectedRevision:null,changes:{activeOperations:[{op:'start',entry:{slice:'slice',activity:'implementation',workers:['dev'],workspace:f.root,reviewPath:f.reviewPath}}]}});
  await reached;let reviewWritten=false,deltaWritten=false;
  const finding=updateReview({projectRoot:f.root,reviewPath:f.reviewPath,expectedRevision:review.revision,actor:{id:'r',role:'reviewer'},operations:[{op:'open_finding',lane:'main',localId:'race',title:'Concurrent finding',severity:'high',affectedPath:'src',evidence:'Changed conclusion',conditionToClose:'Resolve'}]}).then(value=>{reviewWritten=true;return value;});
  const delta=f.update({expectedRevision:d.revision,operations:[]}).then(value=>{deltaWritten=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,40));assert.equal(reviewWritten,false);assert.equal(deltaWritten,false);
  release();const state=await admission;assert.equal(state.state.active[0].activity,'implementation');await Promise.all([finding,delta]);
  assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'implementation'})).ready,false);
 } finally {release();store.assertCurrent=original;}
});

test('legacy active labels cannot bypass gates and post-commit cleanup cannot roll back publication',async()=>{
 const active=[{slice:'slice',activity:'implementing',workers:['dev'],workspace:home}];
 await assert.rejects(applyActiveOperations(home,active,[{op:'update',slice:'slice',set:{workers:['replacement']}}]),{code:'gate_blocked'});
 assert.deepEqual((await applyActiveOperations(home,active,[{op:'release',slice:'slice'}])).active,[]);
 const file=path.join(home,'atomic-test');await writeFile(file,'old');
 await writeAtomically(file,'new',{afterTemporary:async()=>{throw new Error('cleanup failed');}});assert.equal(await readFile(file,'utf8'),'new');
 await assert.rejects(writeAtomically(file,'lost',{renameFile:async()=>{throw new Error('publication failed');}}),/publication failed/);assert.equal(await readFile(file,'utf8'),'new');
});

test('MODIFY spans cannot relabel a new public identity and retained deletion spans survive line shifts',async()=>{
 const original='export function oldName() { return 1; }',final='export function newName() { return 1; }';
 const f=await fixture({'code.ts':original,'requirements.md':'Rename explicitly.'});
 const units=(snapshot,text,name)=>[{id:name,file:'code.ts',domain:'code',kind:'function',name,selector:name,span:{start:0,end:text.length},sourceHash:snapshot.snapshot.files.find(x=>x.file==='code.ts').hash,contentHash:digest(text),isExported:true}];
 const span=(snapshot,text)=>({path:'code.ts',selector:{type:'span',start:0,end:text.length,sourceHash:snapshot.snapshot.files.find(x=>x.file==='code.ts').hash}});
 await analysis(f.root,f.b,units(f.b,original,'oldName'));await writeFile(path.join(f.root,'code.ts'),final);const result=await store.capture(f.root);await analysis(f.root,result,units(result,final,'newName'));
 const d=await f.update({expectedRevision:null,scope:['code.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],operations:[{op:'insert',entry:entry('rename','MODIFY',[span(f.b,original)],[span(result,final)])}]});
 const c=await compare(f,d,result);assert.ok(c.observations.some(x=>x.code==='modify_identity_changed'));assert.ok(c.observations.some(x=>x.code==='undeclared_public_concept'));
 const deletion=await f.update({expectedRevision:d.revision,operations:[{op:'update',id:'rename',set:{action:'DELETE',after:[]}}]});await writeFile(path.join(f.root,'code.ts'),'\n'+original);const shifted=await store.capture(f.root);
 const observed=await compare(f,deletion,shifted);assert.ok(observed.observations.some(x=>x.code==='retained_source'));
});

test('a rejected parser version stays unavailable after failed preparation',async()=>{
 const f=await fixture({'code.ts':'export function x() {}'});const old=await analysis(f.root,f.b);old.versions.metrics='obsolete';await store.link(f.root,f.b.snapshotId,await store.put(f.root,old));
 const prepared=await prepareAnalysis(f.root,f.b.snapshotId,{runtime:degraded});assert.equal(prepared.status,'degraded');assert.equal(prepared.analysis,null);
});

test('obsolete retained parser evidence is replaced and current evidence is reused',async()=>{
 const f=await fixture({'code.ts':'export function factory() {}'});
 const old=await analysis(f.root,f.b);old.versions.extractor='concepts-4-exact-fragments';
 await store.link(f.root,f.b.snapshotId,await store.put(f.root,old));
 let preparations=0;
 const runtime={prepare:async()=>{
  preparations++;
  return {status:'ready',prepared:{modelIdentity:'fixture',index:{chunkerVersion:CHUNKER_VERSION,units:[],fileCoverage:{'code.ts':true},diagnostics:[],tokenCounts:{'code.ts':5},structureCounts:{}}}};
 }};
 const refreshed=await prepareAnalysis(f.root,f.b.snapshotId,{runtime});
 assert.equal(refreshed.status,'ready');assert.equal(preparations,1);
 assert.equal(refreshed.analysis.versions.extractor,CHUNKER_VERSION);
 const cached=await prepareAnalysis(f.root,f.b.snapshotId,{runtime});
 assert.equal(preparations,1);assert.deepEqual(cached.analysis,refreshed.analysis);
});

test('convergence must cover changed source and growth cannot cite a nonexistent requirement',async()=>{
 const original='# Overview\n\nUnchanged.\n\n# Rules\n\nShort.\n',final=original.replace('Short.','A longer requirement.');
 const f=await fixture({'rules.md':original,'requirements.md':'Preserve meaning.'});
 const units=(snapshot,text)=>[{id:'overview',file:'rules.md',domain:'documentation',kind:'heading',name:'Overview',selector:'#overview',span:{start:0,end:text.indexOf('# Rules')},sourceHash:snapshot.snapshot.files.find(x=>x.file==='rules.md').hash,contentHash:digest(text.slice(0,text.indexOf('# Rules')))},{id:'rules',file:'rules.md',domain:'documentation',kind:'heading',name:'Rules',selector:'#rules',span:{start:text.indexOf('# Rules'),end:text.length},sourceHash:snapshot.snapshot.files.find(x=>x.file==='rules.md').hash,contentHash:digest(text.slice(text.indexOf('# Rules')))}];
 await analysis(f.root,f.b,units(f.b,original));await writeFile(path.join(f.root,'rules.md'),final);const result=await store.capture(f.root);await analysis(f.root,result,units(result,final));
 const requirement=ref('requirements.md'),d=await f.update({expectedRevision:null,scope:['rules.md'],baselineId:f.b.snapshotId,requirements:[requirement],operations:[{op:'insert',entry:entry('rules','MODIFY',[ref('rules.md')],[ref('rules.md')])}]});const c=await compare(f,d,result);let revision=null;
 const act=async(id,operations)=>{const r=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'dev',expectedRevision:revision,actor:{id,role:id==='coord'?'coordinator':'reviewer'},operations});revision=r.revision;return r;};
 await act('coord',[{op:'start_wave',id:'audit',mode:'design-audit',deltaRevision:d.revision,snapshotId:result.snapshotId,comparisonId:await store.put(f.root,c),lanes:[{id:'main',reviewer:'r',coverage:['rules.md']}]}]);
 const growth={id:'growth',lane:'main',kind:'growth',reason:'Test justification',evidence:[requirement],growthIds:c.growth.map(x=>x.id),justification:{dimensions:c.growth.map(x=>x.dimension),conceptIds:['rules'],requirements:[ref('requirements.md','DOES NOT EXIST')],reason:'Required behavior'}};
 await assert.rejects(act('r',[{op:'record_assessment',assessment:growth}]),{code:'evidence_missing'});
 growth.justification.requirements=[requirement];
 await act('r',[{op:'record_assessment',assessment:growth},{op:'record_assessment',assessment:{id:'wrong-section',lane:'main',kind:'convergence',reason:'Unchanged overview cannot cover rules.',evidence:[requirement],section:{path:'rules.md',selector:{type:'heading',value:'#overview'}},decision:'retain',conceptIds:['rules'],coverage:[{requirement,targets:[ref('rules.md')]}]}},{op:'submit_lane',lane:'main',status:'CLEAN'}]);
 await assert.rejects(act('coord',[{op:'accept_wave'}]),e=>e.code==='gate_blocked'&&e.problems.some(x=>x.code==='convergence_missing'));
});

test('a changed DELETE identity blocks completion and cannot be attributed to a different concept',async t=>{
 for (const padding of [0,1]) await t.test(`source span with ${padding} extra whitespace bytes`,async()=>{
 const original='function obsolete() { return 1; }\nfunction tracked() { return 2; }\n';
 const f=await fixture({'code.ts':original,'requirements.txt':'Remove obsolete and modify tracked.'});const units=privateFunctions(f.b,original);await analysis(f.root,f.b,units);
 const obsolete={path:'code.ts',selector:{type:'span',...units[0].span,end:units[0].span.end+padding,sourceHash:units[0].sourceHash}},tracked={path:'code.ts',selector:{type:'symbol',value:'tracked'}};
 const d=await f.update({expectedRevision:null,scope:['code.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:entry('obsolete','DELETE',[obsolete],[],{kind:'function'})},{op:'insert',entry:entry('tracked','MODIFY',[tracked],[tracked],{kind:'function'})}]});
 const initial=await compare(f,d,f.b);let revision=null;
 const act=async(id,operations)=>{const r=await updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'dev',expectedRevision:revision,actor:{id,role:id==='coord'?'coordinator':'reviewer'},operations});revision=r.revision;return r;};
 const wave=(id,mode,snapshot,comparisonId)=>({op:'start_wave',id,mode,deltaRevision:d.revision,snapshotId:snapshot.snapshotId,comparisonId,lanes:[{id:'main',reviewer:'r',coverage:['code.ts']}]});
 await act('coord',[wave('audit','design-audit',f.b,await store.put(f.root,initial))]);await act('r',[{op:'submit_lane',lane:'main',status:'CLEAN'}]);await act('coord',[{op:'accept_wave'}]);
 const changed=original.replace('return 1','return 3').replace('return 2','return 4');await writeFile(path.join(f.root,'code.ts'),changed);const result=await store.capture(f.root);await analysis(f.root,result,privateFunctions(result,changed));const c=await compare(f,d,result);
 assert.ok(c.observations.some(item=>item.code==='retained_source'&&item.conceptId==='obsolete'&&item.unit.selector==='obsolete'));
 await act('coord',[wave('review','implementation-review',result,await store.put(f.root,c))]);
 const unclassified=c.observations.find(item=>item.code==='unclassified_unit'&&item.unit.selector==='obsolete');assert.ok(unclassified);
 await assert.rejects(act('r',[{op:'record_assessment',assessment:{id:'relabel',lane:'main',kind:'implementation-detail',observationIds:[unclassified.id],conceptId:'tracked',reason:'Attempt to retain obsolete as tracked detail.',evidence:[ref('code.ts')]}}]),{code:'gate_blocked'});
 await act('r',[{op:'submit_lane',lane:'main',status:'CLEAN'}]);await assert.rejects(act('coord',[{op:'accept_wave'}]),e=>e.code==='gate_blocked'&&e.problems.some(item=>item.code==='retained_source'));
 assert.equal((await checkReviewGate({projectRoot:f.root,reviewPath:f.reviewPath,gate:'completion'})).ready,false);
 const corrected='function tracked() { return 4; }\nfunction helper() { return 5; }\n';await writeFile(path.join(f.root,'code.ts'),corrected);const correctedSnapshot=await store.capture(f.root);await analysis(f.root,correctedSnapshot,privateFunctions(correctedSnapshot,corrected));const correctedComparison=await compare(f,d,correctedSnapshot);
 assert.equal(correctedComparison.observations.some(item=>item.code==='retained_source'),false);
 await act('coord',[wave('correction','implementation-review',correctedSnapshot,await store.put(f.root,correctedComparison))]);
 const helper=correctedComparison.observations.find(item=>item.code==='unclassified_unit'&&item.unit.selector==='helper');assert.ok(helper);
 await act('r',[{op:'record_assessment',assessment:{id:'helper',lane:'main',kind:'implementation-detail',observationIds:[helper.id],conceptId:'tracked',reason:'The newly extracted private helper belongs to tracked.',evidence:[ref('code.ts')]}}]);
 });
});

test('a planned file reference covers new private units but never a new public declaration',async()=>{
 const original='function existing() { return 1; }\n';const f=await fixture({'code.ts':original,'requirements.txt':'Change the code file.'});await analysis(f.root,f.b,privateFunctions(f.b,original));
 const d=await f.update({expectedRevision:null,scope:['code.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:entry('code','MODIFY',[ref('code.ts')],[ref('code.ts')],{kind:'module'})}]});
 const changed='function existing() { return 2; }\nfunction helper() { return 5; }\nexport function api() { return 6; }\n';await writeFile(path.join(f.root,'code.ts'),changed);const result=await store.capture(f.root);
 await analysis(f.root,result,privateFunctions(result,changed).map(unit=>unit.name==='api'?{...unit,isExported:true}:unit));
 const c=await compare(f,d,result);
 assert.equal(c.observations.some(item=>item.code==='unclassified_unit'&&['existing','helper'].includes(item.unit?.selector)),false);
 assert.ok(c.observations.some(item=>item.code==='undeclared_public_concept'&&item.severity==='failure'&&item.unit.selector==='api'));
});

test('private units of a new file belong to the planned entries that create it',async()=>{
 const f=await fixture({'code.ts':'function existing() { return 1; }\n','requirements.txt':'Add a shared module.'});await analysis(f.root,f.b,privateFunctions(f.b,'function existing() { return 1; }\n'));
 const d=await f.update({expectedRevision:null,scope:['code.ts','shared.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:entry('shared','REPLACE',[{path:'code.ts',selector:{type:'symbol',value:'existing'}}],[{path:'shared.ts',selector:{type:'symbol',value:'existing'}}],{kind:'function'})}]});
 await writeFile(path.join(f.root,'code.ts'),'');const text='function existing() { return 1; }\nfunction helper() { return 2; }\n';await writeFile(path.join(f.root,'shared.ts'),text);
 const result=await store.capture(f.root);
 const units=[...text.matchAll(/function (\w+)\(\) \{ return \d; \}/g)].map(match=>({id:match[1],file:'shared.ts',domain:'code',kind:'function',name:match[1],selector:match[1],span:{start:match.index,end:match.index+match[0].length},sourceHash:result.snapshot.files.find(file=>file.file==='shared.ts').hash,contentHash:digest(match[0]),isExported:false}));
 await analysis(f.root,result,units);
 const c=await compare(f,d,result);
 assert.equal(c.observations.some(item=>item.code==='unclassified_unit'&&item.unit?.selector==='helper'),false);
});

test('ADD rejects baseline identities for symbols, exact text, and final source spans while allowing a new function',async()=>{
 const original='function existing() { return 1; }\n';const f=await fixture({'code.ts':original,'requirements.txt':'Add a new function.'});const units=privateFunctions(f.b,original);await analysis(f.root,f.b,units);
 const receiptId=await store.put(f.root,{kind:'search',schemaVersion:1,project:f.root,snapshotId:f.b.snapshotId,snapshot:f.b.snapshot.fingerprint,query:'new function',filters:{},limit:10,status:'ready',capabilities:{semanticSearch:true},modelIdentity:'fixture',indexRevision:'fixture',versions:{},coverage:{},diagnostics:[],candidates:[]});
 const addition=target=>entry('addition','ADD',[],[target],{kind:'function',requirements:[ref('requirements.txt')],reuseEvidence:{receiptIds:[receiptId],candidates:[],justification:'A distinct requirement.',emptyResultReason:'The mocked search returned no candidates.'}});
 let d=await f.update({expectedRevision:null,scope:['code.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:addition({path:'code.ts',selector:{type:'symbol',value:'existing'}})}]});
 assert.equal(d.ready,false);assert.ok(d.diagnostics.some(item=>item.code==='addition_already_exists'));
 for(const target of [ref('code.ts',original.trim()),{path:'code.ts',selector:{type:'span',...units[0].span,sourceHash:units[0].sourceHash}}]) {
  d=await f.update({expectedRevision:d.revision,operations:[{op:'update',id:'addition',set:{after:[target]}}]});assert.equal(d.ready,false);assert.ok((await compare(f,d,f.b)).observations.some(item=>item.code==='addition_already_exists'));
 }
 const changed=original.replace('return 1','return 2');await writeFile(path.join(f.root,'code.ts'),changed);let result=await store.capture(f.root);let current=privateFunctions(result,changed);await analysis(f.root,result,current);
 d=await f.update({expectedRevision:d.revision,operations:[{op:'update',id:'addition',set:{after:[{path:'code.ts',selector:{type:'span',...current[0].span,sourceHash:current[0].sourceHash}}]}}]});assert.ok((await compare(f,d,result)).observations.some(item=>item.code==='addition_already_exists'));
 const fresh=original+'function fresh() { return 3; }\n';await writeFile(path.join(f.root,'code.ts'),fresh);result=await store.capture(f.root);await analysis(f.root,result,privateFunctions(result,fresh));
 d=await f.update({expectedRevision:d.revision,operations:[{op:'update',id:'addition',set:{after:[{path:'code.ts',selector:{type:'symbol',value:'fresh'}}]}}]});assert.equal(d.ready,true);const valid=await compare(f,d,result);assert.equal(valid.observations.some(item=>item.code.startsWith('addition_')),false);assert.equal(valid.growth.some(item=>item.dimension.startsWith('planned.')),false);
});

test('whole-file DELETE requires actual absence and its operation count does not create growth',async()=>{
 const original='function obsolete() { return 1; }';const f=await fixture({'code.ts':original,'requirements.txt':'Delete the file.'});await analysis(f.root,f.b,privateFunctions(f.b,original));
 const d=await f.update({expectedRevision:null,scope:['code.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:entry('file','DELETE',[ref('code.ts')],[],{kind:'file'})}]});
 const renamed='function renamed() { return 1; }';await writeFile(path.join(f.root,'code.ts'),renamed);let result=await store.capture(f.root);await analysis(f.root,result,privateFunctions(result,renamed));assert.ok((await compare(f,d,result)).observations.some(item=>item.code==='retained_source'));
 await rm(path.join(f.root,'code.ts'));result=await store.capture(f.root);await analysis(f.root,result);const c=await compare(f,d,result);assert.equal(c.measurements.find(item=>item.dimension==='planned.delete').after,1);assert.equal(c.measurements.find(item=>item.dimension==='source.bytes').after,0);assert.deepEqual(c.growth,[]);assert.equal(c.observations.some(item=>item.code==='retained_source'),false);
});

test('review rejects immutable comparisons produced before the identity checks',async()=>{
 const f=await fixture();await analysis(f.root,f.b);const d=await f.update({expectedRevision:null,scope:['src'],baselineId:f.b.snapshotId,operations:[]});const c=await compare(f,d,f.b);delete c.versions.comparison;
 await assert.rejects(updateReview({projectRoot:f.root,reviewPath:f.reviewPath,deltaPath:f.deltaPath,delivery:'dev',expectedRevision:null,actor:{id:'coord',role:'coordinator'},operations:[{op:'start_wave',id:'old',mode:'design-audit',deltaRevision:d.revision,snapshotId:f.b.snapshotId,comparisonId:await store.put(f.root,c),lanes:[{id:'main',reviewer:'r',coverage:['src']}]}]}),{code:'evidence_missing'});
});

test('ADD of a new section does not treat reused nested text as the section identity',async()=>{
 const original='# Old\n\nShared text.\n',final=original+'# New\n\nShared text.\n';const f=await fixture({'rules.md':original,'requirements.txt':'Add a section with a shared example.'});
 const units=(snapshot,text)=>[...text.matchAll(/# (Old|New)\n\nShared text\.\n/g)].flatMap(match=>{const start=match.index,end=start+match[0].length,hash=snapshot.snapshot.files.find(file=>file.file==='rules.md').hash;return [{id:match[1],file:'rules.md',domain:'documentation',kind:'heading',name:match[1],selector:'#'+match[1].toLowerCase(),span:{start,end},sourceHash:hash,contentHash:digest(text.slice(start,end))},{id:match[1]+'-text',file:'rules.md',domain:'documentation',kind:'paragraph',name:'Shared text.',selector:'Shared text.',span:{start:end-13,end:end-1},sourceHash:hash,contentHash:digest(text.slice(end-13,end-1))}];});
 await analysis(f.root,f.b,units(f.b,original));
 const receiptId=await store.put(f.root,{kind:'search',schemaVersion:1,project:f.root,snapshotId:f.b.snapshotId,snapshot:f.b.snapshot.fingerprint,query:'new section',filters:{},limit:10,status:'ready',capabilities:{semanticSearch:true},modelIdentity:'fixture',indexRevision:'fixture',versions:{},coverage:{},diagnostics:[],candidates:[]});
 const d=await f.update({expectedRevision:null,scope:['rules.md'],baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:entry('section','ADD',[],[{path:'rules.md',selector:{type:'heading',value:'#new'}}],{kind:'section',requirements:[ref('requirements.txt')],reuseEvidence:{receiptIds:[receiptId],candidates:[],justification:'A distinct section.',emptyResultReason:'The mocked search returned no candidates.'}})}]});assert.equal(d.ready,true);
 await writeFile(path.join(f.root,'rules.md'),final);const result=await store.capture(f.root);await analysis(f.root,result,units(result,final));const c=await compare(f,d,result);assert.equal(c.observations.some(item=>item.code==='addition_already_exists'),false);
});

test('REPLACE consolidation may retain its explicit destination identity but not obsolete source identities',async()=>{
 const original='function retained() { return 1; }\nfunction obsolete() { return 2; }\n',final='function retained() { return 3; }\n';const f=await fixture({'code.ts':original,'requirements.txt':'Consolidate obsolete into retained.'});const before=privateFunctions(f.b,original);await analysis(f.root,f.b,before);
 const reference=unit=>({path:'code.ts',selector:{type:'span',...unit.span,sourceHash:unit.sourceHash}});
 await writeFile(path.join(f.root,'code.ts'),final);let result=await store.capture(f.root),after=privateFunctions(result,final);await analysis(f.root,result,after);
 let d=await f.update({expectedRevision:null,scope:['code.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:entry('consolidate','REPLACE',before.map(reference),[reference(after[0])],{kind:'function'})}]});
 assert.equal((await compare(f,d,result)).observations.some(item=>item.code==='retained_source'),false);
 const incomplete=final+'function obsolete() { return 9; }\n';await writeFile(path.join(f.root,'code.ts'),incomplete);result=await store.capture(f.root);after=privateFunctions(result,incomplete);await analysis(f.root,result,after);
 d=await f.update({expectedRevision:d.revision,operations:[{op:'update',id:'consolidate',set:{after:[reference(after[0])]}}]});
 const c=await compare(f,d,result);assert.deepEqual(c.observations.filter(item=>item.code==='retained_source').map(item=>item.unit.selector),['obsolete']);
});
test('readiness rejects additions and parallel modifications that copy a change into functions that several files repeat',async()=>{
 const body=name=>`function ${name}(lockPath) {\n  const text = readFileSync(lockPath, "utf8");\n  const owner = JSON.parse(text);\n  if (!owner.pid) return null;\n  if (owner.token.length !== 36) return null;\n  const alive = processState(owner.pid);\n  if (!alive) return null;\n  const age = Date.now() - owner.createdAt;\n  if (age > LOCK_STALE_MS) return null;\n  return { pid: owner.pid, token: owner.token };\n}\n`;
 const small='function digest(text) {\n  return hash(text);\n}\n';
 const files={'a.ts':body('readLockOwner')+small,'b.ts':body('readLockOwner').replace('return null;\n  const alive','throw new Error("bad");\n  const alive')+small,'requirements.md':'Requirement'};
 const f=await fixture(files);
 const units=[];
 for(const [file,text] of Object.entries(files)) for(const match of text.matchAll(/function (\w+)\([^)]*\) \{[\s\S]*?\n\}/g)) {
  const startLine=text.slice(0,match.index).split('\n').length,endLine=startLine+match[0].split('\n').length-1;
  units.push({id:`${file}#${match[1]}`,file,domain:'code',kind:'function',name:match[1],selector:match[1],range:{startLine,endLine},rangeComplete:true,span:{start:match.index,end:match.index+match[0].length},sourceHash:f.b.snapshot.files.find(x=>x.file===file).hash,contentHash:digest(match[0])});
 }
 await analysis(f.root,f.b,units);
 const symbol=(path,value)=>({path,selector:{type:'symbol',value}});
 const additions=[entry('report-a','ADD',[],[symbol('a.ts','reportA')]),entry('report-b','ADD',[],[symbol('b.ts','reportB')])];
 const base={schemaVersion:2,scope:['a.ts','b.ts','shared.ts'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],concepts:additions};
 const growth=async document=>(await assessDeltaReadiness(f.root,document)).filter(x=>x.code.startsWith('duplication')||x.code.startsWith('consolidation'));
 const found=await growth(base);
 assert.equal(found.length,1);assert.equal(found[0].code,'duplication_growth');assert.equal(found[0].blocking,true);
 assert.match(found[0].message,/readLockOwner/);assert.doesNotMatch(found[0].message,/digest/);
 assert.deepEqual(await growth({...base,concepts:[additions[0]]}),[]);
 const consolidate=entry('lock-owner','REPLACE',[symbol('a.ts','readLockOwner'),symbol('b.ts','readLockOwner')],[symbol('shared.ts','readLockOwner')]);
 assert.deepEqual(await growth({...base,concepts:[...additions,consolidate]}),[]);
 assert.equal((await growth({...base,concepts:[...additions,{...consolidate,before:[symbol('a.ts','readLockOwner')]}]})).length,1);
 const other='plan/consolidate/change-map.json';
 await updateChangeMap({projectRoot:f.root,deltaPath:other,expectedRevision:null,scope:['a.ts','b.ts','shared.ts'],baselineId:f.b.snapshotId,operations:[{op:'insert',entry:consolidate}]});
 assert.deepEqual(await growth({...base,consolidations:[{deltaPath:other,reason:'The store slice consolidates the lock helpers first.'}]}),[]);
 assert.deepEqual((await growth({...base,consolidations:[{deltaPath:'plan/missing/change-map.json',reason:'Missing.'}]})).map(x=>x.code).sort(),['consolidation_delta_invalid','duplication_growth']);
 const modify=file=>entry(`wait-${file}`,'MODIFY',[symbol(file,'readLockOwner')],[symbol(file,'readLockOwner')]);
 const parallel=await growth({...base,concepts:[modify('a.ts'),modify('b.ts')]});
 assert.equal(parallel.length,1);assert.equal(parallel[0].code,'duplication_growth');
 assert.match(parallel[0].message,/wait-a\.ts, wait-b\.ts change the copies of the functions readLockOwner separately in a\.ts, b\.ts/);
 assert.deepEqual(await growth({...base,concepts:[modify('a.ts')]}),[]);
 assert.deepEqual(await growth({...base,concepts:[entry('digest-a','MODIFY',[symbol('a.ts','digest')],[symbol('a.ts','digest')]),entry('digest-b','MODIFY',[symbol('b.ts','digest')],[symbol('b.ts','digest')])]}),[]);
 assert.deepEqual(await growth({...base,concepts:[modify('a.ts'),modify('b.ts'),consolidate]}),[]);
});

test('treats a scope with a trailing slash like the bare directory',async()=>{
  const {withinScope}=await import('../../dist/server/conservation/conservation-store.mjs');
  assert.equal(withinScope('sheetcalc/formula.py',['sheetcalc/']),true);
  assert.equal(withinScope('sheetcalc/formula.py',['sheetcalc']),true);
  assert.equal(withinScope('sheetcalc',['sheetcalc/']),true);
  assert.equal(withinScope('sheetcalcx/a.py',['sheetcalc/']),false);
  assert.equal(withinScope('a.py',['/']),false);
});

test('accepts concept references under a scope written with a trailing slash',async()=>{
 const f=await fixture({'pkg/code.ts':'function existing() { return 1; }\n','requirements.txt':'Change the code.'});
 const d=await f.update({expectedRevision:null,scope:['pkg/'],baselineId:f.b.snapshotId,requirements:[ref('requirements.txt')],operations:[{op:'insert',entry:entry('code','MODIFY',[ref('pkg/code.ts')],[ref('pkg/code.ts')])}]});
 assert.match(d.revision,/^[a-f0-9]{64}$/);
 await assert.rejects(f.update({expectedRevision:d.revision,operations:[{op:'insert',entry:entry('other','ADD',[],[ref('pkgx/other.ts')])}]}),error=>error.errors.some(item=>item.includes('pkgx/other.ts is outside the declared scope')));
});
test('a delta that cites discovery receipts records a disposition for each finding inside its scope',async()=>{
 const {receiptFindings,withFindingIds}=await import('../../dist/server/conservation/discovery-findings.mjs');
 const code='function alpha() { return "x-state"; }\nfunction beta() { return 2; }\n',other='function alpha2() { return "x-state"; }\nfunction beta2() { return 2; }\n';
 const f=await fixture({'src/code.ts':code,'src/other.ts':other,'lib/far.ts':other,'requirements.md':'Keep behavior.'});await analysis(f.root,f.b);
 const member=(file,line)=>({file,selector:'unit',kind:'function',range:{startLine:line,endLine:line},share:1});
 const groups=withFindingIds('find_shared_literals',{groups:[{literals:[],weight:1,members:[member('src/code.ts',1),member('src/other.ts',1)],users:[],clients:[]},{literals:[],weight:1,members:[member('src/code.ts',2),member('src/other.ts',2)],users:[],clients:[]},{literals:[],weight:1,members:[member('lib/far.ts',1),member('lib/far.ts',2)],users:[],clients:[]}]}).groups;
 const receipt={kind:'repository-analysis',schemaVersion:1,project:f.root,tool:'find_shared_literals',snapshotId:f.b.snapshotId,snapshot:f.b.snapshot.fingerprint,indexRevision:'fixture',versions:{},scope:{},coverage:{},diagnostics:[],files:[],groups};
 const receiptId=await store.put(f.root,receipt);const [first,second]=receiptFindings(receipt);
 assert.deepEqual(groups.map(group=>group.id),receiptFindings(receipt).map(finding=>finding.id));
 const delta=evidence=>({schemaVersion:2,scope:['src'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],concepts:[entry('one-owner','REPLACE',[ref('src/code.ts','function alpha() { return "x-state"; }'),ref('src/other.ts','function alpha2() { return "x-state"; }')],[ref('src/code.ts','function alpha() { return "x-state"; }')])],discoveryEvidence:evidence});
 const codes=async evidence=>(await assessDeltaReadiness(f.root,delta(evidence))).map(item=>item.code);
 let found=await codes({receiptIds:[receiptId],findings:[]});
 assert.ok(found.includes('discovery_tool_missing'));
 const missing=(await assessDeltaReadiness(f.root,delta({receiptIds:[receiptId],findings:[]}))).find(item=>item.code==='finding_disposition_missing');
 assert.match(missing.message,/2 discovery findings/);assert.match(missing.message,new RegExp(first.id));assert.doesNotMatch(missing.message,/lib\/far\.ts/);
 const omittedTools=['find_shared_dependencies','find_same_name_units','report_module_interfaces','report_cohesion_clusters','report_complex_units'].map(tool=>({tool,reason:'Not needed for the fixture.'}));
 found=await codes({receiptIds:[receiptId],omittedTools,findings:[{receiptId,findingId:first.id,disposition:'CHANGE',conceptIds:['one-owner'],reason:'Consolidate the state literal.'},{receiptId,findingId:second.id,disposition:'KEEP',reason:'Unrelated constants.'}]});
 assert.deepEqual(found.filter(code=>/discovery|finding/.test(code)),[]);
 found=await codes({receiptIds:[receiptId],omittedTools,findings:[{receiptId,findingId:second.id,disposition:'CHANGE',conceptIds:['one-owner'],reason:'Wrong entry.'},{receiptId,findingId:first.id,disposition:'DEFER',reason:'Later.'},{receiptId,findingId:'0123456789abcdef',disposition:'KEEP',reason:'Unknown.'}]});
 assert.ok(found.includes('finding_change_mismatch'));assert.ok(found.includes('finding_not_in_receipt'));assert.ok(found.includes('findings_deferred'));
 assert.ok((await codes({receiptIds:[receiptId],omittedTools,findings:[{receiptId,findingId:first.id,disposition:'CHANGE',conceptIds:['absent'],reason:'Missing entry.'}]})).includes('finding_change_unplanned'));
 const staleId=await store.put(f.root,{...receipt,snapshotId:'f'.repeat(64)});
 assert.ok((await codes({receiptIds:[staleId],omittedTools,findings:[]})).includes('discovery_receipt_invalid'));
 const written=await f.update({expectedRevision:null,scope:['src'],baselineId:f.b.snapshotId,requirements:[ref('requirements.md')],discoveryEvidence:{receiptIds:[receiptId],omittedTools,findings:[{receiptId,findingId:first.id,disposition:'KEEP',reason:'Fixture.'}]},operations:[]});
 assert.ok(written.diagnostics.some(item=>item.code==='finding_disposition_missing'));assert.equal(written.ready,false);
});

test('a legacy concept-delta.json keeps working and can be renamed to change-map.json mid-review', async () => {
 const root=await mkdtemp(path.join(home,'renamed-'));await writeFile(path.join(root,'script.js'),'let x=0;\n');
 const legacyPath='plan/slice/concept-delta.json',newPath='plan/slice/change-map.json',reviewPath='plan/slice/review.json';
 const b=await store.capture(root,legacyPath);await analysis(root,b);
 const d=await updateChangeMap({projectRoot:root,deltaPath:legacyPath,expectedRevision:null,scope:['script.js'],baselineId:b.snapshotId,operations:[]});
 assert.equal(d.deltaPath,legacyPath);
 // A caller that already uses the new name finds the slice's legacy file instead of creating a second one.
 assert.equal((await getChangeMap({projectRoot:root,deltaPath:newPath})).revision,d.revision);
 let revision=null;
 const act=async(id,operations,deltaPath=legacyPath)=>{const r=await updateReview({projectRoot:root,reviewPath,deltaPath,delivery:'dev',expectedRevision:revision,actor:{id,role:id==='coord'?'coordinator':'reviewer'},operations});revision=r.revision;return r;};
 const comparison=async(deltaPath)=>(await compareChangeMap({projectRoot:root,deltaPath,expectedRevision:d.revision,baselineId:b.snapshotId,resultSnapshotId:b.snapshotId},{runtime:degraded})).comparisonId;
 await act('coord',[{op:'start_wave',id:'audit',mode:'design-audit',deltaRevision:d.revision,snapshotId:b.snapshotId,comparisonId:await comparison(newPath),lanes:[{id:'main',reviewer:'reviewer',coverage:['script.js']}]}]);
 await act('reviewer',[{op:'submit_lane',lane:'main',status:'CLEAN'}]);await act('coord',[{op:'accept_wave'}]);
 assert.equal((await checkReviewGate({projectRoot:root,reviewPath,gate:'implementation'})).ready,true);
 await import('node:fs/promises').then(fs=>fs.rename(path.join(root,legacyPath),path.join(root,newPath)));
 const renamed=await getChangeMap({projectRoot:root,deltaPath:legacyPath});
 assert.equal(renamed.deltaPath,newPath);assert.equal(renamed.revision,d.revision);
 assert.equal((await checkReviewGate({projectRoot:root,reviewPath,gate:'implementation'})).ready,true);
 const after=await store.capture(root);
 assert.equal(after.snapshot.files.some(file=>file.file===newPath),false);
 await act('coord',[{op:'start_wave',id:'audit-2',mode:'design-audit',deltaRevision:d.revision,snapshotId:b.snapshotId,comparisonId:await comparison(newPath),lanes:[{id:'main',reviewer:'reviewer',coverage:['script.js']}]}],newPath);
 await act('reviewer',[{op:'submit_lane',lane:'main',status:'CLEAN'}],newPath);await act('coord',[{op:'accept_wave'}],newPath);
 assert.equal((await checkReviewGate({projectRoot:root,reviewPath,gate:'implementation'})).ready,true);
});
