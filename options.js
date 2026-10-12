const engine = document.querySelector('#engine');
const fields = document.querySelector('#tencent-fields');
const doubaoFields = document.querySelector('#doubao-fields');
const secretId = document.querySelector('#secret-id');
const secretKey = document.querySelector('#secret-key');
const region = document.querySelector('#region');
const doubaoApiKey = document.querySelector('#doubao-api-key');
const doubaoModel = document.querySelector('#doubao-model');
const doubaoDomain = document.querySelector('#doubao-domain');
const doubaoProtectedTerms = document.querySelector('#doubao-protected-terms');
const status = document.querySelector('#status');
const subtitleButton = document.querySelector('#toggle-subtitles');
const webpageButton = document.querySelector('#toggle-webpage');
const subtitleState = document.querySelector('#subtitle-state');

async function refreshSubtitleState() {
  try {
    const result = await pageCommand('subtitles-state');
    if (!result?.ok) throw new Error('不支持字幕翻译');
    showToggle(subtitleButton, result.enabled, '字幕翻译');
    subtitleState.textContent = `字幕状态：${result.state || (result.enabled ? '已开启' : '已关闭')}${result.error ? `（${result.error}）` : ''}`;
  } catch (_) { subtitleState.textContent = '字幕翻译目前支持 YouTube，更新后请刷新页面'; }
}
refreshSubtitleState();
setInterval(refreshSubtitleState, 1000);

async function pageCommand(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('请先打开需要翻译的网页');
  try {
    return await chrome.tabs.sendMessage(tab.id, { type }, { frameId: 0 });
  } catch (_) {
    throw new Error('当前页面不支持此功能，或需要刷新网页后重试');
  }
}

function showToggle(button, enabled, label) {
  button.textContent = `${enabled ? '关闭' : '开启'}${label}`;
  button.setAttribute('aria-pressed', String(enabled));
}

for (const [button, feature, label] of [[subtitleButton, 'subtitles', '字幕翻译'], [webpageButton, 'webpage', '网页文字翻译']]) {
  pageCommand(`${feature}-state`).then(result => {
    if (result?.ok) showToggle(button, result.enabled, label);
  }).catch(() => {});
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await pageCommand(`toggle-${feature}`);
      if (!result?.ok) throw new Error(feature === 'subtitles' ? '字幕翻译目前支持 YouTube 视频页面' : '请刷新当前网页后重试');
      showToggle(button, result.enabled, label);
      status.textContent = `${label}已${result.enabled ? '开启' : '关闭'}`;
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  });
}

function showFields() {
  fields.hidden = engine.value !== 'tencent';
  doubaoFields.hidden = engine.value !== 'doubao';
}

async function save() {
  await chrome.storage.local.set({
    translationEngine: engine.value,
    tencentSecretId: secretId.value.trim(),
    tencentSecretKey: secretKey.value.trim(),
    tencentRegion: region.value.trim() || 'ap-guangzhou',
    doubaoApiKey: doubaoApiKey.value.trim(),
    doubaoModel: doubaoModel.value.trim() || 'doubao-seed-translation-250915',
    doubaoDomain: doubaoDomain.value,
    doubaoProtectedTerms: doubaoProtectedTerms.value.trim()
  });
  status.textContent = '已保存';
}

engine.addEventListener('change', showFields);
document.querySelector('#save').addEventListener('click', () => save().catch(showError));
document.querySelector('#test').addEventListener('click', async () => {
  try {
    status.textContent = '正在测试…';
    await save();
    if (engine.value === 'chrome') {
      status.textContent = 'Chrome 本地翻译无需测试';
      return;
    }
    const result = await chrome.runtime.sendMessage({ type: engine.value === 'doubao' ? 'test-doubao' : 'test-tencent' });
    if (!result?.ok) throw new Error(result?.error || '连接失败');
    status.textContent = result.batch
      ? `上下文翻译成功：${result.texts.join(' / ')}`
      : `连接成功：Hello → ${result.text}`;
  } catch (error) {
    showError(error);
  }
});

function showError(error) {
  status.textContent = `错误：${error.message || error}`;
}

chrome.storage.local.get({
  translationEngine: 'chrome',
  tencentSecretId: '',
  tencentSecretKey: '',
  tencentRegion: 'ap-guangzhou',
  doubaoApiKey: '',
  doubaoModel: 'doubao-seed-translation-250915',
  doubaoDomain: 'general',
  doubaoProtectedTerms: 'boondocker, boondockers'
}).then(config => {
  engine.value = config.translationEngine;
  secretId.value = config.tencentSecretId;
  secretKey.value = config.tencentSecretKey;
  region.value = config.tencentRegion;
  doubaoApiKey.value = config.doubaoApiKey;
  doubaoModel.value = config.doubaoModel;
  doubaoDomain.value = config.doubaoDomain;
  doubaoProtectedTerms.value = config.doubaoProtectedTerms;
  showFields();
});
