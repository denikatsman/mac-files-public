/* Synthetic host UI; every tools/call goes through the real local MCP SDK server. */
(() => {
  const frame = document.getElementById('app');
  const state = window.integration = { requests: [], messages: [], downloads: [], errors: [], initialized: false };
  const fixtureReady = fetch('/fixture').then(response => {
    if (!response.ok) throw new Error('Fixture metadata unavailable');
    return response.json();
  }).then(fixture => { state.fixture = fixture; return fixture; });
  const send = payload => frame.contentWindow.postMessage(payload, '*');

  async function callTool(name, args) {
    const response = await fetch('/invoke', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'MCP request failed');
    return result;
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'ui/initialize':
        return { protocolVersion: '2026-01-26', hostInfo: { name: 'Local MCP integration fixture', version: '1.0.0' },
          hostCapabilities: { serverTools: {}, message: { text: {} }, downloadFile: {} },
          hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'mobile',
            containerDimensions: { maxWidth: 390, maxHeight: 844 }, safeAreaInsets: { top: 0, right: 0, bottom: 20, left: 0 } } };
      case 'tools/call': return callTool(params.name, params.arguments || {});
      case 'ui/message': state.messages.push(params); return {};
      case 'ui/download-file': {
        const resource = params.contents?.[0]?.resource;
        if (!resource || typeof resource.blob !== 'string') throw new Error('Expected embedded file bytes');
        const bytes = Uint8Array.from(atob(resource.blob), character => character.charCodeAt(0));
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
        state.downloads.push({ name: resource.uri, size: bytes.length, sha256: hash });
        return {};
      }
      case 'ui/request-display-mode': return { mode: params.mode };
      case 'ui/open-link': return { isError: true };
      case 'ui/update-model-context': return {};
      default: throw new Error(`Unhandled method: ${method}`);
    }
  }

  window.addEventListener('message', async event => {
    if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
    const message = event.data;
    state.requests.push({ method: message.method || '(response)', params: message.params || null });
    try {
      if (message.method === 'ui/notifications/initialized') {
        const fixture = await fixtureReady;
        const result = await callTool('open_browser', {});
        send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } });
        send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result });
        state.initialized = true;
        state.fixture = fixture;
        return;
      }
      if (message.id === undefined || !message.method) return;
      send({ jsonrpc: '2.0', id: message.id, result: await dispatch(message.method, message.params || {}) });
    } catch (error) {
      state.errors.push(String(error));
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } });
    }
  });
  frame.src = '/widget';
})();
