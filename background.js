const ENDPOINT = 'https://tmt.tencentcloudapi.com/';
const DOUBAO_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const SERVICE = 'tmt';
const CACHE_KEY = 'tencentTranslationCache';
const CACHE_LIMIT = 8 * 1024 * 1024;
const DOUBAO_CACHE_VERSION = 1;
const DOUBAO_DOMAINS = {
  general: ['General subtitle dialogue or webpage text.', []],
  footwear: ['Footwear and clothing reviews. Distinguish brands, product models, materials and construction terms from ordinary words.', ['Red Wing', 'Iron Ranger', 'Parkhurst', 'Boondocker', 'Boondockers', 'Vibram', 'Horween', "White's Boots", "Nick's Boots", 'Thursday Boots']],
  gaming: ['Video game dialogue, reviews and guides. Distinguish game titles, characters, studios, platforms and gameplay abbreviations.', ['Steam', 'PlayStation', 'Xbox', 'Nintendo Switch', 'Epic Games', 'Unreal Engine', 'Unity', 'FPS', 'RPG', 'DLC', 'NPC', 'PvP', 'PvE']],
  technology: ['Technology and consumer electronics. Distinguish companies, products, models, software and technical abbreviations.', ['Windows', 'macOS', 'Linux', 'Android', 'iOS', 'Chrome', 'YouTube', 'OpenAI', 'NVIDIA', 'AMD', 'Intel', 'API', 'GPU', 'CPU']],
  finance: ['Finance and investing. Distinguish companies, assets, indices, tickers and financial abbreviations.', ['Bitcoin', 'Ethereum', 'Nasdaq', 'S&P 500', 'ETF', 'IPO', 'GDP', 'CPI']],
  automotive: ['Cars and automotive reviews. Distinguish manufacturers, models, component names and automotive abbreviations.', ['Tesla', 'BMW', 'Mercedes-Benz', 'Toyota', 'Honda', 'Ford', 'Volkswagen', 'EV', 'SUV', 'ABS', 'ADAS']]
};
let cachePromise;
let cacheWrite = Promise.resolve();
let cacheWriteTimer;
const pendingTranslations = new Map();
const requestQueues = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!['translate', 'translate-batch', 'promote-translation', 'test-tencent', 'test-doubao', 'download-caption'].includes(message?.type)) return;
  handleMessage(message).then(sendResponse).catch(error => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  migrateLegacySettings().catch(() => {});
});

async function migrateLegacySettings() {
  const old = await chrome.storage.local.get(['translationEngine', 'qwenDomain', 'qwenProtectedTerms', 'doubaoDomain', 'doubaoProtectedTerms', CACHE_KEY]);
  const changes = {};
  if (old.translationEngine === 'qwen') changes.translationEngine = 'doubao';
  if (old.doubaoDomain === undefined && old.qwenDomain !== undefined) changes.doubaoDomain = old.qwenDomain;
  if (old.doubaoProtectedTerms === undefined && old.qwenProtectedTerms !== undefined) changes.doubaoProtectedTerms = old.qwenProtectedTerms;
  const cache = old[CACHE_KEY];
  if (cache) {
    for (const key of Object.keys(cache)) if (cache[key].engine === 'qwen') delete cache[key];
    changes[CACHE_KEY] = cache;
  }
  if (Object.keys(changes).length) await chrome.storage.local.set(changes);
  await chrome.storage.local.remove(['qwenApiKey', 'qwenDomain', 'qwenProtectedTerms']);
}

