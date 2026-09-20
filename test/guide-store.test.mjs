/**
 * The guide shelf's storage, against a real IndexedDB implementation.
 *
 * The migration is the part that matters: version 1 held exactly one guide, and
 * anyone who made one before the shelf existed must still have it afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';

// The store keeps the current selection in localStorage, which Node has not got.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const {
  chooseGuide, deleteGuide, guideEnabled, listGuides, loadGuide, loadSelectedGuide,
  saveGuide, selectGuide, selectedGuideId, setGuideEnabled,
} = await import('../src/companion/store.ts');

const DB = 'walk-the-past';
const bytes = (n) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251)).buffer;

function wipe() {
  store.clear();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

/** A database exactly as version 1 left it: one store, one guide, one key. */
function seedVersion1(record) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('guide');
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('guide', 'readwrite');
      transaction.objectStore('guide').put(record, 'current');
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  });
}

test('a guide made before the shelf existed survives the upgrade', async () => {
  await wipe();
  await seedVersion1({
    glb: bytes(64), avatarId: 'avaturn-abc', name: 'Nikolaos',
    portrait: 'data:image/jpeg;base64,AAAA', createdAt: 1700000000000,
  });

  const guides = await listGuides();
  assert.equal(guides.length, 1, 'the old guide should have come across');
  const [guide] = guides;
  assert.equal(guide.name, 'Nikolaos');
  assert.equal(guide.avatarId, 'avaturn-abc');
  assert.equal(guide.portrait, 'data:image/jpeg;base64,AAAA');
  assert.equal(guide.createdAt, 1700000000000, 'and kept the date it was made');
  assert.ok(guide.id, 'and been given an id to be chosen by');

  const full = await loadGuide(guide.id);
  assert.equal(full.glb.byteLength, 64, 'the model has to come with it');
  assert.equal(selectedGuideId(), guide.id, 'and it should be the one you walk with');
  assert.equal((await loadSelectedGuide()).name, 'Nikolaos');
});

test('the upgrade runs once, and does not duplicate the guide', async () => {
  await wipe();
  await seedVersion1({ glb: bytes(8), avatarId: 'a', name: 'Once', createdAt: 1 });
  await listGuides();
  await listGuides();
  const guides = await listGuides();
  assert.equal(guides.length, 1, `expected one guide, got ${guides.length}`);
});

test('an upgrade from an empty version 1 leaves an empty shelf', async () => {
  await wipe();
  await new Promise((resolve) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('guide');
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
  assert.deepEqual(await listGuides(), []);
  assert.equal(await loadSelectedGuide(), null);
});

test('guides are kept, listed newest first, and thrown away', async () => {
  await wipe();
  const one = await saveGuide({ glb: bytes(16), avatarId: 'a', name: 'First', createdAt: 1000 });
  const two = await saveGuide({ glb: bytes(32), avatarId: 'b', name: 'Second', createdAt: 2000 });

  const guides = await listGuides();
  assert.deepEqual(guides.map((g) => g.name), ['Second', 'First'], 'newest first');
  assert.equal(guides[0].id, two.id);

  assert.equal((await loadGuide(one.id)).glb.byteLength, 16, 'each keeps its own model');
  assert.equal((await loadGuide(two.id)).glb.byteLength, 32);

  await deleteGuide(one.id);
  assert.deepEqual((await listGuides()).map((g) => g.name), ['Second']);
  assert.equal(await loadGuide(one.id), null, 'and its model goes with it');
});

test('making a guide selects it, and deleting the current one steps aside', async () => {
  await wipe();
  const first = await saveGuide({ glb: bytes(8), avatarId: 'a', name: 'First', createdAt: 1000 });
  assert.equal(selectedGuideId(), first.id, 'a guide you just made is the one you walk with');

  const second = await saveGuide({ glb: bytes(8), avatarId: 'b', name: 'Second', createdAt: 2000 });
  assert.equal(selectedGuideId(), second.id);

  selectGuide(first.id);
  assert.equal((await loadSelectedGuide()).name, 'First');

  await deleteGuide(first.id);
  assert.equal(selectedGuideId(), null, 'the selection cannot point at a deleted guide');
  assert.equal((await loadSelectedGuide()).name, 'Second', 'so it falls back to the newest');
});

test('walking alone means no guide is loaded at all', async () => {
  await wipe();
  await saveGuide({ glb: bytes(8), avatarId: 'a', name: 'Someone', createdAt: 1 });
  assert.equal(guideEnabled(), true, 'a guide is the default');
  setGuideEnabled(false);
  assert.equal(await loadSelectedGuide(), null);
  setGuideEnabled(true);
  assert.equal((await loadSelectedGuide()).name, 'Someone');
});

test('choosing falls back to the newest rather than to nobody', () => {
  const guides = [{ id: 'new' }, { id: 'old' }];
  assert.equal(chooseGuide(guides, 'old', true).id, 'old', 'your choice wins');
  assert.equal(chooseGuide(guides, null, true).id, 'new', 'no choice takes the newest');
  assert.equal(chooseGuide(guides, 'deleted', true).id, 'new', 'a stale choice takes the newest');
  assert.equal(chooseGuide(guides, 'old', false), null, 'walking alone takes nobody');
  assert.equal(chooseGuide([], 'old', true), null);
});
