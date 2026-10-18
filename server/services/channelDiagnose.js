/**
 * Manual diagnosis of one live channel, one movie or one series episode.
 *
 * It runs on this server, so it sees exactly what the monitor and the player
 * see. Probing produces a raw trace; the analyze* functions turn that trace
 * into findings an admin can read ("slower than realtime", "manifest frozen",
 * "no seeking support"...). Analysis is kept free of I/O so it can be tested.
 */
const { getDb } = require('../db/sqlite');
const { sources, settings } = require('../db');
const xtreamApi = require('./xtreamApi');
const cache = require('./cache');
const contentFilter = require('./contentFilter');
const { validateHttpUrl } = require('./urlSecurity');
const health = require('./channelHealth');

const { followHops, readBody, monitorHeaders, pickHeaders, redact, streamUrl, checkUrlOnce } = health;

const DIAG_TIMEOUT_MS = 12000; // 4 slow attempts must still fit behind a reverse proxy's ~100s limit
const LIVE_TRIES = 3;
const BODY_BUDGET_MS = 8000; // downloads are measured for at most this long, then cut
const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
const MOVIE_SAMPLE_BYTES = 4 * 1024 * 1024;
const LEVELS = { ok: 0, info: 0, warn: 1, bad: 2 };

const finding = (level, code, title, detail = '') => ({ level, code, title, detail });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const mbps = (bytes, ms) => (ms > 0 ? (bytes * 8) / ms / 1000 : 0);
const seconds = ms => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
// Headers must arrive within `ms`; after arm() the rest of the exchange gets its own deadline.
function timeBudget(ms) {
    const controller = new AbortController();
    let timer;
    const arm = after => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), after);
    };
    arm(ms);
    return { signal: controller.signal, arm, stop: () => clearTimeout(timer) };
}
const sumMs = hops => hops.reduce((total, h) => total + (h.ms || 0), 0);

function verdictOf(findings) {
    const worst = Math.max(0, ...findings.map(f => LEVELS[f.level]));
    return ['ok', 'warn', 'bad'][worst];
}

// --- shared analysis -------------------------------------------------------

/** Why a single failed attempt failed, in words. */
function explainFailure(attempt, account, forceProxy) {
    const error = attempt.error || 'unknown error';
    const host = attempt.hops?.at(-1)?.host || 'the provider';
    const snippet = attempt.snippet ? ` it said: "${attempt.snippet.slice(0, 120)}"` : '';
    const full = account && Number(account.active_cons) >= Number(account.max_connections);

    // A Cloudflare block page: the CDN rejects this server (IP or connection fingerprint), not necessarily the file.
    const cloudflare = /cloudflare/i.test(attempt.headers?.server || '') || attempt.headers?.['cf-ray'];
    if (/^http (403|429|503)$/.test(error) && cloudflare && /text\/html/i.test(attempt.headers?.['content-type'] || '')) {
        const ms = attempt.hops?.at(-1)?.ms;
        const playback = forceProxy === true ? 'the player is set to use this server as a proxy, so playback is affected too.'
            : forceProxy === false ? 'the player connects straight from the viewer\'s browser (force proxy is off), which is usually not blocked: use "test in this browser" to confirm.'
                : 'viewers that connect from their own browser are usually not blocked: use "test in this browser" to confirm.';
        return finding('warn', 'cdn_blocked', 'the provider\'s CDN blocks requests from this server',
            `${host} (behind Cloudflare) answered ${error} with a block page${ms != null ? ` in ${ms} ms` : ''}. that means this server's IP or connection is blocked, not that the file is broken. ${playback} it does affect anything this server downloads itself (proxy mode, remux, transcoding).`);
    }

    if (/^http (404|410)$/.test(error)) {
        return finding('bad', 'not_found', 'the provider says this stream does not exist',
            `${host} answered ${error}. the item was removed or its id changed; syncing the source again may fix it.`);
    }
    if (/^http (401|403)$/.test(error)) {
        return finding('bad', 'refused', 'the provider refused the request',
            `${host} answered ${error}. usual causes: credentials rejected, connection limit reached${full ? ' (it is reached right now)' : ''}, or this server's IP is blocked.${snippet}`);
    }
    if (error === 'http 429') {
        return finding('bad', 'rate_limited', 'the provider is rate limiting this server',
            `${host} answered 429: too many requests in a short time. wait a while before checking again.`);
    }
    if (/^http 5\d\d$/.test(error)) {
        return finding('bad', 'provider_error', 'the provider failed to serve it',
            `${host} answered ${error}. this is the provider's side: overloaded, or the channel was cold and not started yet.${snippet}`);
    }
    if (error === 'timeout') {
        const hop = attempt.hops?.length || 1;
        return finding('bad', 'timeout', 'the provider did not answer in time',
            `no answer from ${host} (hop ${hop}) before the timeout. the node may be down or the channel is being started.`);
    }
    if (error === 'empty playlist') {
        return finding('bad', 'empty_playlist', 'the playlist is empty',
            'the provider answers but lists no segments: nothing is being produced for this channel right now.');
    }
    if (error === 'not a playlist') {
        return finding('bad', 'not_a_playlist', 'the provider did not return an HLS playlist',
            `${host} returned something else.${snippet}`);
    }
    return finding('bad', 'network', 'network error', `${error}${attempt.code ? ` (${attempt.code})` : ''} while talking to ${host}.`);
}

