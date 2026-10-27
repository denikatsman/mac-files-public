import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderPdfPage, extractPdfText, MAX_PDF_BYTES } from './index.mjs';

// Construct a tiny two-page synthetic PDF entirely in memory; no user files
// are read or written by these tests.
function syntheticPdf(withText = false) {
  const page1 = withText ? 'BT /F1 18 Tf 50 700 Td (First synthetic page text.) Tj ET\n' : '0.1 0.3 0.5 rg 100 200 200 300 re f\n';
  const page2 = withText ? 'BT /F1 18 Tf 50 700 Td (Second synthetic page text.) Tj ET\n' : '0.7 0.2 0.1 rg 100 200 200 300 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(page1)} >>\nstream\n${page1}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(page2)} >>\nstream\n${page2}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let contents = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(contents));
    contents += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(contents);
  contents += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) contents += `${String(offset).padStart(10, '0')} 00000 n \n`;
  contents += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(contents);
}

test('render distinct PDF pages without touching source files', { timeout: 30000 }, async () => {
  const pdf = syntheticPdf();
  const before = createHash('sha256').update(pdf).digest('hex');
  const first = await renderPdfPage(pdf, { page: 1, maxPixels: 900 });
  const second = await renderPdfPage(pdf, { page: 2, maxPixels: 900 });
  assert.equal(first.pages, 2);
  assert.equal(second.pages, 2);
  assert.equal(first.page, 1);
  assert.equal(second.page, 2);
  assert.ok(first.width <= 900 && first.height <= 900);
  assert.notEqual(first.data_base64, second.data_base64);
  assert.equal(createHash('sha256').update(pdf).digest('hex'), before);
  await assert.rejects(renderPdfPage(pdf, { page: 3 }), /out of range/i);
});

test('extract complete embedded text with resumable page and character offsets', { timeout: 30000 }, async () => {
  const pdf = syntheticPdf(true);
  const full = await extractPdfText(pdf, { maxPages: 8, maxChars: 65536 });
  assert.equal(full.has_more, false);
  assert.equal(full.page_count, 2);
  assert.match(full.pages[0].text, /First synthetic/);
  assert.match(full.pages[1].text, /Second synthetic/);
  let page = 1, charOffset = 0, pieces = new Map(), turns = 0;
  while (true) {
    assert.ok(++turns < 12, 'text continuation must advance');
    const part = await extractPdfText(pdf, { page, charOffset, maxPages: 1, maxChars: 15 });
    for (const item of part.pages) pieces.set(item.page, (pieces.get(item.page) || '') + item.text);
    if (!part.has_more) break;
    page = part.next_page;
    charOffset = part.next_char_offset;
  }
  assert.equal(pieces.get(1), full.pages[0].text);
  assert.equal(pieces.get(2), full.pages[1].text);
  await assert.rejects(extractPdfText(pdf, { page: 1, charOffset: 1000 }), /offset is out of range/i);
  await assert.rejects(extractPdfText(pdf, { maxPages: 9 }), /maxPages/i);
});

test('reject malformed, oversized, and invalid parameters', { timeout: 30000 }, async () => {
  await assert.rejects(renderPdfPage(Buffer.from('not a PDF')), /not a valid PDF/i);
  await assert.rejects(renderPdfPage(Buffer.from('%PDF-invalid')), /not a valid PDF/i);
  await assert.rejects(renderPdfPage(Buffer.alloc(MAX_PDF_BYTES + 1)), /limit/i);
  await assert.rejects(renderPdfPage(syntheticPdf(), { page: 0 }), /positive integer/i);
  await assert.rejects(renderPdfPage(syntheticPdf(), { maxPixels: 5000 }), /dimension/i);
});
