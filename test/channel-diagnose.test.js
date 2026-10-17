const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.NODECAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-diag-'));
process.env.ALLOW_LOCAL_MEDIA_URLS = 'true';

const { getDb } = require('../server/db/sqlite');
const { sources } = require('../server/db');
const diag = require('../server/services/channelDiagnose');

const codes = result => result.findings.map(f => f.code);
const attempt = (ms, error, status) => ({ ok: !error, error, attempt: { totalMs: ms, error, hops: [{ host: 'h.example', ms, status }] } });

test('live analysis: slower than realtime, frozen playlist and cold start are named', () => {
    const fine = [attempt(300), attempt(320), attempt(310)];
    const slow = diag.analyzeLive({
        tries: fine, plain: attempt(300), freshness: { first: 5, second: 6, waitedMs: 7000, segments: 6 },
        segment: { ok: true, bytes: 3e6, ms: 7000, complete: true, duration: 6.4, ttfbMs: 100 }
    });
    assert.ok(codes(slow).includes('slower_than_realtime'));
    assert.equal(diag.verdictOf(slow.findings), 'bad');

    const frozen = diag.analyzeLive({ tries: fine, freshness: { first: 0, second: 0, waitedMs: 7000, stalled: true } });
    assert.ok(codes(frozen).includes('stalled'));

    const cold = diag.analyzeLive({ tries: [attempt(9000, 'http 503'), attempt(300), attempt(310)] });
    assert.ok(codes(cold).includes('cold_start') && codes(cold).includes('unstable'));

    const healthy = diag.analyzeLive({
        tries: fine, freshness: { first: 5, second: 6, waitedMs: 7000 },
        segment: { ok: true, bytes: 1.5e6, ms: 400, complete: true, duration: 6.4, ttfbMs: 100 }
    });
    assert.equal(diag.verdictOf(healthy.findings), 'ok');
});

test('live analysis: a refusal is explained with the account state', () => {
    const tries = [attempt(100, 'http 403', 403), attempt(100, 'http 403', 403), attempt(100, 'http 403', 403)];
    const account = { status: 'Active', max_connections: '1', active_cons: 1, exp_date: String(Math.floor(Date.now() / 1000) + 9e6) };
    const result = diag.analyzeLive({ tries, account });
    const refused = result.findings.find(f => f.code === 'refused');
    assert.match(refused.detail, /connection limit reached \(it is reached right now\)/);
    assert.ok(codes(result).includes('at_limit'));
    const expired = diag.analyzeLive({ tries, account: { ...account, exp_date: '1000' } });
    assert.ok(codes(expired).includes('account_expired'));
});

test('movie analysis: container detection, moov position and range support', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
    assert.equal(diag.detectContainer(mp4), 'mp4');
    assert.equal(diag.detectContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), 'mkv');
    assert.equal(diag.detectContainer(Buffer.from('<html></html>')), null);

    const box = (type, size) => { const b = Buffer.alloc(size); b.writeUInt32BE(size, 0); b.write(type, 4, 'latin1'); return b; };
    assert.equal(diag.moovPosition(Buffer.concat([box('ftyp', 24), box('moov', 100)]), 5e6), 'start');
    assert.equal(diag.moovPosition(Buffer.concat([box('ftyp', 24), box('mdat', 100)]), 5e6), 'end');

    const probe = {
        status: 200, ttfbMs: 5000, hops: [{ host: 'h', ms: 5000 }], headers: { 'content-type': 'video/mp4' },
        buffer: Buffer.concat([box('ftyp', 24), box('mdat', 100)]), bytes: 2 * 1048576, readMs: 8000, total: 3e9
    };
    const result = diag.analyzeMovie({ probes: [probe], extension: 'mp4' });
    for (const code of ['slow_start', 'slow_download', 'moov_at_end', 'no_range']) assert.ok(codes(result).includes(code), code);
    assert.equal(diag.verdictOf(result.findings), 'bad');

    const timed = rate => {
        const bytes = 4 * 1048576, readMs = (bytes * 8) / (rate * 1000);
        return codes(diag.analyzeMovie({ probes: [{ ...probe, ttfbMs: 300, bytes, readMs, total: 340 * 1048576, status: 206, headers: { 'content-range': 'bytes 0-1/2' } }], durationSecs: 1320 }));
    };
    assert.ok(timed(1.5).includes('cannot_keep_up'), 'slower than the video bitrate (~2.2 mbps)');
    assert.ok(timed(2.6).includes('thin_margin'));
    assert.ok(timed(9).includes('fast_download') && !timed(9).includes('slow_download'));

    const html = diag.analyzeMovie({ probes: [{ ...probe, buffer: Buffer.from('<html>blocked</html>'), headers: { 'content-type': 'text/html' } }] });
    assert.ok(codes(html).includes('not_video'));
});

