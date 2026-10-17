/**
 * Health Page Controller (admin only)
 *
 * Live channel monitor results, manual diagnosis for channels, movies and series episodes.
 */

class HealthPage {
    constructor(app) {
        this.app = app;
        this.timer = null;
        this.data = null;
        this.filter = 'all';
        this.query = '';
        this.modalJson = null;
        this.searchTimers = {};
        this.searchRequests = { movie: 0, series: 0 };
        this.series = null; // the open series: { outline, selected, results, running, stop }

        const $ = id => document.getElementById(id);
        $('health-run')?.addEventListener('click', async () => {
            await API.channelHealth.run();
            this.load();
        });
        $('health-report')?.addEventListener('click', e => this.copyReport(e.currentTarget));
        $('health-search')?.addEventListener('input', e => { this.query = e.target.value.trim().toLowerCase(); this.renderRows(); });
        $('health-chips')?.addEventListener('click', e => {
            const chip = e.target.closest('[data-filter]');
            if (chip) { this.filter = chip.dataset.filter; this.render(); }
        });
        document.querySelectorAll('.health-tab').forEach(tab => tab.addEventListener('click', () => this.switchTab(tab.dataset.htab)));
        $('health-rows')?.addEventListener('click', e => this.rowClick(e));
        $('health-movie-rows')?.addEventListener('click', e => this.rowClick(e));
        for (const kind of ['movie', 'series']) {
            $(`health-${kind}-search`)?.addEventListener('input', e => {
                clearTimeout(this.searchTimers[kind]);
                this.searchTimers[kind] = setTimeout(() => this.searchTitles(kind, e.target.value.trim()), 300);
            });
        }
        $('health-series-rows')?.addEventListener('click', e => this.rowClick(e));
        $('series-back')?.addEventListener('click', () => this.closeSeries());
        $('series-select-all')?.addEventListener('click', () => this.selectEpisodes(() => true));
        $('series-clear')?.addEventListener('click', () => this.selectEpisodes(() => false));
        $('series-run')?.addEventListener('click', () => this.runChecklist());
        $('series-stop')?.addEventListener('click', () => { if (this.series) this.series.stop = true; });
        $('series-copy')?.addEventListener('click', e => this.copySeriesResults(e.currentTarget));
        $('series-seasons')?.addEventListener('change', e => this.checklistChange(e));
        $('series-seasons')?.addEventListener('click', e => {
            const view = e.target.closest('[data-view]');
            if (view) this.showEpisodeResult(view.dataset.view);
        });
        $('health-modal-close')?.addEventListener('click', () => this.closeModal());
        $('health-modal-done')?.addEventListener('click', () => this.closeModal());
        $('health-modal')?.addEventListener('click', e => { if (e.target.id === 'health-modal') this.closeModal(); });
        $('health-modal-browser')?.addEventListener('click', () => this.browserTest());
        $('health-modal-copy')?.addEventListener('click', e => this.copyText(JSON.stringify(this.modalJson, null, 2), e.currentTarget));
    }

    show() {
        this.load();
        this.timer = setInterval(() => this.load(), 5000);
    }

    hide() {
        clearInterval(this.timer);
    }

    async load() {
        try {
            this.data = await API.channelHealth.get();
            this.render();
        } catch (err) {
            console.error('[Health] Failed to load:', err);
            document.getElementById('health-summary').textContent = `failed to load: ${err.message}`;
        }
    }

    // ---- formatting -------------------------------------------------------

    esc(text) {
        const el = document.createElement('div');
        el.textContent = text ?? '';
        return el.innerHTML;
    }

    span(ms) {
        const s = Math.round(ms / 1000);
        if (s < 90) return `${s}s`;
        const m = Math.round(s / 60);
        return m < 90 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
    }

    ago(ts) {
        return `${this.span(Date.now() - ts)} ago`;
    }

    // ---- live dashboard ---------------------------------------------------

    isFlaky(c) { return c.status === 'online' && !!c.debug; }

    render() {
        const d = this.data, channels = d.channels;
        const count = {
            online: channels.filter(c => c.status === 'online').length,
            offline: channels.filter(c => c.status !== 'online').length,
            flaky: channels.filter(c => this.isFlaky(c)).length,
            hidden: channels.filter(c => c.auto_hidden).length
        };

        document.getElementById('health-cards').innerHTML = [
            ['ok', count.online, 'online'], ['bad', count.offline, 'offline'],
            ['warn', count.flaky, 'needed a retry'], ['muted', count.hidden, 'hidden by the monitor']
        ].map(([tone, n, label]) => `<div class="health-card ${tone}"><div class="num">${n}</div><div class="lbl">${label}</div></div>`).join('');

        const s = d.summary;
        const banner = document.getElementById('health-banner');
        banner.classList.toggle('hidden', !s?.suspect);
        if (s?.suspect) {
            banner.textContent = `${(s.failureRate * 100).toFixed(1)}% of the channels failed in the last run, so nothing was hidden. ` +
                'a provider does not lose that many channels at once: this points to the network or the provider, not to the channels.';
        }

        document.getElementById('health-summary').textContent = d.running
            ? `${d.phase}: ${d.checked} of ${d.total}`
            : s ? `last run ${this.ago(d.lastRun)}: checked ${s.total} channels in ${this.span(s.durationMs)}` : 'no run has finished yet';
        document.getElementById('health-schedule').textContent = d.running ? 'running now'
            : d.nextRun ? (d.nextRun <= Date.now() ? 'next run: any moment now' : `next run in ${this.span(d.nextRun - Date.now())}`) + ` · every ${d.intervalMin} min`
                : '';
        const progress = document.getElementById('health-progress');
        progress.classList.toggle('hidden', !d.running);
        document.getElementById('health-progress-bar').style.width = d.total ? `${Math.round(d.checked / d.total * 100)}%` : '0';
        document.getElementById('health-stats').textContent = this.describeRun(s);

        document.getElementById('health-chips').innerHTML = [
            ['all', 'all', channels.length], ['offline', 'offline', count.offline], ['flaky', 'needed a retry', count.flaky],
            ['hidden', 'hidden', count.hidden], ['online', 'online', count.online]
        ].map(([key, label, n]) => `<button class="health-chip${this.filter === key ? ' active' : ''}" data-filter="${key}">${label} ${n}</button>`).join('');

        this.renderRows();
    }

