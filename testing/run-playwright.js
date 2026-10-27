// Executed by playwright-cli run-code against mock-host.html. Uses synthetic data only.
async (page) => {
  const frame = page.frameLocator('#app');
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(() => window.mockHost?.initialized === true);
  await frame.locator('[data-test-path="/Mac/README.md"]').waitFor();
  const layout = await frame.locator('html').evaluate(e => ({scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));
  check(layout.scrollWidth <= layout.clientWidth + 1, `Unexpected horizontal overflow: ${JSON.stringify(layout)}`);

  await frame.locator('[data-test-path="/Mac/Projects"]').click();
  await frame.getByText('This folder is empty').waitFor();
  await frame.getByRole('button', {name:'Home',exact:true}).click();
  await frame.locator('[data-test-path="/Mac/README.md"]').waitFor();

  await frame.locator('#search-input').fill('README');
  await frame.locator('#search-input').press('Enter');
  await frame.locator('[data-test-path="/Mac/README.md"]').waitFor();
  check(await frame.locator('[data-test-path]').count() === 1, 'Search should return exactly the matching file');
  await frame.locator('[data-test-path="/Mac/README.md"]').click();
  await frame.getByText('A synthetic project note.', {exact:false}).waitFor();
  await frame.locator('#ask-chatgpt').click();
  await page.waitForFunction(() => window.mockHost.messages.length === 1);
  const message = await page.evaluate(() => JSON.stringify(window.mockHost.messages[0]));
  check(message.includes('/Mac/README.md'), 'Assistant message must reference selected file');

  await frame.locator('#close-preview').click();
  await frame.getByRole('button', {name:'Home',exact:true}).click();
  await frame.locator('[data-test-path="/Mac/pixel.png"]').click();
  await frame.locator('#preview-body img').waitFor();
  await frame.locator('#preview-body img').evaluate(img => new Promise((resolve,reject) => {
    if (img.complete) return img.naturalWidth ? resolve() : reject(new Error('Image did not decode'));
    img.addEventListener('load',resolve,{once:true});
    img.addEventListener('error',()=>reject(new Error('Image did not decode')),{once:true});
  }));
  check((await frame.locator('#preview-body img').getAttribute('src')).startsWith('data:image/png;base64,'), 'Image must use CSP-compatible data URL');
  await frame.locator('#close-preview').click();
  await frame.locator('[data-test-path="/Mac/document.pdf"]').click();
  await frame.locator('#pdf-page').filter({hasText:'Page 1 of 2'}).waitFor();
  check(await frame.locator('#pdf-previous').isDisabled(), 'Previous must be disabled on first page');
  check((await frame.locator('#preview-body img').getAttribute('src')).startsWith('data:image/png;base64,'), 'PDF page must use CSP-compatible raster image');
  await frame.locator('#pdf-next').click();
  await frame.locator('#pdf-page').filter({hasText:'Page 2 of 2'}).waitFor();
  check(await frame.locator('#pdf-next').isDisabled(), 'Next must be disabled on last page');
  await frame.locator('#pdf-previous').click();
  await frame.locator('#pdf-page').filter({hasText:'Page 1 of 2'}).waitFor();
  const pdfCalls=await page.evaluate(() => window.mockHost.requests.filter(r=>r.method==='tools/call' && r.params?.name==='read_pdf_page'));
  check(pdfCalls.length === 3 && pdfCalls.slice(1).every(call=>call.params.arguments.expected_version === 'a'.repeat(64)), 'Later PDF page renders must pin the original file version');
  await frame.locator('#close-preview').click();
  await frame.locator('[data-test-path="/Mac/sample.bin"]').click();
  await frame.locator('#preview').waitFor();
  await frame.locator('#download').click();
  await page.waitForFunction(() => window.mockHost.downloads.length === 1, null, {timeout:30000});
  const download = await page.evaluate(() => window.mockHost.downloads[0]);
  check(download.length === 600123 && download.exact, `Binary download mismatch: ${JSON.stringify(download)}`);
  const chunkCalls = await page.evaluate(() => window.mockHost.requests.filter(r => r.method === 'tools/call' && r.params?.name === 'read_file_chunk' && r.params.arguments.path === '/Mac/sample.bin'));
  check(chunkCalls.length === 3, `Expected three bounded chunks, got ${chunkCalls.length}`);
  check(chunkCalls.slice(1).every(call => call.params.arguments.expected_version === 'fixture-v1'), 'Later chunks must pin the original version');

  await page.goto(new URL('/testing/mock-host.html?hostDownload=0',page.url()).href);
  await page.waitForFunction(() => window.mockHost?.initialized === true);
  await frame.locator('[data-test-path="/Mac/sample.bin"]').click();
  await frame.locator('#download').click();
  await frame.locator('[data-test-download="ready"]').waitFor({timeout:30000});
  const fallback = await frame.locator('#download-result').innerText();
  check(fallback.includes('may be blocked by the host'), 'Unverified download fallback must be disclosed');
  check((await page.evaluate(() => window.mockHost.downloads.length)) === 0, 'No host download is falsely reported');

  await page.goto(new URL('/testing/mock-host.html?initial=/Mac/Projects',page.url()).href);
  await frame.getByText('This folder is empty').waitFor();
  await frame.getByRole('button', {name:'Home',exact:true}).click();
  await frame.locator('[data-test-path="/Mac/README.md"]').waitFor();
  const lastBrowse=await page.evaluate(() => window.mockHost.requests.filter(r=>r.method==='tools/call' && r.params?.name==='browse_directory').at(-1));
  check(lastBrowse.params.arguments.path === '/Mac', 'Home must target the actual home, not the initial folder');
  await frame.locator('#mode-select').selectOption('content');
  await frame.locator('#search-input').fill('missing');
  await frame.locator('#search-input').press('Enter');
  await frame.locator('#status').filter({hasText:'Search was incomplete.'}).waitFor();
  const coverage=await frame.locator('#status').innerText();
  check(coverage.includes('2 non-UTF-8 or binary files were skipped') && coverage.includes('1 symbolic links were not followed') && coverage.includes('1 locations could not be read'), `Incomplete search coverage was not disclosed: ${coverage}`);

  await page.goto(new URL('/testing/mock-host.html?changed=1',page.url()).href);
  await frame.locator('[data-test-path="/Mac/sample.bin"]').click();
  await frame.locator('#download').click();
  await frame.locator('#status').filter({hasText:'The file changed while it was being read'}).waitFor({timeout:30000});
  check((await page.evaluate(() => window.mockHost.downloads.length)) === 0, 'Changed file must not be delivered as a successful download');

  await page.goto(new URL('/testing/mock-host.html?pdfError=1',page.url()).href);
  await frame.locator('[data-test-path="/Mac/document.pdf"]').click();
  await frame.locator('#status').filter({hasText:'PDF preview unavailable'}).waitFor();
  check(await frame.locator('#pdf-nav').isHidden(), 'PDF navigation must stay hidden when rendering fails');
  check(await frame.locator('#download').isEnabled(), 'PDF rendering failure must not disable original download');

  await page.goto(new URL('/testing/mock-host.html?pdfChanged=1',page.url()).href);
  await frame.locator('[data-test-path="/Mac/document.pdf"]').click();
  await frame.locator('#pdf-page').filter({hasText:'Page 1 of 2'}).waitFor();
  await frame.locator('#pdf-next').click();
  await frame.locator('#status').filter({hasText:'PDF preview unavailable: PDF file changed'}).waitFor();
  check((await frame.locator('#pdf-page').innerText())==='Page 1 of 2','Changed PDF must not display the next page as successful');

  await page.goto(new URL('/testing/mock-host.html?delayChunks=1',page.url()).href);
  await frame.locator('[data-test-path="/Mac/sample.bin"]').click();
  await frame.locator('#download').click();
  await page.waitForFunction(() => window.mockHost.requests.some(r=>r.method==='tools/call' && r.params?.name==='read_file_chunk'));
  await frame.locator('#close-preview').click();
  await frame.locator('[data-test-path="/Mac/README.md"]').click();
  await frame.getByText('A synthetic project note.', {exact:false}).waitFor();
  await page.waitForFunction(() => window.mockHost.chunkResponses >= 1, null, {timeout:10000});
  check(await frame.locator('#download').isEnabled(), 'Cancelled earlier download must not disable current file download');
  check((await page.evaluate(() => window.mockHost.downloads.length)) === 0, 'Cancelled download must not send stale data');

  await page.goto(new URL('/testing/mock-host.html?hostDownload=0&overlay=1&long=1',page.url()).href);
  await frame.locator('[data-test-path="/Mac/README.md"]').click();
  await frame.locator('#download').click();
  await frame.locator('[data-test-download="ready"]').waitFor({timeout:30000});
  await frame.locator('#download-result').evaluate(element => new Promise(resolve => element.ownerDocument.defaultView.requestAnimationFrame(() => element.ownerDocument.defaultView.requestAnimationFrame(resolve))));
  const downloadBox = await frame.locator('#download-result').boundingBox();
  const composerBox = await page.locator('#composer-overlay').boundingBox();
  check(downloadBox && composerBox && downloadBox.y + downloadBox.height <= composerBox.y, 'Download controls must be scrollable above the mobile composer');
  await page.evaluate(() => document.getElementById('app').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{safeAreaInsets:{top:0,right:0,bottom:260,left:0}}}, '*'));
  await frame.locator('#app').evaluate(element => new Promise(resolve => element.ownerDocument.defaultView.requestAnimationFrame(resolve)));
  const updatedPadding = await frame.locator('#app').evaluate(element => parseFloat(getComputedStyle(element).paddingBottom));
  check(updatedPadding >= 284, `Host safe-area changes must update bottom clearance, got ${updatedPadding}`);
  return {status:'PASS',viewport:'390x844',checks:['MCP handshake','mobile width','browse','name search','text preview','message with selected path','image decode under strict CSP','PDF raster, paging and error','three-chunk original bytes and SHA-256','fallback disclosure','initial home','incomplete search coverage','changed-file rejection','cancelled-download race','download controls clear the mobile composer']};
}