const isIp = host => /^(\d{1,3}\.){3}\d{1,3}$/.test(host.replace(/:\d+$/, '')) || host.startsWith('[');

/**
 * A file served over plain http from a bare IP address cannot be loaded by an https page: the browser
 * upgrades the request to https and an IP has no valid certificate (ERR_CERT_AUTHORITY_INVALID).
 */
function mixedContentFinding(hops) {
    const last = hops?.at(-1);
    // Loopback is only reachable from the machine itself (development), never from a viewer's https page.
    if (!last || last.proto !== 'http' || !isIp(last.host) || /^127\./.test(last.host)) return null;
    return finding('warn', 'plain_http_ip', 'the file comes from an IP address over plain http',
        `${last.host} serves it without https. a viewer on an https page has the request upgraded to https and the browser rejects the IP's certificate (ERR_CERT_AUTHORITY_INVALID), so it will not play directly. it plays through the server proxy. if the app itself is served over plain http this does not apply.`);
}

/** Account-level findings (status, expiry, connection limit). */
function analyzeAccount(account) {
    if (!account) return [];
    if (account.error) return [finding('warn', 'account_unreadable', 'could not read the account info', account.error)];
    const out = [];
    if (account.status && account.status !== 'Active') {
        out.push(finding('bad', 'account_inactive', `the account is ${account.status.toLowerCase()}`, 'the provider will refuse every stream until it is active again.'));
    }
    const exp = Number(account.exp_date) * 1000;
    if (exp && exp < Date.now()) {
        out.push(finding('bad', 'account_expired', 'the account has expired', `expired on ${new Date(exp).toISOString().slice(0, 10)}.`));
    } else if (exp && exp - Date.now() < 7 * 86400000) {
        out.push(finding('warn', 'account_expiring', 'the account expires within 7 days', `expires on ${new Date(exp).toISOString().slice(0, 10)}.`));
    }
    const max = Number(account.max_connections), active = Number(account.active_cons);
    if (max && active > max) {
        out.push(finding('warn', 'over_limit', 'the account is over its connection limit', `${active} connections open, ${max} allowed. the provider may refuse or cut streams.`));
    } else if (max && active === max) {
        out.push(finding('info', 'at_limit', 'the account is at its connection limit', `${active} of ${max} connections in use: any new viewer may be refused.`));
    }
    return out;
}

// --- live ------------------------------------------------------------------

function parsePlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out = { variants: [], segments: [], targetDuration: null, sequence: null };
    const resolve = ref => { try { return new URL(ref, baseUrl).href; } catch { return null; } };
    lines.forEach((line, i) => {
        const next = lines[i + 1] && !lines[i + 1].startsWith('#') ? resolve(lines[i + 1]) : null;
        if (line.startsWith('#EXT-X-TARGETDURATION:')) out.targetDuration = parseFloat(line.split(':')[1]);
        else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) out.sequence = parseInt(line.split(':')[1]);
        else if (line.startsWith('#EXT-X-STREAM-INF') && next) out.variants.push(next);
        else if (line.startsWith('#EXTINF:') && next) out.segments.push({ url: next, duration: parseFloat(line.slice(8)) || 0 });
    });
    return out;
}

