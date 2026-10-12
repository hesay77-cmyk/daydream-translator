const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const plain = value => JSON.parse(JSON.stringify(value));
const bytes = text => new TextEncoder().encode(text).byteLength;
const flush = () => new Promise(resolve => setImmediate(resolve));
const config = { translationEngine: 'doubao', doubaoApiKey: 'fixture-only', doubaoModel: 'doubao-seed-translation-250915', doubaoDomain: 'general', doubaoProtectedTerms: '' };

function background() {
  const inputs = [];
  let now = 100000;
  const c = { console, URL, AbortSignal, TextEncoder, Uint8Array, crypto: webcrypto,
    setTimeout: () => 1, clearTimeout() {},
    Date: class extends Date { static now() { return now += 10000; } },
    chrome: { runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: { get: async defaults => ({ ...defaults, ...config }), set: async () => {}, remove: async () => {} } } },
    output: source => source.includes('<CUE_')
      ? source.replace(/<CUE_(\d+)>([\s\S]*?)<\/CUE_\1>/g, (_, id, text) => `<CUE_${id}>译:${text}</CUE_${id}>`)
      : `译:${source}`,
    async fetch(url, options) {
      assert.equal(url, 'https://ark.cn-beijing.volces.com/api/v3/responses');
      const request = JSON.parse(options.body);
      const input = request.input[0].content[0];
      assert.equal(input.translation_options.target_language, 'zh');
      assert.ok(bytes(input.text) <= 900, 'Actual masked source stays within the byte budget');
      inputs.push(input.text);
      return { ok: true, status: 200, text: async () => JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: await c.output(input.text) }] }] }) };
    }
  };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), c);
  return { c, inputs };
}

function captions(events = [], backend) {
  const sent = [], draws = [], listeners = {};
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0.5, duration: 600 });
  const player = { querySelector: () => video, classList: { remove() {} } };
  const c = { console, URL, AbortController, TextEncoder, Promise, Date,
    location: new URL('https://www.youtube.com/watch?v=context-video'),
    localStorage: { getItem: () => null },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, addEventListener() {},
    MutationObserver: class { observe() {} },
    document: {
      documentElement: { dataset: { ytzhTimeline: JSON.stringify({ videoId: 'context-video', languageCode: 'en', data: { events } }) }, classList: { add() {}, remove() {} } },
      querySelector: () => null,
      querySelectorAll: selector => selector === '.html5-video-player' ? [player] : [],
      addEventListener(type, fn) { listeners[type] = fn; }
    },
    chrome: { storage: { local: { get: async defaults => ({ ...defaults, translationEngine: 'doubao' }) }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, async sendMessage(message) { sent.push(plain(message)); return backend.c.handleMessage(message); } } },
    record(source, translated) { draws.push({ source, translated }); }
  };
  const source = fs.readFileSync('content.js', 'utf8')
    .replace(/  function render\(source, translated\) \{[\s\S]*?\n  \}\n\n  function nativeCaption/, '  function render(source, translated) { record(source, translated); }\n\n  function nativeCaption')
    .replace('  bindVideo();\n})();', `  globalThis.audit = { planSubtitleBatches, precedingContext, subtitleInputSize, updateTimelineCaption, pretranslateAhead, bindVideo,
      setup(video) { enabled=true; translationEngine='doubao'; boundVideo=video; },
      state() { return { renderedSource, currentSource, prefetching }; }
    };\n})();`);
  vm.runInNewContext(source, c);
  c.audit.setup(video);
  return { c, video, sent, draws, listeners };
}