    describeRun(s) {
        if (!s) return 'nothing to show yet';
        const list = obj => Object.entries(obj).map(([k, n]) => `${k} x${n}`).join(', ') || 'none';
        const hosts = Object.entries(s.hosts).map(([h, v]) => `${h} ${v.fail}/${v.ok + v.fail}`).join(', ') || 'none';
        return [
            `failed on the first pass: ${s.failedFirstPass}`,
            `recovered on the recheck: ${s.recoveredOnRecheck} (high numbers mean the provider starts channels on demand)`,
            `still failing: ${s.failedFinal} (${(s.failureRate * 100).toFixed(1)}%)`,
            `hidden: ${s.hidden}, brought back: ${s.restored}`,
            `errors: ${list(s.finalErrors)}`,
            `failures by upstream host (failed/total): ${hosts}`,
            `settings: ${s.config.perSourceConcurrency} parallel per source, ${s.config.timeoutMs / 1000}s timeout, ${s.config.node}`
        ].join('\n');
    }

    matches(c) {
        if (this.query && !c.name.toLowerCase().includes(this.query)) return false;
        switch (this.filter) {
            case 'offline': return c.status !== 'online';
            case 'online': return c.status === 'online';
            case 'flaky': return this.isFlaky(c);
            case 'hidden': return !!c.auto_hidden;
            default: return true;
        }
    }

    renderRows() {
        const rows = this.data.channels.filter(c => this.matches(c));
        document.getElementById('health-rows').innerHTML = rows.slice(0, 500).map(c => {
            const attrs = `data-type="live" data-source="${c.source_id}" data-item="${this.esc(c.item_id)}"`;
            let pill;
            if (c.status !== 'online') pill = `<span class="pill bad">offline${c.auto_hidden ? ' · hidden' : ''}</span><span class="cause">${this.esc(c.error)}</span>`;
            else if (c.debug) pill = '<span class="pill warn">flaky</span><span class="cause">needed a retry</span>';
            else pill = '<span class="pill ok">online</span>';
            return `<tr>
                <td class="name">${this.esc(c.name)}</td>
                <td>${pill}</td>
                <td>${c.latency_ms == null ? '-' : c.latency_ms + ' ms'}</td>
                <td>${this.ago(c.checked_at)}</td>
                <td class="actions">${c.debug ? `<button class="btn btn-sm btn-ghost" data-action="trace" ${attrs}>trace</button>` : ''}
                    <button class="btn btn-sm btn-secondary" data-action="diagnose" ${attrs}>diagnose</button></td>
            </tr>`;
        }).join('');
        const empty = document.getElementById('health-empty');
        empty.classList.toggle('hidden', rows.length > 0);
        empty.textContent = this.data.channels.length ? 'no channel matches this filter' : 'no channel has been checked yet';
        if (rows.length > 500) empty.classList.remove('hidden'), empty.textContent = `showing 500 of ${rows.length}, refine the search`;
    }

    switchTab(name) {
        document.querySelectorAll('.health-tab').forEach(t => t.classList.toggle('active', t.dataset.htab === name));
        document.querySelectorAll('.health-panel').forEach(p => p.classList.toggle('active', p.id === `hpanel-${name}`));
    }

    // ---- movies and series ------------------------------------------------

    async searchTitles(kind, query) {
        const rows = document.getElementById(`health-${kind}-rows`);
        const empty = document.getElementById(`health-${kind}-empty`);
        const request = ++this.searchRequests[kind];
        if (query.length < 2) { rows.innerHTML = ''; empty.classList.add('hidden'); return; }
        try {
            const found = await (kind === 'movie' ? API.channelHealth.searchMovies(query) : API.channelHealth.searchSeries(query));
            if (request !== this.searchRequests[kind]) return;
            const action = kind === 'movie' ? 'diagnose' : 'open-series';
            const label = kind === 'movie' ? 'diagnose' : 'open';
            rows.innerHTML = found.map(m => `<tr>
                <td class="name">${this.esc(m.name)}${m.year ? ` <span class="cause">${this.esc(String(m.year).slice(0, 10))}</span>` : ''}</td>
                <td>${this.esc(m.source)}</td>
                <td class="actions"><button class="btn btn-sm btn-secondary" data-action="${action}" data-type="${kind}" data-source="${m.source_id}" data-item="${this.esc(m.item_id)}" data-name="${this.esc(m.name)}">${label}</button></td>
            </tr>`).join('');
            empty.classList.toggle('hidden', found.length > 0);
            empty.textContent = `no ${kind} found`;
        } catch (err) {
            empty.classList.remove('hidden');
            empty.textContent = `search failed: ${err.message}`;
        }
    }

    // ---- series checklist -------------------------------------------------

    $(id) { return document.getElementById(id); }

    async openSeries(sourceId, seriesId, name) {
        this.$('series-search-view').classList.add('hidden');
        this.$('series-checklist-view').classList.remove('hidden');
        this.$('series-title').textContent = name;
        this.$('series-seasons').innerHTML = '<p class="hint">loading episodes from the provider...</p>';
        this.series = null;
        this.updateChecklistControls();
        try {
            const outline = await API.channelHealth.seriesEpisodes(sourceId, seriesId);
            this.series = { outline, selected: new Set(), results: new Map(), running: false, stop: false };
            this.renderChecklist();
        } catch (err) {
            this.$('series-seasons').innerHTML = `<p class="hint">${this.esc(err.message)}</p>`;
        }
    }