test('diagnosing a live channel and a movie against a real server', async () => {
    let sequence = 100, frozen = false;
    const movie = Buffer.alloc(6 * 1048576);
    movie.writeUInt32BE(24, 0); movie.write('ftypisom', 4, 'latin1');
    movie.writeUInt32BE(8, 24); movie.write('moov', 28, 'latin1');
    let honorRanges = true;

    const server = http.createServer((req, res) => {
        if (req.url === '/live.m3u8') {
            if (!frozen) sequence++;
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.end(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:1.0,\n/seg${sequence}.ts?token=${Math.random()}\n`);
        }
        if (req.url.startsWith('/seg')) return res.end(Buffer.alloc(200000));
        if (req.url === '/movie.mp4') {
            const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
            res.setHeader('Content-Type', 'video/mp4');
            if (!m || !honorRanges) return res.end(movie);
            const start = Number(m[1]), end = Math.min(Number(m[2]), movie.length - 1);
            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${start}-${end}/${movie.length}`);
            return res.end(movie.subarray(start, end + 1));
        }
        res.statusCode = 404; res.end();
    }).listen(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const source = await sources.create({ name: 'diag source', type: 'm3u', url: base, enabled: true });
    const insert = getDb().prepare(`INSERT INTO playlist_items (id, source_id, item_id, type, name, stream_url, container_extension)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run(`${source.id}:live1`, source.id, 'live1', 'live', 'good channel', `${base}/live.m3u8`, null);
    insert.run(`${source.id}:m1`, source.id, 'm1', 'movie', 'Some Movie', `${base}/movie.mp4`, 'mp4');
    insert.run(`${source.id}:m2`, source.id, 'm2', 'movie', 'xxx movie', `${base}/movie.mp4`, 'mp4');

    const live = await diag.diagnose('live', source.id, 'live1');
    assert.equal(live.verdict, 'ok', JSON.stringify(live.findings));
    assert.ok(codes(live).includes('advancing') && codes(live).includes('segments_fast'));
    assert.equal(live.timeline.length, 5, '3 tries + no-header try + newest segment');

    frozen = true;
    const stuck = await diag.diagnose('live', source.id, 'live1');
    assert.ok(codes(stuck).includes('stalled'));
    assert.equal(stuck.verdict, 'bad');

    const good = await diag.diagnose('movie', source.id, 'm1');
    assert.ok(codes(good).includes('seek_ok'), JSON.stringify(good.findings));
    assert.ok(!codes(good).includes('no_range'));

    honorRanges = false;
    const noRange = await diag.diagnose('movie', source.id, 'm1');
    assert.ok(codes(noRange).includes('no_range'));

    assert.equal(await diag.diagnose('movie', source.id, 'm2'), null, 'adult titles cannot be diagnosed');
    assert.equal(await diag.diagnose('live', source.id, 'nope'), null);
    assert.deepEqual((await diag.searchMovies('movie')).map(m => m.name), ['Some Movie'], 'adult titles are not searchable');
    server.close();
});

test('series: episodes are listed per season and each one can be diagnosed', async () => {
    const cache = require('../server/services/cache'); // the real cache writes under the repo's data/ folder
    cache.get = () => null;
    cache.set = () => {};

    const file = Buffer.alloc(5 * 1048576);
    file.writeUInt32BE(24, 0); file.write('ftypisom', 4, 'latin1');
    file.writeUInt32BE(8, 24); file.write('moov', 28, 'latin1');
    let requestedPath = null;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/player_api.php') {
            res.setHeader('Content-Type', 'application/json');
            if (url.searchParams.get('action') === 'get_series_info') {
                return res.end(JSON.stringify({ episodes: {
                    2: [{ id: '202', episode_num: 1, title: 'Back', container_extension: 'mp4' }],
                    1: [{ id: '101', episode_num: 1, title: 'Pilot', container_extension: 'mp4' }, { id: '102', episode_num: 2, title: 'Second' }]
                } }));
            }
            return res.end(JSON.stringify({ user_info: { status: 'Active', max_connections: '1', active_cons: 0, exp_date: String(Math.floor(Date.now() / 1000) + 9e7) } }));
        }
        if (url.pathname.startsWith('/series/')) {
            requestedPath = url.pathname;
            const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
            res.setHeader('Content-Type', 'video/mp4');
            const start = m ? Number(m[1]) : 0, end = m ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
            if (m) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`); }
            return res.end(file.subarray(start, end + 1));
        }
        res.statusCode = 404; res.end();
    }).listen(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        const source = await sources.create({ name: 'x', type: 'xtream', url: base, username: 'user', password: 'pass', enabled: true });
        const m3u = await sources.create({ name: 'm', type: 'm3u', url: base, enabled: true });
        const insert = getDb().prepare("INSERT INTO playlist_items (id, source_id, item_id, type, name) VALUES (?, ?, ?, 'series', ?)");
        insert.run(`${source.id}:7`, source.id, '7', 'Some Show');
        insert.run(`${source.id}:8`, source.id, '8', 'xxx show');
        insert.run(`${m3u.id}:7`, m3u.id, '7', 'Playlist Show');

        const outline = await diag.seriesOutline(source.id, '7');
        assert.deepEqual(outline.seasons.map(s => [s.season, s.episodes.map(e => e.id)]), [[1, ['101', '102']], [2, ['202']]], 'seasons sorted, episodes listed');
        assert.equal(outline.seasons[0].episodes[1].ext, 'mp4', 'extension defaults to mp4');

        const result = await diag.diagnose('episode', source.id, '102', { seriesId: '7' });
        assert.equal(result.kind, 'episode');
        assert.equal(result.item.name, 'Some Show S01E02 Second');
        assert.equal(requestedPath, '/series/user/pass/102.mp4');
        assert.ok(codes(result).includes('seek_ok'), JSON.stringify(result.findings));
        assert.ok(!JSON.stringify(result).includes('pass/'), 'credentials are redacted');

        assert.equal(await diag.diagnose('episode', source.id, '999', { seriesId: '7' }), null, 'an episode that is not in the series');
        assert.equal(await diag.diagnose('episode', source.id, '101', {}), null, 'a series id is required');
        assert.equal(await diag.seriesOutline(source.id, '8'), null, 'adult series are not listed');
        await assert.rejects(diag.seriesOutline(m3u.id, '7'), /xtream/);
        assert.deepEqual((await diag.searchTitles('series', 'show')).map(s => s.name).sort(), ['Playlist Show', 'Some Show']);
    } finally {
        server.close();
    }
});

