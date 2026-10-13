/**
 * Adult content filter.
 *
 * Content is sanitized on the server so adult titles and categories never
 * reach the browser. Filtering happens at read time (not at sync time) so an
 * admin can switch it on and off without re-syncing sources.
 *
 * Two keyword lists are used:
 *  - STRONG keywords are unambiguous and are checked against category names
 *    and item names.
 *  - CATEGORY keywords are common words ("adult", "sex") that would cause
 *    false positives in titles ("Sex Education", "Adult Swim"), so they are
 *    only checked against category names.
 */
const { settings } = require('../db');

const STRONG_KEYWORDS = [
    'porn', 'porno', 'pornos', 'pornografia', 'pornstar', 'pornhub',
    'xxx', 'xvideos', 'xnxx', 'redtube', 'brazzers',
    'onlyfans', 'only fans', 'fansly',
    'hentai', 'nsfw', 'playboy', 'camgirl', 'camgirls',
    'erotic', 'erotica', 'erotico', 'eroticos', 'erotik'
];

const CATEGORY_KEYWORDS = [
    'adult', 'adults', 'adulto', 'adultos', 'adulte', 'adultes',
    'sex', 'sexo', 'sexy', 'sexual',
    '18+', '+18', '18 plus', '21+', '+21',
    'for adults', 'for adult', 'xxx adult'
];

// Legitimate names that contain a category keyword
const ALLOWED_PHRASES = ['adult swim', 'adult education', 'adult contemporary', 'adults only swim'];

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

function buildPattern(words) {
    const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Match whole tokens: the keyword must not be glued to other letters or digits
    return new RegExp(`(^|[^a-z0-9])(?:${escaped.join('|')})(?=$|[^a-z0-9])`);
}

const strongPattern = buildPattern(STRONG_KEYWORDS);
const categoryPattern = buildPattern([...STRONG_KEYWORDS, ...CATEGORY_KEYWORDS]);

function stripAllowed(text) {
    let out = text;
    for (const phrase of ALLOWED_PHRASES) out = out.split(phrase).join(' ');
    return out;
}

/** True when a playlist item name (channel, movie, series) is adult. */
function isAdultItemName(name) {
    return strongPattern.test(stripAllowed(normalize(name)));
}

/** True when a category / group name is adult. */
function isAdultCategoryName(name) {
    return categoryPattern.test(stripAllowed(normalize(name)));
}

// --- enabled flag -----------------------------------------------------------
// Read synchronously by query helpers; refreshed whenever settings change.
// Defaults to on so content is never exposed while settings are still loading.
let enabled = true;

async function refresh() {
    try {
        const current = await settings.get();
        enabled = current.blockAdultContent !== false;
    } catch (err) {
        console.error('[ContentFilter] Failed to read settings, keeping filter on:', err.message);
        enabled = true;
    }
    return enabled;
}

function isEnabled() {
    return enabled;
}

/**
 * Register the SQL functions used by the query helpers on a better-sqlite3 db.
 * is_adult_item(name) and is_adult_category(name) return 1 or 0.
 */
function registerSqlFunctions(db) {
    db.function('is_adult_item', { deterministic: true }, name => (isAdultItemName(name) ? 1 : 0));
    db.function('is_adult_category', { deterministic: true }, name => (isAdultCategoryName(name) ? 1 : 0));
}

/**
 * SQL fragment that excludes adult playlist items. `alias` is the
 * playlist_items table alias. Returns '' when the filter is off.
 */
function itemClause(alias = 'playlist_items') {
    if (!enabled) return '';
    return ` AND is_adult_item(${alias}.name) = 0
        AND NOT EXISTS (
            SELECT 1 FROM categories adult_c
            WHERE adult_c.source_id = ${alias}.source_id
              AND adult_c.category_id = ${alias}.category_id
              AND adult_c.type = ${alias}.type
              AND is_adult_category(adult_c.name) = 1
        )`;
}

/** SQL fragment that excludes adult categories. */
function categoryClause(alias = 'categories') {
    if (!enabled) return '';
    return ` AND is_adult_category(${alias}.name) = 0`;
}

/**
 * Whether a single stored item is adult (by its own name or its category).
 * Used to guard lookups by id. Returns false when the filter is off.
 */
function isAdultStoredItem(db, sourceId, itemId, type = null) {
    if (!enabled) return false;
    const row = db.prepare(`
        SELECT 1 FROM playlist_items p
        WHERE p.source_id = ? AND p.item_id = ? ${type ? 'AND p.type = ?' : ''}
          AND (is_adult_item(p.name) = 1 OR EXISTS (
              SELECT 1 FROM categories c
              WHERE c.source_id = p.source_id AND c.category_id = p.category_id
                AND c.type = p.type AND is_adult_category(c.name) = 1
          ))
        LIMIT 1
    `).get(...(type ? [sourceId, String(itemId), type] : [sourceId, String(itemId)]));
    return !!row;
}

module.exports = {
    isAdultItemName,
    isAdultCategoryName,
    isEnabled,
    refresh,
    registerSqlFunctions,
    itemClause,
    categoryClause,
    isAdultStoredItem
};