    closeSeries() {
        this.series = null;
        this.$('series-checklist-view').classList.add('hidden');
        this.$('series-search-view').classList.remove('hidden');
    }

    episodeIds() {
        return this.series.outline.seasons.flatMap(s => s.episodes.map(e => e.id));
    }

    renderChecklist() {
        const { outline } = this.series;
        if (!outline.seasons.some(s => s.episodes.length)) {
            this.$('series-seasons').innerHTML = '<p class="hint">the provider lists no episodes for this series</p>';
            return;
        }
        this.$('series-seasons').innerHTML = outline.seasons.map(season => `
            <details class="season-box" open data-season="${season.season}">
                <summary><input type="checkbox" data-season-check="${season.season}" aria-label="select the whole season">
                    <span>season ${season.season} <span class="cause">${season.episodes.length} episodes</span></span></summary>
                ${season.episodes.map(ep => `
                <label class="ep-row" data-row="${this.esc(ep.id)}">
                    <input type="checkbox" data-ep="${this.esc(ep.id)}">
                    <span class="num">E${String(ep.number ?? 0).padStart(2, '0')}</span>
                    <span class="name">${this.esc(ep.title)}</span>
                    <span class="ep-result"></span>
                </label>`).join('')}
            </details>`).join('');
        this.updateChecklistControls();
    }

    checklistChange(e) {
        if (!this.series || this.series.running) return;
        const { selected } = this.series;
        if (e.target.dataset.ep) {
            e.target.checked ? selected.add(e.target.dataset.ep) : selected.delete(e.target.dataset.ep);
        } else if (e.target.dataset.seasonCheck) {
            const season = this.series.outline.seasons.find(s => String(s.season) === e.target.dataset.seasonCheck);
            season.episodes.forEach(ep => e.target.checked ? selected.add(ep.id) : selected.delete(ep.id));
        }
        this.updateChecklistControls();
    }

    selectEpisodes(predicate) {
        if (!this.series || this.series.running) return;
        this.series.selected = new Set(this.episodeIds().filter(predicate));
        this.updateChecklistControls();
    }

    // Keeps every checkbox, count and button in step with the selection without redrawing (which would collapse the seasons).
    updateChecklistControls() {
        const state = this.series, running = !!state?.running;
        const box = this.$('series-seasons');
        if (state) {
            box.querySelectorAll('[data-ep]').forEach(i => { i.checked = state.selected.has(i.dataset.ep); i.disabled = running; });
            state.outline.seasons.forEach(season => {
                const input = box.querySelector(`[data-season-check="${season.season}"]`);
                if (!input) return;
                const picked = season.episodes.filter(ep => state.selected.has(ep.id)).length;
                input.checked = picked > 0 && picked === season.episodes.length;
                input.indeterminate = picked > 0 && picked < season.episodes.length;
                input.disabled = running;
            });
        }
        const picked = state?.selected.size || 0;
        const run = this.$('series-run');
        run.textContent = `Test selected (${picked})`;
        run.disabled = !picked || running;
        this.$('series-stop').classList.toggle('hidden', !running);
        this.$('series-select-all').disabled = this.$('series-clear').disabled = !state || running;
        this.$('series-copy').disabled = !state?.results.size;
    }

    verdictPill(result) {
        if (result.error && !result.verdict) return `<span class="pill bad">failed</span><span class="cause">${this.esc(result.error)}</span>`;
        const label = { ok: 'healthy', warn: 'issues', bad: 'broken' }[result.verdict];
        const issue = result.findings.find(f => f.level === 'bad') || result.findings.find(f => f.level === 'warn');
        return `<span class="pill ${result.verdict}">${label}</span>` + (issue ? `<span class="cause" title="${this.esc(issue.title)}">${this.esc(issue.title)}</span>` : '') +
            ` <button class="btn btn-sm btn-ghost" type="button" data-view="${this.esc(result.item?.item_id ?? '')}">details</button>`;
    }

    setEpisodeCell(id, html) {
        const cell = this.$('series-seasons').querySelector(`[data-row="${CSS.escape(id)}"] .ep-result`);
        if (cell) cell.innerHTML = html;
    }

    showEpisodeResult(id) {
        const result = this.series?.results.get(id);
        if (!result?.verdict) return;
        this.modalJson = result;
        this.openModal(`episode: ${result.item.name}`, this.renderDiagnosis(result));
    }

    // One episode at a time: the account usually allows a single connection, and results show up as they arrive.
    async runChecklist() {
        const state = this.series;
        if (!state || state.running || !state.selected.size) return;
        const ids = this.episodeIds().filter(id => state.selected.has(id));
        const { source_id: sourceId, series_id: seriesId } = state.outline;
        state.running = true;
        state.stop = false;
        this.updateChecklistControls();
        let done = 0;
        for (const id of ids) {
            if (state.stop) break;
            this.$('series-progress').textContent = `testing ${done + 1} of ${ids.length}...`;
            this.setEpisodeCell(id, '<span class="pill muted">testing...</span>');
            try {
                state.results.set(id, await API.channelHealth.diagnose('episode', sourceId, id, seriesId));
            } catch (err) {
                state.results.set(id, { error: err.message });
            }
            this.setEpisodeCell(id, this.verdictPill(state.results.get(id)));
            done++;
        }
        ids.slice(done).forEach(id => this.setEpisodeCell(id, ''));
        state.running = false;
        const tally = v => ids.filter(id => state.results.get(id)?.verdict === v).length;
        const failed = ids.filter(id => state.results.get(id)?.error && !state.results.get(id)?.verdict).length;
        this.$('series-progress').textContent = `${state.stop ? 'stopped after' : 'tested'} ${done}: ${tally('ok')} healthy, ${tally('warn')} with issues, ${tally('bad')} broken` + (failed ? `, ${failed} failed to run` : '');
        this.updateChecklistControls();
    }