/** Turns the raw live probe into findings and display metrics. */
function analyzeLive({ tries, plain, freshness, segment, account, forceProxy }) {
    const findings = [], metrics = [];
    const ok = tries.filter(t => t.ok);

    if (!ok.length) {
        findings.push(explainFailure(tries.at(-1).attempt, account, forceProxy));
        const kinds = [...new Set(tries.map(t => t.error))];
        if (kinds.length > 1) findings.push(finding('info', 'mixed_errors', 'the attempts failed in different ways', kinds.join(', ')));
    } else {
        if (ok.length < tries.length) {
            findings.push(finding('warn', 'unstable', `${tries.length - ok.length} of ${tries.length} attempts failed`,
                'the channel answers only some of the time. viewers will see it start, stall or fail at random.'));
        }
        const first = tries[0];
        const fastest = Math.min(...ok.map(t => t.attempt.totalMs));
        if (!first.ok || (first.attempt.totalMs > 2000 && first.attempt.totalMs > fastest * 3 && ok.length > 1)) {
            findings.push(finding('warn', 'cold_start', 'the first request was slow or failed, the next ones were fast',
                'the provider starts a channel only when someone asks for it. the first viewer after a quiet period waits or sees an error; this is normal for some providers but worth knowing.'));
        }
        const latency = median(ok.map(t => t.attempt.totalMs));
        metrics.push({ label: 'playlist response', value: seconds(latency) });
        if (latency >= 4000) findings.push(finding('bad', 'slow_playlist', 'the playlist is very slow', `${seconds(latency)} to get the playlist. players will take that long to start, and may time out.`));
        else if (latency >= 1500) findings.push(finding('warn', 'slow_playlist', 'the playlist is slow', `${seconds(latency)} to get the playlist (healthy is under 1.5s).`));

        const hops = ok[0].attempt.hops;
        if (hops.length > 1) {
            const slowest = hops.reduce((a, b) => ((b.ms || 0) > (a.ms || 0) ? b : a));
            metrics.push({ label: 'served by', value: hops.at(-1).host });
            if ((slowest.ms || 0) > 1000 && slowest.ms > sumMs(hops) * 0.6) {
                findings.push(finding('info', 'slow_hop', `most of the wait is at ${slowest.host}`, `${seconds(slowest.ms)} of ${seconds(sumMs(hops))} total.`));
            }
        }
    }

    const mixed = ok.length && mixedContentFinding(ok[0].attempt.hops);
    if (mixed) findings.push(mixed);

    if (plain) {
        if (ok.length && !plain.ok) {
            findings.push(finding('info', 'header_sensitive', 'fails without browser headers', 'the provider rejects requests that do not look like a browser. the player sends them, so this is harmless.'));
        } else if (!ok.length && plain.ok) {
            findings.push(finding('warn', 'header_sensitive', 'works without browser headers but fails with them',
                'the provider treats the User-Agent/Origin/Referer headers differently. the player and the monitor both send them, so this is probably why it fails.'));
        }
    }

    if (freshness) {
        if (freshness.error) {
            findings.push(finding('warn', 'freshness_failed', 'could not re-read the playlist to see if it advances', freshness.error));
        } else if (freshness.inconclusive) {
            findings.push(finding('info', 'freshness_unknown', 'could not tell if the playlist advances',
                `its segments are longer than the ${seconds(freshness.waitedMs)} this check waits.`));
        } else if (freshness.stalled) {
            findings.push(finding('bad', 'stalled', 'the playlist is frozen',
                `after ${seconds(freshness.waitedMs)} it still lists the same segments (sequence ${freshness.first ?? '?'}). the provider answers but the channel is not producing video, so players will show a black screen or loop.`));
        } else {
            findings.push(finding('ok', 'advancing', 'the playlist is advancing', `sequence ${freshness.first ?? '?'} → ${freshness.second ?? '?'} in ${seconds(freshness.waitedMs)}: new segments are being produced.`));
        }
        if (freshness.segments) metrics.push({ label: 'segments listed', value: String(freshness.segments) });
    }

    if (segment) {
        if (!segment.ok) {
            findings.push(finding('bad', 'segment_failed', 'the playlist works but the newest segment does not',
                `${segment.error}${segment.host ? ` at ${segment.host}` : ''}. players load the playlist fine and then buffer forever.`));
        } else {
            const rate = mbps(segment.bytes, segment.ms);
            metrics.push({ label: 'segment download', value: `${rate.toFixed(1)} mbps` });
            metrics.push({ label: 'segment size', value: `${(segment.bytes / 1048576).toFixed(1)} mb` });
            if (segment.complete && segment.duration > 0) {
                const ratio = segment.ms / (segment.duration * 1000);
                metrics.push({ label: 'download vs playback', value: `${Math.round(ratio * 100)}%` });
                const sentence = `${seconds(segment.ms)} to download ${segment.duration.toFixed(1)}s of video (${rate.toFixed(1)} mbps).`;
                if (ratio > 0.9) findings.push(finding('bad', 'slower_than_realtime', 'this channel is slower than realtime', `${sentence} the player cannot keep up, it will buffer constantly.`));
                else if (ratio > 0.5) findings.push(finding('warn', 'slow_segments', 'this channel is slow', `${sentence} there is little headroom: any hiccup will cause buffering.`));
                else findings.push(finding('ok', 'segments_fast', 'segments download fast', sentence));
            }
            else if (segment.duration > 0 && segment.ms > segment.duration * 1000) {
                findings.push(finding('bad', 'slower_than_realtime', 'this channel is slower than realtime',
                    `after ${seconds(segment.ms)} the ${segment.duration.toFixed(1)}s segment was still downloading (${rate.toFixed(1)} mbps so far). the player cannot keep up, it will buffer constantly.`));
            }
            if (segment.ttfbMs > 2500) findings.push(finding('warn', 'slow_segment_start', 'segments are slow to start', `${seconds(segment.ttfbMs)} before the first byte arrives.`));
        }
    }

    findings.push(...analyzeAccount(account));
    if (!findings.some(f => LEVELS[f.level] > 0)) findings.unshift(finding('ok', 'healthy', 'nothing wrong found', 'the playlist answers, advances and its segments download quickly.'));
    return { findings, metrics };
}

