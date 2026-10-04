import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFile = promisify(execFileCallback);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_TEXT = 24_000;
const MAX_PIXELS = 40_000_000;
function fail(code) { throw Object.assign(new Error(code), { code, permanent: true }); }
export function detectReceiptMime(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0,5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  return null;
}
function imageDimensions(bytes,mimeType) {
  const view=Buffer.from(bytes);
  if(mimeType==='image/png'&&view.length>=24) return {width:view.readUInt32BE(16),height:view.readUInt32BE(20)};
  if(mimeType!=='image/jpeg') return null;
  let offset=2;
  while(offset+4<view.length) {
    if(view[offset++]!==0xff) continue;
    let marker=view[offset++]; while(marker===0xff&&offset<view.length) marker=view[offset++];
    if(marker===0xd8||marker===0xd9||marker>=0xd0&&marker<=0xd7) continue;
    if(offset+2>view.length) break;
    const size=view.readUInt16BE(offset); if(size<2||offset+size>view.length) break;
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&size>=7)
      return {height:view.readUInt16BE(offset+3),width:view.readUInt16BE(offset+5)};
    offset+=size;
  }
  return null;
}
export async function extractDocumentText({ bytes, mimeType }, { execFileImpl=execFile }={}) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_BYTES) fail('RECEIPT_FILE_INVALID');
  const actual = detectReceiptMime(Buffer.from(bytes));
  if (!actual || actual !== mimeType) fail('RECEIPT_FILE_TYPE_MISMATCH');
  if(actual!=='application/pdf') {
    const dimensions=imageDimensions(bytes,actual);
    if(!dimensions||!dimensions.width||!dimensions.height||dimensions.width*dimensions.height>MAX_PIXELS) fail('RECEIPT_IMAGE_DIMENSIONS_INVALID');
  }
  const dir = await mkdtemp(join(tmpdir(),'finance-loop-receipt-'));
  try {
    const deadline=Date.now()+180_000;
    const bounded=ms=>Math.max(1,Math.min(ms,deadline-Date.now()));
    const input = join(dir, actual === 'application/pdf' ? 'source.pdf' : actual === 'image/png' ? 'source.png' : 'source.jpg');
    await writeFile(input, bytes, { mode: 0o600 });
    let text = '';
    if (actual === 'application/pdf') {
      try {
        const { stdout: pages } = await execFileImpl('pdfinfo',[input],{timeout:bounded(15000),maxBuffer:256000});
        const pageCount = Number(/^Pages:\s+(\d+)/mi.exec(pages)?.[1]);
        if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) fail('RECEIPT_PAGE_LIMIT');
        const pagesText = [];
        for (let page=1; page<=pageCount; page++) {
          let pageText = '';
          if(Date.now()>=deadline) fail('RECEIPT_PROCESSING_TIME_LIMIT');
          try { pageText = (await execFileImpl('pdftotext',['-f',String(page),'-l',String(page),'-layout','-enc','UTF-8',input,'-'],{timeout:bounded(12000),maxBuffer:512000})).stdout.trim(); } catch {}
          if (!pageText) {
            const prefix = join(dir,`page-${page}`);
            await execFileImpl('pdftoppm',['-f',String(page),'-l',String(page),'-png','-scale-to','2400',input,prefix],{timeout:bounded(20000),maxBuffer:512000});
            const imagePath = join(dir,(await readdir(dir)).find(name => name.startsWith(`page-${page}-`) && name.endsWith('.png')) ?? 'missing.png');
            pageText = (await execFileImpl('tesseract',[imagePath,'stdout','-l','eng'],{timeout:bounded(30000),maxBuffer:512000})).stdout.trim();
          }
          pagesText.push(`[page ${page}]\n${pageText}`);
        }
        if (!pagesText.some(pageText => pageText.slice(pageText.indexOf('\n') + 1).trim())) fail('RECEIPT_TEXT_EMPTY');
        text = pagesText.join('\n\f\n');
      } catch (error) { if (error?.permanent) throw error; fail('RECEIPT_PDF_READ_FAILED'); }
    }
    if (actual !== 'application/pdf' || !text) {
      try {
        const { stdout } = await execFileImpl('tesseract',[input,'stdout','-l','eng'],{timeout:bounded(90000),maxBuffer:2_000_000});
        text = stdout.trim();
      } catch { fail('RECEIPT_OCR_FAILED'); }
    }
    if (!text) fail('RECEIPT_TEXT_EMPTY');
    if (text.length > MAX_TEXT) fail('RECEIPT_TEXT_TOO_LARGE');
    return text;
  } finally { await rm(dir,{recursive:true,force:true}); }
}