function checkPlanner() {
  const { c } = captions([], background());
  const cues = Array.from({ length: 35 }, (_, index) => ({ start: index * 1500, end: index * 1500 + 1000,
    text: `Line ${index} ${'some subtitle words '.repeat(3)}${index % 3 === 2 ? '.' : ','}` }));
  const batches = c.audit.planSubtitleBatches(cues);
  assert.deepEqual(plain(batches.flatMap(batch => batch.cues)), cues, 'Every cue appears once, in order');
  assert.ok(batches.length > 2);
  for (const batch of batches) {
    assert.ok(batch.cues.length <= 20 && batch.context.length <= 2);
    assert.ok(c.audit.subtitleInputSize([...batch.context, ...batch.cues.map(cue => cue.text)]) <= 900);
  }
  assert.match(batches[0].cues.at(-1).text, /\.$/, 'Prefer the last sentence boundary inside the budget');
  assert.deepEqual(plain(batches[1].context), batches[0].cues.slice(-2).map(cue => cue.text), 'Next batch carries neighbouring original text');

  const gap = [{ start: 0, end: 1000, text: 'First.' }, { start: 9000, end: 10000, text: 'New scene.' }];
  const separated = c.audit.planSubtitleBatches(gap);
  assert.equal(separated.length, 2);
  assert.equal(separated[1].context.length, 0, 'Do not carry history across a long silent gap');
  assert.deepEqual(plain(c.audit.planSubtitleBatches(cues, 4, 9000).flatMap(batch => batch.cues)), cues.slice(4, 7));
  assert.deepEqual(plain(c.audit.planSubtitleBatches(cues, -1)), []);
  const longCue = [{ start: 0, end: 1000, text: '字幕'.repeat(800) }];
  assert.equal(c.audit.planSubtitleBatches(longCue).length, 1, 'Long single cue always makes forward progress');
  for (let length = 1; length <= 80; length++) {
    const mixed = Array.from({ length }, (_, index) => ({ start: index * 2000, end: index * 2000 + 1500,
      text: `${index} ${'English 日本語 中文 😀 '.repeat(index % 12 + 1)}${index % 4 === 0 ? '?' : ''}` }));
    const planned = c.audit.planSubtitleBatches(mixed);
    assert.deepEqual(plain(planned.flatMap(batch => batch.cues)), mixed);
    for (const batch of planned) assert.ok(c.audit.subtitleInputSize([...batch.context, ...batch.cues.map(cue => cue.text)]) <= 900);
  }
  console.log('Sentence boundaries, silence boundaries, overlap, Unicode budgets and cue coverage passed');
}

async function checkContextRequests() {
  const { c, inputs } = background();
  const options = { scopes: ['subtitle-v2:video-a:1000'], context: ['Alice found the red book.'] };
  assert.deepEqual(plain(await c.translateBatchCached(['She opened it.'], config, 1, options)), ['译:She opened it.']);
  assert.match(inputs[0], /Alice found the red book/);
  assert.match(inputs[0], /<CUE_1>She opened it\.<\/CUE_1>/);
  await c.translateBatchCached(['She opened it.'], config, 1, options);
  assert.equal(inputs.length, 1, 'Local scoped cache avoids a repeated call');
  await c.translateBatchCached(['She opened it.'], config, 1, { ...options, scopes: ['subtitle-v2:video-b:1000'] });
  await c.translateBatchCached(['She opened it.'], config, 1, { ...options, scopes: ['subtitle-v2:video-a:2000'] });
  assert.equal(inputs.length, 3, 'Different videos and repeated dialogue at different positions do not share a translation');

  await c.translateBatchCached(['Cached neighbour.'], config, 1, { scopes: ['subtitle-v2:video-a:3000'] });
  c.output = source => source.replace(/<CUE_(\d+)>([\s\S]*?)<\/CUE_\1>/g, (_, id, text) => `<CUE_${id}>新:${text}</CUE_${id}>`);
  const cachedBatch = await c.translateBatchCached(['Cached neighbour.', 'New target.'], config, 1,
    { scopes: ['subtitle-v2:video-a:3000', 'subtitle-v2:video-a:4000'] });
  assert.match(inputs.at(-1), /Cached neighbour/);
  assert.deepEqual(plain(cachedBatch), ['译:Cached neighbour.', '新:New target.'], 'Cached history is sent but its stored translation is preserved');

  c.output = source => source;
  const long = ['日本語の長い字幕😀'.repeat(180), 'Next sentence.'];
  const translated = await c.doubaoTranslateBatch(long, config, ['Older context.']);
  assert.equal(translated[0].replaceAll(' ', ''), long[0]);
  assert.equal(translated[1], long[1]);
  const protectedConfig = { ...config, doubaoProtectedTerms: 'boondocker' };
  const protectedText = 'boondocker '.repeat(200).trim();
  const protectedResult = (await c.doubaoTranslateBatch([protectedText], protectedConfig))[0];
  assert.equal(protectedResult.replace(/\s+/g, ' '), protectedText, 'Splitting never cuts a protected-term placeholder');
  const parts = c.splitTranslationText('😀 漢字 boondocker '.repeat(300));
  assert.equal(parts.join(''), '😀 漢字 boondocker '.repeat(300));
  assert.ok(parts.every(part => bytes(part) <= 900));

  c.output = source => source.includes('<CUE_') ? '<CUE_0>wrong</CUE_0><CUE_0>duplicate</CUE_0>' : `fallback:${source}`;
  const fallback = await c.translateBatchCached(['Duplicate key.', 'Duplicate key.'], config);
  assert.deepEqual(plain(fallback), ['fallback:Duplicate key.', 'fallback:Duplicate key.'], 'Duplicate tag fallback cannot deadlock duplicate source keys');
  await assert.rejects(c.doubaoTranslateBatch(['One.', 'Two.'], config), /没有完整保留字幕编号/);
  c.output = () => '<CUE_1>second</CUE_1><CUE_0>first</CUE_0>';
  assert.deepEqual(plain(await c.doubaoTranslateBatch(['One.', 'Two.'], config)), ['first', 'second'], 'Output order cannot change cue mapping');
  console.log('Actual source budgets, history discard, scoped cache, cached-neighbour context, long cues, protected terms and tag recovery passed');
}

