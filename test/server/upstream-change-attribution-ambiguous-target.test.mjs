// Review finding review-correctness-4/ambiguous-target-drops-cross-file-edges: the merged detector baseline must keep call edges to same-named units in one file, such as methods of two object literals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,mkdir,rm,appendFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {conservationStore as store,digest} from '../../dist/server/conservation/conservation-store.mjs';
import {updateChangeMap} from '../../dist/server/conservation/change-map.mjs';
import {compareChangeMap,ANALYSIS_VERSION} from '../../dist/server/conservation/conservation-analysis.mjs';
import {CHUNKER_VERSION} from '../../dist/native-runtime/versions.mjs';

const home=await realpath(await mkdtemp(path.join(os.tmpdir(),'prism-upstream-ambiguous-')));
store.directory=path.join(home,'evidence');
test.after(()=>rm(home,{recursive:true,force:true}));
const degraded={prepare:async()=>({status:'degraded',diagnostics:[{code:'unsupported_runtime',message:'Test without inference'}]})};
const ref=(file,value)=>({path:file,...(value?{selector:{type:'text',value}}:{})});
const key={initiative:'task',slice:'task'};
// Two strategy objects in one file give units with the same file, kind, and selector, as the native graph reports for object-literal methods.
const helpers=[1,2].map(n=>`function alpha(value) {\n  return value + ${n};\n}\nfunction beta(value) {\n  return value + ${n};\n}\nfunction gamma(value) {\n  return value + ${n};\n}\n`).join("");
const user=name=>`function ${name}(value) {\n  return alpha(value) + beta(value) + gamma(value);\n}\n`;
// The native graph names a unit by its file, kind, name, and line, so a line shift gives the unit a new ID.
async function functionAnalysis(root,snapshot) {
 const units=[],edges=[];
 for(const file of snapshot.snapshot.files.filter(item=>item.file.endsWith('.mjs'))) {
  const text=(await store.bytes(root,file)).toString('utf8');
  for(const match of text.matchAll(/function (\w+)\([^)]*\) \{[\s\S]*?\n\}/g)) {
   const startLine=text.slice(0,match.index).split('\n').length,endLine=startLine+match[0].split('\n').length-1;
   units.push({id:`function:${digest(`${file.file}:function:${match[1]}:${startLine}`).slice(0,32)}`,file:file.file,domain:'code',kind:'function',name:match[1],selector:match[1],range:{startLine,endLine},span:{start:match.index,end:match.index+match[0].length},sourceHash:file.hash,contentHash:digest(match[0]),isExported:false,body:match[0]});
  }
 }
 for(const unit of units) for(const target of units) if(target.file!==unit.file&&new RegExp(`\\b${target.name}\\(`).test(unit.body.split('\n').slice(1).join('\n'))) edges.push({source:unit.id,target:target.id,kind:'calls'});
 for(const unit of units) delete unit.body;
 const record={kind:'analysis',schemaVersion:1,project:root,snapshotId:snapshot.snapshotId,units,edges,unresolvedReferences:[],fileCoverage:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,true])),diagnostics:[],tokenCounts:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,1])),structureCounts:Object.fromEntries(snapshot.snapshot.files.map(f=>[f.file,{sections:0,paragraphs:0,listItems:0,links:0}])),versions:{extractor:CHUNKER_VERSION,metrics:ANALYSIS_VERSION,tokenizer:'fixture'}};
 await store.link(root,snapshot.snapshotId,await store.put(root,record));
}

test('an upstream line shift in a file with same-named units keeps the in-scope observations of a comparison without T',async()=>{
 const root=await mkdtemp(path.join(home,'project-'));
 const put=async(file,body)=>{await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),body);};
 for(const [file,body] of Object.entries({'rules.md':'old\n','requirements.md':'Requirement\n','src/helpers.mjs':helpers,'src/scope.mjs':user('first'),'src/other.mjs':user('second')})) await put(file,body);
 const b=await store.capture(root,key);await functionAnalysis(root,b);
 const scope=['rules.md','src/scope.mjs'];
 const delta=await updateChangeMap({projectRoot:root,...key,expectedRevision:null,scope,baselineId:b.snapshotId,requirements:[ref('requirements.md')],
  operations:[{op:'insert',entry:{id:'r',kind:'rule',label:'r',action:'REPLACE',before:[ref('rules.md','old')],after:[ref('rules.md','new')],reason:'Satisfy the bound requirement.'}}]});
 // A merge from main adds a header line to the out-of-scope helpers, so each helper unit gets a new ID.
 await put('src/helpers.mjs','// Helpers.\n'+helpers);
 const t=await store.capture(root);
 // The task edits only in-scope files, and the shared calls stay as the baseline had them.
 await put('rules.md','new\n');await appendFile(path.join(root,'src/scope.mjs'),'// note\n');
 const f=await store.capture(root);await functionAnalysis(root,f);
 const run=async startSnapshotId=>store.get(root,(await compareChangeMap({projectRoot:root,...key,expectedRevision:delta.revision,baselineId:b.snapshotId,resultSnapshotId:f.snapshotId,...(startSnapshotId?{startSnapshotId}:{})},{runtime:degraded})).comparisonId,'comparison');
 const without=await run(),withT=await run(t.snapshotId);
 const inScope=comparison=>comparison.observations.filter(item=>item.file&&scope.includes(item.file)).map(item=>`${item.code}:${item.file}:${item.severity}`).sort();
 assert.deepEqual(inScope(withT),inScope(without));
});
