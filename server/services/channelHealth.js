/**
 * Channel health monitor.
 *
 * Periodically fetches every live channel's playlist the way the player does
 * (the URL behind /api/proxy/stream?url=...) and records whether it returned a
 * usable HLS manifest and how long that took. Channels that fail are checked
 * once more at the end of the run; if they still fail they are hidden (same
 * flag as Manage Content) and are shown again by the next run that finds them
 * online. Channels an admin hid by hand and adult channels are never checked.
 *
 * If a run fails more than SUSPECT_RATE of its channels nothing is hidden: a
 * provider does not lose that many channels at once, so the cause is the
 * network or the provider, not the channels.
 *
 * Every failure (and every channel that needed a retry) keeps a per-attempt
 * trace in channel_health.debug so a wrong verdict can be diagnosed later.
 *
 * The schedule and the last run summary live in the database (health_meta), so
 * restarting the server neither loses them nor starts a run: the next run is
 * always INTERVAL_MIN after the end of the previous one.
 */
const { getDb } = require('../db/sqlite');
const { sources } = require('../db');
const { validateHttpUrl } = require('./urlSecurity');
const contentFilter = require('./contentFilter');

const INTERVAL_MIN = parseInt(process.env.CHANNEL_CHECK_INTERVAL_MIN) || 120;
// Providers cap simultaneous connections per account, so checks are throttled per source.
const TIMEOUT_MS = 20000;
const PER_SOURCE_CONCURRENCY = 2;
const RETRY_DELAY_MS = 2000;
const CATCH_UP_MS = 60 * 1000; // a run that came due while the server was down starts this long after boot
const MAX_HOPS = 6;
const SUSPECT_RATE = 0.15;
const SUSPECT_MIN_SAMPLE = 20;

const state = { running: false, lastRun: null, nextRun: null, checked: 0, total: 0, phase: null, summary: null };
let timer = null;
let metaLoaded = false;

const KEPT_HEADERS = ['server', 'via', 'retry-after', 'cf-ray', 'x-powered-by', 'content-type', 'content-length'];

