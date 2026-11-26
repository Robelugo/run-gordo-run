import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_PEOPLE, PERSONAL_KEYS, People } from '../js/people.js';

/** A localStorage stand-in. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

test('what was saved before profiles existed goes to the first person', () => {
  const storage = fakeStorage({
    'ctlx.profile': '{"age":40}',
    'ctlx.history': '[{"seconds":600}]',
    'ctlx.cat': '"siamese"',
    'ctlx.units': '"metric"',
    'ctlx.code': '"abc"',
  });
  const people = new People(storage);
  assert.deepEqual(people.list, [{ id: 'p1', name: 'Runner 1' }]);
  assert.equal(people.activeId, 'p1');
  assert.equal(storage.getItem(people.keyFor('profile')), '{"age":40}');
  assert.equal(storage.getItem(people.keyFor('history')), '[{"seconds":600}]');
  assert.equal(storage.getItem(people.keyFor('cat')), '"siamese"');
  assert.equal(storage.getItem('ctlx.profile'), null, 'the old copy is gone');
  // Shared settings stay where they were.
  assert.equal(people.keyFor('units'), 'ctlx.units');
  assert.equal(people.keyFor('code'), 'ctlx.code');
  assert.equal(storage.getItem('ctlx.units'), '"metric"');

  // Starting again changes nothing.
  const again = new People(storage);
  assert.deepEqual(again.list, people.list);
  assert.equal(storage.getItem(again.keyFor('profile')), '{"age":40}');
});

test('each person has their own settings, and the choice is remembered', () => {
  const storage = fakeStorage();
  const people = new People(storage);
  people.rename('p1', '  Sam  ');
  const second = people.add('Ana');
  assert.deepEqual(people.list.map((p) => p.name), ['Sam', 'Ana']);
  assert.equal(people.activeId, 'p1', 'adding does not switch');

  storage.setItem(people.keyFor('profile'), '"first"');
  assert.ok(people.select(second.id));
  assert.equal(storage.getItem(people.keyFor('profile')), null);
  storage.setItem(people.keyFor('profile'), '"second"');
  for (const key of PERSONAL_KEYS) assert.notEqual(people.keyFor(key), people.keyOf('p1', key));

  const reopened = new People(storage);
  assert.equal(reopened.active.name, 'Ana');
  assert.equal(storage.getItem(reopened.keyFor('profile')), '"second"');
  reopened.select('p1');
  assert.equal(storage.getItem(reopened.keyFor('profile')), '"first"');
  assert.ok(!reopened.select('nobody'));
  assert.equal(reopened.activeId, 'p1');
});

test('names are tidied and get a default', () => {
  const people = new People(fakeStorage());
  assert.equal(people.add('').name, 'Runner 2');
  assert.equal(people.add('   ').name, 'Runner 3');
  assert.equal(people.add('A very long name that goes on and on').name.length, 16);
  people.rename('p1', '');
  assert.equal(people.list[0].name, 'Runner 1', 'an empty name keeps the old one');
});

test('removing a person removes their data, but never the last person', () => {
  const storage = fakeStorage();
  const people = new People(storage);
  assert.ok(!people.remove('p1'), 'the only person stays');
  const ana = people.add('Ana');
  people.select(ana.id);
  storage.setItem(people.keyFor('history'), '[1,2,3]');
  storage.setItem(people.keyOf('p1', 'history'), '[9]');

  assert.ok(people.remove(ana.id));
  assert.equal(people.activeId, 'p1', 'falls back to someone who is left');
  assert.equal(storage.getItem(people.keyOf(ana.id, 'history')), null);
  assert.equal(storage.getItem(people.keyOf('p1', 'history')), '[9]');

  // A new person never inherits what a removed one left behind.
  storage.setItem(people.keyOf('p2', 'profile'), '"stale"');
  const next = people.add('Luis');
  assert.equal(next.id, 'p2');
  assert.equal(storage.getItem(people.keyOf('p2', 'profile')), null);
});

test('the list is capped', () => {
  const people = new People(fakeStorage());
  while (!people.full) assert.ok(people.add());
  assert.equal(people.list.length, MAX_PEOPLE);
  assert.equal(people.add('One more'), null);
  assert.equal(new Set(people.list.map((p) => p.id)).size, MAX_PEOPLE);
});

test('a damaged list or unavailable storage still leaves one usable person', () => {
  const damaged = new People(fakeStorage({ 'ctlx.people': '{"oops":true}', 'ctlx.u.p1.profile': '"kept"', 'ctlx.person': '"p7"' }));
  assert.equal(damaged.activeId, 'p1');
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  const people = new People(broken);
  assert.equal(people.active.name, 'Runner 1');
  assert.ok(people.add('Ana'));
  assert.ok(people.select('p2'));
  assert.equal(people.keyFor('profile'), 'ctlx.u.p2.profile');
});
