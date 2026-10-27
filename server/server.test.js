import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalHttpServer, UI_URI, withPdfSlot } from './server.js';
import { makeFilesystem } from './files.js';

function fixturePdf(){
  const stream='BT /F1 14 Tf 20 350 Td (MCP PDF text) Tj ET\n';
  const stream2='BT /F1 14 Tf 20 350 Td (MCP second page) Tj ET\n';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',`<< /Length ${Buffer.byteLength(stream2)} >>\nstream\n${stream2}endstream`];
  let pdf='%PDF-1.4\n';const offsets=[0];
  for(const [i,o] of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for(const n of offsets.slice(1)) pdf+=`${String(n).padStart(10,'0')} 00000 n \n`;
  return Buffer.from(pdf+`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('MCP entrypoints, scoped search, byte transfer and origin protection',async()=>{
  const outer=await fs.mkdtemp(path.join(os.tmpdir(),'file-browser-test-'));
  const root=path.join(outer,'inside'),uiPath=path.join(outer,'widget.html');
  await fs.mkdir(root);await fs.mkdir(path.join(root,'nested'));
  await fs.writeFile(uiPath,'<!doctype html><title>fixture</title>');
  await fs.writeFile(path.join(root,'nested','report.md'),'Exact needle and human-readable content.');
  await fs.writeFile(path.join(root,'sample.pdf'),fixturePdf());
  for(let i=0;i<7;i++) await fs.writeFile(path.join(root,`target-${i}.txt`),`fixture ${i}`);
  const boundary=path.join(root,'boundary.txt');
  const multi=path.join(root,'multi.txt'),multiText='\uFEFFA😀éZ 🐈 the end';
  await fs.writeFile(multi,multiText,'utf8');
  await fs.writeFile(boundary,Buffer.concat([Buffer.from('boundary-needle'),Buffer.alloc(131071-15,0x61),Buffer.from('é end')]));
  const cross=path.join(root,'cross.txt');
  await fs.writeFile(cross,Buffer.concat([Buffer.alloc(131068,0x61),Buffer.from('café-needle') ]));
  await fs.writeFile(path.join(root,'deep.txt'),Buffer.concat([Buffer.alloc(131200,0x61),Buffer.from('deepneedle-late') ]));
  await fs.writeFile(path.join(root,'.hidden'),'hidden');
  await fs.writeFile(path.join(outer,'outside.txt'),'outside');
  await fs.symlink(path.join(outer,'outside.txt'),path.join(root,'outside-link'));
  const original=crypto.randomBytes(600123);original[0]=0;
  const binary=path.join(root,'binary.dat');await fs.writeFile(binary,original);
  const server=createLocalHttpServer({root,uiPath});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port, transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client=new Client({name:'test-client',version:'1'});
  try {
    await client.connect(transport);
    const {tools}=await client.listTools();
    const open=tools.find(t=>t.name==='open_browser');assert.ok(open);
    assert.equal(open._meta.ui.resourceUri,UI_URI);
    assert.deepEqual(open._meta['openai/ui'].entrypoints,[{type:'global'},{type:'thread'}]);
    assert.ok(!open.inputSchema.required || open.inputSchema.required.length===0);
    assert.equal(open.inputSchema.type,'object');assert.equal(open.inputSchema.properties.limit.maximum,500);
    assert.equal(open.outputSchema.properties.entries.type,'array');
    assert.ok(open.outputSchema.required.includes('entries'));
    const readSchema=tools.find(t=>t.name==='read_file').inputSchema;
    assert.ok(readSchema.required.includes('path'));assert.equal(readSchema.properties.max_bytes.maximum,131072);
    const searchSchema=tools.find(t=>t.name==='search_files').inputSchema;
    assert.deepEqual(searchSchema.properties.mode.enum,['name','content']);
    assert.deepEqual(tools.find(t=>t.name==='read_file_chunk')._meta.ui.visibility,['app']);
    const resource=await client.readResource({uri:UI_URI});
    assert.match(resource.contents[0].text,/fixture/);
    assert.deepEqual(resource.contents[0]._meta['openai/ui'].availableDisplayModes,['inline','fullscreen']);
    const legacyResource=await client.readResource({uri:'ui://file-browser/v1.html'});
    assert.equal(legacyResource.contents[0].text,resource.contents[0].text);
    const browse=await client.callTool({name:'open_browser',arguments:{}});
    assert.equal(browse.structuredContent.path,await fs.realpath(root));
    assert.ok(browse.structuredContent.entries.some(e=>e.name==='.hidden'));
    const matched=await client.callTool({name:'search_files',arguments:{root,query:'needle',mode:'content'}});
    assert.ok(matched.structuredContent.entries.some(e=>e.name==='report.md'));
    assert.ok(matched.structuredContent.entries.some(e=>e.name==='boundary.txt'));
    const utfPreview=await client.callTool({name:'read_file',arguments:{path:boundary,max_bytes:131072}});
    assert.equal(utfPreview.structuredContent.kind,'text');assert.match(utfPreview.structuredContent.content,/boundary-needle/);
    let textOffset=0,textVersion,reconstructed='';
    do {
      const args={path:multi,max_bytes:4,offset:textOffset};if(textVersion) args.expected_version=textVersion;
      const page=await client.callTool({name:'read_file',arguments:args});assert.equal(page.isError,undefined);
      assert.equal(page.structuredContent.kind,'text');reconstructed+=page.structuredContent.content;
      textVersion=page.structuredContent.version;textOffset=page.structuredContent.next_offset;
    } while(textOffset!==null);
    assert.equal(reconstructed,multiText);
    const missingReadVersion=await client.callTool({name:'read_file',arguments:{path:multi,offset:1}});assert.equal(missingReadVersion.isError,true);
    const tooSmall=await client.callTool({name:'read_file',arguments:{path:multi,max_bytes:1}});assert.equal(tooSmall.isError,true);
    await fs.appendFile(multi,'changed');
    const changedText=await client.callTool({name:'read_file',arguments:{path:multi,offset:1,expected_version:textVersion}});assert.equal(changedText.isError,true);
    const deep=await client.callTool({name:'search_files',arguments:{root,query:'deepneedle-late',mode:'content'}});
    assert.ok(deep.structuredContent.entries.some(e=>e.name==='deep.txt'));
    const across=await client.callTool({name:'search_files',arguments:{root,query:'café-needle',mode:'content'}});
    assert.ok(across.structuredContent.entries.some(e=>e.name==='cross.txt'));
    const pagedArgs={root,query:'target-',mode:'name',limit:2};
    const first=await client.callTool({name:'search_files',arguments:pagedArgs});
    assert.equal(first.structuredContent.entries.length,2);assert.ok(first.structuredContent.next_cursor);
    const cursor=first.structuredContent.next_cursor;
    const wrongLimit=await client.callTool({name:'search_files',arguments:{...pagedArgs,limit:1,cursor}});assert.equal(wrongLimit.isError,true);
    const [page2,retry,concurrentWrong]=await Promise.all([client.callTool({name:'search_files',arguments:{...pagedArgs,cursor}}),client.callTool({name:'search_files',arguments:{...pagedArgs,cursor}}),client.callTool({name:'search_files',arguments:{...pagedArgs,limit:1,cursor}})]);
    assert.equal(concurrentWrong.isError,true);
    assert.deepEqual(page2.structuredContent,retry.structuredContent);
    const seen=[...first.structuredContent.entries,...page2.structuredContent.entries];
    let next=page2.structuredContent.next_cursor;
    while(next){const page=await client.callTool({name:'search_files',arguments:{...pagedArgs,cursor:next}});seen.push(...page.structuredContent.entries);next=page.structuredContent.next_cursor;}
    assert.equal(seen.length,7);assert.equal(new Set(seen.map(e=>e.path)).size,7);
    const badCursor=await client.callTool({name:'search_files',arguments:{...pagedArgs,cursor:'not-valid'}});assert.equal(badCursor.isError,true);
    let simulatedTime=100;
    const scoped=await makeFilesystem(root,{now:()=>simulatedTime,cursorTtlMs:10});
    const expires=await scoped.search({root,query:'target-',limit:1});assert.ok(expires.next_cursor);
    simulatedTime+=11;
    await assert.rejects(scoped.search({root,query:'target-',limit:1,cursor:expires.next_cursor}),/expired/);
    let simulatedSearchTime=0;
    const budgeted=await makeFilesystem(root,{searchNow:()=>simulatedSearchTime++,pageTimeMs:2});
    const pagedContentArgs={root,query:'café-needle',mode:'content',limit:20};
    let contentPage=await budgeted.search(pagedContentArgs),calls=1,found=[...contentPage.entries];
    while(contentPage.next_cursor && calls++<50){contentPage=await budgeted.search({...pagedContentArgs,cursor:contentPage.next_cursor});found.push(...contentPage.entries);}
    assert.ok(calls>1 && calls<50);assert.ok(found.some(e=>e.name==='cross.txt'));
    const preview=await client.callTool({name:'read_file',arguments:{path:binary}});
    assert.equal(preview.structuredContent.kind,'binary');
    const pdf=await client.callTool({name:'read_pdf_page',arguments:{path:path.join(root,'sample.pdf'),page:1,max_pixels:300}});
    assert.equal(pdf.isError,undefined);assert.equal(pdf.structuredContent.pages,2);assert.equal(pdf.structuredContent.mime_type,'image/png');
    assert.deepEqual(Buffer.from(pdf._meta.data_base64,'base64').subarray(0,8),Buffer.from('89504e470d0a1a0a','hex'));
    assert.equal(pdf.structuredContent.version.length,64);
    const wrongPdfVersion=await client.callTool({name:'read_pdf_page',arguments:{path:path.join(root,'sample.pdf'),expected_version:'0'.repeat(64)}});assert.equal(wrongPdfVersion.isError,true);
    const missingPdfVersion=await client.callTool({name:'read_pdf_page',arguments:{path:path.join(root,'sample.pdf'),page:2}});assert.equal(missingPdfVersion.isError,true);assert.match(missingPdfVersion.content[0].text,/expected_version/);
    const secondPdfPage=await client.callTool({name:'read_pdf_page',arguments:{path:path.join(root,'sample.pdf'),page:2,max_pixels:300,expected_version:pdf.structuredContent.version}});assert.equal(secondPdfPage.isError,undefined);assert.equal(secondPdfPage.structuredContent.page,2);
    const pdfText=await client.callTool({name:'read_pdf_text',arguments:{path:path.join(root,'sample.pdf'),max_pages:1,max_chars:20}});
    assert.equal(pdfText.isError,undefined);assert.equal(pdfText.structuredContent.page_count,2);assert.equal(pdfText.structuredContent.version,pdf.structuredContent.version);
    assert.match(pdfText.structuredContent.pages[0].text,/MCP PDF text/);
    const missingTextVersion=await client.callTool({name:'read_pdf_text',arguments:{path:path.join(root,'sample.pdf'),page:2}});assert.equal(missingTextVersion.isError,true);assert.match(missingTextVersion.content[0].text,/expected_version/);
    const missingOffsetVersion=await client.callTool({name:'read_pdf_text',arguments:{path:path.join(root,'sample.pdf'),char_offset:1}});assert.equal(missingOffsetVersion.isError,true);assert.match(missingOffsetVersion.content[0].text,/expected_version/);
    const continuedText=await client.callTool({name:'read_pdf_text',arguments:{path:path.join(root,'sample.pdf'),page:pdfText.structuredContent.next_page,char_offset:pdfText.structuredContent.next_char_offset,expected_version:pdfText.structuredContent.version}});assert.equal(continuedText.isError,undefined);assert.match(continuedText.structuredContent.pages[0].text,/MCP second page/);
    const wrongTextVersion=await client.callTool({name:'read_pdf_text',arguments:{path:path.join(root,'sample.pdf'),expected_version:'0'.repeat(64)}});assert.equal(wrongTextVersion.isError,true);
    const escaped=await client.callTool({name:'read_file',arguments:{path:path.join(root,'outside-link')}});
    assert.equal(escaped.isError,true);
    const chunks=[];let offset=0,version;
    while(offset<original.length){
      const args={path:binary,offset,length:262144};if(version) args.expected_version=version;
      const result=await client.callTool({name:'read_file_chunk',arguments:args});
      assert.equal(result.isError,undefined);const d=result.structuredContent;
      assert.equal(d.offset,offset);assert.ok(d.length<=262144);assert.ok(result._meta.data_base64);
      const decoded=Buffer.from(result._meta.data_base64,'base64');assert.equal(decoded.length,d.length);
      chunks.push(decoded);version=d.version;offset=d.next_offset;
    }
    const assembled=Buffer.concat(chunks);
    assert.equal(crypto.createHash('sha256').update(assembled).digest('hex'),crypto.createHash('sha256').update(original).digest('hex'));
    const noVersion=await client.callTool({name:'read_file_chunk',arguments:{path:binary,offset:5}});assert.equal(noVersion.isError,true);
    const randomOffset=await client.callTool({name:'read_file_chunk',arguments:{path:binary,offset:13,length:100,expected_version:version}});
    assert.deepEqual(Buffer.from(randomOffset._meta.data_base64,'base64'),original.subarray(13,113));
    await fs.appendFile(binary,'changed');
    const changed=await client.callTool({name:'read_file_chunk',arguments:{path:binary,offset:1,expected_version:version}});assert.equal(changed.isError,true);
    const crossOrigin=await fetch(`http://127.0.0.1:${port}/health`,{headers:{Origin:'https://attacker.example'}});assert.equal(crossOrigin.status,403);
    const rebindStatus=await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port,path:'/health',headers:{host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(rebindStatus,403);
  } finally {
    await client.close();await new Promise(resolve=>server.close(resolve));await fs.rm(outer,{recursive:true,force:true});
  }
});

test('PDF admission gate bounds snapshots as well as rendering',async()=>{
  const releases=[];
  const first=withPdfSlot(()=>new Promise(resolve=>releases.push(resolve)));
  const second=withPdfSlot(()=>new Promise(resolve=>releases.push(resolve)));
  await assert.rejects(withPdfSlot(async()=>{}),/busy/);
  releases.forEach(resolve=>resolve());
  await Promise.all([first,second]);
  await assert.rejects(withPdfSlot(async()=>{throw new Error('fixture')}),/fixture/);
  assert.equal(await withPdfSlot(async()=>42),42);
});
