// playwright-cli run-code script: synthetic iframe host, real local MCP server.
async (page) => {
  const frame = page.frameLocator('#app');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => window.integration?.initialized === true, null, { timeout: 30000 });
  const fixture = await page.evaluate(() => window.integration.fixture);
  const file = name => frame.locator(`[data-test-path="${fixture.root}/${name}"]`);
  await file('README.md').waitFor();

  await file('nested').click();
  await file('nested/note.txt').waitFor();
  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  await file('README.md').click();
  await frame.getByText('Integration fixture:', { exact: false }).waitFor();
  await frame.locator('#ask-chatgpt').click();
  await page.waitForFunction(() => window.integration.messages.length === 1);
  check((await page.evaluate(() => JSON.stringify(window.integration.messages[0]))).includes('/README.md'), 'Expected selected file in ChatGPT message');

  await frame.locator('#close-preview').click();
  await frame.locator('#mode-select').selectOption('content');
  await frame.locator('#search-input').fill('exact search needle');
  await frame.locator('#search-input').press('Enter');
  await frame.locator('#list-title').filter({ hasText: 'Results for' }).waitFor({ timeout: 30000 });
  await file('README.md').waitFor({ timeout: 30000 });
  check((await frame.locator('[data-test-path]').count()) === 1, 'Expected one content-search match');

  await frame.getByRole('button', { name: 'Home', exact: true }).click();
  await file('pixel.png').click();
  await frame.locator('#preview-body img').waitFor();
  check((await frame.locator('#preview-body img').getAttribute('src')).startsWith('data:image/png;base64,'), 'Expected CSP-compatible PNG');
  await frame.locator('#close-preview').click();
  await file('document.pdf').click();
  await frame.locator('#pdf-page').filter({ hasText: 'Page 1 of 1' }).waitFor({ timeout: 30000 });
  check((await frame.locator('#preview-body img').getAttribute('src')).startsWith('data:image/png;base64,'), 'Expected PDF raster preview');

  await frame.locator('#close-preview').click();
  await file('sample.bin').click();
  await frame.locator('#download').click();
  await page.waitForFunction(() => window.integration.downloads.length === 1, null, { timeout: 30000 });
  const outcome = await page.evaluate(() => ({ download: window.integration.downloads[0], errors: window.integration.errors, requests: window.integration.requests }));
  check(outcome.download.size === fixture.binarySize, 'Original file length mismatch');
  check(outcome.download.sha256 === fixture.binaryHash, 'Original file SHA-256 mismatch');
  check(outcome.requests.filter(request => request.params?.name === 'read_file_chunk' && request.params.arguments?.path === `${fixture.root}/sample.bin`).length === 3, 'Expected three actual MCP chunk calls for the binary file');
  check(outcome.errors.length === 0, `Unexpected host errors: ${outcome.errors.join(', ')}`);
  return { status: 'PASS', viewport: '390x844', scope: 'synthetic host and disposable fixture, real MCP server', checks: ['browse', 'content search', 'text and image preview', 'PDF preview', 'ChatGPT message', 'three-chunk exact binary SHA-256'] };
}
