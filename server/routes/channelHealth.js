const express = require('express');
const router = express.Router();
const channelHealth = require('../services/channelHealth');
const channelDiagnose = require('../services/channelDiagnose');

router.get('/', (req, res) => {
    res.json({ ...channelHealth.getState(), channels: channelHealth.list() });
});

router.post('/run', (req, res) => {
    channelHealth.runOnce();
    res.status(202).json({ started: true });
});

// Movies and series are only looked up on demand: nothing here is monitored automatically.
for (const [route, type] of [['movies', 'movie'], ['series', 'series']]) {
    router.get(`/${route}`, async (req, res) => {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json([]);
        res.json(await channelDiagnose.searchTitles(type, q));
    });
}

router.get('/series/:sourceId/:seriesId', async (req, res) => {
    try {
        const outline = await channelDiagnose.seriesOutline(parseInt(req.params.sourceId), req.params.seriesId);
        if (!outline) return res.status(404).json({ error: 'Not found' });
        res.json(outline);
    } catch (err) {
        res.status(err.statusCode || 502).json({ error: channelHealth.redact(err.message) });
    }
});

router.post('/diagnose', async (req, res) => {
    const { type = 'live', itemId, seriesId } = req.body || {};
    const sourceId = parseInt(req.body?.sourceId);
    if (!['live', 'movie', 'episode'].includes(type) || !Number.isInteger(sourceId) || (typeof itemId !== 'string' && typeof itemId !== 'number')
        || (type === 'episode' && typeof seriesId !== 'string' && typeof seriesId !== 'number')) {
        return res.status(400).json({ error: 'type, sourceId, itemId (and seriesId for episodes) are required' });
    }
    try {
        const result = await channelDiagnose.diagnose(type, sourceId, itemId, { seriesId });
        if (!result) return res.status(404).json({ error: 'Not found' });
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: channelHealth.redact(err.message) });
    }
});

module.exports = router;
