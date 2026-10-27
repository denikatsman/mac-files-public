import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { makeMcpServer } from './server.js';

// Tunnel client supervises this process. Never write diagnostics to stdout:
// stdout is reserved for MCP protocol messages.
const server = await makeMcpServer();
await server.connect(new StdioServerTransport());
