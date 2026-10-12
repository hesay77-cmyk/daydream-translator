(() => {
  const translations = new Map();
  const translators = new Map();
  let detectorPromise;
  let enabled = false;
  let translationEngine = 'chrome';
  let currentSource = '';
  let currentScope = '';
  let updateVersion = 0;
  let updateTimer;
  let boundVideo;
  let timelineTimer;
  let prefetchGeneration = 0;
  let prefetching = false;
  let prefetchedWindow = '';
  let timelineCues = [];
  let displayCues = [];
  let timelineVideoId;
  let boundVideoId;
  let videoListeners;
  let renderedSource = '';
  let captionRequest;
  let captionState = '已关闭';
  let captionError = '';
  const failures = new Map();
  const prefetchPending = new Set();
  let savedPosition;
  try { savedPosition = JSON.parse(localStorage.getItem('ytzhSubtitlePosition')); } catch (_) {}
  document.documentElement.classList.add('ytzh-disabled');

  chrome.storage.local.get({ translationEngine: 'chrome' }).then(config => {
    translationEngine = config.translationEngine;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!['translationEngine', 'doubaoModel', 'doubaoDomain', 'doubaoProtectedTerms', 'doubaoApiKey'].some(key => changes[key])) return;
    if (changes.translationEngine) translationEngine = changes.translationEngine.newValue || 'chrome';
    translations.clear();
    failures.clear();
    prefetchPending.clear();
    updateVersion++;
    prefetchGeneration++;
    prefetching = false;
    prefetchedWindow = '';
    currentSource = '';
    if (enabled) updateCaption();
  });

  function notify(message) {
    document.querySelector('.ytzh-notice')?.remove();
    const notice = document.createElement('div');
    notice.className = 'ytzh-notice';
    notice.textContent = message;
    document.body.append(notice);
    setTimeout(() => notice.remove(), 5000);
  }

  function normalizeLanguage(language = '') {
    const code = language.toLowerCase().split('-')[0];
    return code === 'he' ? 'iw' : code;
  }

  async function detectLanguage(text) {
    if (!('LanguageDetector' in self)) throw new Error('当前 Chrome 不支持自动语言识别');
    detectorPromise ??= LanguageDetector.create();
    const results = await (await detectorPromise).detect(text);
    return normalizeLanguage(results[0]?.detectedLanguage);
  }

  async function getTranslator(sourceLanguage) {
    if (!('Translator' in self)) throw new Error('请升级到最新版桌面版 Chrome');
    const options = { sourceLanguage, targetLanguage: 'zh' };
    if (await Translator.availability(options) === 'unavailable') {
      throw new Error(`当前设备不支持 ${sourceLanguage} → 中文翻译`);
    }
    return Translator.create(options);
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

  function subtitleScope(cue) {
    return translationEngine === 'doubao' && cue ? `subtitle-v2:${timelineVideoId}:${cue.start}` : '';
  }

  function translationId(text, cue) {
    const scope = subtitleScope(cue);
    return scope ? `${scope}\n${text}` : text;
  }

  function translate(text, purpose = 'subtitle', cue) {
    const key = translationId(text, cue);
    const scope = subtitleScope(cue);
    if (purpose === 'subtitle' && prefetchPending.has(key)) {
      chrome.runtime.sendMessage({ type: 'promote-translation', text, scope }).catch(() => {});
    }
    if (!translations.has(key)) {
      const request = (async () => {
        if (translationEngine !== 'chrome') {
          const context = scope ? precedingContext(displayCues, displayCues.findIndex(item => item.start === cue.start && item.text === cue.text)) : [];
          const result = await chrome.runtime.sendMessage({ type: 'translate', text, purpose, scope, context });
          if (!result?.ok) throw new Error(result?.error || '云翻译失败');
          return result.text;
        }
        const sourceLanguage = await detectLanguage(text);
        if (!sourceLanguage || sourceLanguage === 'zh') return null;
        if (!translators.has(sourceLanguage)) translators.set(sourceLanguage, getTranslator(sourceLanguage));
        const translator = await translators.get(sourceLanguage);
        return translateWithRetry(translator, text);
      })().catch(error => {
        if (translations.get(key) === request) translations.delete(key);
        translators.clear();
        detectorPromise = undefined;
        throw error;
      });
      translations.set(key, request);
    }
    return translations.get(key);
  }

  function activePlayer() {
    const players = [...document.querySelectorAll('.html5-video-player')];
    if (!location.pathname.startsWith('/shorts/')) return players[0] || null;
    return players.map(player => {
      const rect = player.getBoundingClientRect();
      const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      return { player, area: width * height };
    }).sort((a, b) => b.area - a.area).find(item => item.area > 0)?.player || null;
  }

  function hideOverlays() {
    renderedSource = '';
    document.querySelectorAll('.ytzh-overlay').forEach(box => box.classList.remove('ytzh-visible'));
    document.querySelectorAll('.html5-video-player.ytzh-ready').forEach(player => player.classList.remove('ytzh-ready'));
    document.documentElement.classList.remove('ytzh-ready');
  }

  function overlay() {
    if (!enabled) return null;
    const player = activePlayer();
    if (!player) return null;
    let box = player.querySelector(':scope > .ytzh-overlay');
    if (!box) {
      box = document.createElement('div');
      box.className = 'ytzh-overlay';
      box.innerHTML = '<div class="ytzh-chinese ytzh-current"></div><div class="ytzh-english"></div>';
      player.append(box);
      makeDraggable(box, player);
      if (Number.isFinite(savedPosition?.x) && Number.isFinite(savedPosition?.y)) {
        positionOverlay(box, savedPosition.x, savedPosition.y);
      }
    }
    return box;
  }

  function positionOverlay(box, x, y) {
    box.classList.add('ytzh-positioned');
    box.style.left = `${x}%`;
    box.style.top = `${y}%`;
  }

  function makeDraggable(box, player) {
    box.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const playerRect = player.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const offsetX = event.clientX - (boxRect.left + boxRect.width / 2);
      const offsetY = event.clientY - (boxRect.top + boxRect.height / 2);
      box.setPointerCapture(event.pointerId);
      box.classList.add('ytzh-dragging');
      const move = moveEvent => {
        const halfX = boxRect.width / 2;
        const halfY = boxRect.height / 2;
        const centerX = Math.max(halfX, Math.min(playerRect.width - halfX, moveEvent.clientX - playerRect.left - offsetX));
        const centerY = Math.max(halfY, Math.min(playerRect.height - halfY, moveEvent.clientY - playerRect.top - offsetY));
        positionOverlay(box, centerX / playerRect.width * 100, centerY / playerRect.height * 100);
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', () => {
        box.removeEventListener('pointermove', move);
        box.classList.remove('ytzh-dragging');
        localStorage.setItem('ytzhSubtitlePosition', JSON.stringify({ x: parseFloat(box.style.left), y: parseFloat(box.style.top) }));
      }, { once: true });
    });
    box.addEventListener('dblclick', () => {
      localStorage.removeItem('ytzhSubtitlePosition');
      box.classList.remove('ytzh-positioned');
      box.style.left = '';
      box.style.top = '';
    });
  }

  function render(source, translated) {
    const box = overlay();
    if (!box) return;
    box.querySelector('.ytzh-current').textContent = translated;
    const english = box.querySelector('.ytzh-english');
    english.textContent = source;
    english.style.fontSize = '';
    box.classList.add('ytzh-visible');
    while (english.scrollWidth > box.clientWidth && parseFloat(getComputedStyle(english).fontSize) > 10) {
      english.style.fontSize = `${parseFloat(getComputedStyle(english).fontSize) - 1}px`;
    }
    box.parentElement.classList.add('ytzh-ready');
  }

  function nativeCaption() {
    return [...(activePlayer()?.querySelectorAll('.ytp-caption-segment') || [])]
      .map(segment => segment.textContent.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function precedingContext(cues, index) {
    const context = [];
    for (let offset = index - 1; offset >= 0 && context.length < 2; offset--) {
      if (cues[offset + 1].start - cues[offset].end > 5000) break;
      context.unshift(cues[offset].text);
    }
    return context;
  }

  function subtitleInputSize(texts) {
    const source = texts.map((text, index) => `<CUE_${index}>${text}</CUE_${index}>`).join('\n');
    return new TextEncoder().encode(source).byteLength;
  }

  function planSubtitleBatches(cues, from = 0, until = Infinity) {
    const batches = [];
    // ponytail: 900 UTF-8 bytes is a conservative input budget, not exact model tokenization.
    while (from >= 0 && from < cues.length && cues[from].start <= until) {
      const context = precedingContext(cues, from);
      while (context.length && subtitleInputSize([...context, cues[from].text]) > 900) context.shift();
      let end = from;
      let sentenceEnd = from;
      while (end < cues.length && cues[end].start <= until && end - from < 20) {
        if (end > from && cues[end].start - cues[end - 1].end > 5000) break;
        if (end > from && subtitleInputSize([...context, ...cues.slice(from, end + 1).map(cue => cue.text)]) > 900) break;
        end++;
        if (/[.!?。！？]["'”’）)\]]*$/.test(cues[end - 1].text)) sentenceEnd = end;
      }
      const limited = end < cues.length && cues[end].start <= until
        && cues[end].start - cues[end - 1].end <= 5000;
      if (limited && sentenceEnd > from) end = sentenceEnd;
      batches.push({ cues: cues.slice(from, end), context });
      from = end;
    }
    return batches;
  }

  function loadTimeline() {
    const expectedVideoId = new URL(location.href).searchParams.get('v')
      || location.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
    if (timelineCues.length && timelineVideoId === expectedVideoId) return true;
    timelineCues = [];
    displayCues = [];
    try {
      const payload = JSON.parse(document.documentElement.dataset.ytzhTimeline || 'null');
      if (expectedVideoId && payload?.videoId !== expectedVideoId) return false;
      if (payload?.languageCode?.toLowerCase().startsWith('zh')) return false;
      timelineCues = (payload?.data?.events || [])
        .filter(event => event.segs?.length)
        .map(event => ({
          start: Number(event.tStartMs),
          end: Number(event.tStartMs) + Number(event.dDurationMs || 0),
          text: event.segs.map(segment => segment.utf8 || '').join('').replace(/\s+/g, ' ').trim()
        }))
        .filter(cue => Number.isFinite(cue.start) && cue.text);
      timelineVideoId = expectedVideoId;
      timelineCues.forEach((cue, index) => {
        if (cue.end <= cue.start) {
          const end = timelineCues[index + 1]?.start ?? boundVideo?.duration * 1000;
          cue.end = Number.isFinite(end) ? end : cue.start;
        }
      });
      displayCues = [];
      for (let index = 0; index < timelineCues.length;) {
        const current = timelineCues[index];
        const next = timelineCues[index + 1];
        if (next && current.end >= next.start && current.text.length + next.text.length <= 100) {
          displayCues.push({ ...current, end: next.end, text: `${current.text} ${next.text}` });
          index += 2;
        } else {
          displayCues.push(current);
          index++;
        }
      }
    } catch (_) {}
    return timelineCues.length > 0;
  }

  async function updateTimelineCaption() {
    if (!enabled || !boundVideo || !loadTimeline()) return false;
    const now = boundVideo.currentTime * 1000;
    let cue;
    for (let index = displayCues.length - 1; index >= 0; index--) {
      if (displayCues[index].start <= now) {
        const nextStart = displayCues[index + 1]?.start ?? Infinity;
        if (now < Math.min(displayCues[index].end, nextStart)) cue = displayCues[index];
        break;
      }
    }
    if (!cue) {
      if (currentSource) updateVersion++;
      currentSource = '';
      hideOverlays();
      captionState = '已读取时间轴，当前无字幕';
      captionError = '';
      return true;
    }
    await showCaption(cue.text, cue);
    return true;
  }

  async function updateCaption() {
    if (!enabled) return;
    if (await updateTimelineCaption()) return;
    const source = nativeCaption();
    if (!source) {
      if (currentSource) updateVersion++;
      currentSource = '';
      hideOverlays();
      captionState = '等待原字幕';
      captionError = '';
      return;
    }
    await showCaption(source);
  }

  async function showCaption(source, cue) {
    const key = translationId(source, cue);
    const scope = subtitleScope(cue);
    if (source !== currentSource || scope !== currentScope) {
      currentSource = source;
      currentScope = scope;
      updateVersion++;
      hideOverlays();
      captionError = '';
    }
    const version = updateVersion;
    if (source === renderedSource || (captionRequest?.source === source && captionRequest.version === version)) return;
    const failed = failures.get(key);
    if (!translations.has(key) && failed && (failed.count >= 3 || Date.now() < failed.retryAt)) return;
    const request = { source, version };
    captionRequest = request;
    captionState = '翻译字幕正在生成';
    const pendingTimer = setTimeout(() => {
      if (enabled && version === updateVersion && source === currentSource) {
        render(source, '翻译字幕正在生成…');
      }
    }, 1000);
    try {
      const pending = translate(source, 'subtitle', cue);
      pretranslateAhead();
      const translated = await pending;
      if (enabled && version === updateVersion && source === currentSource) {
        if (translated) render(source, translated);
        else hideOverlays();
        renderedSource = source;
        failures.delete(key);
        captionError = '';
        captionState = translated ? (timelineCues.length ? '已读取时间轴' : '跟随原字幕') : '原字幕无需翻译';
      }
    } catch (error) {
      if (version === updateVersion) {
        hideOverlays();
        const count = (failed?.count || 0) + 1;
        failures.set(key, { count, retryAt: Date.now() + count * 1000 });
        captionState = count < 3 ? '翻译失败，稍后自动重试' : '翻译失败，请检查设置后重新开启';
        captionError = String(error.message || error);
      }
    } finally {
      clearTimeout(pendingTimer);
      if (captionRequest === request) captionRequest = undefined;
    }
  }

  async function pretranslateAhead() {
    const video = activePlayer()?.querySelector('video');
    if (!enabled || !video || prefetching) return;
    const videoId = new URL(location.href).searchParams.get('v')
      || location.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
    const start = video.currentTime * 1000;
    const windowKey = `${videoId}:${Math.floor(start / 60000)}`;
    if (windowKey === prefetchedWindow) return;
    const generation = prefetchGeneration;
    prefetching = true;
    try {
      let payload;
      for (let attempt = 0; attempt < 20 && generation === prefetchGeneration; attempt++) {
        const raw = document.documentElement.dataset.ytzhTimeline;
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (!videoId || parsed.videoId === videoId) payload = parsed;
          } catch (_) {}
        }
        if (!payload) {
          const rawTrack = document.documentElement.dataset.ytzhCaptionTrack;
          try {
            const track = rawTrack && JSON.parse(rawTrack);
            if (track && (!videoId || track.videoId === videoId)) {
              const result = await chrome.runtime.sendMessage({ type: 'download-caption', url: track.url });
              if (!enabled || generation !== prefetchGeneration) return;
              document.documentElement.dataset.ytzhTimelineStatus = result?.ok ? result.diagnostic : `失败：${result?.error || '未知错误'}`;
              if (result?.ok) {
                payload = { videoId: track.videoId, languageCode: track.languageCode, data: result.data };
                document.documentElement.dataset.ytzhTimeline = JSON.stringify(payload);
              }
            }
          } catch (_) {}
        }
        if (payload) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!payload || !enabled || generation !== prefetchGeneration) return;
      timelineCues = [];
      displayCues = [];
      loadTimeline();
      updateTimelineCaption();
      if (translationEngine === 'doubao') {
        const first = displayCues.findIndex(cue => cue.start >= start);
        for (const batch of planSubtitleBatches(displayCues, first, start + 5 * 60 * 1000)) {
          if (!enabled || generation !== prefetchGeneration) return;
          const entries = batch.cues.map((cue, offset) => ({ cue, offset, key: translationId(cue.text, cue) }));
          const missing = entries.filter(entry => !translations.has(entry.key));
          if (!missing.length) continue;
          const request = chrome.runtime.sendMessage({
            type: 'translate-batch', texts: batch.cues.map(cue => cue.text),
            scopes: batch.cues.map(subtitleScope), context: batch.context, purpose: 'prefetch'
          }).then(result => {
            if (!result?.ok || result.texts?.length !== batch.cues.length || result.texts.some(text => !text)) {
              throw new Error(result?.error || '豆包批量译文不完整');
            }
            return result.texts;
          });
          const waiting = missing.map(({ key, offset }) => {
            prefetchPending.add(key);
            const pending = request.then(results => results[offset]).catch(error => {
              if (translations.get(key) === pending) translations.delete(key);
              throw error;
            }).finally(() => {
              if (translations.get(key) === pending || !translations.has(key)) prefetchPending.delete(key);
            });
            translations.set(key, pending);
            return pending;
          });
          await Promise.all(waiting);
        }
        if (enabled && generation === prefetchGeneration) prefetchedWindow = windowKey;
        return;
      }
      const seen = new Set();
      const texts = displayCues
        .filter(cue => cue.start >= start && cue.start <= start + 5 * 60 * 1000)
        .filter(cue => cue.text && !seen.has(cue.text) && seen.add(cue.text))
        .map(cue => cue.text);
      for (const text of texts) {
        if (!enabled || generation !== prefetchGeneration) return;
        await translate(text, 'prefetch');
      }
      if (enabled && generation === prefetchGeneration) prefetchedWindow = windowKey;
    } catch (_) {
      // Optional preloading must never interrupt live subtitles.
    } finally {
      if (generation === prefetchGeneration) prefetching = false;
    }
  }

  function bindVideo() {
    const video = activePlayer()?.querySelector('video');
    const videoId = new URL(location.href).searchParams.get('v')
      || location.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
    if (video === boundVideo && videoId === boundVideoId) return;
    if (translationEngine === 'doubao') {
      translations.clear();
      prefetchPending.clear();
    }
    videoListeners?.abort();
    hideOverlays();
    updateVersion++;
    currentSource = '';
    failures.clear();
    captionError = '';
    captionState = enabled ? '等待原字幕' : '已关闭';
    timelineCues = [];
    displayCues = [];
    prefetchGeneration++;
    prefetching = false;
    prefetchedWindow = '';
    boundVideo = video;
    boundVideoId = videoId;
    clearInterval(timelineTimer);
    if (!video) return;
    videoListeners = new AbortController();
    timelineTimer = setInterval(() => {
      bindVideo();
      updateTimelineCaption().then(used => {
        if (!used && (location.pathname.startsWith('/shorts/') || captionState.startsWith('翻译失败'))) updateCaption();
      });
    }, 100);
    video.addEventListener('seeking', () => {
      if (video !== boundVideo) return;
      clearTimeout(updateTimer);
      updateVersion++;
      currentSource = '';
      failures.clear();
      captionError = '';
      prefetchGeneration++;
      prefetching = false;
      prefetchedWindow = '';
      hideOverlays();
    }, { signal: videoListeners.signal });
    video.addEventListener('seeked', () => {
      if (video !== boundVideo) return;
      if (enabled) setTimeout(() => updateTimelineCaption().then(used => { if (!used) updateCaption(); }), 80);
    }, { signal: videoListeners.signal });
  }

  new MutationObserver(() => {
    bindVideo();
    if (!enabled) return;
    if (loadTimeline()) return;
    clearTimeout(updateTimer);
    updateTimer = setTimeout(updateCaption, 500);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  document.addEventListener('yt-navigate-start', () => {
    clearTimeout(updateTimer);
    updateVersion++;
    prefetchGeneration++;
    prefetching = false;
    prefetchedWindow = '';
    currentSource = '';
    failures.clear();
    captionError = '';
    captionState = enabled ? '等待原字幕' : '已关闭';
    timelineCues = [];
    displayCues = [];
    hideOverlays();
  });

  document.addEventListener('yt-navigate-finish', () => {
    bindVideo();
    if (enabled) setTimeout(() => updateTimelineCaption().then(used => { if (!used) updateCaption(); }), 250);
  });

  function toggleSubtitles() {
    enabled = !enabled;
    updateVersion++;
    currentSource = '';
    failures.clear();
    captionError = '';
    captionState = enabled ? '等待原字幕' : '已关闭';
    timelineCues = [];
    displayCues = [];
    if (!enabled) {
      prefetchGeneration++;
      prefetching = false;
    }
    document.documentElement.classList.toggle('ytzh-disabled', !enabled);
    document.documentElement.classList.remove('ytzh-ready');
    hideOverlays();
    if (enabled) { bindVideo(); updateCaption(); }
    notify(enabled ? '视频字幕翻译已开启（Alt+A 关闭）' : '视频字幕翻译已关闭');
    return enabled;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'toggle-subtitles') sendResponse({ ok: true, enabled: toggleSubtitles() });
    if (message?.type === 'subtitles-state') sendResponse({ ok: true, enabled, state: captionState, error: captionError });
  });

  addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey || event.key.toLowerCase() !== 'a' || event.repeat) return;
    if (event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleSubtitles();
  }, true);
  bindVideo();
})();