    copySeriesResults(button) {
        const { outline, results } = this.series;
        const rows = outline.seasons.flatMap(season => season.episodes.filter(ep => results.has(ep.id)).map(ep => {
            const r = results.get(ep.id);
            return { season: season.season, episode: ep.number, title: ep.title, verdict: r.verdict || 'failed', error: r.error, result: r.verdict ? r : undefined };
        }));
        this.copyText(JSON.stringify({ generated: new Date().toISOString(), series: outline.name, source_id: outline.source_id, series_id: outline.series_id, episodes: rows }, null, 2), button);
    }

    // ---- diagnosis modal --------------------------------------------------

    rowClick(e) {
        const button = e.target.closest('button[data-action]');
        if (!button) return;
        const { action, type, source, item, name } = button.dataset;
        if (action === 'open-series') {
            this.openSeries(parseInt(source), item, name);
        } else if (action === 'trace') {
            const channel = this.data.channels.find(c => String(c.source_id) === source && String(c.item_id) === item);
            this.showTrace(channel);
        } else {
            const channel = this.data?.channels.find(c => String(c.source_id) === source && String(c.item_id) === item);
            this.diagnose(type, parseInt(source), item, name || channel?.name);
        }
    }

    openModal(title, bodyHtml) {
        document.getElementById('health-modal-browser').classList.toggle('hidden', !this.canBrowserTest(this.modalJson));
        document.getElementById('health-modal-title').textContent = title;
        document.getElementById('health-modal-body').innerHTML = bodyHtml;
        document.getElementById('health-modal').classList.add('active');
    }

    closeModal() {
        document.getElementById('health-modal').classList.remove('active');
    }

    async diagnose(type, sourceId, itemId, name) {
        this.modalJson = null;
        const wait = type === 'live' ? 'this takes up to a minute: it samples the playlist twice and downloads a segment' : 'this takes up to half a minute: it downloads the start of the file and tests seeking';
        this.openModal(`diagnosing ${name || ''}`, `<p class="diag-loading hint">${wait}...</p>`);
        try {
            const result = await API.channelHealth.diagnose(type, sourceId, itemId);
            this.modalJson = result;
            this.openModal(`${{ live: 'channel', movie: 'movie', episode: 'episode' }[result.kind]}: ${result.item.name}`, this.renderDiagnosis(result));
        } catch (err) {
            this.openModal('diagnosis failed', `<p>${this.esc(err.message)}</p>`);
        }
    }

    showTrace(channel) {
        this.modalJson = { channel: this.brief(channel), attempts: channel.debug };
        const rows = channel.debug.map((a, i) => ({
            label: `${a.plain ? 'no headers' : 'try'} ${i + 1}`, ok: !a.error, hops: a.hops, totalMs: a.totalMs, error: a.error
        }));
        const tone = channel.status === 'online' ? 'warn' : 'bad';
        const head = channel.status === 'online' ? 'works, but needed a retry' : `offline: ${channel.error}`;
        this.openModal(`trace: ${channel.name}`,
            `<div class="verdict ${tone}"><div class="head">${this.esc(head)}</div><div class="sub">saved by the monitor ${this.ago(channel.checked_at)}. run a diagnosis for a fresh and deeper test.</div></div>` +
            this.renderTimeline(rows) + this.renderRaw(this.modalJson));
    }

    renderFindings(findings) {
        return `<ul class="findings">${findings.map(f => `<li><span class="dot ${f.level}"></span><div><div class="t">${this.esc(f.title)}</div>${f.detail ? `<div class="d">${this.esc(f.detail)}</div>` : ''}</div></li>`).join('')}</ul>`;
    }

    renderMetrics(metrics) {
        return metrics.length ? `<div class="metrics">${metrics.map(m => `<div><div class="v">${this.esc(m.value)}</div><div class="l">${this.esc(m.label)}</div></div>`).join('')}</div>` : '';
    }

    renderDiagnosis(r) {
        const verdict = r.verdictLabel || { ok: 'healthy', warn: 'works, but has issues', bad: 'broken' }[r.verdict];
        const metrics = [...r.metrics];
        if (r.account && !r.account.error) {
            metrics.push({ label: 'account', value: r.account.status });
            metrics.push({ label: 'connections', value: `${r.account.active_cons} of ${r.account.max_connections}` });
            if (Number(r.account.exp_date)) metrics.push({ label: 'expires', value: new Date(r.account.exp_date * 1000).toISOString().slice(0, 10) });
        }
        return `<div class="verdict ${r.verdict}"><div class="head">${this.esc(verdict)}</div><div class="sub">${this.esc(r.url)}</div></div>` +
            this.renderFindings(r.findings) + this.renderMetrics(metrics) +
            '<div id="browser-test"></div>' + this.renderTimeline(r.timeline) + this.renderRaw(r);
    }

    // ---- test in this browser ---------------------------------------------
    //
    // What a viewer actually gets: the stream loaded and played by this browser, the way the
    // player does it (straight from the provider, or through this server when "force proxy"
    // is on). The result is compared with the server's own probe to reach a conclusion.

    canBrowserTest(r) {
        return !!r && ['live', 'movie', 'episode'].includes(r.kind) && r.sourceType === 'xtream';
    }

    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // Resolves true when `name` fires on the target, false after `ms`.
    waitFor(target, name, ms) {
        return new Promise(resolve => {
            const timer = setTimeout(() => { target.removeEventListener(name, onEvent); resolve(false); }, ms);
            const onEvent = () => { clearTimeout(timer); resolve(true); };
            target.addEventListener(name, onEvent, { once: true });
        });
    }