async function getText(url, headers, hops) {
    const t0 = Date.now();
    const { res, url: finalUrl } = await followHops(url, { headers, signal: AbortSignal.timeout(DIAG_TIMEOUT_MS), hops });
    const text = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, text, ms: Date.now() - t0, url: finalUrl };
}

// Loads the media playlist behind a channel URL, following a master playlist to its first variant.
async function loadMediaPlaylist(url, headers) {
    const hops = [];
    let page = await getText(url, headers, hops);
    if (!page.ok) throw new Error(`http ${page.status}`);
    let parsed = parsePlaylist(page.text, page.url);
    if (parsed.variants.length && !parsed.segments.length) {
        page = await getText(parsed.variants[0], headers, hops);
        if (!page.ok) throw new Error(`variant http ${page.status}`);
        parsed = parsePlaylist(page.text, page.url);
    }
    return { parsed, hops };
}

async function probeSegment(segmentUrl, headers) {
    const hops = [];
    const t0 = Date.now();
    const budget = timeBudget(DIAG_TIMEOUT_MS);
    try {
        const { res } = await followHops(segmentUrl, { headers, signal: budget.signal, hops });
        const ttfbMs = Date.now() - t0;
        if (!res.ok) return { ok: false, error: `http ${res.status}`, host: hops.at(-1)?.host, hops };
        budget.arm(BODY_BUDGET_MS + 4000);
        const body = await readBody(res, SEGMENT_MAX_BYTES, { maxMs: BODY_BUDGET_MS });
        return { ok: body.bytes > 0, error: body.bytes ? null : 'empty segment', host: hops.at(-1)?.host, hops, ttfbMs,
            bytes: body.bytes, complete: body.complete, ms: Math.max(body.ms, 1) };
    } catch (err) {
        return { ok: false, error: err.name === 'TimeoutError' ? 'timeout' : redact(err.message), host: hops.at(-1)?.host, hops };
    } finally { budget.stop(); }
}

async function diagnoseLive(item, source, account, forceProxy) {
    const url = streamUrl(item, source);
    const tries = [];
    for (let i = 0; i < LIVE_TRIES; i++) {
        if (i) await sleep(1000);
        tries.push(await checkUrlOnce(url, { timeoutMs: DIAG_TIMEOUT_MS, keepBody: i === 0 }));
    }
    const plain = await checkUrlOnce(url, { plain: true, timeoutMs: DIAG_TIMEOUT_MS });

    let freshness = null, segment = null, timeline = [];
    if (tries.some(t => t.ok)) {
        const headers = monitorHeaders(url);
        try {
            const a = await loadMediaPlaylist(url, headers);
            const target = a.parsed.targetDuration || 6;
            const wait = Math.min(Math.max(target * 1300, 3000), 14000);
            await sleep(wait);
            const b = await loadMediaPlaylist(url, headers);
            // Segment urls carry a per-request token, so only the sequence number says whether it moved.
            freshness = {
                first: a.parsed.sequence, second: b.parsed.sequence, waitedMs: wait, segments: b.parsed.segments.length,
                inconclusive: a.parsed.sequence == null || wait < target * 1000,
                stalled: a.parsed.sequence != null && a.parsed.sequence === b.parsed.sequence
            };
            const newest = b.parsed.segments.at(-1);
            if (newest) {
                segment = { ...(await probeSegment(newest.url, headers)), duration: newest.duration };
                timeline.push({ label: 'newest segment', ok: segment.ok, hops: segment.hops, totalMs: sumMs(segment.hops) + (segment.ms || 0) });
            }
        } catch (err) {
            freshness = { error: err.name === 'TimeoutError' ? 'timeout' : redact(err.message) };
        }
    }

    const { findings, metrics } = analyzeLive({ tries, plain, freshness, segment, account, forceProxy });
    timeline = [
        ...tries.map((t, i) => ({ label: `playlist, try ${i + 1}`, ok: t.ok, hops: t.attempt.hops, totalMs: t.attempt.totalMs, error: t.error })),
        { label: 'playlist, no browser headers', ok: plain.ok, hops: plain.attempt.hops, totalMs: plain.attempt.totalMs, error: plain.error },
        ...timeline
    ];
    const strip = ({ attempt }) => attempt;
    return {
        findings, metrics, timeline,
        steps: { tries: tries.map(strip), plain: strip(plain), freshness, segment: segment && { ...segment, hops: undefined } }
    };
}

