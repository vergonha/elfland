const express = require('express');
const router = express.Router();
const { settings, getDefaultSettings } = require('../db');
const syncService = require('../services/syncService');
const contentFilter = require('../services/contentFilter');

/**
 * Get all settings
 * GET /api/settings
 */
router.get('/', async (req, res) => {
    try {
        const currentSettings = await settings.get();
        res.json(currentSettings);
    } catch (err) {
        console.error('Error getting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Update settings (partial update)
 * PUT /api/settings
 */
router.put('/', async (req, res) => {
    try {
        // The adult filter has its own endpoint so a stale client copy of the
        // settings can never flip it as a side effect of saving something else.
        const { blockAdultContent, ...updates } = req.body || {};
        const updatedSettings = await settings.update(updates);

        // If sync interval changed, restart the server-side sync timer
        if (updates.epgRefreshInterval !== undefined) {
            syncService.restartSyncTimer().catch(console.error);
        }

        res.json(updatedSettings);
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Enable or disable the adult content filter (admin only, see index.js)
 * PUT /api/settings/content-filter
 * Body: { enabled: boolean }
 */
router.put('/content-filter', async (req, res) => {
    try {
        if (typeof req.body?.enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean' });
        }
        await settings.update({ blockAdultContent: req.body.enabled });
        await contentFilter.refresh();
        res.json({ enabled: contentFilter.isEnabled() });
    } catch (err) {
        console.error('Error updating content filter:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Reset settings to defaults
 * DELETE /api/settings
 */
router.delete('/', async (req, res) => {
    try {
        const defaultSettings = await settings.reset();
        await contentFilter.refresh();
        res.json(defaultSettings);
    } catch (err) {
        console.error('Error resetting settings:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get default settings (for reference)
 * GET /api/settings/defaults
 */
router.get('/defaults', (req, res) => {
    res.json(getDefaultSettings());
});

/**
 * Get sync status (last sync time)
 * GET /api/settings/sync-status
 */
router.get('/sync-status', (req, res) => {
    const lastSyncTime = syncService.getLastSyncTime();
    res.json({
        lastSyncTime: lastSyncTime ? lastSyncTime.toISOString() : null
    });
});

/**
 * Get hardware capabilities (GPU acceleration support)
 * GET /api/settings/hw-info
 */
router.get('/hw-info', async (req, res) => {
    try {
        const hwDetect = require('../services/hwDetect');
        let capabilities = hwDetect.getCapabilities();

        // If not yet detected, run detection now
        if (!capabilities) {
            capabilities = await hwDetect.detect();
        }

        res.json(capabilities);
    } catch (err) {
        console.error('Error getting hardware info:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Refresh hardware detection (re-probe GPUs)
 * POST /api/settings/hw-info/refresh
 */
router.post('/hw-info/refresh', async (req, res) => {
    try {
        const hwDetect = require('../services/hwDetect');
        const capabilities = await hwDetect.refresh();
        res.json(capabilities);
    } catch (err) {
        console.error('Error refreshing hardware info:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

