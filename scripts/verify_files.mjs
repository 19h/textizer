import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import init, { PackedText } from '../pkg/textizer.js';
import { captureTransfer, captureFiles, collectTextFiles, decodeText, fileText, combinedText, chunks, renderInputs } from '../web/files.js';
import { createPlan } from '../web/render-plan.js';
const bytes = s => new TextEncoder().encode(s);
const file = (name, text, type = '') => new File([text], name, { type });
const entry = (name, text) => ({ name, isFile: true, file(resolve) { resolve(file(name,text)); } });
function folder(name, children) {
  return { name, isDirectory: true, createReader() {
    let offset=0; return { readEntries(resolve) { const batch=children.slice(offset,offset+100);offset+=100;resolve(batch); } };
  } };
}
const root = folder('project', [...Array.from({length:121},(_,i)=>entry(`f${i}.rs`,'fn main() {}')),
  folder('nested',[entry('a.md','— markdown'),entry('bad.png',new Uint8Array([137,80,78,71,0,0]))])]);
let captured = false;
const data = { types:['Files'], items:[{kind:'file',webkitGetAsEntry(){captured=true;return root;},getAsFile(){return null;}}] };
const snapshot = captureTransfer(data);
assert.equal(captured,true);
const result = await collectTextFiles(snapshot);
assert.equal(result.files.length,122);
assert.equal(result.skipped.length,1);
assert.ok(result.files.some(f=>f.path==='project/nested/a.md'));
assert.equal(fileText({path:'project/a.rs',text:'x'},'/Users/me'),'# /Users/me/project/a.rs\nx');
for (const b of [new Uint8Array([0,1,2]),bytes('%PDF-1.7'),bytes('MZstub'),new Uint8Array([0xff])]) assert.throws(()=>decodeText(b));
assert.equal(decodeText(new Uint8Array([255,254,65,0,10,0])),'A\n');
assert.equal(decodeText(bytes('é Ω source')),'é Ω source');
const many = 'αβ🧬'.repeat(20);
const split = chunks(many,8); assert.equal(split.join(''),many);
assert.ok(split.every(s=>bytes(s).length<=8));
const empty = await collectTextFiles(captureFiles([file('empty.txt','')]));
assert.equal(empty.files.length,1);
await init({module_or_path:readFileSync(new URL('../pkg/textizer_bg.wasm',import.meta.url))});
const files=[{path:'project/a.rs',text:'let a=1;'}, {path:'project/sub/b.md',text:'hello'}];
const options={page_mode:'full',max_columns:0};
const together = renderInputs('',files,false,'/src');
assert.equal(together[0].text,'# /src/project/a.rs\nlet a=1;\n\n# /src/project/sub/b.md\nhello');
const combined=createPlan(PackedText,together,options);
const separateInputs=renderInputs('',files,true,'/src');
const separated=createPlan(PackedText,separateInputs,options);
assert.equal(combined.pages.length,1);
assert.equal(separated.pages.length,2);
assert.deepEqual(separated.pages.map(p=>p.file_path),['/src/project/a.rs','/src/project/sub/b.md']);
assert.deepEqual(separated.pages.map(p=>p.index),[0,1]);
const huge=[{path:'a',text:'x'.repeat(4*1024*1024)}];
assert.ok(renderInputs('',huge,true,'').every(s=>bytes(s.text).length<=4*1024*1024));
const spacedFiles = [
  {path:'project/two  words.txt',text:'  first\n\nsecond\tthird  '},
  {path:'project/b.txt',text:' next\u0085line\n'},
];
assert.equal(fileText(spacedFiles[0],'/root',true),'# /root/project/two  words.txt\nfirst second third');
assert.equal(fileText({path:'bom.txt',text:'\ufeff first\n'},'',true),'# bom.txt\n\ufeff first');
for (const separate of [false,true]) {
  const inputs=renderInputs('',spacedFiles,separate,'/root',true);
  for (const input of inputs) {
    const doc=new PackedText(input.text,JSON.stringify({...options,reflow:false}));
    try {
      const rows=JSON.parse(doc.pageRowsJson(0));
      assert.ok(rows[0].text.startsWith('# /root/project/'));
      assert.equal(rows[0].hard_break,true);
      assert.ok(rows.some(row=>row.text==='first second third' || row.text==='next line'));
      assert.ok(!rows.some(row=>row.text.includes('# ') && row.text.includes('first second third')));
    } finally {doc.free();}
  }
}
assert.equal(combinedText(spacedFiles,'/root'),renderInputs('',spacedFiles,false,'/root',false)[0].text);
console.log('PASS: folder batches, headers, binary filtering, UTF-16, empty files, Unicode chunks and combined/per-file plans');