async function handleMessage(message) {
  if (message.type === 'download-caption') return downloadCaption(message.url);
  const config = await chrome.storage.local.get({
    translationEngine: 'chrome',
    tencentSecretId: '',
    tencentSecretKey: '',
    tencentRegion: 'ap-guangzhou',
    doubaoApiKey: '',
    doubaoModel: 'doubao-seed-translation-250915',
    doubaoDomain: 'general',
    doubaoProtectedTerms: 'boondocker, boondockers'
  });
  if (['translate', 'translate-batch'].includes(message.type) && !['tencent', 'doubao'].includes(config.translationEngine)) {
    return { ok: false, local: true };
  }
  const engine = message.type === 'test-doubao' ? 'doubao'
    : message.type === 'test-tencent' ? 'tencent'
    : config.translationEngine;
  const priority = message.purpose === 'subtitle' ? 0 : message.purpose === 'prefetch' ? 1 : 2;
  if (message.type === 'promote-translation') {
    const key = await translationKey(engine, String(message.text || '').trim(), config);
    pendingTranslations.get(key)?.promote?.(0);
    return { ok: true };
  }
  if (engine === 'tencent' && (!config.tencentSecretId || !config.tencentSecretKey)) {
    throw new Error('请先在插件设置中填写腾讯云 SecretId 和 SecretKey');
  }
  if (engine === 'doubao' && !config.doubaoApiKey) {
    throw new Error('请先在插件设置中填写豆包 API Key');
  }
  if (message.type === 'translate-batch') {
    if (engine !== 'doubao') return { ok: false, error: '批量上下文翻译仅供豆包使用' };
    const texts = Array.isArray(message.texts) ? message.texts.map(text => String(text).trim()).filter(Boolean) : [];
    if (!texts.length || texts.length > 20) throw new Error('每批字幕必须为1至20条');
    return { ok: true, texts: await translateBatchCached(texts, config, priority) };
  }
  if (message.type === 'test-doubao') {
    const texts = await requestDoubaoBatch([
      'The reviewer picked up the boots and examined the leather.',
      'He said they were surprisingly comfortable for the price.'
    ], config);
    return { ok: true, batch: true, texts };
  }
  const text = message.type.startsWith('test-') ? 'Hello' : String(message.text || '').trim();
  if (!text) throw new Error('没有需要翻译的文字');
  const translated = message.type.startsWith('test-')
    ? await requestTranslation(engine, text, config)
    : await translateCached(engine, text, config, priority);
  return { ok: true, text: translated };
}

async function translateBatchCached(texts, config, priority = 1) {
  const cache = await loadCache();
  const keys = await Promise.all(texts.map(text => translationKey('doubao', text, config)));
  const results = texts.map((text, index) => cache[keys[index]]?.source === text ? cache[keys[index]].translated : null);
  const owned = [];
  let job;
  let effectivePriority = priority;
  const waiting = texts.map((text, index) => {
    if (results[index]) return Promise.resolve(results[index]);
    const key = keys[index];
    if (!pendingTranslations.has(key)) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      promise.promote = value => {
        effectivePriority = Math.min(effectivePriority, value);
        job?.promote?.(value);
      };
      pendingTranslations.set(key, promise);
      owned.push({ key, text, promise, resolve, reject });
    }
    const pending = pendingTranslations.get(key);
    pending.promote?.(priority);
    return pending;
  });
  const result = Promise.all(waiting);
  if (owned.length) {
    (async () => {
      try {
        job = requestDoubaoBatch(owned.map(item => item.text), config, effectivePriority);
        let translated;
        try { translated = await job; } catch (error) {
          if (!/没有完整保留字幕编号/.test(error.message)) throw error;
          translated = [];
          for (const item of owned) {
            job = requestDoubao(item.text, config, effectivePriority);
            translated.push(await job);
          }
        }
        if (translated.length !== owned.length || translated.some(text => !text)) throw new Error('批量译文不完整');
        owned.forEach((item, index) => {
          cache[item.key] = { engine: 'doubao', source: item.text, translated: translated[index], savedAt: Date.now() };
          item.resolve(translated[index]);
        });
        trimCache(cache);
        scheduleCacheWrite(cache);
      } catch (error) { owned.forEach(item => item.reject(error)); }
      finally {
        owned.forEach(item => {
          if (pendingTranslations.get(item.key) === item.promise) pendingTranslations.delete(item.key);
        });
      }
    })();
  }
  return result;
}

