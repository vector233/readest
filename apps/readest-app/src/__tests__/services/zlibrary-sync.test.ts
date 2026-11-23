import { expect, it, vi } from 'vitest';
import { syncShelf, shelfStatus, type SyncProgress } from '@/services/zlibrary/sync';
import { type CatalogBook, type ShelfBook } from '@/services/zlibrary/catalog';

const edition: CatalogBook = {
  title: 'Example',
  author: 'Writer',
  format: 'epub',
  url: 'https://zh.z-library.sk/book/example/title',
};
const first: ShelfBook = {
  id: 'a',
  title: edition.title,
  author: edition.author,
  matches: [edition],
};
const second: ShelfBook = { ...first, id: 'b', title: 'Another', matches: undefined };

it('rechecks an unavailable edition from the old downloader once in the browser', async () => {
  const progress: SyncProgress = { a: { selected: edition, manual: true } };
  const add = vi.fn().mockResolvedValue(undefined);
  const actions = {
    read: (id: string) => progress[id],
    save: (id: string, row: SyncProgress[string]) => {
      progress[id] = row;
    },
    existing: () => undefined,
    search: vi.fn(),
    add,
    current: vi.fn(),
    stopping: () => false,
  };
  expect(shelfStatus(first, progress['a'])).toBe('ready');
  await syncShelf([first], actions);
  expect(shelfStatus(first, progress['a'])).toBe('manual');
  await syncShelf([first], actions);
  expect(add).toHaveBeenCalledTimes(1);
});

it('records a completed import once, resumes after failure, and leaves empty searches distinct', async () => {
  const progress: SyncProgress = {};
  const existingHashes = new Set<string>();
  const add = vi.fn(async () => {
    existingHashes.add('hash');
    return 'hash';
  });
  const search = vi
    .fn<() => Promise<CatalogBook[]>>()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue([]);
  const actions = {
    read: (id: string) => progress[id],
    save: (id: string, row: SyncProgress[string]) => {
      progress[id] = row;
    },
    existing: (_book: ShelfBook, hash?: string) =>
      hash && existingHashes.has(hash) ? hash : undefined,
    search,
    add,
    current: vi.fn(),
    stopping: () => false,
  };
  await expect(syncShelf([first, second], actions)).rejects.toThrow('unavailable');
  expect(shelfStatus(first, progress['a'])).toBe('added');
  expect(shelfStatus(second, progress['b'])).toBe('pending');
  await syncShelf([first, second], actions);
  expect(shelfStatus(second, progress['b'])).toBe('missing');
  expect(add).toHaveBeenCalledTimes(1);
  expect(search.mock.calls).toEqual([['Another Writer'], ['Another Writer'], ['Another']]);
});

it('keeps ambiguous editions available and stops before starting a second download', async () => {
  const progress: SyncProgress = {};
  const ambiguous: ShelfBook = {
    ...first,
    id: 'ambiguous',
    matches: [
      { ...edition, title: 'Example: East' },
      { ...edition, title: 'Example: West', url: edition.url + '2' },
    ],
  };
  let stop = false;
  const add = vi.fn(async () => {
    stop = true;
    return 'stored';
  });
  await syncShelf([ambiguous, first, { ...first, id: 'last' }], {
    read: (id) => progress[id],
    save: (id, row) => {
      progress[id] = row;
    },
    existing: () => undefined,
    add,
    search: vi.fn().mockResolvedValue([]),
    current: vi.fn(),
    stopping: () => stop,
  });
  expect(shelfStatus(ambiguous, progress['ambiguous'])).toBe('choose');
  expect(add).toHaveBeenCalledTimes(1);
  expect(progress['last']).toBeUndefined();
});

it('checks an unresolved shelf edition by ISBN once and imports a verified result', async () => {
  const isbn = '9780306406157';
  const entry = { ...first, matches: [], isbn };
  const progress: SyncProgress = {};
  const search = vi.fn().mockResolvedValue([{ ...edition, isbn }]);
  await syncShelf([entry], {
    read: (id) => progress[id],
    save: (id, row) => {
      progress[id] = row;
    },
    existing: () => undefined,
    add: async () => 'isbn-hash',
    search,
    current: vi.fn(),
    stopping: () => false,
  });
  expect(search).toHaveBeenCalledWith(isbn);
  expect(progress['a']?.hash).toBe('isbn-hash');
});

it('revisits old empty answers, resumes the failed query and keeps an imported book on later syncs', async () => {
  const row: ShelfBook = { ...first, title: 'Example（2024）', matches: [], isbnChecked: true };
  const progress: SyncProgress = { a: { matches: [], isbnChecked: true } };
  const search = vi
    .fn<(q: string) => Promise<CatalogBook[]>>()
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('Catalog HTTP 429'))
    .mockResolvedValueOnce([edition]);
  const add = vi.fn().mockResolvedValue('found');
  const options = {
    read: (id: string) => progress[id],
    save: (id: string, state: SyncProgress[string]) => {
      progress[id] = state;
    },
    existing: (_: ShelfBook, hash?: string) => hash,
    search,
    add,
    current: vi.fn(),
    stopping: () => false,
  };
  expect(shelfStatus(row, progress['a'])).toBe('pending');
  await expect(syncShelf([row], options)).rejects.toThrow('429');
  expect(shelfStatus(row, progress['a'])).toBe('pending');
  await syncShelf([row], options);
  await syncShelf([row], options);
  expect(search.mock.calls).toEqual([['Example Writer'], ['Example'], ['Example']]);
  expect(add.mock.calls).toEqual([[edition]]);
  expect(shelfStatus(row, progress['a'])).toBe('added');
});

it('preserves a selected edition and uses a new shelf seed even when an old search was empty', async () => {
  const picked = { ...edition, url: edition.url + '/picked' };
  const progress: SyncProgress = { a: { matches: [] }, b: { selected: picked } };
  const search = vi.fn();
  const add = vi.fn().mockResolvedValue('hash');
  await syncShelf([first, second], {
    read: (id) => progress[id],
    save: (id, state) => {
      progress[id] = state;
    },
    existing: () => undefined,
    search,
    add,
    current: vi.fn(),
    stopping: () => false,
  });
  expect(search).not.toHaveBeenCalled();
  expect(add.mock.calls).toEqual([[edition], [picked]]);
});

it('stops between alternate searches without caching an unfinished or permanently empty answer', async () => {
  const row = { ...first, title: 'Example（新版）', matches: [] };
  const progress: SyncProgress = {};
  let stop = false;
  const search = vi.fn(async () => {
    stop = true;
    return [];
  });
  const add = vi.fn();
  const options = {
    read: (id: string) => progress[id],
    save: (id: string, state: SyncProgress[string]) => {
      progress[id] = state;
    },
    existing: () => undefined,
    search,
    add,
    current: vi.fn(),
    stopping: () => stop,
  };
  await syncShelf([row], options);
  expect(shelfStatus(row, progress['a'])).toBe('pending');
  stop = false;
  await syncShelf([row], options);
  expect(shelfStatus(row, progress['a'])).toBe('missing');
  stop = false;
  await syncShelf([row], options);
  expect(search.mock.calls).toEqual([['Example Writer'], ['Example']]);
  expect(add).not.toHaveBeenCalled();
});
