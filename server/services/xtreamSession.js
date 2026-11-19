/**
 * One Xtream session per provider login, shared by every burzum user and every server-side caller.
 *
 * Panels open a new session (and count a connection) on every hit of /live|movie|series/<user>/<pass>/...,
 * then redirect to an edge server with a token. Only the first request hits the panel; every other request,
 * for any channel, goes straight to the edge with that token. The token is tied to the provider username,
 * so the key is the panel origin plus that username.
 */
const { validateHttpUrl } = require('./urlSecurity');

const PANEL_TIMEOUT_MS = 15000;
const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};
const sessions = new Map(); // "<panel origin>|<user>" -> Promise<{ origin, search } | null>

function accountKey(url) {
    const { origin, pathname } = new URL(url);
    const match = pathname.match(/^\/(?:live|movie|series)\/([^/]+)\/[^/]+\/[^/]+$/);
    return match ? `${origin}|${match[1]}` : null;
}

// Concurrent callers share one in-flight panel request, so simultaneous plays still open a single session.
function sessionFor(key, url, headers) {
    if (!sessions.has(key)) {
        const pending = (async () => {
            const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(PANEL_TIMEOUT_MS) });
            await response.body?.cancel();
            const location = response.headers.get('location');
            if (response.status < 300 || response.status >= 400 || !location) return null; // panel serves directly
            const edge = new URL(location, url);
            validateHttpUrl(edge.href);
            // Only a redirect that keeps the path can be reused for other channels.
            return edge.pathname === new URL(url).pathname ? { origin: edge.origin, search: edge.search } : null;
        })();
        sessions.set(key, pending);
        pending.catch(() => { if (sessions.get(key) === pending) sessions.delete(key); });
    }
    return sessions.get(key);
}

/**
 * Returns the URL to fetch instead of `url`. `reused` is true when it points at the edge with the shared
 * token; when that request is refused, call `renew()` and resolve again (concurrent failures renew once).
 */
async function resolve(url, headers = DEFAULT_HEADERS) {
    const key = accountKey(url);
    if (!key) return { target: url, reused: false, renew() {} };
    const session = sessionFor(key, url, headers);
    const edge = await session;
    if (!edge) return { target: url, reused: false, renew() {} };
    return {
        target: `${edge.origin}${new URL(url).pathname}${edge.search}`,
        reused: true,
        renew() { if (sessions.get(key) === session) sessions.delete(key); }
    };
}

// For ffmpeg/ffprobe inputs, which cannot renew mid-stream.
// shortcut: a token revoked mid-stream makes ffmpeg fail until the next play renews it; upgrade by feeding ffmpeg from proxyStream
async function edgeUrl(url) {
    try { return (await resolve(url)).target; } catch { return url; }
}

module.exports = { resolve, edgeUrl };
