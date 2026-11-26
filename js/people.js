// The people who use the app on this device. Each one has their own profile,
// workout history, VO2 max log, program settings and cat; everything else
// (units, unlock code, sounds) is shared.
// Pure logic over a localStorage-like object, covered by the Node tests.

/** Settings stored once per person. */
export const PERSONAL_KEYS = ['profile', 'profileAsked', 'history', 'vo2log', 'levels', 'custom', 'heartCustom', 'cat', 'catHolo'];
export const MAX_PEOPLE = 8;
export const MAX_NAME = 16;

export function cleanName(name, fallback) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || fallback;
}

const isList = (list) =>
  Array.isArray(list) && list.length > 0 && list.every((p) => p && typeof p.id === 'string' && /^p\d+$/.test(p.id) && typeof p.name === 'string');

export class People {
  constructor(storage, prefix = 'ctlx.') {
    this._storage = storage;
    this._prefix = prefix;
    const list = this._read('people');
    if (isList(list)) this.list = list.map(({ id, name }) => ({ id, name }));
    else {
      // First run with this version: whatever was saved so far belongs to the first person.
      this.list = [{ id: 'p1', name: 'Runner 1' }];
      for (const key of PERSONAL_KEYS) this._move(`${prefix}${key}`, this.keyOf('p1', key));
      this._write('people', this.list);
    }
    const active = this._read('person');
    this.activeId = this.list.some((p) => p.id === active) ? active : this.list[0].id;
  }

  get active() {
    return this.list.find((p) => p.id === this.activeId);
  }

  get full() {
    return this.list.length >= MAX_PEOPLE;
  }

  /** Storage key of one person's setting. */
  keyOf(id, key) {
    return `${this._prefix}u.${id}.${key}`;
  }

  /** Storage key of a setting: the selected person's own for personal settings, shared otherwise. */
  keyFor(key) {
    return PERSONAL_KEYS.includes(key) ? this.keyOf(this.activeId, key) : `${this._prefix}${key}`;
  }

  /** Name a new person gets when none is typed. */
  nextName() {
    for (let n = this.list.length + 1; ; n++) {
      if (!this.list.some((p) => p.name === `Runner ${n}`)) return `Runner ${n}`;
    }
  }

  /** Adds a person (not selected yet). Returns null when the list is full. */
  add(name) {
    if (this.full) return null;
    const number = 1 + Math.max(...this.list.map((p) => Number(p.id.slice(1))));
    const person = { id: `p${number}`, name: cleanName(name, this.nextName()) };
    this._forget(person.id); // nothing left over from a removed person with the same id
    this.list.push(person);
    this._write('people', this.list);
    return person;
  }

  rename(id, name) {
    const person = this.list.find((p) => p.id === id);
    if (!person) return false;
    person.name = cleanName(name, person.name);
    this._write('people', this.list);
    return true;
  }

  select(id) {
    if (!this.list.some((p) => p.id === id)) return false;
    this.activeId = id;
    this._write('person', id);
    return true;
  }

  /** Removes a person and everything saved for them. The last person cannot be removed. */
  remove(id) {
    if (this.list.length < 2 || !this.list.some((p) => p.id === id)) return false;
    this.list = this.list.filter((p) => p.id !== id);
    this._write('people', this.list);
    this._forget(id);
    if (this.activeId === id) this.select(this.list[0].id);
    return true;
  }

  _forget(id) {
    for (const key of PERSONAL_KEYS) {
      try {
        this._storage.removeItem(this.keyOf(id, key));
      } catch {
        /* storage unavailable */
      }
    }
  }

  _move(from, to) {
    try {
      const raw = this._storage.getItem(from);
      if (raw === null) return;
      this._storage.setItem(to, raw);
      this._storage.removeItem(from); // only once the copy is safely stored
    } catch {
      /* storage unavailable or full: the old value stays where it was */
    }
  }

  _read(key) {
    try {
      const raw = this._storage.getItem(`${this._prefix}${key}`);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  _write(key, value) {
    try {
      this._storage.setItem(`${this._prefix}${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable: the list just won't persist */
    }
  }
}