test('a slow first speed sample is measured again elsewhere and the better one is used', async () => {
    const file = Buffer.alloc(20 * 1048576);
    file.writeUInt32BE(24, 0); file.write('ftypisom', 4, 'latin1');
    file.writeUInt32BE(8, 24); file.write('moov', 28, 'latin1');
    const server = http.createServer(async (req, res) => {
        const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
        const start = Number(m[1]), end = Math.min(Number(m[2]), file.length - 1);
        res.statusCode = 206;
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
        const slow = start === 0; // only the start of the file is slow
        for (let at = start; at <= end; at += 262144) {
            if (!res.write(file.subarray(at, Math.min(at + 262144, end + 1)))) await new Promise(r => res.once('drain', r));
            if (slow) await new Promise(r => setTimeout(r, 400));
        }
        res.end();
    }).listen(0);
    await new Promise(r => server.once('listening', r));
    try {
        const source = await sources.create({ name: 'slow', type: 'm3u', url: `http://127.0.0.1:${server.address().port}`, enabled: true });
        getDb().prepare("INSERT INTO playlist_items (id, source_id, item_id, type, name, stream_url, container_extension) VALUES (?, ?, 'slow1', 'movie', 'Slow Start', ?, 'mp4')")
            .run(`${source.id}:slow1`, source.id, `http://127.0.0.1:${server.address().port}/f.mp4`);
        const result = await diag.diagnose('movie', source.id, 'slow1');
        assert.ok(result.timeline.some(t => t.label === 'second speed sample'));
        assert.ok(codes(result).includes('fast_download'), JSON.stringify(result.findings));
        assert.match(result.findings.find(f => f.code === 'fast_download').detail, /best of 2 samples/);
    } finally {
        server.close();
    }
});
