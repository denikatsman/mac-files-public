/* Disposable local integration fixture. It never uses the user's file tree. */
import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLocalHttpServer, UI_URI } from '../server/server.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const testingDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = await fs.mkdtemp(path.join(testingDir, '.integration-'));
const binary = Buffer.alloc(600123);
for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
const binaryHash = crypto.createHash('sha256').update(binary).digest('hex');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmYQAAAAASUVORK5CYII=', 'base64');

function fixturePdf() {
  const stream = 'BT /F1 14 Tf 20 350 Td (MCP PDF text) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(pdf + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

await fs.mkdir(path.join(fixtureRoot, 'nested'));
await fs.writeFile(path.join(fixtureRoot, 'README.md'), 'Integration fixture: exact search needle and a readable text preview.\n');
await fs.writeFile(path.join(fixtureRoot, 'nested', 'note.txt'), 'Nested integration document.\n');
await fs.writeFile(path.join(fixtureRoot, 'sample.bin'), binary);
await fs.writeFile(path.join(fixtureRoot, 'pixel.png'), pixel);
await fs.writeFile(path.join(fixtureRoot, 'document.pdf'), fixturePdf());

const mcpServer = createLocalHttpServer({ root: fixtureRoot });
await new Promise(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
const mcpPort = mcpServer.address().port;
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`));
const client = new Client({ name: 'isolated-ui-integration-test', version: '1.0.0' });
await client.connect(transport);
const available = await client.listTools();
const tools = new Set(available.tools.map(tool => tool.name));
for (const tool of ['open_browser', 'browse_directory', 'search_files', 'read_file', 'read_file_chunk', 'read_pdf_page']) {
  if (!tools.has(tool)) throw new Error(`Missing MCP tool: ${tool}`);
}
const resource = await client.readResource({ uri: UI_URI });
const widget = resource.contents.find(item => item.uri === UI_URI);
if (!widget?.text || widget.mimeType !== 'text/html;profile=mcp-app') throw new Error('MCP UI resource unavailable');

const hostHtml = await fs.readFile(path.join(testingDir, 'integration-host.html'));
const hostJs = await fs.readFile(path.join(testingDir, 'integration-host.js'));
const allowedTools = new Set(['open_browser', 'browse_directory', 'search_files', 'read_file', 'read_file_chunk', 'read_pdf_page', 'file_info']);
const host = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  try {
    if (req.method === 'GET' && pathname === '/integration-host.html') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(hostHtml); return;
    }
    if (req.method === 'GET' && pathname === '/integration-host.js') {
      res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8' }).end(hostJs); return;
    }
    if (req.method === 'GET' && pathname === '/widget') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'" }).end(widget.text); return;
    }
    if (req.method === 'GET' && pathname === '/fixture') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ root: await fs.realpath(fixtureRoot), binarySize: binary.length, binaryHash })); return;
    }
    if (req.method === 'POST' && pathname === '/invoke') {
      let length = 0; const chunks = [];
      for await (const chunk of req) { length += chunk.length; if (length > 65536) throw new Error('Request too large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!allowedTools.has(input.name) || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) throw new Error('Invalid tool call');
      const result = await client.callTool({ name: input.name, arguments: input.arguments });
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(result)); return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    res.writeHead(404).end('Not found');
  } catch (error) {
    res.writeHead(500, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error.message || error) }));
  }
});
const port = Number(process.env.INTEGRATION_PORT || 18792);
await new Promise(resolve => host.listen(port, '127.0.0.1', resolve));
console.log(`Local integration host: http://127.0.0.1:${host.address().port}/integration-host.html`);

let closing = false;
async function close() {
  if (closing) return; closing = true;
  await new Promise(resolve => host.close(resolve));
  await client.close();
  await new Promise(resolve => mcpServer.close(resolve));
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }));
