const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const keys = [];
const messages = [];
const classes = new Set();
const context = {
  console,
  URL,
  location: new URL('https://www.youtube.com/watch?v=test'),
  localStorage: { getItem: () => null },
  setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  MutationObserver: class { observe() {} },
  addEventListener(type, listener) { if (type === 'keydown') keys.push(listener); },
  chrome: {
    storage: { local: { get: async defaults => defaults }, onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener: listener => messages.push(listener) } }
  },
  document: {
    documentElement: { dataset: {}, append() {}, classList: {
      add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }
    } },
    body: { append() {} },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    createElement: () => ({ remove() {}, classList: { add() {} } })
  }
};
context.self = context;
vm.createContext(context);
for (const file of ['webpage.js', 'content.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
}
function send(type) {
  let reply;
  messages.forEach(listener => listener({ type }, {}, value => { reply = value; }));
  return reply;
}
function press(key, extra = {}) {
  const event = { key, altKey: true, target: { closest: () => null }, preventDefault() {}, stopImmediatePropagation() {}, ...extra };
  keys.forEach(listener => listener(event));
}
assert.equal(send('webpage-state').enabled, false);
assert.equal(send('subtitles-state').enabled, false);
press('a');
assert.equal(send('subtitles-state').enabled, true);
assert.equal(send('webpage-state').enabled, false, 'Alt+A must not enable page translation');
press('w');
assert.equal(send('webpage-state').enabled, true);
assert.equal(send('subtitles-state').enabled, true);
press('a');
assert.equal(send('subtitles-state').enabled, false);
assert.equal(send('webpage-state').enabled, true, 'Closing subtitles must not close page translation');
press('w', { repeat: true });
press('w', { ctrlKey: true });
press('w', { target: { closest: () => ({}) } });
assert.equal(send('webpage-state').enabled, true, 'Repeated keys, other modifiers and input fields must be ignored');
assert.equal(send('toggle-webpage').enabled, false);
assert.equal(send('toggle-subtitles').enabled, true);
assert.equal(send('webpage-state').enabled, false, 'Popup subtitle button must not enable page translation');
assert.equal(send('toggle-subtitles').enabled, false);
console.log('Independent subtitle/page controls passed');