// --- movies ----------------------------------------------------------------

function detectContainer(buffer) {
    if (buffer.length >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
    if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return 'mkv';
    if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 11) === 'AVI') return 'avi';
    if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === 'OggS') return 'ogg';
    if (buffer.length >= 189 && buffer[0] === 0x47 && buffer[188] === 0x47) return 'ts';
    if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === 'FLV\x01') return 'flv';
    if (buffer.length >= 4 && buffer.toString('latin1', 0, 3) === 'ID3') return 'mp3';
    return null;
}

// For mp4: is the index (moov) before the media data? Players need it first, and if it is
// at the end they must seek to the end of the file before they can start.
function moovPosition(buffer, totalSize) {
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        let size = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        if (type === 'moov') return 'start';
        if (size === 1 && offset + 16 <= buffer.length) size = Number(buffer.readBigUInt64BE(offset + 8));
        if (size === 0) size = (totalSize || buffer.length) - offset;
        if (type === 'mdat') return 'end';
        if (size < 8) return null;
        offset += size;
    }
    return null;
}

/** Turns the raw movie probe into findings and display metrics. */
function analyzeMovie({ probes, seek, extension, account, durationSecs, forceProxy }) {
    const findings = [], metrics = [];
    const probe = probes.at(-1);

    if (probe.error) {
        findings.push(explainFailure({ error: probe.error, hops: probe.hops, snippet: probe.snippet, code: probe.code, headers: probe.headers }, account, forceProxy));
    } else {
        if (probes.length > 1) findings.push(finding('warn', 'cold_start', 'the first request failed, the retry worked', `first try: ${probes[0].error}. the provider may need a moment to fetch the file.`));
        const ttfb = probe.ttfbMs;
        metrics.push({ label: 'time to first byte', value: seconds(ttfb) });
        if (ttfb >= 4000) findings.push(finding('bad', 'slow_start', 'very slow to start', `${seconds(ttfb)} before the first byte. players will look frozen before playback begins.`));
        else if (ttfb >= 1500) findings.push(finding('warn', 'slow_start', 'slow to start', `${seconds(ttfb)} before the first byte (healthy is under 1.5s).`));

        const mixed = mixedContentFinding(probe.hops);
        if (mixed) findings.push(mixed);

        const type = probe.headers['content-type'] || '';
        const looksLikeText = /text\/|html|json|mpegurl/i.test(type) || probe.buffer.toString('latin1', 0, 1) === '<';
        if (looksLikeText) {
            findings.push(finding('bad', 'not_video', 'the provider returned a page, not a video',
                `content-type "${type || 'none'}". it said: "${redact(probe.buffer.toString('utf8', 0, 160).replace(/\s+/g, ' '))}"`));
        } else {
            const container = detectContainer(probe.buffer);
            if (!container) findings.push(finding('warn', 'unknown_format', 'the file does not look like a known video format', `first bytes: ${probe.buffer.subarray(0, 8).toString('hex')}. it may be corrupt or encrypted.`));
            else {
                metrics.push({ label: 'format', value: container });
                if (extension && extension.toLowerCase() !== container && !(extension === 'm4v' && container === 'mp4')) {
                    findings.push(finding('info', 'extension_mismatch', `the name says .${extension} but the file is ${container}`, 'harmless for most players.'));
                }
                if (['mkv', 'avi', 'flv', 'ts'].includes(container)) {
                    findings.push(finding('info', 'needs_remux', `${container} is not played natively by most browsers`, 'it needs the remux/transcode path to play in the browser.'));
                }
                if (container === 'mp4' && moovPosition(probe.buffer, probe.total) === 'end') {
                    findings.push(finding('warn', 'moov_at_end', 'the mp4 index is at the end of the file',
                        'browsers must fetch the end of the file before they can start, so playback starts slowly and depends on seeking support.'));
                }
            }
        }

        if (probe.total != null) {
            metrics.push({ label: 'size', value: probe.total >= 1073741824 ? `${(probe.total / 1073741824).toFixed(2)} gb` : `${(probe.total / 1048576).toFixed(0)} mb` });
            if (probe.total < 1048576) findings.push(finding('bad', 'tiny_file', 'the file is almost empty', `only ${probe.total} bytes: truncated or a placeholder.`));
        }
        if (probe.bytes >= 1048576) {
            const rate = mbps(probe.bytes, probe.readMs);
            metrics.push({ label: 'download speed', value: `${rate.toFixed(1)} mbps` });
            const sample = `${probe.samples > 1 ? 'best of 2 samples, ' : ''}${(probe.bytes / 1048576).toFixed(1)} mb in ${seconds(probe.readMs)}`;
            if (durationSecs > 0 && probe.total) {
                // The file's own bitrate is what the connection has to sustain.
                const needed = mbps(probe.total, durationSecs * 1000);
                const margin = rate / needed;
                metrics.push({ label: 'video bitrate', value: `${needed.toFixed(1)} mbps` });
                const sentence = `downloads at ${rate.toFixed(1)} mbps (${sample}) and the video needs ${needed.toFixed(1)} mbps.`;
                if (margin < 1) findings.push(finding('bad', 'cannot_keep_up', 'too slow for this video', `${sentence} playback will buffer constantly.`));
                else if (margin < 1.5) findings.push(finding('warn', 'thin_margin', 'barely fast enough', `${sentence} there is little room: any dip in speed will cause buffering.`));
                else findings.push(finding('ok', 'fast_download', 'download speed is good', sentence));
            } else {
                const sentence = `${rate.toFixed(1)} mbps ${sample}.`;
                if (rate < 3) findings.push(finding('bad', 'slow_download', 'too slow to stream', `${sentence} a 1080p movie needs about 5-8 mbps.`));
                else if (rate < 8) findings.push(finding('warn', 'slow_download', 'borderline speed', `${sentence} fine for sd/720p, may buffer on 1080p.`));
                else findings.push(finding('ok', 'fast_download', 'download speed is good', sentence));
            }
        }

        const ranged = probe.status === 206 && /^bytes /.test(probe.headers['content-range'] || '');
        if (!ranged) {
            findings.push(finding('warn', 'no_range', 'the server ignores range requests',
                'it streams the whole file from the start, so seeking and resuming will restart the download.'));
        } else if (seek) {
            if (seek.ok) findings.push(finding('ok', 'seek_ok', 'seeking works', `jumped to ${(seek.offset / 1048576).toFixed(0)} mb and got that part directly.`));
            else findings.push(finding('warn', 'seek_failed', 'seeking failed', `asking for a later part of the file returned ${seek.error}. skipping ahead will not work.`));
        }
    }

    findings.push(...analyzeAccount(account));
    if (!findings.some(f => LEVELS[f.level] > 0)) findings.unshift(finding('ok', 'healthy', 'nothing wrong found', 'the file starts quickly, downloads fast and supports seeking.'));
    return { findings, metrics };
}

