const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.DAYDREAM_PLAYWRIGHT || 'playwright');
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000);
    })]);
  } finally { clearTimeout(timer); }
}

(async () => {
  const extension = path.resolve(process.env.DAYDREAM_EXTENSION || __dirname);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'daydream-extension-check-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.DAYDREAM_CHROMIUM, headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1100, height: 800 }
  });
  context.setDefaultTimeout(15000);
  console.log('Isolated extension browser launched');
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    console.log('Extension service worker started');
    const errors = [];
    worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const manifest = await bounded(worker.evaluate(() => chrome.runtime.getManifest()), 'Worker manifest read');
    console.log('Worker manifest read');
    assert.equal(manifest.version, '1.18.0');
    assert.deepEqual(manifest.permissions, ['storage']);
    await bounded(worker.evaluate(async () => {
      await chrome.storage.local.set({ translationEngine: 'doubao', doubaoApiKey: 'mock-only', doubaoProtectedTerms: '' });
      self.fixtureInputs = [];
      self.fetch = async (url, options) => {
        if (url !== 'https://ark.cn-beijing.volces.com/api/v3/responses') throw new Error('Fixture blocks external network');
        const source = JSON.parse(options.body).input[0].content[0].text;
        self.fixtureInputs.push(source);
        if (new TextEncoder().encode(source).byteLength > 900) throw new Error('Input budget exceeded');
        const text = source.replace(/<CUE_(\d+)>([\s\S]*?)<\/CUE_\1>/g,
          (_, id, original) => `<CUE_${id}>模拟译文：${original.match(/Sentence (\d+)/)?.[1] || original}</CUE_${id}>`);
        return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
    }), 'Worker fixture setup');
    console.log('Worker fixture configured');
    const events = Array.from({ length: 18 }, (_, index) => ({ tStartMs: index * 1500, dDurationMs: 1000,
      segs: [{ utf8: `Sentence ${index} ${'some subtitle words '.repeat(3)}.` }] }));
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith('chrome-extension://')) return route.continue();
      if (url.startsWith('https://www.youtube.com/api/timedtext')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ events }) });
      }
      if (url.startsWith('https://www.youtube.com/watch?')) {
        const videoId = new URL(url).searchParams.get('v');
        const playerResponse = { videoDetails: { videoId }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [
          { baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`, languageCode: 'en' }
        ] } } };
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
          <div class="html5-video-player" style="position:relative;width:900px;height:600px;background:#262626">
          <video></video><div class="ytp-caption-window-container"><span class="ytp-caption-segment">Native caption.</span></div></div>
          <script>window.ytInitialPlayerResponse=${JSON.stringify(playerResponse)};
          document.querySelector('video').currentTime=0.5;</script></body></html>` });
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://www.youtube.com/watch?v=extension-fixture');
    console.log('YouTube fixture loaded');
    await page.waitForFunction(() => document.documentElement.dataset.ytzhTimeline);
    await page.keyboard.press('Alt+a');
    await page.waitForFunction(() => document.querySelector('.ytzh-current')?.textContent === '模拟译文：0');
    await page.waitForFunction(() => document.querySelector('.ytzh-overlay')?.classList.contains('ytzh-visible'));
    console.log('Actual content-script subtitle displayed');
    assert.equal(await page.locator('.ytp-caption-window-container').evaluate(el => getComputedStyle(el).visibility), 'hidden');
    await page.evaluate(() => { document.querySelector('video').currentTime = 9.5; });
    await page.waitForFunction(() => document.querySelector('.ytzh-current')?.textContent === '模拟译文：6');
    await page.evaluate(() => { document.querySelector('video').currentTime = 10.2; });
    await page.waitForFunction(() => !document.querySelector('.ytzh-overlay')?.classList.contains('ytzh-visible'));
    assert.equal(await page.locator('.ytp-caption-window-container').evaluate(el => getComputedStyle(el).visibility), 'visible');
    await page.evaluate(() => { document.querySelector('video').currentTime = 0.5; });
    await page.waitForFunction(() => document.querySelector('.ytzh-current')?.textContent === '模拟译文：0'
      && document.querySelector('.ytzh-overlay')?.classList.contains('ytzh-visible'));
    await page.keyboard.press('Alt+a');
    assert.ok(await page.evaluate(() => document.documentElement.classList.contains('ytzh-disabled')));
    await page.keyboard.press('Alt+a');
    await page.waitForFunction(() => document.querySelector('.ytzh-overlay')?.classList.contains('ytzh-visible'));
    const extensionId = new URL(worker.url()).hostname;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/options.html`);
    assert.equal(await popup.locator('#engine').inputValue(), 'doubao');
    assert.equal(await popup.locator('#doubao-api-key').inputValue(), 'mock-only');
    const inputs = await worker.evaluate(() => self.fixtureInputs);
    assert.ok(inputs.some(source => source.includes('Sentence 0') && source.includes('Sentence 1')), 'Actual worker carries neighbouring source context');
    assert.ok(inputs.every(source => Buffer.byteLength(source) <= 900));
    assert.deepEqual(errors, [], 'No extension or fixture page errors');
    console.log('Actual unpacked MV3 extension: manifest, content scripts, page bridge, worker messaging, context, playback, expiry, toggles and settings passed (mock API, fresh profile)');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
