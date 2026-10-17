const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.NODECAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-health-'));
process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';

const { getDb } = require('../server/db/sqlite');
const { sources } = require('../server/db');
const health = require('../server/services/channelHealth');

test('failed channels are rechecked then hidden, return when online, and adult channels are never checked', async () => {
    let body = '#EXTM3U\n#EXT-X-VERSION:3\n';
    const server = http.createServer((req, res) => {
        if (req.url === '/missing') { res.statusCode = 404; return res.end(); }
        if (req.url.startsWith('/live/')) { res.statusCode = 404; return res.end(`not found ${req.url}`); }
        if (req.url === '/hop') { res.statusCode = 302; res.setHeader('Location', '/empty'); return res.end(); }
        res.end(body);
    }).listen(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    assert.equal((await health.checkUrl(`${base}/empty`)).error, 'empty playlist');
    assert.equal((await health.checkUrl(`${base}/missing`)).error, 'http 404');
    const hop = await health.checkUrl(`${base}/hop`);
    assert.equal(hop.attempts[0].hops.length, 2, 'redirects are followed hop by hop');
    const leaked = await health.checkUrl(`${base}/live/secretuser/secretpass/5.m3u8`);
    assert.ok(!JSON.stringify(leaked).includes('secretpass'), 'traces do not carry credentials');
    assert.equal(leaked.attempts[0].status ?? leaked.attempts[0].hops[0].status, 404);
    body = '#EXTM3U\n#EXTINF:10,\nseg1.ts\n';
    const ok = await health.checkUrl(`${base}/live`);
    assert.ok(ok.ok && ok.latency >= 0);

    const source = await sources.create({ name: 't', type: 'm3u', url: base, enabled: true });
    getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, stream_url)
        VALUES (?, ?, 'c1', 'live', 'chan', ?)`).run(`${source.id}:c1`, source.id, `${base}/live`);
    getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, stream_url)
        VALUES (?, ?, 'adult1', 'live', 'xxx channel', ?)`).run(`${source.id}:adult1`, source.id, `${base}/live`);
    const hidden = () => getDb().prepare('SELECT is_hidden FROM playlist_items WHERE item_id = ?').get('c1').is_hidden;

    body = '#EXTM3U\n';
    let hits = 0;
    server.on('request', () => hits++);
    await health.runOnce();
    assert.equal(hits, 2, 'failed channel is fetched twice (run + recheck), adult channel never');
    assert.equal(hidden(), 1, 'still failing after recheck hides');
    assert.equal(health.list().length, 1, 'adult channel is not listed');
    assert.equal(health.list()[0].status, 'offline');

    body = '#EXTM3U\n#EXTINF:10,\nseg1.ts\n';
    await health.runOnce();
    assert.equal(hidden(), 0, 'recovered channel is shown again');
    assert.equal(health.list()[0].status, 'online');
    server.close();
});

test('a run where too many channels fail hides nothing and says so; diagnose traces one channel', async () => {
    const server = http.createServer((req, res) => res.end('#EXTM3U\n')).listen(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const source = await sources.create({ name: 's', type: 'm3u', url: base, enabled: true });
    const insert = getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, stream_url)
        VALUES (?, ?, ?, 'live', ?, ?)`);
    for (let i = 0; i < 25; i++) insert.run(`${source.id}:s${i}`, source.id, `s${i}`, `suspect ${i}`, `${base}/live`);

    await health.runOnce();
    const { summary } = health.getState();
    assert.ok(summary.suspect);
    assert.equal(summary.hidden, 0);
    assert.equal(getDb().prepare("SELECT COUNT(*) n FROM playlist_items WHERE name LIKE 'suspect%' AND is_hidden = 1").get().n, 0);
    assert.equal(summary.finalErrors['empty playlist'], 25);

    const report = await health.diagnose(source.id, 's1');
    assert.equal(report.attempts.length, 4);
    assert.equal(report.attempts[3].plain, true);
    assert.equal(await health.diagnose(source.id, 'missing'), null);
    server.close();
});
