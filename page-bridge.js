(() => {
  let run = 0;

  function capture(url, body) {
    if (!String(url).includes('/api/timedtext') || !body) return;
    let captionUrl;
    try { captionUrl = new URL(url, location.href); } catch (_) { return; }
    const captionVideoId = captionUrl.searchParams.get('v');
    if (captionVideoId && captionVideoId !== videoId()) return;
    if ([captionUrl.searchParams.get('lang'), captionUrl.searchParams.get('tlang')]
      .some(language => language?.toLowerCase().startsWith('zh'))) return;
    const data = parseCaption(body);
    if (!data?.events?.length) return;
    const languageCode = captionUrl.searchParams.get('lang') || '';
    document.documentElement.dataset.ytzhTimeline = JSON.stringify({ videoId: videoId(), languageCode, data });
    document.documentElement.dataset.ytzhPageDownloadStatus = `播放器响应，${body.length} 字节，${data.events.length} 条`;
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.ytzhUrl = String(url);
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    if (this.ytzhUrl?.includes('/api/timedtext')) {
      this.addEventListener('load', () => {
        try { capture(this.ytzhUrl, this.responseText); } catch (_) {}
      }, { once: true });
    }
    return nativeSend.apply(this, args);
  };

  if (typeof window.fetch === 'function') {
    const nativeFetch = window.fetch;
    window.fetch = async function(input, init) {
      const response = await nativeFetch.call(this, input, init);
      const url = typeof input === 'string' ? input : input?.url;
      if (String(url).includes('/api/timedtext')) {
        response.clone().text().then(body => capture(url, body)).catch(() => {});
      }
      return response;
    };
  }

  function videoId() {
    return new URL(location.href).searchParams.get('v') || location.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
  }

  function embeddedPlayerResponse() {
    for (const script of document.scripts || []) {
      const text = script.textContent || '';
      const marker = 'var ytInitialPlayerResponse = ';
      const markerAt = text.indexOf(marker);
      if (markerAt < 0) continue;
      const start = text.indexOf('{', markerAt + marker.length);
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index >= 0 && index < text.length; index++) {
        const character = text[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === '{') depth++;
        else if (character === '}' && --depth === 0) {
          try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { break; }
        }
      }
    }
  }

  function download(url) {
    return new Promise(resolve => {
      const request = new XMLHttpRequest();
      request.open('GET', url, true);
      request.withCredentials = true;
      request.timeout = 10000;
      request.onload = () => resolve({ status: request.status, body: request.responseText || '' });
      request.onerror = () => resolve({ status: 0, body: '' });
      request.ontimeout = () => resolve({ status: 0, body: '' });
      request.send();
    });
  }

  function parseCaption(body) {
    try { return JSON.parse(body); } catch (_) {}
    const document = new DOMParser().parseFromString(body, 'text/xml');
    const events = [...document.querySelectorAll('text, p')].map(node => {
      const seconds = Number(node.getAttribute('start') ?? node.getAttribute('t') / 1000);
      const duration = Number(node.getAttribute('dur') ?? node.getAttribute('d') / 1000);
      return {
        tStartMs: Math.round(seconds * 1000),
        dDurationMs: Math.round(duration * 1000),
        segs: [{ utf8: node.textContent || '' }]
      };
    }).filter(event => event.segs[0].utf8.trim());
    return events.length ? { events } : null;
  }

  async function publishTimeline() {
    const expectedId = videoId();
    let currentResponse;
    try {
      for (const player of document.querySelectorAll('.html5-video-player, ytd-player')) {
        const response = player.getPlayerResponse?.();
        if (response?.videoDetails?.videoId === expectedId) { currentResponse = response; break; }
      }
    } catch (_) {}
    for (let response of [
      currentResponse,
      window.ytInitialPlayerResponse,
      window.ytplayer?.config?.args?.player_response,
      window.ytplayer?.config?.args?.raw_player_response,
      embeddedPlayerResponse()
    ]) {
      if (typeof response === 'string') {
        try {
          response = JSON.parse(response);
        } catch (_) {
          continue;
        }
      }
      if (!response || (expectedId && response.videoDetails?.videoId !== expectedId)) continue;
      const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const foreign = tracks.filter(track => !track.languageCode?.toLowerCase().startsWith('zh'));
      const track = foreign.find(item => !item.kind) || foreign[0];
      if (!track) continue;
      const originalUrl = new URL(track.baseUrl);
      const jsonUrl = new URL(track.baseUrl);
      jsonUrl.searchParams.set('fmt', 'json3');
      document.documentElement.dataset.ytzhCaptionTrack = JSON.stringify({
        videoId: expectedId,
        languageCode: track.languageCode,
        url: originalUrl.href
      });
      let downloaded = await download(originalUrl.href);
      let data = downloaded.body && parseCaption(downloaded.body);
      if (!data) {
        downloaded = await download(jsonUrl.href);
        data = downloaded.body && parseCaption(downloaded.body);
      }
      document.documentElement.dataset.ytzhPageDownloadStatus = `HTTP ${downloaded.status}，${downloaded.body.length} 字节`;
      if (expectedId !== videoId()) return false;
      if (data) {
        document.documentElement.dataset.ytzhTimeline = JSON.stringify({
          videoId: expectedId,
          languageCode: track.languageCode,
          data
        });
      }
      return true;
    }
    return false;
  }

  async function publishSoon() {
    const thisRun = ++run;
    for (let attempt = 0; attempt < 240 && thisRun === run; attempt++) {
      if (await publishTimeline()) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  document.addEventListener('yt-navigate-start', () => {
    run++;
    delete document.documentElement.dataset.ytzhTimeline;
    delete document.documentElement.dataset.ytzhCaptionTrack;
    delete document.documentElement.dataset.ytzhTimelineStatus;
  });
  document.addEventListener('yt-navigate-finish', publishSoon);
  publishSoon();
})();