async function downloadCaption(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.pathname !== '/api/timedtext') {
      throw new Error('不允许的字幕地址');
    }
    url.searchParams.set('fmt', 'json3');
    const response = await fetch(url.href, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    const body = await response.text();
    if (!response.ok || !body) throw new Error(`HTTP ${response.status}，返回 ${body.length} 字节`);
    let data;
    try { data = JSON.parse(body); } catch (_) { throw new Error(`HTTP ${response.status}，返回内容不是 JSON（${body.length} 字节）`); }
    return { ok: true, data, diagnostic: `HTTP ${response.status}，${body.length} 字节，${data.events?.length || 0} 条` };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

async function translateCached(engine, text, config, priority = 1) {
  const cache = await loadCache();
  const key = await translationKey(engine, text, config);
  if (cache[key]?.source === text) return cache[key].translated;
  if (!pendingTranslations.has(key)) {
    const job = requestTranslation(engine, text, config, priority);
    const pending = (async () => {
      const translated = await job;
      cache[key] = { engine, source: text, translated, savedAt: Date.now() };
      trimCache(cache);
      scheduleCacheWrite(cache);
      return translated;
    })().finally(() => pendingTranslations.delete(key));
    pending.promote = value => job.promote?.(value);
    pendingTranslations.set(key, pending);
  }
  const pending = pendingTranslations.get(key);
  pending.promote?.(priority);
  return pending;
}

function translationKey(engine, text, config) {
  const cacheEngine = engine === 'doubao' ? `doubao:${DOUBAO_CACHE_VERSION}:${config.doubaoModel || 'doubao-seed-translation-250915'}:${config.doubaoDomain}:${config.doubaoProtectedTerms}` : engine;
  return sha256(`${cacheEngine}\n${text}`);
}

function requestTranslation(engine, text, config, priority = 1) {
  return engine === 'doubao' ? requestDoubao(text, config, priority) : requestTencent(text, config, priority);
}

function requestTencent(text, config, priority = 1) {
  return queueRequest('tencent', async () => {
    try {
      return await tencentTranslate(text, config);
    } catch (error) {
      if (!/frequency limit|request times/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 600));
      requestQueues.get('tencent').lastStart = Date.now();
      return tencentTranslate(text, config);
    }
  }, priority);
}

function requestDoubao(text, config, priority = 1) {
  return queueDoubao(() => doubaoTranslate(text, config), priority);
}

function requestDoubaoBatch(texts, config, priority = 1) {
  return queueDoubao(() => doubaoTranslateBatch(texts, config), priority);
}

function queueDoubao(task, priority = 1) {
  return queueRequest('doubao', async () => {
    try {
      return await task();
    } catch (error) {
      if (!/429|rate limit|throttl/i.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500));
      requestQueues.get('doubao').lastStart = Date.now();
      return task();
    }
  }, priority);
}

function queueRequest(engine, task, priority) {
  if (!requestQueues.has(engine)) requestQueues.set(engine, { items: [], running: false, lastStart: 0 });
  const queue = requestQueues.get(engine);
  const item = { task, priority };
  const promise = new Promise((resolve, reject) => { Object.assign(item, { resolve, reject }); });
  promise.promote = value => { item.priority = Math.min(item.priority, value); };
  queue.items.push(item);
  if (!queue.running) {
    queue.running = true;
    Promise.resolve().then(async () => {
      while (queue.items.length) {
        const wait = Math.max(0, (engine === 'doubao' ? 1050 : 250) - (Date.now() - queue.lastStart));
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
        queue.items.sort((a, b) => a.priority - b.priority);
        const next = queue.items.shift();
        queue.lastStart = Date.now();
        try { next.resolve(await next.task()); } catch (error) { next.reject(error); }
      }
      queue.running = false;
    });
  }
  return promise;
}

function scheduleCacheWrite(cache) {
  clearTimeout(cacheWriteTimer);
  cacheWriteTimer = setTimeout(() => {
    cacheWrite = cacheWrite.catch(() => {}).then(() => chrome.storage.local.set({ [CACHE_KEY]: cache }));
  }, 400);
}

async function loadCache() {
  cachePromise ??= chrome.storage.local.get({ [CACHE_KEY]: {} }).then(data => data[CACHE_KEY] || {});
  return cachePromise;
}

