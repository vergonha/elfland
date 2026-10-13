const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.NODECAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-filter-'));

const Database = require('better-sqlite3');
const filter = require('../server/services/contentFilter');

test('category names with adult keywords are detected', () => {
    for (const name of ['XXX', 'Porn HD', 'OnlyFans', 'Only Fans Leaks', 'Adults +18', '18+ Movies', 'Adulto', 'Canais Pornô', 'Hentai', 'Sex']) {
        assert.equal(filter.isAdultCategoryName(name), true, name);
    }
});

test('regular category names are not flagged', () => {
    for (const name of ['Movies', 'Sports', 'Adult Swim', 'Kids', 'Sussex News', 'Essex FM', 'News']) {
        assert.equal(filter.isAdultCategoryName(name), false, name);
    }
});

test('item names only match strong keywords to avoid false positives', () => {
    assert.equal(filter.isAdultItemName('Sex Education'), false);
    assert.equal(filter.isAdultItemName('Adult Swim: Rick and Morty'), false);
    assert.equal(filter.isAdultItemName('Hot XXX Collection'), true);
    assert.equal(filter.isAdultItemName('Brazzers Live'), true);
});

test('sql helpers drop adult categories, their items and adult item names', async () => {
    const db = new Database(':memory:');
    filter.registerSqlFunctions(db);
    db.exec(`
        CREATE TABLE categories (source_id INTEGER, category_id TEXT, type TEXT, name TEXT, is_hidden INTEGER DEFAULT 0);
        CREATE TABLE playlist_items (source_id INTEGER, item_id TEXT, type TEXT, name TEXT, category_id TEXT, is_hidden INTEGER DEFAULT 0);
        INSERT INTO categories VALUES (1,'1','movie','Action',0),(1,'2','movie','XXX Adults',0);
        INSERT INTO playlist_items VALUES
            (1,'10','movie','Die Hard','1',0),
            (1,'11','movie','Some Title','2',0),
            (1,'12','movie','Porn Movie','1',0);
    `);

    const settings = require('../server/db').settings;
    await settings.update({ blockAdultContent: true });
    await filter.refresh();
    assert.equal(filter.isEnabled(), true);

    const cats = db.prepare(`SELECT name FROM categories WHERE 1=1 ${filter.categoryClause('categories')}`).all();
    assert.deepEqual(cats.map(c => c.name), ['Action']);

    const items = db.prepare(`SELECT name FROM playlist_items WHERE 1=1 ${filter.itemClause('playlist_items')}`).all();
    assert.deepEqual(items.map(i => i.name), ['Die Hard']);

    assert.equal(filter.isAdultStoredItem(db, 1, '11', 'movie'), true);
    assert.equal(filter.isAdultStoredItem(db, 1, '10', 'movie'), false);

    await settings.update({ blockAdultContent: false });
    await filter.refresh();
    assert.equal(filter.isEnabled(), false);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM playlist_items WHERE 1=1 ${filter.itemClause('playlist_items')}`).get().n, 3);
    assert.equal(filter.isAdultStoredItem(db, 1, '11', 'movie'), false);
});
