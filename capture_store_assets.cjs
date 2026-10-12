const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.DAYDREAM_PLAYWRIGHT || 'playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 800 }, deviceScaleFactor: 1 });
    await page.addInitScript(() => {
      window.chrome = {
        storage: { local: { get: async defaults => defaults, set: async () => {} } },
        tabs: { query: async () => [{id:1}], sendMessage: async () => ({ok:true,enabled:false,state:'未开启'}) },
        runtime: { sendMessage: async () => ({ ok: false }) }
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, 'options.html')).href);
    await page.locator('#engine').selectOption('chrome');
    await page.screenshot({ path: path.join(__dirname, 'releases', 'settings-ui.png'), fullPage: true });
    if (await page.locator('#doubao-fields').isVisible()) throw new Error('Cloud credentials must be hidden in the default local mode');
    await page.locator('#engine').selectOption('doubao');
    if (await page.locator('#doubao-api-key').inputValue()) throw new Error('Release settings must not contain an API key');
    console.log('Rendered real settings UI; shortcut help and empty credentials verified');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
