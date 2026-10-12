const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function captions(events, withPlayer = false) {
  const draws = [], sent = [], timers = new Map();
  let timerId = 0, now = 10000;
  const video = new EventTarget();
  Object.assign(video, { currentTime: 0.5, duration: 60 });
  const player = { querySelector: () => video, classList: { remove() {} } };
  const handlers = [];
  const c = {
    URL, AbortController, console, Promise, TextEncoder,
    Date: class extends Date { static now() { return now; } },
    location: new URL('https://www.youtube.com/watch?v=reliability'),
    localStorage: { getItem: () => null },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    setInterval: () => 1, clearInterval() {}, addEventListener() {},
    MutationObserver: class { observe() {} },
    document: {
      documentElement: { dataset: { ytzhTimeline: JSON.stringify({ videoId: 'reliability', languageCode: 'en', data: { events } }) }, classList: { add() {}, remove() {}, toggle() {} } },
      querySelectorAll: selector => withPlayer && selector === '.html5-video-player' ? [player] : [],
      querySelector: () => null, addEventListener() {}
    },
    chrome: {
      storage: { local: { get: async defaults => ({ ...defaults, translationEngine: 'doubao' }) }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { handlers.push(fn); } }, sendMessage: async message => { sent.push(message); return c.response(message); } }
    },
    response: () => ({ ok: true, text: '译文' }),
    record(source, text) { draws.push({ source, text }); }
  };
  const source = fs.readFileSync('content.js', 'utf8')
    .replace(/  function render\(source, translated\) \{[\s\S]*?\n  \}\n\n  function nativeCaption/, '  function render(source, translated) { record(source, translated); }\n\n  function nativeCaption')
    .replace('  bindVideo();\n})();', `  globalThis.audit = { updateTimelineCaption, bindVideo, pretranslateAhead,
      setup(video) { enabled=true; translationEngine='doubao'; boundVideo=video; },
      cache(text, translated) { translations.set(translationId(text, displayCues.find(cue => cue.text === text)), Promise.resolve(translated)); },
      retryNow() { for (const failed of failures.values()) failed.retryAt=0; },
      state() { return { captionState, captionError, renderedSource, currentSource }; }
    };\n})();`);
  vm.runInNewContext(source, c);
  c.audit.setup(video);
  return { c, video, draws, sent, handlers, tick() { now += 10000; } };
}
const cue = (start, duration, text) => ({ tStartMs: start, dDurationMs: duration, segs: [{ utf8: text }] });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function checkCaptions() {
  const a = captions([cue(0, 10000, 'Hello world')]);
  a.c.response = () => ({ ok: false, error: 'Temporary error' });
  await a.c.audit.updateTimelineCaption();
  await a.c.audit.updateTimelineCaption();
  assert.equal(a.sent.length, 1, 'No immediate retry storm');
  assert.match(a.c.audit.state().captionState, /重试/);
  a.tick(); a.c.response = () => ({ ok: true, text: '你好世界' });
  await a.c.audit.updateTimelineCaption();
  assert.equal(a.draws.at(-1).text, '你好世界', 'Retry recovers the same current cue');
  assert.equal(a.sent[1].purpose, 'subtitle');
  a.video.currentTime = 20;
  await a.c.audit.updateTimelineCaption();
  assert.equal(a.c.audit.state().renderedSource, '', 'Last cue disappears after its end');

  const b = captions([cue(0, 10000, 'Hello world')]);
  b.c.response = () => ({ ok: false, error: 'Temporary error' });
  await b.c.audit.updateTimelineCaption();
  b.c.audit.cache('Hello world', '缓存恢复');
  await b.c.audit.updateTimelineCaption();
  assert.equal(b.draws.at(-1).text, '缓存恢复', 'Late cache result bypasses retry cooldown');

  const bounded = captions([cue(0, 10000, 'Hello world')]);
  bounded.c.response = () => ({ ok: false, error: 'Temporary error' });
  for (let i = 0; i < 6; i++) { bounded.tick(); await bounded.c.audit.updateTimelineCaption(); }
  assert.equal(bounded.sent.length, 3, 'Retries stop after three attempts');

  const gap = captions([cue(0, 1000, 'First'), cue(5000, 1000, 'Next')]);
  await gap.c.audit.updateTimelineCaption();
  assert.equal(gap.draws.at(-1).source, 'First', 'Do not merge across a silent gap');
  gap.video.currentTime = 2;
  await gap.c.audit.updateTimelineCaption();
  assert.equal(gap.c.audit.state().renderedSource, '');
  gap.video.currentTime = 5.5;
  await gap.c.audit.updateTimelineCaption();
  assert.equal(gap.draws.at(-1).source, 'Next');

  const stale = captions([cue(0, 1000, 'First')]);
  let release;
  stale.c.response = () => new Promise(resolve => { release = resolve; });
  const old = stale.c.audit.updateTimelineCaption();
  await flush(); stale.video.currentTime = 2;
  await stale.c.audit.updateTimelineCaption();
  release({ ok: true, text: '过期译文' }); await old;
  assert.equal(stale.draws.length, 0, 'Late result never restores an expired cue');

  const prefetched = captions([cue(0, 1000, 'First'), cue(8000, 1000, 'Next')], true);
  let finishBatch;
  prefetched.c.response = message => message.type === 'translate-batch'
    ? new Promise(resolve => { finishBatch = resolve; }) : { ok: true, text: '第一句' };
  await prefetched.c.audit.updateTimelineCaption(); await flush();
  assert.equal(prefetched.sent.filter(message => message.type === 'translate-batch').length, 1);
  prefetched.video.currentTime = 8.5;
  const current = prefetched.c.audit.updateTimelineCaption(); await flush();
  assert.equal(prefetched.sent.filter(message => message.type === 'translate').length, 1, 'Current cue shares the prefetched promise');
  finishBatch({ ok: true, texts: ['下一句'] }); await current; await flush();
  assert.equal(prefetched.draws.at(-1).text, '下一句');
  assert.ok(prefetched.sent.some(message => message.type === 'promote-translation'), 'Current playback promotes its queued prefetch');
  let state;
  prefetched.handlers[0]({ type: 'subtitles-state' }, {}, result => { state = result; });
  assert.equal(state.state, '已读取时间轴', 'Popup receives the actual caption state');
  console.log('Caption retry, late cache, gaps, expiry, stale responses and prefetch sharing passed');
}