// Stored traces must never carry the account's credentials.
const redact = text => String(text ?? '').replace(/\/(live|movie|series)\/[^/\s"']+\/[^/\s"']+\//g, '/$1/<user>/<pass>/');

const monitorHeaders = url => {
    const origin = new URL(url).origin;
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*', 'Accept-Encoding': 'identity', Origin: origin, Referer: `${origin}/`
    };
};

// Follows redirects by hand so every hop is timed and validated. `hops` is filled in as it goes,
// so the caller still has the trace when a later hop throws.
async function followHops(url, { headers, signal, hops }) {
    let current = validateHttpUrl(url);
    for (let i = 0; ; i++) {
        const hop = { host: new URL(current).host };
        hops.push(hop);
        const t0 = Date.now();
        let res;
        try { res = await fetch(current, { headers, signal, redirect: 'manual' }); }
        finally { hop.ms = Date.now() - t0; }
        hop.status = res.status;
        const location = res.headers.get('location');
        if (res.status < 300 || res.status >= 400 || !location) return { res, url: current };
        await res.body?.cancel();
        if (i + 1 >= MAX_HOPS) throw new Error('too many redirects');
        current = validateHttpUrl(new URL(location, current).href);
    }
}

// Reads at most maxBytes or for maxMs; `complete` tells whether the body ended on its own.
// A read that fails after some data arrived still returns what it got.
async function readBody(res, maxBytes, { maxMs = Infinity } = {}) {
    const started = Date.now();
    const chunks = [];
    let bytes = 0, complete = true;
    try {
        for await (const chunk of res.body || []) {
            chunks.push(Buffer.from(chunk));
            bytes += chunk.length;
            if (bytes >= maxBytes || Date.now() - started >= maxMs) { complete = false; break; } // leaving the loop cancels the stream
        }
    } catch (err) {
        if (!bytes) throw err;
        complete = false;
    }
    return { buffer: Buffer.concat(chunks), bytes, complete, ms: Date.now() - started };
}

const pickHeaders = res => Object.fromEntries(KEPT_HEADERS.filter(h => res.headers.has(h)).map(h => [h, res.headers.get(h)]));

// One fetch of the playlist and its verdict, plus a trace of what happened.
// shortcut: a master playlist counts as online without fetching its variants, upgrade if variants die alone
async function checkUrlOnce(url, { plain = false, keepBody = false, timeoutMs = TIMEOUT_MS } = {}) {
    const started = Date.now();
    const attempt = { plain, hops: [] };
    const done = (ok, error, extra = {}) => ({
        ok, error, ...extra,
        attempt: { ...attempt, totalMs: Date.now() - started, ...(error && { error }) }
    });
    try {
        const { res, url: finalUrl } = await followHops(url, {
            headers: plain ? {} : monitorHeaders(url), signal: AbortSignal.timeout(timeoutMs), hops: attempt.hops
        });
        attempt.headers = pickHeaders(res);
        if (!res.ok) {
            attempt.snippet = redact((await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200));
            return done(false, `http ${res.status}`, { retry: res.status >= 500 });
        }
        const body = await res.text();
        attempt.bytes = body.length;
        attempt.snippet = redact(body.slice(0, 120));
        const latency = Date.now() - started;
        if (!body.trimStart().startsWith('#EXTM3U')) return done(false, 'not a playlist');
        const hasEntries = body.split('\n').some(l => l.trim() && !l.trim().startsWith('#'));
        return hasEntries ? done(true, null, { latency, ...(keepBody && { body, finalUrl }) }) : done(false, 'empty playlist');
    } catch (err) {
        const timeout = err.name === 'TimeoutError';
        attempt.code = err.cause?.code || err.code;
        return done(false, timeout ? 'timeout' : redact(err.message), { retry: timeout });
    }
}

// Providers start a channel on its first request: that one 503s or times out, the next is fast.
async function checkUrl(url) {
    const first = await checkUrlOnce(url);
    if (!first.retry) return { ...first, attempts: [first.attempt] };
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    const second = await checkUrlOnce(url);
    return { ...second, attempts: [first.attempt, second.attempt] };
}

const hostOf = result => result.attempts.at(-1).hops.at(-1)?.host || 'unknown';

function streamUrl(item, source) {
    if (item.stream_url) return item.stream_url;
    if (source.type !== 'xtream') return null;
    return `${source.url.replace(/\/$/, '')}/live/${source.username}/${source.password}/${item.item_id}.m3u8`;
}

// Returns 'hidden' / 'restored' when the visibility changed.
function record(item, result, canHide = true) {
    const db = getDb();
    let autoHidden = db.prepare('SELECT auto_hidden FROM channel_health WHERE source_id = ? AND item_id = ?')
        .get(item.source_id, item.item_id)?.auto_hidden || 0;
    const setHidden = hidden => db.prepare('UPDATE playlist_items SET is_hidden = ? WHERE source_id = ? AND item_id = ? AND type = \'live\'')
        .run(hidden, item.source_id, item.item_id);
    let change = null;

    if (result.ok && autoHidden) { setHidden(0); autoHidden = 0; change = 'restored'; }
    if (!result.ok && canHide && !item.is_hidden) { setHidden(1); autoHidden = 1; change = 'hidden'; }

    const attempts = result.attempts || [];
    const debug = !result.ok || attempts.length > 1 ? JSON.stringify(attempts) : null;
    db.prepare(`INSERT OR REPLACE INTO channel_health
        (source_id, item_id, status, latency_ms, error, fail_count, checked_at, auto_hidden, debug)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.source_id, item.item_id, result.ok ? 'online' : 'offline',
            result.latency ?? null, result.error ?? null, result.ok ? 0 : 1, Date.now(), autoHidden, debug);
    return change;
}

async function checkAll(items, byId, onResult) {
    const queues = new Map();
    for (const item of items) {
        if (!queues.has(item.source_id)) queues.set(item.source_id, []);
        queues.get(item.source_id).push(item);
    }
    const worker = async queue => {
        for (let item; (item = queue.shift());) {
            const url = streamUrl(item, byId.get(item.source_id));
            const result = url ? await checkUrl(url)
                : { ok: false, error: 'no stream url', attempts: [{ hops: [], error: 'no stream url' }] };
            try { onResult(item, result); } catch (err) { console.error('[ChannelHealth]', err.message); }
            state.checked++;
        }
    };
    await Promise.all([...queues.values()].flatMap(q => Array.from({ length: PER_SOURCE_CONCURRENCY }, () => worker(q))));
}

const count = (list, key) => list.reduce((acc, x) => { acc[key(x)] = (acc[key(x)] || 0) + 1; return acc; }, {});

async function runOnce() {
    if (state.running) return;
    ensureMeta();
    state.running = true;
    const started = Date.now();
    try {
        const byId = new Map((await sources.getAll()).filter(s => s.enabled).map(s => [s.id, s]));
        // Manually hidden channels are skipped; auto-hidden ones keep being checked so they can come back.
        const items = getDb().prepare(`
            SELECT p.source_id, p.item_id, p.stream_url, p.is_hidden FROM playlist_items p
            LEFT JOIN channel_health h ON h.source_id = p.source_id AND h.item_id = p.item_id
            WHERE p.type = 'live' AND (p.is_hidden = 0 OR h.auto_hidden = 1)
            ${contentFilter.itemClause('p', true)}
        `).all().filter(i => byId.has(i.source_id));

        // Failures are only recorded (and hidden) after the recheck and the suspect-run test.
        const hostStats = {}, failedFirst = [];
        let restored = 0;
        state.phase = 'checking';
        state.total = items.length;
        state.checked = 0;
        await checkAll(items, byId, (item, result) => {
            const host = (hostStats[hostOf(result)] ||= { ok: 0, fail: 0 });
            if (result.ok) { host.ok++; if (record(item, result) === 'restored') restored++; }
            else { host.fail++; failedFirst.push({ item, result }); }
        });

        state.phase = 'rechecking failures';
        state.total = failedFirst.length;
        state.checked = 0;
        const first = new Map(failedFirst.map(f => [f.item, f.result]));
        const finals = [];
        await checkAll(failedFirst.map(f => f.item), byId, (item, result) => {
            // Keep the first pass trace: it shows what the channel did before the recheck.
            finals.push({ item, result: { ...result, attempts: [...first.get(item).attempts, ...result.attempts] } });
        });

        const failedFinal = finals.filter(f => !f.result.ok);
        const failureRate = items.length ? failedFinal.length / items.length : 0;
        const suspect = items.length >= SUSPECT_MIN_SAMPLE && failureRate > SUSPECT_RATE;
        const changes = finals.map(f => record(f.item, f.result, !suspect));

        state.summary = {
            at: Date.now(), durationMs: Date.now() - started, total: items.length,
            failedFirstPass: failedFirst.length, recoveredOnRecheck: finals.length - failedFinal.length,
            failedFinal: failedFinal.length, failureRate: Number(failureRate.toFixed(4)), suspect,
            hidden: changes.filter(c => c === 'hidden').length,
            restored: restored + changes.filter(c => c === 'restored').length,
            firstPassErrors: count(failedFirst, f => f.result.error),
            finalErrors: count(failedFinal, f => f.result.error),
            hosts: Object.fromEntries(Object.entries(hostStats).filter(([, s]) => s.fail)),
            config: { intervalMin: INTERVAL_MIN, perSourceConcurrency: PER_SOURCE_CONCURRENCY, timeoutMs: TIMEOUT_MS,
                retryDelayMs: RETRY_DELAY_MS, suspectRate: SUSPECT_RATE, node: process.version }
        };
        state.lastRun = Date.now();
    } catch (err) {
        console.error('[ChannelHealth] Run failed:', err.message);
    } finally {
        state.running = false;
        state.phase = null;
        schedule(Date.now() + INTERVAL_MIN * 60 * 1000);
    }
}

function list() {
    return getDb().prepare(`
        SELECT p.name, p.stream_icon, p.source_id, p.item_id, p.is_hidden,
               h.status, h.latency_ms, h.error, h.checked_at, h.auto_hidden, h.debug
        FROM channel_health h
        JOIN playlist_items p ON p.source_id = h.source_id AND p.item_id = h.item_id AND p.type = 'live'
        WHERE 1 = 1 ${contentFilter.itemClause('p', true)}
        ORDER BY (h.status = 'online'), p.name COLLATE NOCASE
    `).all().map(row => ({ ...row, debug: row.debug ? JSON.parse(row.debug) : null }));
}

function ensureMeta() {
    if (metaLoaded) return;
    metaLoaded = true;
    try {
        for (const { key, value } of getDb().prepare('SELECT key, value FROM health_meta').all()) {
            if (key in state) state[key] = JSON.parse(value);
        }
    } catch (err) { console.error('[ChannelHealth] Could not load saved state:', err.message); }
}

function saveMeta() {
    const upsert = getDb().prepare('INSERT OR REPLACE INTO health_meta (key, value) VALUES (?, ?)');
    for (const key of ['lastRun', 'nextRun', 'summary']) upsert.run(key, JSON.stringify(state[key]));
}

function schedule(at) {
    clearTimeout(timer);
    state.nextRun = at;
    try { saveMeta(); } catch (err) { console.error('[ChannelHealth] Could not save state:', err.message); }
    timer = setTimeout(() => runOnce(), Math.max(at - Date.now(), 0));
    timer.unref();
}

// Keeps the saved schedule across restarts. With no saved schedule (first boot) the first run is INTERVAL_MIN away.
function start() {
    ensureMeta();
    const now = Date.now(), interval = INTERVAL_MIN * 60 * 1000;
    const saved = state.nextRun;
    schedule(saved ? (saved < now ? now + CATCH_UP_MS : Math.min(saved, now + interval)) : now + interval);
}

module.exports = {
    start, runOnce, list, checkUrl, checkUrlOnce, followHops, readBody, monitorHeaders, pickHeaders,
    redact, streamUrl, TIMEOUT_MS,
    getState: () => { ensureMeta(); return { ...state, intervalMin: INTERVAL_MIN }; }
};