function trimCache(cache, limit = CACHE_LIMIT) {
  const encoder = new TextEncoder();
  const entries = Object.entries(cache).sort((a, b) => a[1].savedAt - b[1].savedAt);
  while (entries.length && encoder.encode(JSON.stringify(cache)).byteLength > limit) {
    delete cache[entries.shift()[0]];
  }
  return cache;
}

async function tencentTranslate(text, config) {
  const body = JSON.stringify({ SourceText: text, Source: 'auto', Target: 'zh', ProjectId: 0 });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const action = 'TextTranslate';
  const host = 'tmt.tencentcloudapi.com';
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${await sha256(body)}`;
  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha256(canonicalRequest)}`;
  const secretDate = await hmac(`TC3${config.tencentSecretKey}`, date);
  const secretService = await hmac(secretDate, SERVICE);
  const secretSigning = await hmac(secretService, 'tc3_request');
  const signature = hex(await hmac(secretSigning, stringToSign));
  const authorization = `TC3-HMAC-SHA256 Credential=${config.tencentSecretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': '2018-03-21',
      'X-TC-Region': config.tencentRegion || 'ap-guangzhou'
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.Response?.Error) {
    throw new Error(data.Response?.Error?.Message || `腾讯云请求失败（HTTP ${response.status}）`);
  }
  return data.Response?.TargetText || '';
}

async function doubaoTranslate(text, config, termSource = text) {
  const terms = preservedTerms(termSource, config.doubaoProtectedTerms, config.doubaoDomain);
  // Translation-only models receive source text, rather than chat instructions.
  const tokens = terms.map((term, index) => ({ ...term, token: `__YTKEEP_${index}__` }));
  let source = text;
  for (const term of [...tokens].sort((a, b) => b.source.length - a.source.length)) {
    const escaped = term.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    source = source.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu'), term.token);
  }
  const response = await fetch(DOUBAO_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(45000),
    headers: {
      Authorization: `Bearer ${config.doubaoApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.doubaoModel || 'doubao-seed-translation-250915',
      stream: false,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: source,
          translation_options: { target_language: 'zh' }
        }]
      }]
    })
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new Error(`豆包返回内容异常（HTTP ${response.status}）`); }
  if (!response.ok || data.error) {
    throw new Error(data.error?.message || data.message || `豆包请求失败（HTTP ${response.status}）`);
  }
  let translated = (data.output || [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text')
    .map(item => item.text || '').join('').trim();
  if (!translated) throw new Error('豆包没有返回译文');
  for (const term of tokens) translated = translated.replaceAll(term.token, term.target);
  return translated;
}

function preservedTerms(text, protectedTerms = '', domainName = 'general') {
  const glossary = DOUBAO_DOMAINS[domainName]?.[1] || [];
  const custom = String(protectedTerms).split(/[,，\n]/).map(term => term.trim()).filter(Boolean);
  const matched = [...custom, ...glossary].map(target => {
    const index = String(text).toLocaleLowerCase().indexOf(target.toLocaleLowerCase());
    return index < 0 ? null : { source: String(text).slice(index, index + target.length), target };
  }).filter(Boolean);
  return matched.filter((term, index, all) =>
    all.findIndex(item => item.source.toLocaleLowerCase() === term.source.toLocaleLowerCase()) === index
  ).slice(0, 30);
}

async function doubaoTranslateBatch(texts, config) {
  const source = texts.map((text, index) => `<CUE_${index}>${text}</CUE_${index}>`).join('\n');
  const translated = await doubaoTranslate(source, config, texts.join('\n'));
  const results = texts.map((_, index) => {
    const match = translated.match(new RegExp(`<CUE_${index}>([\\s\\S]*?)<\\/CUE_${index}>`));
    return match?.[1].trim();
  });
  if (results.some(result => !result)) throw new Error('豆包没有完整保留字幕编号');
  return results;
}

async function sha256(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function hmac(key, value) {
  const rawKey = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value)));
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