async function checkRequests() {
  let now = 100000;
  const c = { crypto: webcrypto, TextEncoder, Uint8Array, console, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now += 10000; } },
    chrome: { runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} } },
      storage: { local: { get: async defaults => defaults, set: async () => {}, remove: async () => {} } } } };
  vm.createContext(c); vm.runInContext(fs.readFileSync('background.js', 'utf8'), c);
  const config = { doubaoModel: 'test', doubaoDomain: 'general', doubaoProtectedTerms: '' };
  let calls = 0, release;
  c.batchStub = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  vm.runInContext('requestDoubaoBatch=batchStub', c);
  const batch1 = c.translateBatchCached(['Hello'], config);
  const batch2 = c.translateBatchCached(['Hello'], config);
  await new Promise(resolve => setTimeout(resolve, 20));
  const single = c.translateCached('doubao', 'Hello', config, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'Identical batches and live single requests share one call');
  release(['你好']);
  assert.equal((await Promise.all([batch1, batch2, single])).flat().join('|'), '你好|你好|你好');

  c.batchStub = async () => { throw new Error('豆包没有完整保留字幕编号'); };
  c.singleStub = async text => `fallback:${text}`;
  vm.runInContext('requestDoubaoBatch=batchStub;requestDoubao=singleStub', c);
  assert.equal((await c.translateBatchCached(['Fallback'], config))[0], 'fallback:Fallback', 'Malformed batch fallback does not deadlock');

  const order = [];
  let unblock;
  const active = c.queueRequest('priority-test', () => new Promise(resolve => { unblock = resolve; }), 2);
  await flush();
  const page = c.queueRequest('priority-test', async () => order.push('page'), 2);
  const preload = c.queueRequest('priority-test', async () => order.push('prefetch'), 1);
  const live = c.queueRequest('priority-test', async () => order.push('subtitle'), 0);
  unblock(); await Promise.all([active, page, preload, live]);
  assert.deepEqual(order, ['subtitle', 'prefetch', 'page'], 'Live subtitles take priority after the active request');

  let unblock2;
  const active2 = c.queueRequest('promotion-test', () => new Promise(resolve => { unblock2 = resolve; }), 1);
  await flush();
  const promoted = c.queueRequest('promotion-test', async () => order.push('promoted'), 2);
  const next = c.queueRequest('promotion-test', async () => order.push('other'), 1);
  promoted.promote(0); unblock2(); await Promise.all([active2, promoted, next]);
  assert.deepEqual(order.slice(-2), ['promoted', 'other']);
  console.log('Cloud request deduplication, malformed-batch fallback, priority and promotion passed');
}

(async () => { await checkCaptions(); await checkRequests(); })().catch(error => { console.error(error); process.exitCode = 1; });