async function checkPlayback() {
  const backend = background();
  const events = Array.from({ length: 18 }, (_, index) => ({ tStartMs: index * 1500, dDurationMs: 1000,
    segs: [{ utf8: `Sentence ${index} ${'subtitle words '.repeat(3)}.` }] }));
  const a = captions(events, backend);
  await a.c.audit.updateTimelineCaption();
  while (a.c.audit.state().prefetching) await flush();
  const batches = a.sent.filter(message => message.type === 'translate-batch');
  assert.ok(batches.length > 1);
  assert.ok(batches.every(message => message.scopes.every(scope => scope.startsWith('subtitle-v2:context-video:'))));
  assert.ok(batches[1].context.length > 0);
  assert.ok(a.draws[0].translated.startsWith('译:Sentence 0'));
  const calls = backend.inputs.length;
  a.video.currentTime = 9.5;
  await a.c.audit.updateTimelineCaption();
  assert.ok(a.draws.at(-1).translated.startsWith('译:Sentence 6'));
  assert.equal(backend.inputs.length, calls, 'Playback reuses preloaded position translations');

  const repeatedBackend = background();
  const repeatedEvents = [0, 1500].map(start => ({ tStartMs: start, dDurationMs: 1000, segs: [{ utf8: 'Repeated words.' }] }));
  const repeated = captions(repeatedEvents, repeatedBackend);
  await repeated.c.audit.updateTimelineCaption();
  while (repeated.c.audit.state().prefetching) await flush();
  repeated.video.currentTime = 1.7;
  await repeated.c.audit.updateTimelineCaption();
  assert.equal(repeated.draws.length, 2, 'Identical text at a new position still displays its own scoped result');
  const loaded = repeatedBackend.inputs.length;
  repeated.video.currentTime = 0.5;
  await repeated.c.audit.updateTimelineCaption();
  assert.equal(repeatedBackend.inputs.length, loaded, 'Seeking back reuses the position cache');
  repeated.listeners['yt-navigate-start']();
  repeated.c.location = new URL('https://www.youtube.com/watch?v=another-video');
  repeated.c.document.documentElement.dataset.ytzhTimeline = JSON.stringify({ videoId: 'another-video', languageCode: 'en', data: { events: repeatedEvents } });
  repeated.c.audit.bindVideo();
  await repeated.c.audit.updateTimelineCaption();
  while (repeated.c.audit.state().prefetching) await flush();
  assert.ok(repeatedBackend.inputs.length > loaded, 'Navigation never reuses another video\'s scoped cache');
  assert.ok(repeated.sent.some(message => message.scope === 'subtitle-v2:another-video:0'));

  let finish;
  backend.c.output = source => new Promise(resolve => { finish = () => resolve(source.replace(/<CUE_(\d+)>([\s\S]*?)<\/CUE_\1>/g, (_, id, text) => `<CUE_${id}>late:${text}</CUE_${id}>`)); });
  const scope = 'subtitle-v2:sharing:100';
  const batch = backend.c.handleMessage({ type: 'translate-batch', texts: ['Sharing test.'], scopes: [scope], context: ['A preceding line.'], purpose: 'prefetch' });
  while (!finish) await flush();
  const before = backend.inputs.length;
  const live = backend.c.handleMessage({ type: 'translate', text: 'Sharing test.', scope, context: ['A preceding line.'], purpose: 'subtitle' });
  await flush();
  assert.equal(backend.inputs.length, before, 'Live and prefetch scoped requests share the same pending translation');
  finish();
  assert.equal((await live).text, (await batch).texts[0]);
  console.log('Content-to-background context integration, preloaded playback, repeated dialogue, seeking, navigation and scoped live request sharing passed');
}

(async () => { checkPlanner(); await checkContextRequests(); await checkPlayback(); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
