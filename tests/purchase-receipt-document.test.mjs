import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { extractDocumentText, detectReceiptMime } from '../src/worker/purchase-receipt-document.mjs';

const pdf=Buffer.from('%PDF-1.7\n');

test('extracts searchable PDF pages and OCRs blank scanned pages with bounded raster dimensions',async()=>{
  const calls=[];
  const execFileImpl=async(command,args,options)=>{
    calls.push({command,args,options});
    if(command==='pdfinfo') return {stdout:'Pages: 2\n'};
    if(command==='pdftotext') return {stdout:args.includes('1')?'Supplier invoice text\nItem A $2.00':''};
    if(command==='pdftoppm') { await writeFile(`${args.at(-1)}-2.png`,Buffer.from('fake image'));return {stdout:''}; }
    if(command==='tesseract') return {stdout:'Scanned item text $3.00'};
    throw new Error(`unexpected command ${command}`);
  };
  const text=await extractDocumentText({bytes:pdf,mimeType:'application/pdf'},{execFileImpl});
  assert.match(text,/\[page 1\][\s\S]*Supplier invoice text/);
  assert.match(text,/\[page 2\][\s\S]*Scanned item text/);
  assert.ok(calls.some(call=>call.command==='pdftoppm'&&call.args.includes('-scale-to')&&call.args.includes('2400')));
  assert.ok(calls.every(call=>call.options.timeout<=180_000));
});

test('rejects unsupported file signatures, oversized PDFs, and oversized image pixel dimensions',async()=>{
  assert.equal(detectReceiptMime(Buffer.from('not a pdf')),null);
  await assert.rejects(extractDocumentText({bytes:Buffer.from('not a pdf'),mimeType:'application/pdf'}),{code:'RECEIPT_FILE_TYPE_MISMATCH'});
  const tooManyPages=async()=>({stdout:'Pages: 21\n'});
  await assert.rejects(extractDocumentText({bytes:pdf,mimeType:'application/pdf'},{execFileImpl:tooManyPages}),{code:'RECEIPT_PAGE_LIMIT'});
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(100000,16);png.writeUInt32BE(100000,20);
  await assert.rejects(extractDocumentText({bytes:png,mimeType:'image/png'}),{code:'RECEIPT_IMAGE_DIMENSIONS_INVALID'});
});

test('does not silently truncate extracted receipt text',async()=>{
  const execFileImpl=async(command,args)=>{
    if(command==='pdfinfo') return {stdout:'Pages: 1\n'};
    if(command==='pdftotext') return {stdout:'x'.repeat(25_000)};
    throw new Error('unexpected OCR');
  };
  await assert.rejects(extractDocumentText({bytes:pdf,mimeType:'application/pdf'},{execFileImpl}),{code:'RECEIPT_TEXT_TOO_LARGE'});
});

test('rejects an all-blank PDF instead of sending page markers to extraction',async()=>{
  const execFileImpl=async(command,args)=>{
    if(command==='pdfinfo') return {stdout:'Pages: 1\n'};
    if(command==='pdftotext') return {stdout:'  \n'};
    if(command==='pdftoppm') { await writeFile(`${args.at(-1)}-1.png`,Buffer.from('fake image'));return {stdout:''}; }
    if(command==='tesseract') return {stdout:' \n '};
    throw new Error(`unexpected command ${command}`);
  };
  await assert.rejects(extractDocumentText({bytes:pdf,mimeType:'application/pdf'},{execFileImpl}),{code:'RECEIPT_TEXT_EMPTY'});
});
