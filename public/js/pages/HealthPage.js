/**
 * Channel Health Page Controller (admin only)
 */

class HealthPage {
    constructor(app) {
        this.app = app;
        this.timer = null;
        this.data = null;
        document.getElementById('health-run')?.addEventListener('click', async () => {
            await API.channelHealth.run();
            this.load();
        });
        document.getElementById('health-report')?.addEventListener('click', () => this.showReport());
        document.getElementById('health-rows')?.addEventListener('click', e => {
            const button = e.target.closest('button[data-action]');
            if (button) this.rowAction(button.dataset.action, button.dataset.source, button.dataset.item);
        });
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
            const data = this.data = await API.channelHealth.get();
            const online = data.channels.filter(c => c.status === 'online').length;
            const last = data.lastRun ? new Date(data.lastRun).toLocaleString() : 'never';
            document.getElementById('health-summary').textContent = data.running
                ? `${data.phase}: ${data.checked}/${data.total}...`
                : `${online} online, ${data.channels.length - online} offline. last run: ${last}. runs every ${data.intervalMin} min`;
            document.getElementById('health-stats').textContent = this.describeRun(data.summary);
            document.getElementById('health-rows').innerHTML = data.channels.map(c => {
                const note = c.status === 'online' ? '' : ` (${c.error})`
                    + (c.auto_hidden ? ' hidden' : '');
                const attrs = `data-source="${c.source_id}" data-item="${this.escape(c.item_id)}"`;
                return `<tr>
                    <td>${this.escape(c.name)}</td>
                    <td class="health-${c.status}">${c.status}${this.escape(note)}${c.debug && c.status === 'online' ? ' (needed retry)' : ''}</td>
                    <td>${c.latency_ms == null ? '-' : c.latency_ms + ' ms'}</td>
                    <td>${new Date(c.checked_at).toLocaleTimeString()}</td>
                    <td>${c.debug ? `<button class="btn btn-sm btn-ghost" data-action="details" ${attrs}>details</button>` : ''}
                        <button class="btn btn-sm btn-ghost" data-action="diagnose" ${attrs}>diagnose</button></td>
                </tr>`;
            }).join('');
        } catch (err) {
            console.error('[Health] Failed to load:', err);
            document.getElementById('health-summary').textContent = `failed to load: ${err.message}`;
        }
    }

    describeRun(s) {
        if (!s) return 'no run finished yet';
        const rate = (s.failureRate * 100).toFixed(1);
        const lines = [
            `last run: ${s.total} checked in ${Math.round(s.durationMs / 1000)}s. ` +
                `failed first pass: ${s.failedFirstPass}, recovered on recheck: ${s.recoveredOnRecheck}, ` +
                `still failing: ${s.failedFinal} (${rate}%). hidden: ${s.hidden}, restored: ${s.restored}`
        ];
        if (s.suspect) lines.push(`WARNING: ${rate}% of channels failed, nothing was hidden. this points to the network or the provider, not the channels`);
        const errors = Object.entries(s.finalErrors).map(([k, n]) => `${k} x${n}`).join(', ');
        if (errors) lines.push(`errors: ${errors}`);
        const hosts = Object.entries(s.hosts).map(([h, v]) => `${h} ${v.fail}/${v.ok + v.fail}`).join(', ');
        if (hosts) lines.push(`failures by upstream host (failed/total): ${hosts}`);
        return lines.join('\n');
    }

    async rowAction(action, source, item) {
        const channel = this.data?.channels.find(c => String(c.source_id) === source && String(c.item_id) === item);
        if (action === 'details') {
            this.showDebug({ channel: this.brief(channel), attempts: channel.debug });
            return;
        }
        this.showDebug(`diagnosing ${channel?.name}... (takes a few seconds)`);
        try {
            this.showDebug(await API.channelHealth.diagnose(parseInt(source), item));
        } catch (err) {
            this.showDebug(`diagnose failed: ${err.message}`);
        }
    }

    brief(c) {
        return { name: c.name, source_id: c.source_id, item_id: c.item_id, status: c.status, error: c.error,
            auto_hidden: !!c.auto_hidden, latency_ms: c.latency_ms, checked_at: new Date(c.checked_at).toISOString() };
    }

    showReport() {
        const failing = this.data.channels.filter(c => c.status !== 'online' || c.debug).slice(0, 40);
        this.showDebug({
            summary: this.data.summary,
            browser_time: new Date().toISOString(),
            channels: failing.map(c => ({ ...this.brief(c), attempts: c.debug }))
        }, true);
    }

    async showDebug(content, copy = false) {
        const panel = document.getElementById('health-debug');
        panel.classList.remove('hidden');
        panel.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        panel.scrollIntoView({ block: 'nearest' });
        if (!copy) return;
        try {
            await navigator.clipboard.writeText(panel.textContent);
            panel.textContent = '(copied to clipboard)\n' + panel.textContent;
        } catch {
            panel.textContent = '(could not copy automatically, select and copy the text below)\n' + panel.textContent;
        }
    }

    escape(text) {
        const el = document.createElement('div');
        el.textContent = text;
        return el.innerHTML;
    }
}