    makeVideo() {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.style.display = 'none';
        document.body.appendChild(video);
        return video;
    }

    dropVideo(video) {
        video.removeAttribute('src');
        video.load();
        video.remove();
    }

    newSample(url, path) {
        const conn = navigator.connection;
        return {
            host: new URL(url, location.href).host, path, stalls: 0, stallMs: 0, playing: false,
            env: {
                userAgent: navigator.userAgent, page: location.protocol,
                mixedContent: location.protocol === 'https:' && url.startsWith('http:'),
                connection: conn ? { type: conn.effectiveType, downlinkMbps: conn.downlink, rttMs: conn.rtt } : null
            }
        };
    }

    bufferEnd(video) {
        return video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    }

    // Can the browser reach the address at all? An opaque no-cors request only fails on network-level problems.
    async checkReachable(url) {
        const controller = new AbortController();
        try {
            await fetch(url, { mode: 'no-cors', headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.any ? AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) : controller.signal });
            return true;
        } catch { return false; } finally { controller.abort(); }
    }

    // Plays for a while and records stalls, how much is buffered ahead, dropped frames. Stalls are only
    // counted during this phase: the waiting caused by a seek afterwards is not a playback problem.
    async measurePlayback(video, sample, playMs, t0, live = false) {
        let counting = true, stalledAt = null;
        video.addEventListener('waiting', () => { if (counting && sample.playing) { sample.stalls++; stalledAt = performance.now(); } });
        video.addEventListener('playing', () => { if (counting && stalledAt) { sample.stallMs += Math.round(performance.now() - stalledAt); stalledAt = null; } });

        const started = this.waitFor(video, 'playing', 15000);
        video.play().catch(err => { sample.playError = err.name; });
        sample.playing = await started;
        if (!sample.playing) return;
        sample.startMs = Math.round(performance.now() - t0);

        const wall0 = performance.now(), buffer0 = this.bufferEnd(video), time0 = video.currentTime;
        await this.sleep(playMs);
        counting = false;
        const wallSec = (performance.now() - wall0) / 1000;
        sample.advancedSec = Number((video.currentTime - time0).toFixed(2));
        sample.fillRate = Number(((this.bufferEnd(video) - buffer0) / wallSec).toFixed(2));
        sample.bufferAheadSec = Number((this.bufferEnd(video) - video.currentTime).toFixed(1));
        // A live playlist's duration is just what it has buffered, so "fully buffered" only means something for files.
        sample.fullyBuffered = !live && Number.isFinite(video.duration) && this.bufferEnd(video) >= video.duration - 0.5;
        const quality = video.getVideoPlaybackQuality?.();
        if (quality) { sample.frames = quality.totalVideoFrames; sample.dropped = quality.droppedVideoFrames; }
    }

    async measureSeek(video, sample) {
        if (!Number.isFinite(video.duration) || video.duration < 60) return;
        const t0 = performance.now();
        const seeked = this.waitFor(video, 'seeked', 10000);
        video.currentTime = Math.floor(video.duration * 0.5);
        sample.seekOk = await seeked;
        sample.seekMs = Math.round(performance.now() - t0);
        if (!sample.seekOk) return;
        const at = video.currentTime;
        await this.sleep(3000);
        sample.seekPlayedSec = Number((video.currentTime - at).toFixed(2));
    }

    async probeVideo(url, { playMs = 8000, loadTimeoutMs = 15000, seek = true, path = 'direct', live = false } = {}) {
        const video = this.makeVideo(), sample = this.newSample(url, path), t0 = performance.now();
        sample.live = live;
        try {
            const loaded = this.waitFor(video, 'loadedmetadata', loadTimeoutMs);
            const failed = this.waitFor(video, 'error', loadTimeoutMs);
            video.src = url;
            const outcome = await Promise.race([loaded.then(ok => ok && 'loaded'), failed.then(ok => ok && 'error'), this.sleep(loadTimeoutMs).then(() => 'timeout')]);
            if (outcome !== 'loaded') {
                if (outcome === 'error') { sample.errorCode = video.error?.code; sample.errorMessage = video.error?.message || ''; } else sample.loadTimeout = true;
                sample.reachable = await this.checkReachable(url);
                return sample;
            }
            sample.metadataMs = Math.round(performance.now() - t0);
            sample.duration = Math.round(video.duration);
            sample.width = video.videoWidth;
            sample.height = video.videoHeight;
            await this.measurePlayback(video, sample, playMs, t0, live);
            if (seek && sample.playing) await this.measureSeek(video, sample);
            if (video.error) { sample.errorCode = video.error.code; sample.errorMessage = video.error.message || ''; }
        } finally { this.dropVideo(video); }
        return sample;
    }

    // Live: hls.js, like the player. Without MSE (Safari) the native HLS support is used.
    async probeLive(url, { playMs = 10000, loadTimeoutMs = 20000, path = 'direct' } = {}) {
        if (!(window.Hls && Hls.isSupported())) {
            if (!document.createElement('video').canPlayType('application/vnd.apple.mpegurl')) {
                const sample = this.newSample(url, path);
                sample.unsupported = true;
                return sample;
            }
            return { ...(await this.probeVideo(url, { playMs, loadTimeoutMs, seek: false, path, live: true })), engine: 'native' };
        }
        const video = this.makeVideo(), sample = this.newSample(url, path), t0 = performance.now();
        Object.assign(sample, { engine: 'hls.js', live: true, frags: 0, fragLoadMs: [], fragSeconds: [], hlsErrors: [] });
        const hls = new Hls();
        try {
            const parsed = new Promise(resolve => hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => {
                sample.manifestMs = Math.round(performance.now() - t0);
                sample.levels = d.levels.length;
                sample.width = d.levels[0]?.width;
                sample.height = d.levels[0]?.height;
                resolve('parsed');
            }));
            const fatal = new Promise(resolve => hls.on(Hls.Events.ERROR, (_, d) => {
                sample.hlsErrors.push({ fatal: d.fatal, type: d.type, details: d.details, httpCode: d.response?.code ?? null });
                if (d.fatal) resolve('fatal');
            }));
            hls.on(Hls.Events.FRAG_LOADED, (_, d) => {
                const stats = d.frag.stats;
                sample.frags++;
                sample.fragLoadMs.push(Math.round(stats.loading.end - stats.loading.start));
                sample.fragSeconds.push(Number(d.frag.duration.toFixed(2)));
                if (sample.firstFragMs == null) sample.firstFragMs = Math.round(performance.now() - t0);
            });
            hls.attachMedia(video);
            hls.loadSource(url);
            const outcome = await Promise.race([parsed, fatal, this.sleep(loadTimeoutMs).then(() => 'timeout')]);
            if (outcome === 'timeout') sample.loadTimeout = true;
            if (outcome !== 'parsed') return sample;
            await Promise.race([this.measurePlayback(video, sample, playMs, t0, true), fatal]);
        } finally { hls.destroy(); this.dropVideo(video); }
        return sample;
    }

    // ---- reading the browser result

    analyzeBrowserProbe(s, server, playMs = 8000) {
        const findings = [], metrics = [];
        const add = (level, title, detail = '') => findings.push({ level, title, detail });
        const sec = ms => `${(ms / 1000).toFixed(1)}s`;
        const reasons = { 1: 'loading was aborted', 2: 'network error', 3: 'the video could not be decoded', 4: 'the format or address is not supported, or the response was not a playable video' };
        const hlsWords = {
            manifestLoadError: 'the playlist could not be loaded', manifestLoadTimeOut: 'the playlist timed out', manifestParsingError: 'the playlist is not valid',
            levelEmptyError: 'the playlist is empty', levelLoadError: 'a quality level could not be loaded', fragLoadError: 'a video segment could not be loaded',
            fragLoadTimeOut: 'a video segment timed out', fragParsingError: 'a video segment is corrupt', bufferStalledError: 'playback ran out of data',
            manifestIncompatibleCodecsError: 'the codecs are not supported by this browser'
        };
        const path = s.path === 'proxy' ? 'through this server\'s proxy' : 'straight from the provider';
        metrics.push({ label: 'browser path', value: s.path === 'proxy' ? 'via server proxy' : 'direct' });

        const fatal = s.hlsErrors?.find(e => e.fatal);
        if (s.unsupported) {
            add('info', 'this browser cannot play HLS', 'it has neither hls.js support (MediaSource) nor native HLS.');
        } else if (s.errorCode || fatal) {
            const why = fatal ? `${hlsWords[fatal.details] || fatal.details}${fatal.httpCode ? ` (http ${fatal.httpCode})` : ''}` : (reasons[s.errorCode] || `error ${s.errorCode}`);
            add('bad', `this browser could not play it ${path}`, `${why}${s.errorMessage ? ` · ${s.errorMessage}` : ''}. host: ${s.host}.`);
            if (s.reachable === true) add('info', 'the address is reachable from this browser', 'the request itself went through, so the response was not a playable video: a block page, a refusal, or an unsupported codec.');
            if (s.reachable === false) add('warn', 'the address is not reachable from this browser', `the request failed at the network level${s.env.mixedContent ? ' (an http file from an https page is blocked as mixed content)' : ''}.`);
        } else if (s.loadTimeout) {
            add('bad', `nothing loaded in this browser ${path}`, `${s.host} did not deliver the start of the stream within the time limit.${s.reachable === true ? ' The address itself is reachable.' : ''}`);
        } else {
            const loadMs = s.manifestMs ?? s.metadataMs;
            metrics.push({ label: s.manifestMs != null ? 'playlist loaded in' : 'details loaded in', value: sec(loadMs) });
            if (s.width) metrics.push({ label: 'resolution', value: `${s.width}x${s.height}` });
            const slowLoad = s.manifestMs != null ? [2000, 5000] : [3000, 8000];
            if (loadMs >= slowLoad[1]) add('bad', 'very slow to load', `${sec(loadMs)} before the player knows what it is playing.`);
            else if (loadMs >= slowLoad[0]) add('warn', 'slow to load', `${sec(loadMs)} before the player knows what it is playing.`);

            if (s.playError && !s.playing) {
                add('info', 'the browser would not autoplay it', `${s.playError}: it loaded fine, but the browser blocked the automatic start.`);
            } else if (!s.playing) {
                add('bad', 'it loaded but never started playing', 'the details arrived but no frame was shown.');
            } else {
                metrics.push({ label: 'time to first frame', value: sec(s.startMs) });
                if (s.startMs >= 6000) add('bad', 'very slow to start playing', `${sec(s.startMs)} from request to first frame.`);
                else if (s.startMs >= 3000) add('warn', 'slow to start playing', `${sec(s.startMs)} from request to first frame.`);

                if (s.advancedSec < playMs / 1000 * 0.6) add('bad', 'playback barely moved', `only ${s.advancedSec}s played in ${playMs / 1000}s: it is buffering constantly.`);
                else if (s.stalls > 0) add(s.stallMs >= 3000 ? 'bad' : 'warn', `playback stalled ${s.stalls} time${s.stalls > 1 ? 's' : ''}`, `${sec(s.stallMs)} waiting for data in ${playMs / 1000}s of playback.`);
                else add('ok', 'plays without interruptions', `${s.advancedSec}s played in ${playMs / 1000}s.`);

                if (!s.live) {
                    // Browsers stop fetching once ~30s are buffered (and serve repeat plays from cache), so a big lead is the proof of a fast connection.
                    if (s.fullyBuffered) add('ok', 'the whole file was buffered immediately', 'the connection is far faster than the video.');
                    else if (s.bufferAheadSec >= 15) add('ok', 'the connection is far ahead of playback', `${s.bufferAheadSec}s are already buffered ahead of the playhead.`);
                    else if (s.fillRate != null) {
                        metrics.push({ label: 'buffer fill speed', value: `${s.fillRate}x realtime` });
                        const sentence = `the buffer grew ${s.fillRate}s per second of playback and only ${s.bufferAheadSec}s are buffered ahead.`;
                        if (s.fillRate < 1) add('bad', 'downloading slower than playback', `${sentence} it will run dry and stall.`);
                        else if (s.fillRate < 1.5) add('warn', 'little room over playback speed', `${sentence} any dip will cause a stall.`);
                        else add('ok', 'downloads comfortably faster than playback', sentence);
                    }
                }
                if (s.frames > 30 && s.dropped / s.frames > 0.1) add('warn', 'many frames were dropped', `${s.dropped} of ${s.frames}: this device or browser struggles to decode it, regardless of the network.`);
            }
            if (s.frags) {
                const ratios = s.fragLoadMs.map((ms, i) => ms / (s.fragSeconds[i] * 1000));
                const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
                metrics.push({ label: 'segments loaded', value: String(s.frags) });
                metrics.push({ label: 'segment load / duration', value: `${Math.round(mean * 100)}%` });
                if (mean >= 0.9) add('bad', 'segments load slower than they play', `on average a segment takes ${Math.round(mean * 100)}% of its own duration to download.`);
                else if (mean >= 0.5) add('warn', 'segments load slowly', `on average a segment takes ${Math.round(mean * 100)}% of its own duration to download.`);
            }
            if (s.hlsErrors?.length && !fatal) add('warn', `${s.hlsErrors.length} recoverable error${s.hlsErrors.length > 1 ? 's' : ''} while playing`, [...new Set(s.hlsErrors.map(e => hlsWords[e.details] || e.details))].join('; '));
            if (s.seekOk === false) {
                const slow = s.fillRate != null && s.fillRate < 1 && s.bufferAheadSec < 15;
                add(slow ? 'warn' : 'bad', 'seeking did not complete in 10s',
                    slow ? 'jumping to the middle needs fresh data, and the connection is already too slow to keep up (see above), so this is expected.'
                        : 'jumping to the middle of the video never completed although playback itself was fine: the file host may not accept range requests.');
            }
            else if (s.seekOk) {
                metrics.push({ label: 'seek to middle', value: sec(s.seekMs) });
                if (s.seekMs >= 6000) add('bad', 'seeking is very slow', `${sec(s.seekMs)} to jump to the middle of the video.`);
                else if (s.seekMs >= 2500) add('warn', 'seeking is slow', `${sec(s.seekMs)} to jump to the middle of the video.`);
                else if (s.seekPlayedSec < 1.5) add('warn', 'playback stalls after seeking', `only ${s.seekPlayedSec}s played in the 3s after the jump.`);
                else add('ok', 'seeking works', `jumped to the middle in ${sec(s.seekMs)} and kept playing.`);
            }
        }
        return { findings, metrics, conclusion: this.concludeBrowser(s, server, playMs) };
    }

    // Puts the browser result next to the server's probe: who is affected, and what to do.
    concludeBrowser(s, server, playMs = 8000) {
        const fatal = s.hlsErrors?.some(e => e.fatal);
        const broken = !!(s.errorCode || fatal || s.loadTimeout || (!s.playing && !s.playError && !s.unsupported));
        const healthyBuffer = s.live || s.fullyBuffered || s.bufferAheadSec >= 15;
        const rough = !broken && (s.stalls > 0 || s.advancedSec < playMs / 1000 * 0.6 || (!healthyBuffer && s.fillRate != null && s.fillRate < 1.2));
        const forceProxy = server?.playback?.forceProxy;
        const serverBlocked = server?.findings?.some(f => f.code === 'cdn_blocked');
        const serverOk = server?.verdict === 'ok';
        const via = s.path === 'proxy';

        if (s.unsupported) return { level: 'warn', title: 'inconclusive', detail: 'this browser cannot play HLS, so there is nothing to compare.' };
        if (!broken && !rough) {
            if (serverBlocked && !via && forceProxy) return { level: 'bad', title: 'the viewer is fine, but "force proxy" sends playback through a server that is blocked', detail: 'this browser plays it directly. with force proxy on, viewers go through the server instead, and the CDN blocks it. turn force proxy off.' };
            if (serverBlocked) return { level: 'ok', title: 'viewers are fine: only the server is blocked', detail: via ? 'it plays through the proxy, so the server can reach the stream when it counts. the server probe above was blocked, but this is the real path.' : 'it plays straight from the provider. the server being blocked only affects what the server downloads itself: the automatic monitor, remux and transcoding.' };
            if (server && !serverOk) return { level: 'ok', title: 'playback works, despite the server-side findings', detail: 'this browser plays it fine. review the server findings above: they may affect proxy, remux or transcoding, not this playback.' };
            return { level: 'ok', title: 'healthy end to end', detail: `it works from the server and plays ${via ? 'through the proxy' : 'straight from the provider'} in this browser.` };
        }
        const barely = s.advancedSec < playMs / 1000 * 0.6 || s.stallMs >= 3000;
        if (rough) return { level: barely ? 'bad' : 'warn', title: barely ? 'it barely plays in this browser' : 'it plays, but not smoothly in this browser', detail: serverOk ? 'the server reaches it fine, so the limit is between this browser and the provider (this connection or this device).' : serverBlocked ? 'the server is blocked, so it cannot compare. the slowness is between this browser and the provider, or in the provider itself.' : 'the server also saw problems, so the provider is the likely cause.' };
        if (serverOk) return { level: 'bad', title: 'works from the server, fails in this browser', detail: via ? 'even through the proxy this browser cannot play it: check the format and codecs.' : 'the server can fetch it, this browser cannot. turning on "force proxy" would send playback through the server instead.' };
        if (serverBlocked) return { level: 'bad', title: 'fails here and the server is blocked too', detail: 'neither this browser nor the server can get it. the provider or its CDN is refusing the stream.' };
        return { level: 'bad', title: 'broken for everyone', detail: 'it fails both from the server and in this browser: the problem is on the provider\'s side.' };
    }

    async browserTest() {
        const r = this.modalJson;
        const box = document.getElementById('browser-test');
        if (!this.canBrowserTest(r) || !box) return;
        const button = document.getElementById('health-modal-browser');
        button.disabled = true;
        const head = '<div class="section-title">test in this browser</div>';
        const live = r.kind === 'live';
        box.innerHTML = `${head}<p class="hint">${live ? 'playing the channel for ~10 seconds, the way the player does' : 'loading the file, playing it muted for ~8 seconds, then jumping to the middle'}...</p>`;
        try {
            const { item } = r;
            const { url } = await API.proxy.xtream.getStreamUrl(item.source_id, item.item_id, live ? 'live' : r.kind === 'movie' ? 'movie' : 'series', live ? 'm3u8' : (item.ext || 'mp4'));
            const proxy = live && r.playback?.forceProxy;
            const playUrl = proxy ? `/api/proxy/stream?url=${encodeURIComponent(url)}` : url;
            let sample = live ? await this.probeLive(playUrl, { path: proxy ? 'proxy' : 'direct' }) : await this.probeVideo(playUrl);
            // A page served over https cannot load an http file: retry once on https before blaming the file.
            if (!live && sample.errorCode && url.startsWith('http:') && location.protocol === 'https:') {
                sample = { ...(await this.probeVideo(url.replace(/^http:/, 'https:'))), upgradedToHttps: true };
            }
            const analysis = this.analyzeBrowserProbe(sample, r, live ? 10000 : 8000);
            r.browserTest = { sample, conclusion: analysis.conclusion, findings: analysis.findings };
            const c = analysis.conclusion;
            box.innerHTML = head + `<div class="verdict ${c.level}"><div class="head">${this.esc(c.title)}</div><div class="sub">${this.esc(c.detail)}</div></div>` +
                this.renderFindings(analysis.findings) + this.renderMetrics(analysis.metrics);
        } catch (err) {
            box.innerHTML = `${head}<p class="hint">could not run it: ${this.esc(err.message)}</p>`;
        }
        button.disabled = false;
    }

    // One bar per request; each hop of the redirect chain is a segment sized by its time.
    renderTimeline(rows) {
        if (!rows.length) return '';
        const scale = Math.max(1, ...rows.map(r => r.totalMs || 0));
        const bar = row => {
            const hops = row.hops || [];
            const parts = hops.map((h, i) => {
                const last = i === hops.length - 1;
                const tone = h.status >= 300 && h.status < 400 ? 'redirect' : (!h.status || h.status >= 400 || (last && !row.ok)) ? 'fail' : '';
                return `<span class="${tone}" style="width:${(h.ms || 0) / scale * 100}%" title="${this.esc(`${h.host} · ${h.status ?? 'no answer'} · ${h.ms} ms`)}"></span>`;
            });
            const rest = (row.totalMs || 0) - hops.reduce((t, h) => t + (h.ms || 0), 0);
            if (rest > 20) parts.push(`<span class="${row.ok ? '' : 'fail'}" style="width:${rest / scale * 100}%" title="body · ${rest} ms"></span>`);
            return parts.join('');
        };
        return '<div class="section-title">timeline (grey: redirect, green: answered, red: failed)</div>' + rows.map(r =>
            `<div class="timeline-row"><div class="lab" title="${this.esc(r.error || '')}">${this.esc(r.label)}${r.error ? ' · ' + this.esc(r.error) : ''}</div><div class="bar">${bar(r)}</div><div class="tot">${r.totalMs ?? '-'} ms</div></div>`
        ).join('');
    }

    renderRaw(json) {
        return `<details class="raw"><summary>raw data (what to send when asking for help)</summary><pre>${this.esc(JSON.stringify(json, null, 2))}</pre></details>`;
    }

    // ---- copying ----------------------------------------------------------

    brief(c) {
        return { name: c.name, source_id: c.source_id, item_id: c.item_id, status: c.status, error: c.error,
            auto_hidden: !!c.auto_hidden, latency_ms: c.latency_ms, checked_at: new Date(c.checked_at).toISOString() };
    }

    copyReport(button) {
        const d = this.data;
        const problems = d.channels.filter(c => c.status !== 'online' || c.debug).slice(0, 40);
        this.copyText(JSON.stringify({
            generated: new Date().toISOString(), summary: d.summary, lastRun: d.lastRun && new Date(d.lastRun).toISOString(),
            channels: problems.map(c => ({ ...this.brief(c), attempts: c.debug }))
        }, null, 2), button);
    }

    async copyText(text, button) {
        const label = button.textContent;
        try {
            await navigator.clipboard.writeText(text);
            button.textContent = 'copied';
        } catch {
            // Clipboard needs https; show the text so it can be copied by hand.
            this.modalJson = null;
            this.openModal('copy this', `<details class="raw" open><summary>select all and copy</summary><pre>${this.esc(text)}</pre></details>`);
        }
        setTimeout(() => { button.textContent = label; }, 1500);
    }
}
