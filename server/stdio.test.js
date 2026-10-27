import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP browser preserves original bytes in a scoped fixture', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-files-stdio-'));
  const fixture = path.join(root, 'sample.bin');
  const bytes = crypto.randomBytes(300017);
  await fs.writeFile(fixture, bytes);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'stdio-server.js')],
    env: { ...process.env, FILE_BROWSER_ROOT: root },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mac-files-stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === 'open_browser'));
    const opened = await client.callTool({ name: 'open_browser', arguments: {} });
    assert.equal(opened.structuredContent.path, await fs.realpath(root));
    const chunks = [];
    let offset = 0;
    let expected_version;
    while (offset < bytes.length) {
      const args = { path: fixture, offset, length: 262144 };
      if (expected_version) args.expected_version = expected_version;
      const page = await client.callTool({ name: 'read_file_chunk', arguments: args });
      assert.equal(page.isError, undefined);
      chunks.push(Buffer.from(page._meta.data_base64, 'base64'));
      expected_version = page.structuredContent.version;
      offset = page.structuredContent.next_offset;
    }
    assert.equal(crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
      crypto.createHash('sha256').update(bytes).digest('hex'));
  } finally {
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
