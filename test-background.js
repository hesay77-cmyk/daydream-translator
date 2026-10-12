const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

global.crypto = webcrypto;
global.chrome = {
  runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
  storage: { local: {
    data: {},
    async get(defaults) { return Array.isArray(defaults) ? this.data : { ...defaults, ...this.data }; },
    async set(values) { Object.assign(this.data, values); },
    async remove(keys) { keys.forEach(key => delete this.data[key]); }
  } }
};
vm.runInThisContext(fs.readFileSync('background.js', 'utf8'));

(async () => {
  if (await sha256('abc') !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') {
    throw new Error('SHA-256 self-check failed');
  }
  if (hex(await hmac('key', 'value')) !== '90fbfcf15e74a36b89dbdb2a721d9aecffdfdddc5c83e27f7592594f71932481') {
    throw new Error('HMAC self-check failed');
  }
  const cache = { old: { source: 'a', translated: '甲', savedAt: 1 }, fresh: { source: 'b', translated: '乙', savedAt: 2 } };
  trimCache(cache, 100);
  if ('old' in cache || !('fresh' in cache)) throw new Error('cache trimming self-check failed');
  global.location = new URL('https://www.youtube.com/watch?v=test-video');
  global.document = {
    documentElement: { dataset: {} },
    listeners: {},
    querySelector() { return null; },
    addEventListener(type, listener) { this.listeners[type] = listener; }
  };
  const playerResponse = {
    videoDetails: { videoId: 'test-video' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: 'https://www.youtube.com/api/timedtext', languageCode: 'en' }
    ] } }
  };
  document.scripts = [{ textContent: `var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};` }];
  global.window = {};
  global.XMLHttpRequest = class {
    open() {}
    addEventListener(_type, listener) { this.listener = listener; }
    send() { this.status = 200; this.responseText = JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }] }] }); this.listener?.(); this.onload?.(); }
  };
  global.DOMParser = class { parseFromString() { return { querySelectorAll() { return []; } }; } };
  vm.runInThisContext(fs.readFileSync('page-bridge.js', 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 10));
  const published = JSON.parse(document.documentElement.dataset.ytzhCaptionTrack);
  if (published.videoId !== 'test-video' || published.languageCode !== 'en') {
    throw new Error('page-context caption track bridge self-check failed');
  }
  if (!published.url.includes('/api/timedtext') || published.url.includes('fmt=json3')) throw new Error('original caption track URL self-check failed');
  const timeline = JSON.parse(document.documentElement.dataset.ytzhTimeline);
  if (timeline.data.events[0].segs[0].utf8 !== 'Hello') throw new Error('page timeline download self-check failed');
  const beforeTranslatedTrack = document.documentElement.dataset.ytzhTimeline;
  const translatedRequest = new XMLHttpRequest();
  translatedRequest.open('GET', 'https://www.youtube.com/api/timedtext?lang=en&tlang=zh-Hans');
  translatedRequest.send();
  if (document.documentElement.dataset.ytzhTimeline !== beforeTranslatedTrack) {
    throw new Error('YouTube Chinese auto-translation must not replace the source timeline');
  }
  document.listeners['yt-navigate-start']();
  if (document.documentElement.dataset.ytzhTimeline || document.documentElement.dataset.ytzhCaptionTrack) {
    throw new Error('YouTube navigation must clear the previous video timeline');
  }
  const originalTencentTranslate = tencentTranslate;
  const requestStarts = [];
  tencentTranslate = async () => { requestStarts.push(Date.now()); return 'ok'; };
  await Promise.all([requestTencent('a', {}), requestTencent('b', {})]);
  tencentTranslate = originalTencentTranslate;
  if (requestStarts[1] - requestStarts[0] < 240) throw new Error('Tencent rate-limit self-check failed');
  const originalFetch = global.fetch;
  let requestBody;
  let requestedUrl;
  global.fetch = async (_url, options) => {
    requestedUrl = _url;
    requestBody = JSON.parse(options.body);
    return ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }] }),
    requestBody: options.body
  });
  };
  if (await doubaoTranslate('Hello', { doubaoApiKey: 'test' }) !== '你好') throw new Error('Doubao response self-check failed');
  if (requestedUrl !== 'https://ark.cn-beijing.volces.com/api/v3/responses' || requestBody.store !== undefined ||
      requestBody.input[0].content[0].translation_options.target_language !== 'zh' || requestBody.messages) {
    throw new Error('Doubao Responses request format self-check failed');
  }
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '<CUE_0>你好</CUE_0>\n<CUE_1>世界</CUE_1>' }] }] })
  });
  const batch = await doubaoTranslateBatch(['Hello', 'world'], { doubaoApiKey: 'test' });
  if (batch.join('|') !== '你好|世界') throw new Error('Doubao batch parsing self-check failed');
  if (preservedTerms('The Ordinary Sentence Has Capital Letters.').length) throw new Error('Capitalized words must not be auto-preserved');
  const customTerms = preservedTerms('This boondocker is comfortable.', 'boondocker, moc toe').map(term => term.source);
  if (!customTerms.includes('boondocker') || customTerms.includes('moc toe')) throw new Error('Doubao custom glossary self-check failed');
  const gamingTerms = preservedTerms('I bought it on steam and played an RPG.', '', 'gaming');
  if (!gamingTerms.some(term => term.source === 'steam' && term.target === 'Steam') || !gamingTerms.some(term => term.source === 'RPG')) {
    throw new Error('Doubao domain glossary self-check failed');
  }

  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = body.input[0].content[0].text;
    if (!input.includes('__YTKEEP_0__') || input.includes('boondocker')) throw new Error('Protected term masking failed');
    return { ok: true, status: 200, text: async () => JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '这双 __YTKEEP_0__ 很舒适。' }] }] }) };
  };
  if (await doubaoTranslate('This boondocker is comfortable.', { doubaoApiKey: 'test', doubaoProtectedTerms: 'boondocker' }) !== '这双 boondocker 很舒适。') throw new Error('Protected term restoration failed');
  chrome.storage.local.data = {
    translationEngine: 'qwen', qwenApiKey: 'old-test-key', qwenDomain: 'gaming', qwenProtectedTerms: 'Steam',
    tencentTranslationCache: { old: { engine: 'qwen' }, keep: { engine: 'tencent' } }
  };
  await migrateLegacySettings();
  const migrated = chrome.storage.local.data;
  if (migrated.translationEngine !== 'doubao' || migrated.doubaoDomain !== 'gaming' || migrated.doubaoProtectedTerms !== 'Steam' ||
      migrated.qwenApiKey || migrated.tencentTranslationCache.old || !migrated.tencentTranslationCache.keep) throw new Error('Legacy settings cleanup failed');
  global.fetch = originalFetch;
  console.log('background crypto self-check passed');
})();
