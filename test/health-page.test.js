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