async function rangeProbe(url, range, headers) {
    const hops = [];
    const t0 = Date.now();
    const budget = timeBudget(DIAG_TIMEOUT_MS);
    try {
        const { res, url: finalUrl } = await followHops(url, { headers: { ...headers, Range: `bytes=${range}` }, signal: budget.signal, hops });
        const ttfbMs = Date.now() - t0;
        const kept = pickHeaders(res);
        for (const h of ['accept-ranges', 'content-range']) if (res.headers.has(h)) kept[h] = res.headers.get(h);
        const base = { status: res.status, hops, ttfbMs, headers: kept, finalUrl };
        if (!res.ok) {
            const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
            return { ...base, error: `http ${res.status}`, snippet: redact(text), buffer: Buffer.alloc(0), bytes: 0 };
        }
        budget.arm(BODY_BUDGET_MS + 4000);
        const body = await readBody(res, MOVIE_SAMPLE_BYTES, { maxMs: BODY_BUDGET_MS });
        const total = /\/(\d+)$/.exec(kept['content-range'] || '')?.[1] ?? (res.status === 200 ? kept['content-length'] : null);
        return { ...base, buffer: body.buffer, bytes: body.bytes, readMs: Math.max(body.ms, 1), total: total != null ? Number(total) : null };
    } catch (err) {
        const timeout = err.name === 'TimeoutError';
        return { hops, status: null, error: timeout ? 'timeout' : redact(err.message), code: err.cause?.code || err.code, headers: {}, buffer: Buffer.alloc(0), bytes: 0 };
    } finally { budget.stop(); }
}

// Movies and episodes are plain files; only the path differs ('movie' or 'series').
function movieUrl(item, source, folder = 'movie') {
    if (item.stream_url) return item.stream_url;
    if (source.type !== 'xtream') return null;
    return `${source.url.replace(/\/$/, '')}/${folder}/${source.username}/${source.password}/${item.item_id}.${item.container_extension || 'mp4'}`;
}

