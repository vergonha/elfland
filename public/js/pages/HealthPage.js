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

    renderDiagnosis(r) {
        const verdict = { ok: 'healthy', warn: 'works, but has issues', bad: 'broken' }[r.verdict];
        const metrics = [...r.metrics];
        if (r.account && !r.account.error) {
            metrics.push({ label: 'account', value: r.account.status });
            metrics.push({ label: 'connections', value: `${r.account.active_cons} of ${r.account.max_connections}` });
            if (Number(r.account.exp_date)) metrics.push({ label: 'expires', value: new Date(r.account.exp_date * 1000).toISOString().slice(0, 10) });
        }
        return `<div class="verdict ${r.verdict}"><div class="head">${verdict}</div><div class="sub">${this.esc(r.url)}</div></div>` +
            `<ul class="findings">${r.findings.map(f => `<li><span class="dot ${f.level}"></span><div><div class="t">${this.esc(f.title)}</div>${f.detail ? `<div class="d">${this.esc(f.detail)}</div>` : ''}</div></li>`).join('')}</ul>` +
            (metrics.length ? `<div class="metrics">${metrics.map(m => `<div><div class="v">${this.esc(m.value)}</div><div class="l">${this.esc(m.label)}</div></div>`).join('')}</div>` : '') +
            this.renderTimeline(r.timeline) + this.renderRaw(r);
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
