const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.DAYDREAM_PLAYWRIGHT || 'playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.DAYDREAM_CHROMIUM, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await page.goto('https://www.youtube.com/shorts/render-fixture');
    await page.setContent(`<div class="html5-video-player" style="position:absolute;top:1500px;width:400px;height:600px"><video></video></div>
      <div id="active" class="html5-video-player" style="position:relative;width:400px;height:600px;background:#ccc"><video></video>
      <div class="ytp-caption-window-container"><span class="ytp-caption-segment">Hello world.</span></div></div>`);
    await page.addStyleTag({ content: fs.readFileSync('styles.css', 'utf8') });
    await page.evaluate(() => {
      window.time = 0.5; window.calls = []; window.listeners = []; window.shouldFail = true;
      const video = document.querySelector('#active video');
      Object.defineProperty(video, 'currentTime', { get: () => window.time });
      Object.defineProperty(video, 'duration', { get: () => 20 });
      document.documentElement.dataset.ytzhTimeline = JSON.stringify({ videoId: 'render-fixture', languageCode: 'en', data: { events: [
        { tStartMs: 0, dDurationMs: 6000, segs: [{ utf8: 'Hello world.' }] }
      ] } });
      window.chrome = {
        storage: { local: { get: async defaults => ({ ...defaults, translationEngine: 'doubao' }) }, onChanged: { addListener() {} } },
        runtime: { onMessage: { addListener(fn) { window.listeners.push(fn); } }, sendMessage: async message => {
          window.calls.push(message);
          if (window.shouldFail) { window.shouldFail = false; return { ok: false, error: 'Temporary fixture failure' }; }
          return { ok: true, text: '你好世界。' };
        } }
      };
    });
    await page.addScriptTag({ content: fs.readFileSync('content.js', 'utf8') });
    await page.keyboard.press('Alt+a');
    await page.waitForFunction(() => document.querySelector('#active .ytzh-current')?.textContent === '你好世界。');
    assert.equal(await page.locator('#active .ytzh-overlay').isVisible(), true);
    assert.equal(await page.locator('#active .ytp-caption-window-container').evaluate(el => getComputedStyle(el).visibility), 'hidden');
    assert.equal(await page.locator('.html5-video-player').first().locator('.ytzh-overlay').count(), 0);
    await page.evaluate(() => { window.time = 7; });
    await page.waitForFunction(() => !document.querySelector('#active .ytzh-overlay').classList.contains('ytzh-visible'));
    assert.equal(await page.locator('#active .ytp-caption-window-container').evaluate(el => getComputedStyle(el).visibility), 'visible');
    await page.keyboard.press('Alt+a');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('ytzh-disabled')), true);
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.type === 'translate').length), 2);
    console.log('Headless Chrome: visible Shorts overlay, automatic recovery, expiry, native-caption fallback and Alt+A passed (mock API only)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
