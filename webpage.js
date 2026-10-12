(() => {
  const translations = new Map();
  const translators = new Map();
  let processed = new WeakSet();
  const retries = new WeakMap();
  let detector;
  let enabled = false;
  let run = 0;
  let scrollTimer;
  let pageTimer;
  let pageQueue = Promise.resolve();
  let translationEngine = 'chrome';

  chrome.storage.local.get({ translationEngine: 'chrome' }).then(config => {
    translationEngine = config.translationEngine;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!['translationEngine', 'doubaoModel', 'doubaoDomain', 'doubaoProtectedTerms', 'doubaoApiKey'].some(key => changes[key])) return;
    if (changes.translationEngine) translationEngine = changes.translationEngine.newValue || 'chrome';
    run++;
    restorePage();
    if (enabled) schedulePage(0);
  });

  const ignored = 'script,style,noscript,textarea,input,select,option,button,code,pre,[contenteditable="true"],[role="button"],[role="menuitem"],[role="tab"],[role="switch"],[role="checkbox"],[role="radio"],ytd-channel-name,#channel-name,.ytd-channel-name,.html5-video-player,.ytzh-overlay,.ytzh-notice,.ytzh-page-translation';

  function notice(message) {
    document.querySelector('.ytzh-notice')?.remove();
    const box = document.createElement('div');
    box.className = 'ytzh-notice';
    box.textContent = message;
    document.documentElement.append(box);
    setTimeout(() => box.remove(), 3500);
  }

  function languageCode(value = '') {
    const code = value.toLowerCase().split('-')[0];
    return code === 'he' ? 'iw' : code;
  }

  async function translatorFor(text) {
    if (!('LanguageDetector' in self) || !('Translator' in self)) throw new Error('请升级到最新版桌面版 Chrome');
    if (/^@|^https?:\/\//i.test(text.trim())) return null;
    if (/\p{Script=Han}/u.test(text) && !/[\u3040-\u30ff]/u.test(text)) return null;
    detector ??= await LanguageDetector.create();
    const detected = await detector.detect(text);
    const sourceLanguage = languageCode(detected[0]?.detectedLanguage);
    if (!sourceLanguage || sourceLanguage === 'zh') return null;
    if (!translators.has(sourceLanguage)) {
      const options = { sourceLanguage, targetLanguage: 'zh' };
      translators.set(sourceLanguage, (async () => {
        if (await Translator.availability(options) === 'unavailable') return null;
        return Translator.create(options);
      })());
    }
    try {
      return await translators.get(sourceLanguage);
    } catch (error) {
      translators.delete(sourceLanguage);
      throw error;
    }
  }

  async function translateWithRetry(translator, text) {
    let error;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const previous = globalThis.ytzhTranslationQueue || Promise.resolve();
        const request = previous.catch(() => {}).then(() => translator.translate(text));
        globalThis.ytzhTranslationQueue = request.catch(() => {});
        return await request;
      } catch (caught) {
        error = caught;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw error;
  }

  function textNodes(root = document.body) {
    if (!root) return [];
    if (root.nodeType === Node.TEXT_NODE) {
      const parent = root.parentElement;
      const text = root.nodeValue.trim();
      return parent && text.length > 1 && !parent.closest(ignored) && /\p{L}/u.test(text) ? [root] : [];
    }
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        const text = node.nodeValue.trim();
        return parent && text.length > 1 && !parent.closest(ignored) && /\p{L}/u.test(text)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function isNearViewport(node) {
    const rect = node.parentElement?.getBoundingClientRect();
    return rect && rect.bottom >= -100 && rect.top <= innerHeight + 100 && rect.width > 0 && rect.height > 0;
  }

  async function translateNode(node, thisRun) {
    if (!enabled || thisRun !== run || processed.has(node)) return;
    processed.add(node);
    const original = node.nodeValue;
    if (/\p{Script=Han}/u.test(original) && !/[\u3040-\u30ff]/u.test(original)) return;
    try {
      if (translationEngine !== 'chrome') {
        const result = await chrome.runtime.sendMessage({ type: 'translate', text: original.trim(), purpose: 'webpage' });
        if (!result?.ok) throw new Error(result?.error || '腾讯云翻译失败');
        if (!enabled || thisRun !== run || node.nodeValue !== original) return;
        if (!result.text || result.text.trim() === original.trim()) return;
        const line = document.createElement('span');
        line.className = 'ytzh-page-translation';
        line.textContent = result.text;
        node.after(line);
        translations.set(node, line);
        return;
      }
      const translator = await translatorFor(original);
      if (!translator || !enabled || thisRun !== run || node.nodeValue !== original) return;
      const translated = await translateWithRetry(translator, original.trim());
      if (!translated || !enabled || thisRun !== run || node.nodeValue !== original) return;
      if (translated.trim() === original.trim()) return;
      const line = document.createElement('span');
      line.className = 'ytzh-page-translation';
      line.textContent = translated;
      node.after(line);
      translations.set(node, line);
    } catch (_) {
      translators.clear();
      const attempts = (retries.get(node) || 0) + 1;
      retries.set(node, attempts);
      if (attempts < 3) {
        processed.delete(node);
        schedulePage(1000);
      }
      // Unsupported fragments stay unchanged while the rest of the page continues.
    }
  }

  async function translatePage(root) {
    const thisRun = run;
    const nodes = textNodes(root).filter(isNearViewport).sort((a, b) => {
      const priority = node => node.parentElement?.closest('a[href*="/watch"],#video-title,h3') ? 0 : 1;
      return priority(a) - priority(b);
    });
    for (const node of nodes) {
      if (!enabled || thisRun !== run) break;
      await translateNode(node, thisRun);
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  }

  function schedulePage(delay = 200) {
    clearTimeout(pageTimer);
    pageTimer = setTimeout(() => {
      pageQueue = pageQueue.catch(() => {}).then(() => translatePage(document.body));
    }, delay);
  }

  function restorePage() {
    document.querySelector('.ytzh-notice')?.remove();
    document.querySelectorAll('.ytzh-page-translation').forEach(line => line.remove());
    translations.clear();
    processed = new WeakSet();
  }

  new MutationObserver(records => {
    if (!enabled) return;
    if (records.some(record => record.addedNodes.length)) schedulePage();
  }).observe(document.documentElement, { childList: true, subtree: true });

  addEventListener('scroll', () => {
    if (!enabled) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => schedulePage(0), 180);
  }, { passive: true });

  addEventListener('resize', () => {
    if (enabled) schedulePage();
  });

  document.addEventListener('yt-navigate-finish', () => {
    if (enabled) schedulePage(500);
  });

  function toggleWebpage() {
    enabled = !enabled;
    run++;
    if (enabled) {
      const engineName = translationEngine === 'doubao' ? '豆包精翻'
        : translationEngine === 'tencent' ? '腾讯云机器翻译'
        : 'Chrome 本地翻译';
      notice(`网页文字翻译已开启：${engineName}（Alt+W 关闭）`);
      schedulePage(0);
    } else {
      restorePage();
      notice('网页文字翻译已关闭，恢复原文');
    }
    return enabled;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'toggle-webpage') sendResponse({ ok: true, enabled: toggleWebpage() });
    if (message?.type === 'webpage-state') sendResponse({ ok: true, enabled });
  });

  addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey || event.key.toLowerCase() !== 'w' || event.repeat) return;
    if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleWebpage();
  }, true);
})();
