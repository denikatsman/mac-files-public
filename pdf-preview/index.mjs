import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const HELPER = fileURLToPath(new URL('./render.swift', import.meta.url));
const TEXT_HELPER = fileURLToPath(new URL('./extract.swift', import.meta.url));
let active = 0;

// The caller supplies a verified, bounded snapshot read from an already-open
// descriptor. The child receives it through stdin, never as a filesystem path.
export async function renderPdfPage(input, { page = 1, maxPixels = 1200, timeoutMs = 15000 } = {}) {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > MAX_PDF_BYTES) throw new Error('PDF exceeds the preview limit or is empty.');
  if (!input.subarray(0, Math.min(input.length, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('Not a valid PDF.');
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Page must be a positive integer.');
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 64 || maxPixels > 1600) throw new Error('Preview dimension must be between 64 and 1600 pixels.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid PDF timeout.');
  if (active >= 2) throw new Error('PDF preview is busy; try again.');
  active++;
  try {
    return await new Promise((resolve, reject) => {
      let done = false, data = [], total = 0, errorOutput = '';
      const child = spawn('/usr/bin/swift', [HELPER, String(page), String(maxPixels)], { stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('PDF preview timed out.')); }, timeoutMs);
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      child.on('error', () => finish(new Error('The macOS PDF preview renderer is unavailable.')));
      child.stdin.on('error', () => {}); // A failed renderer may close stdin early.
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) { child.kill('SIGKILL'); finish(new Error('PDF preview exceeded the output limit.')); return; }
        data.push(chunk);
      });
      child.stderr.on('data', chunk => { if (errorOutput.length < 1024) errorOutput += chunk.toString('utf8').slice(0, 1024 - errorOutput.length); });
      child.on('close', code => {
        if (done) return;
        if (code !== 0) {
          const known = ['PDF is locked', 'Not a valid PDF', 'Page is out of range', 'Invalid page bounds'];
          const message = known.find(value => errorOutput.includes(value));
          return finish(new Error(message ? `${message}.` : 'PDF preview failed.'));
        }
        try {
          const result = JSON.parse(Buffer.concat(data).toString('utf8'));
          const png = Buffer.from(result.data_base64, 'base64');
          if (result.page !== page || !Number.isSafeInteger(result.pages) || result.pages < page ||
              result.mime_type !== 'image/png' || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
              png.length > 4 * 1024 * 1024 || result.width < 1 || result.height < 1 ||
              result.width > maxPixels || result.height > maxPixels) throw new Error('Invalid renderer response');
          finish(null, result);
        } catch { finish(new Error('PDF renderer returned invalid preview data.')); }
      });
      child.stdin.end(input);
    });
  } finally { active--; }
}

// Offsets are Swift Character (Unicode grapheme cluster) offsets. Callers
// should pass them back unchanged rather than using them as JavaScript indices.
export async function extractPdfText(input, { page = 1, charOffset = 0, maxPages = 4, maxChars = 32768, timeoutMs = 15000 } = {}) {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > MAX_PDF_BYTES) throw new Error('PDF exceeds the preview limit or is empty.');
  if (!input.subarray(0, Math.min(input.length, 1024)).includes(Buffer.from('%PDF-'))) throw new Error('Not a valid PDF.');
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Page must be a positive integer.');
  if (!Number.isSafeInteger(charOffset) || charOffset < 0) throw new Error('Character offset must be a non-negative integer.');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 8) throw new Error('maxPages must be between 1 and 8.');
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 65536) throw new Error('maxChars must be between 1 and 65536.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid PDF timeout.');
  if (active >= 2) throw new Error('PDF processing is busy; try again.');
  active++;
  try {
    return await new Promise((resolve, reject) => {
      let done = false, data = [], total = 0, errorOutput = '';
      const child = spawn('/usr/bin/swift', [TEXT_HELPER, String(page), String(charOffset), String(maxPages), String(maxChars)], { stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('PDF processing timed out.')); }, timeoutMs);
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      child.on('error', () => finish(new Error('The macOS PDF extractor is unavailable.')));
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) { child.kill('SIGKILL'); finish(new Error('PDF text exceeded the output limit.')); return; }
        data.push(chunk);
      });
      child.stderr.on('data', chunk => { if (errorOutput.length < 1024) errorOutput += chunk.toString('utf8').slice(0, 1024 - errorOutput.length); });
      child.on('close', code => {
        if (done) return;
        if (code !== 0) {
          const known = ['PDF is locked', 'Not a valid PDF', 'Page is out of range', 'Character offset is out of range'];
          const message = known.find(value => errorOutput.includes(value));
          return finish(new Error(message ? `${message}.` : 'PDF text extraction failed.'));
        }
        try {
          const result = JSON.parse(Buffer.concat(data).toString('utf8'));
          if (!Number.isSafeInteger(result.page_count) || result.page_count < page || !Array.isArray(result.pages) ||
              result.pages.length > maxPages || !result.pages.every(item => Number.isSafeInteger(item.page) &&
              item.page >= page && item.page <= result.page_count && typeof item.text === 'string') ||
              typeof result.has_more !== 'boolean' || (result.has_more && (!Number.isSafeInteger(result.next_page) ||
              result.next_page < page || result.next_page > result.page_count || !Number.isSafeInteger(result.next_char_offset) || result.next_char_offset < 0)) ||
              (!result.has_more && (result.next_page !== null || result.next_char_offset !== null))) throw new Error();
          finish(null, result);
        } catch { finish(new Error('PDF extractor returned invalid text data.')); }
      });
      child.stdin.end(input);
    });
  } finally { active--; }
}