async function diagnoseMovie(item, source, account, folder = 'movie', forceProxy) {
    const url = movieUrl(item, source, folder);
    if (!url) return { findings: [finding('bad', 'no_url', 'this movie has no stream url', 'the source did not provide one.')], metrics: [], timeline: [], steps: {} };
    validateHttpUrl(url);
    const headers = monitorHeaders(url);

    const probes = [await rangeProbe(url, `0-${MOVIE_SAMPLE_BYTES - 1}`, headers)];
    if (probes[0].error && (probes[0].error === 'timeout' || /^http 5/.test(probes[0].error))) {
        await sleep(2000);
        probes.push(await rangeProbe(url, `0-${MOVIE_SAMPLE_BYTES - 1}`, headers));
    }
    const probe = probes.at(-1);

    // Provider speed swings a lot between requests, so a low first sample is measured again elsewhere in the file.
    let resample = null;
    const slow = () => {
        const rate = mbps(probe.bytes, probe.readMs);
        return item.durationSecs > 0 && probe.total ? rate / mbps(probe.total, item.durationSecs * 1000) < 1.5 : rate < 8;
    };
    if (!probe.error && probe.status === 206 && probe.bytes >= 1048576 && probe.total > 16 * 1048576 && slow()) {
        const offset = Math.floor(probe.total * 0.1);
        resample = await rangeProbe(probe.finalUrl || url, `${offset}-${offset + MOVIE_SAMPLE_BYTES - 1}`, headers);
        probe.samples = 2;
        if (!resample.error && resample.bytes >= 1048576 && mbps(resample.bytes, resample.readMs) > mbps(probe.bytes, probe.readMs)) {
            probe.bytes = resample.bytes;
            probe.readMs = resample.readMs;
        }
    }

    let seek = null;
    if (!probe.error && probe.status === 206 && probe.total > 4 * 1048576) {
        const offset = Math.floor(probe.total / 2);
        const r = await rangeProbe(probe.finalUrl || url, `${offset}-${offset + 65535}`, headers);
        const start = /^bytes (\d+)-/.exec(r.headers['content-range'] || '')?.[1];
        seek = { offset, ok: !r.error && r.status === 206 && Number(start) === offset, error: r.error || `status ${r.status}`, hops: r.hops };
    }

    const { findings, metrics } = analyzeMovie({
        probes, seek, account, durationSecs: item.durationSecs, forceProxy,
        extension: item.container_extension || (item.stream_url || '').split('?')[0].split('.').pop()
    });
    const timeline = [
        ...probes.map((p, i) => ({ label: `start of file, try ${i + 1}`, ok: !p.error, hops: p.hops, totalMs: sumMs(p.hops) + (p.readMs || 0), error: p.error })),
        ...(resample ? [{ label: 'second speed sample', ok: !resample.error, hops: resample.hops, totalMs: sumMs(resample.hops) + (resample.readMs || 0), error: resample.error }] : []),
        ...(seek ? [{ label: 'jump to middle of file', ok: seek.ok, hops: seek.hops, totalMs: sumMs(seek.hops), error: seek.ok ? null : seek.error }] : [])
    ];
    // finalUrl can carry the account's credentials, buffer is binary: neither belongs in the report
    const strip = ({ buffer, finalUrl, ...rest }) => rest;
    return { findings, metrics, timeline, steps: { probes: probes.map(strip), seek } };
}

// --- entry points ----------------------------------------------------------

async function readAccount(source) {
    if (source.type !== 'xtream') return null;
    try {
        const { user_info: u } = await xtreamApi.createFromSource(source).authenticate();
        return { status: u.status, max_connections: u.max_connections, active_cons: u.active_cons, exp_date: u.exp_date };
    } catch (err) { return { error: redact(err.message) }; }
}

// Episodes are not stored: the provider lists them per series, cached like the series page does.
async function loadSeriesInfo(source, seriesId) {
    const key = `series_info_${seriesId}`;
    const cached = cache.get('xtream', source.id, key, 3600000);
    if (cached) return cached;
    const data = await xtreamApi.createFromSource(source).getSeriesInfo(seriesId);
    cache.set('xtream', source.id, key, data);
    return data;
}

