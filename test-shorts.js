const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function player(top, text) {
  const classes = new Set(['ytzh-ready']);
  return {
    classes,
    classList: { remove: name => classes.delete(name) },
    getBoundingClientRect: () => ({ left: 0, right: 400, top, bottom: top + 600 }),
    querySelectorAll: () => [{ textContent: text }]
  };
}
const hidden = player(-700, 'Old short');
const visible = player(0, 'Current short');
const players = [hidden, visible];
const context = {
  URL, location: new URL('https://www.youtube.com/shorts/current'),
  innerWidth: 1000, innerHeight: 700,
  localStorage: { getItem: () => null },
  chrome: {
    storage: { local: { get: async defaults => defaults }, onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } }
  },
  MutationObserver: class { observe() {} },
  addEventListener() {}, setInterval() {}, clearInterval() {}, clearTimeout() {},
  document: {
    documentElement: { classList: { add() {}, remove() {} } },
    querySelectorAll: selector => selector === '.ytzh-overlay' ? [] : players,
    addEventListener() {}
  }
};
// Expose only the existing functions for this DOM regression check.
const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8')
  .replace('  bindVideo();\n})();', '  globalThis.check = { activePlayer, nativeCaption, hideOverlays };\n})();');
vm.runInNewContext(source, context);
assert.equal(context.check.activePlayer(), visible, 'Ignore the off-screen Shorts player');
assert.equal(context.check.nativeCaption(), 'Current short', 'Read only the active player captions');
context.check.hideOverlays();
assert.equal(hidden.classes.has('ytzh-ready'), false);
assert.equal(visible.classes.has('ytzh-ready'), false, 'Restore native captions when hiding the overlay');
hidden.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 600 });
visible.getBoundingClientRect = () => ({ left: 0, right: 400, top: 800, bottom: 1400 });
assert.equal(context.check.activePlayer(), hidden, 'Follow Shorts scrolling to a different player');
context.location = new URL('https://www.youtube.com/watch?v=normal');
assert.equal(context.check.activePlayer(), hidden, 'Preserve normal video selection');
const css = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
assert.ok(css.includes('.html5-video-player.ytzh-ready:has(> .ytzh-overlay.ytzh-visible)'), 'Never hide captions globally');
console.log('Shorts player selection and native-caption fallback passed');
