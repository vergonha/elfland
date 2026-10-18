const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WatchPage = vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../public/js/pages/WatchPage.js'), 'utf8') + '\nWatchPage;',
    { console: { log() {}, warn() {}, error() {} }, encodeURIComponent, document: {}, window: {} }
);

function page({ readyState = 0, code = 4, generation = 3 } = {}) {
    const video = { src: '', readyState, error: { code, message: 'x' }, play: () => Promise.resolve() };
    const p = Object.create(WatchPage.prototype);
    Object.assign(p, { video, playbackGeneration: generation, status: [], updateTranscodeStatus(mode, text) { this.status.push(text); } });
    return p;
}

test('a file the browser cannot load directly is retried once through the proxy', () => {
    const url = 'http://cdn.example/movie.mp4?token=a&b';
    const p = page();
    p.playFile(url, false, 3);
    assert.equal(p.video.src, url, 'plays directly first');

    p.onError({});
    assert.equal(p.video.src, `/api/proxy/stream?url=${encodeURIComponent(url)}`);
    assert.deepEqual(p.status, ['Direct Play (via proxy)']);
    assert.equal(p.directFallback, null);

    p.video.src = 'unchanged';
    p.onError({});
    assert.equal(p.video.src, 'unchanged', 'only once: no retry loop when the proxy fails too');
});

test('the fallback only triggers for a first-load failure of the same playback', () => {
    const url = 'http://cdn.example/movie.mp4';
    const retried = p => p.video.src.startsWith('/api/proxy/');

    let p = page({ code: 2 });
    p.playFile(url, false, 3); p.onError({});
    assert.ok(retried(p), 'a network error counts');

    p = page({ code: 3 });
    p.playFile(url, false, 3); p.onError({});
    assert.ok(!retried(p), 'a decode error is not a connection problem: the proxy would not help');

    p = page({ readyState: 2 });
    p.playFile(url, false, 3); p.onError({});
    assert.ok(!retried(p), 'an error after the video loaded is not retried: position would be lost');

    p = page();
    p.playFile(url, false, 3); p.playbackGeneration = 4; p.onError({});
    assert.ok(!retried(p), 'an error from a previous playback is ignored');

    p = page();
    p.playFile(url, true, 3);
    assert.equal(p.video.src, `/api/proxy/stream?url=${encodeURIComponent(url)}`, 'force proxy still goes straight to the proxy');
    p.video.src = 'unchanged'; p.onError({});
    assert.equal(p.video.src, 'unchanged', 'already proxied: nothing to fall back to');
});