/** Seasons and episodes of a series, for the checklist. Null when the series does not exist (or is adult). */
async function seriesOutline(sourceId, seriesId) {
    const series = getDb().prepare(`
        SELECT p.name FROM playlist_items p
        WHERE p.source_id = ? AND p.item_id = ? AND p.type = 'series' ${contentFilter.itemClause('p', true)}
    `).get(sourceId, String(seriesId));
    const source = series && await sources.getById(sourceId);
    if (!series || !source) return null;
    if (source.type !== 'xtream') {
        throw Object.assign(new Error('episodes can only be listed for xtream sources'), { statusCode: 400 });
    }

    const raw = (await loadSeriesInfo(source, seriesId)).episodes || {};
    const entries = Array.isArray(raw) ? raw.map((episodes, i) => [String(i + 1), episodes]) : Object.entries(raw);
    const seasons = entries.map(([number, episodes]) => ({
        season: parseInt(number) || 0,
        episodes: (episodes || []).map(ep => ({
            id: String(ep.id), number: Number(ep.episode_num) || null,
            title: ep.title || `episode ${ep.episode_num}`, ext: ep.container_extension || 'mp4',
            duration: Number(ep.info?.duration_secs) || null
        }))
    })).sort((a, b) => a.season - b.season);
    return { name: series.name, source_id: sourceId, series_id: String(seriesId), seasons };
}

const pad = n => String(n ?? 0).padStart(2, '0');

/** Diagnoses one live channel, movie or series episode. Returns null when it does not exist (or is adult). */
async function diagnose(type, sourceId, itemId, { seriesId } = {}) {
    if (!['live', 'movie', 'episode'].includes(type)) return null;
    let item, source;
    if (type === 'episode') {
        const outline = seriesId == null ? null : await seriesOutline(sourceId, seriesId);
        const season = outline?.seasons.find(s => s.episodes.some(e => e.id === String(itemId)));
        const episode = season?.episodes.find(e => e.id === String(itemId));
        if (!episode) return null;
        item = {
            name: `${outline.name} S${pad(season.season)}E${pad(episode.number)} ${episode.title}`.trim(),
            source_id: sourceId, item_id: episode.id, container_extension: episode.ext, series_id: outline.series_id,
            durationSecs: episode.duration
        };
        source = await sources.getById(sourceId);
    } else {
        item = getDb().prepare(`
            SELECT p.name, p.source_id, p.item_id, p.stream_url, p.container_extension FROM playlist_items p
            WHERE p.source_id = ? AND p.item_id = ? AND p.type = ? ${contentFilter.itemClause('p', true)}
        `).get(sourceId, String(itemId), type);
        source = item && await sources.getById(sourceId);
    }
    if (!item || !source) return null;

    const account = await readAccount(source);
    if (type === 'movie' && source.type === 'xtream') {
        // Optional: with the duration the speed can be judged against the video's real bitrate.
        try { item.durationSecs = Number((await xtreamApi.createFromSource(source).getVodInfo(item.item_id)).info?.duration_secs) || null; } catch { /* falls back to fixed limits */ }
    }
    const folder = type === 'episode' ? 'series' : 'movie';
    // Whether playback goes through this server decides how much a failure from here matters.
    const forceProxy = (await settings.get().catch(() => ({}))).forceProxy === true;
    const result = await (type === 'live' ? diagnoseLive(item, source, account, forceProxy) : diagnoseMovie(item, source, account, folder, forceProxy));
    const verdict = verdictOf(result.findings);
    return {
        kind: type,
        item: { name: item.name, source_id: item.source_id, item_id: item.item_id, ext: item.container_extension || null, ...(item.series_id && { series_id: item.series_id }) },
        sourceType: source.type,
        playback: { forceProxy },
        url: redact(type === 'live' ? streamUrl(item, source) : movieUrl(item, source, folder)),
        account,
        verdict,
        ...(verdict === 'warn' && result.findings.some(f => f.code === 'cdn_blocked') && { verdictLabel: 'could not be tested from this server' }),
        ...result,
        at: Date.now()
    };
}

/** Movies or series matching a name, for the manual checks. Adult titles are never returned. */
async function searchTitles(type, query, limit = 40) {
    const names = new Map((await sources.getAll()).map(s => [s.id, s.name]));
    const like = `%${String(query).replace(/[\\%_]/g, '\\$&')}%`;
    return getDb().prepare(`
        SELECT p.name, p.source_id, p.item_id, p.year, p.container_extension, p.is_hidden FROM playlist_items p
        WHERE p.type = ? AND p.name LIKE ? ESCAPE '\\' ${contentFilter.itemClause('p', true)}
        ORDER BY p.name COLLATE NOCASE LIMIT ?
    `).all(type, like, limit).map(row => ({ ...row, source: names.get(row.source_id) || `source ${row.source_id}` }));
}

const searchMovies = (query, limit) => searchTitles('movie', query, limit);

module.exports = { diagnose, searchTitles, searchMovies, seriesOutline, analyzeLive, analyzeMovie, parsePlaylist, detectContainer, moovPosition, verdictOf };
