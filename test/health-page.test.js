const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Minimal DOM: enough for the page to build its markup and for us to read it back.
function load() {
    const elements = {};
    const element = id => elements[id] ||= {
        id, innerHTML: '', textContent: '', style: {}, dataset: {},
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, scrollIntoView() {}, querySelectorAll: () => [], querySelector: () => null, disabled: false
    };
    const document = {
        getElementById: element, querySelectorAll: () => [],
        createElement: () => ({ set textContent(v) { this._t = String(v); }, get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); } })
    };
    const context = vm.createContext({ document, API: { channelHealth: {} }, CSS: { escape: v => v }, navigator: {}, console, Date, Math, JSON, Object, Number, setTimeout, clearTimeout, setInterval, clearInterval });
    const Page = vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/HealthPage.js'), 'utf8') + '\nHealthPage;', context);
    return { page: new Page({}), elements, context };
}

const channel = (over = {}) => ({ name: 'Canal <b>X</b>', source_id: 1, item_id: '9', status: 'online', latency_ms: 120, error: null, checked_at: Date.now() - 60000, auto_hidden: 0, debug: null, ...over });

test('dashboard renders counts, filters and escapes channel names', () => {
    const { page, elements } = load();
    page.data = {
        running: false, lastRun: Date.now() - 600000, nextRun: Date.now() + 5400000, intervalMin: 120,
        summary: { total: 3, durationMs: 90000, failedFirstPass: 2, recoveredOnRecheck: 1, failedFinal: 1, failureRate: 0.33, suspect: true,
            hidden: 1, restored: 0, finalErrors: { timeout: 1 }, hosts: { 'a.example': { ok: 1, fail: 1 } }, config: { perSourceConcurrency: 2, timeoutMs: 20000, node: 'v20' } },
        channels: [channel(), channel({ name: 'Down', item_id: '2', status: 'offline', error: 'timeout', auto_hidden: 1, debug: [{ hops: [], error: 'timeout', totalMs: 20000 }] }),
            channel({ name: 'Flaky', item_id: '3', debug: [{ hops: [], totalMs: 5000 }] })]
    };
    page.render();
    assert.match(elements['health-cards'].innerHTML, /num">1<\/div><div class="lbl">hidden by the monitor/);
    assert.match(elements['health-schedule'].textContent, /next run in 1h 30m/);
    assert.match(elements['health-rows'].innerHTML, /Canal &lt;b&gt;X&lt;\/b&gt;/);
    assert.ok(!elements['health-rows'].innerHTML.includes('<b>'));
    assert.match(elements['health-stats'].textContent, /a\.example 1\/2/);

    page.filter = 'offline';
    page.renderRows();
    assert.match(elements['health-rows'].innerHTML, /offline · hidden/);
    assert.ok(!elements['health-rows'].innerHTML.includes('Flaky'));
    page.filter = 'all'; page.query = 'flak';
    page.renderRows();
    assert.match(elements['health-rows'].innerHTML, /flaky/);
});

test('diagnosis renders verdict, findings, metrics, timeline and the raw json', () => {
    const { page } = load();
    const html = page.renderDiagnosis({
        kind: 'live', verdict: 'bad', url: 'http://h/live/<user>/<pass>/1.m3u8', account: { status: 'Active', active_cons: 1, max_connections: '1', exp_date: '1794452399' },
        findings: [{ level: 'bad', code: 'stalled', title: 'the playlist is frozen', detail: 'same sequence' }],
        metrics: [{ label: 'playlist response', value: '0.3s' }],
        timeline: [{ label: 'try 1', ok: false, totalMs: 20000, error: 'timeout', hops: [{ host: 'a', ms: 300, status: 302 }, { host: 'b', ms: 19700 }] }]
    });
    for (const expected of ['verdict bad', 'broken', 'the playlist is frozen', '0.3s', '1 of 1', 'class="fail"', 'class="redirect"', 'raw data']) assert.ok(html.includes(expected), expected);
    assert.ok(!html.includes('<user>'), 'url is escaped');
});

test('series checklist: selecting a season, running one at a time, stopping and the summary', async () => {
    const { page, elements, context } = load();
    const outline = { name: 'Show', source_id: 1, series_id: '7', seasons: [
        { season: 1, episodes: [{ id: '101', number: 1, title: 'Pilot' }, { id: '102', number: 2, title: 'Second <i>' }] },
        { season: 2, episodes: [{ id: '201', number: 1, title: 'Back' }] }] };
    const calls = [];
    context.API.channelHealth.seriesEpisodes = async () => outline;
    context.API.channelHealth.diagnose = async (type, sourceId, id, seriesId) => {
        calls.push([type, sourceId, id, seriesId]);
        const verdict = id === '102' ? 'bad' : 'ok';
        if (id === '201') throw new Error('boom');
        return { verdict, item: { item_id: id, name: id }, findings: [{ level: verdict, title: verdict === 'bad' ? 'file is empty' : 'fine' }] };
    };

    await page.openSeries(1, '7', 'Show');
    assert.match(elements['series-seasons'].innerHTML, /season 1/);
    assert.match(elements['series-seasons'].innerHTML, /Second &lt;i&gt;/);
    assert.equal(elements['series-run'].disabled, true, 'nothing selected yet');

    page.checklistChange({ target: { dataset: { seasonCheck: '1' }, checked: true } });
    assert.equal(elements['series-run'].textContent, 'Test selected (2)');
    page.checklistChange({ target: { dataset: { ep: '201' }, checked: true } });
    assert.equal(elements['series-run'].textContent, 'Test selected (3)');
    page.checklistChange({ target: { dataset: { seasonCheck: '1' }, checked: false } });
    assert.equal(elements['series-run'].textContent, 'Test selected (1)', 'unticking a season clears only its episodes');

    page.selectEpisodes(() => true);
    await page.runChecklist();
    assert.deepEqual(calls.map(c => c[2]), ['101', '102', '201'], 'one at a time, in season order');
    assert.deepEqual(calls[0], ['episode', 1, '101', '7']);
    assert.equal(elements['series-progress'].textContent, 'tested 3: 1 healthy, 0 with issues, 1 broken, 1 failed to run');
    assert.match(page.verdictPill(page.series.results.get('102')), /broken.*file is empty/);
    assert.match(page.verdictPill(page.series.results.get('201')), /failed.*boom/);

    calls.length = 0;
    page.series.results.clear();
    const slow = context.API.channelHealth.diagnose;
    context.API.channelHealth.diagnose = async (...args) => { page.series.stop = true; return slow(...args); };
    await page.runChecklist();
    assert.equal(calls.length, 1, 'stop lets the running episode finish and skips the rest');
    assert.match(elements['series-progress'].textContent, /^stopped after 1/);
});

test('browser test: what the viewer sees, and the conclusion drawn against the server probe', () => {
    const { page } = load();
    const ok = { verdict: 'ok', findings: [], playback: { forceProxy: false } };
    const blocked = { verdict: 'warn', findings: [{ code: 'cdn_blocked' }], playback: { forceProxy: false } };
    const blockedForced = { ...blocked, playback: { forceProxy: true } };
    const good = { path: 'direct', metadataMs: 900, playing: true, startMs: 1200, stalls: 0, stallMs: 0, advancedSec: 7.9, fillRate: 1.1, bufferAheadSec: 25,
        width: 1920, height: 1080, host: 'cdn.example', env: {}, seekOk: true, seekMs: 600, seekPlayedSec: 2.9 };
    const levels = r => r.findings.map(f => f.level + ':' + f.title).join(' | ');

    // a healthy browser plus a blocked server: viewers are fine unless force proxy routes them through the server
    let result = page.analyzeBrowserProbe(good, blocked);
    assert.equal(result.conclusion.level, 'ok');
    assert.match(result.conclusion.title, /viewers are fine: only the server is blocked/);
    assert.match(levels(result), /ok:the connection is far ahead of playback/, 'a big buffer lead proves a fast connection even if the fill rate is low');
    assert.match(levels(result), /ok:seeking works/);
    assert.equal(page.analyzeBrowserProbe(good, blockedForced).conclusion.level, 'bad');
    assert.match(page.analyzeBrowserProbe(good, blockedForced).conclusion.title, /force proxy/);
    assert.equal(page.analyzeBrowserProbe(good, ok).conclusion.title, 'healthy end to end');
    assert.match(page.analyzeBrowserProbe({ ...good, path: 'proxy', live: true, engine: 'hls.js' }, blocked).conclusion.detail, /through the proxy/);

    // stalls during playback; the wait caused by a seek is not counted by the probe, so a clean sample has none
    result = page.analyzeBrowserProbe({ ...good, stalls: 2, stallMs: 900 }, ok);
    assert.match(levels(result), /warn:playback stalled 2 times/);
    assert.equal(result.conclusion.level, 'warn');

    // too slow: little buffer and a fill rate under realtime
    const slow = { ...good, advancedSec: 2.1, fillRate: 0.43, bufferAheadSec: 2.3, seekOk: false };
    result = page.analyzeBrowserProbe(slow, ok);
    assert.match(levels(result), /bad:playback barely moved/);
    assert.match(levels(result), /bad:downloading slower than playback/);
    assert.match(levels(result), /warn:seeking did not complete/, 'a failed seek on a slow link is not blamed on the host');
    assert.equal(result.conclusion.level, 'bad');
    assert.match(result.conclusion.title, /barely plays/);
    assert.match(page.analyzeBrowserProbe(slow, blocked).conclusion.detail, /server is blocked, so it cannot compare/);
    assert.match(levels(page.analyzeBrowserProbe({ ...good, bufferAheadSec: 25, seekOk: false }, ok)), /bad:seeking did not complete/, 'a failed seek with healthy playback does point at the host');

    // load failures and what the reachability check adds
    result = page.analyzeBrowserProbe({ host: 'cdn.example', env: {}, stalls: 0, errorCode: 4, reachable: true }, ok);
    assert.match(levels(result), /bad:this browser could not play it/);
    assert.match(levels(result), /info:the address is reachable/);
    assert.match(result.conclusion.title, /works from the server, fails in this browser/);
    result = page.analyzeBrowserProbe({ host: 'cdn.example', env: { mixedContent: true }, stalls: 0, errorCode: 4, reachable: false }, ok);
    assert.match(levels(result), /warn:the address is not reachable/);
    assert.match(result.findings.at(-1).detail, /mixed content/);
    assert.match(page.analyzeBrowserProbe({ host: 'h', env: {}, stalls: 0, errorCode: 4 }, blocked).conclusion.title, /fails here and the server is blocked too/);
    assert.match(page.analyzeBrowserProbe({ host: 'h', env: {}, stalls: 0, loadTimeout: true }, null).conclusion.title, /broken for everyone/);

    // live: hls.js errors in words, segment speed, and no "whole file buffered" nonsense
    const live = { path: 'proxy', live: true, engine: 'hls.js', manifestMs: 800, playing: true, startMs: 1500, stalls: 0, stallMs: 0, advancedSec: 9.9, fillRate: 1, bufferAheadSec: 10,
        fullyBuffered: false, host: 'x', env: {}, frags: 5, fragLoadMs: [300, 400, 350, 500, 450], fragSeconds: [2, 2, 2, 2, 2], hlsErrors: [] };
    result = page.analyzeBrowserProbe(live, ok, 10000);
    assert.equal(result.conclusion.level, 'ok');
    assert.ok(!/buffered/.test(levels(result)));
    result = page.analyzeBrowserProbe({ ...live, fragLoadMs: [1900, 2100, 2000, 1800, 2200] }, ok, 10000);
    assert.match(levels(result), /bad:segments load slower than they play/);
    result = page.analyzeBrowserProbe({ host: 'x', env: {}, stalls: 0, live: true, hlsErrors: [{ fatal: true, details: 'manifestLoadError', httpCode: 404 }] }, ok, 10000);
    assert.match(result.findings.find(f => f.level === 'bad').detail, /the playlist could not be loaded \(http 404\)/);
    assert.equal(page.analyzeBrowserProbe({ unsupported: true, env: {}, stalls: 0 }, ok).conclusion.title, 'inconclusive');

    assert.ok(page.canBrowserTest({ kind: 'movie', sourceType: 'xtream' }));
    assert.ok(page.canBrowserTest({ kind: 'live', sourceType: 'xtream' }));
    assert.ok(!page.canBrowserTest({ kind: 'episode', sourceType: 'm3u' }));
    assert.match(page.renderDiagnosis({ kind: 'movie', verdict: 'warn', verdictLabel: 'could not be tested from this server', url: 'u', findings: [], metrics: [], timeline: [] }), /could not be tested from this server/);
});
