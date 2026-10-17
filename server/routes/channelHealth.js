const express = require('express');
const router = express.Router();
const channelHealth = require('../services/channelHealth');

router.get('/', (req, res) => {
    res.json({ ...channelHealth.getState(), channels: channelHealth.list() });
});

router.post('/run', (req, res) => {
    channelHealth.runOnce();
    res.status(202).json({ started: true });
});

router.post('/diagnose', async (req, res) => {
    const sourceId = parseInt(req.body?.sourceId);
    const itemId = req.body?.itemId;
    if (!Number.isInteger(sourceId) || (typeof itemId !== 'string' && typeof itemId !== 'number')) {
        return res.status(400).json({ error: 'sourceId and itemId are required' });
    }
    const result = await channelHealth.diagnose(sourceId, itemId);
    if (!result) return res.status(404).json({ error: 'Channel not found' });
    res.json(result);
});

module.exports = router;
