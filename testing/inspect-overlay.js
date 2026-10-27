async (page) => {
  const frame = page.frameLocator('#app');
  return {
    note: await frame.locator('#download-result').boundingBox(),
    overlay: await page.locator('#composer-overlay').boundingBox(),
    iframe: await page.locator('#app').boundingBox(),
    scroll: await frame.locator('html').evaluate(e => ({
      scrollY: e.ownerDocument.defaultView.scrollY,
      height: e.ownerDocument.documentElement.scrollHeight,
      viewport: e.ownerDocument.defaultView.innerHeight,
      noteMargin: getComputedStyle(e.ownerDocument.getElementById('download-result')).scrollMarginBottom,
      appPadding: getComputedStyle(e.ownerDocument.getElementById('app')).paddingBottom,
    })),
  };
}
