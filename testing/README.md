# Synthetic MCP Apps UI test

This fixture uses synthetic data only. It emulates the MCP Apps host handshake, tool calls, messages, download capability and restricted iframe, but it is **not ChatGPT or an iPhone**. It verifies the interface and synthetic binary bytes locally, not account eligibility, the real host CSP or Save to Files.

Prerequisites: Python 3, Node.js and npm (`npx`). The Playwright CLI and its browser must be available. If the browser is missing, run `npx -y --package @playwright/cli playwright-cli install-browser chromium` once.

From the repository root, start this server in one terminal:

```sh
python3 -u testing/serve-fixtures.py --port 18765
```

In another terminal, run:

```sh
npx -y --package @playwright/cli playwright-cli -s=mac-files-fixture open http://127.0.0.1:18765/testing/mock-host.html
npx -y --package @playwright/cli playwright-cli -s=mac-files-fixture --raw run-code --filename testing/run-playwright.js
npx -y --package @playwright/cli playwright-cli -s=mac-files-fixture close
```

The test exercises the JSON-RPC handshake, mobile-width layout, browsing, search and its incomplete-coverage notices, text preview, image decoding under the representative CSP, PDF preview and page navigation, conversation message, exact 600,123-byte download transfer, changed-file rejection, cancellation and host-without-download fallback. A successful run prints a JSON object containing `"status":"PASS"`; failures report an error. Stop the fixture server with Ctrl-C. If port 18765 is occupied, choose another port in the server command and corresponding URL.

## UI connected to the real MCP server

This second fixture uses the real prototype MCP server and SDK over loopback, with a disposable file tree. The iframe host is still a simulation, not ChatGPT.

```sh
node testing/integration-server.mjs
```

In another terminal:

```sh
npx -y --package @playwright/cli playwright-cli -s=mac-files-integration open http://127.0.0.1:18792/integration-host.html
npx -y --package @playwright/cli playwright-cli -s=mac-files-integration --raw run-code --filename testing/run-integration.js
npx -y --package @playwright/cli playwright-cli -s=mac-files-integration close
```

Stop the integration server with Ctrl-C; it removes its disposable fixture. Set `INTEGRATION_PORT` if the default port is unavailable and use the matching URL. This test exercises actual MCP tool calls for browsing, content search, text/image/PDF preview, and three-chunk binary transfer with SHA-256 comparison.
