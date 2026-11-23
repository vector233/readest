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
  expect(search).toHaveBeenCalledTimes(2);
});

it('keeps ambiguous editions available and stops before starting a second download', async () => {
  const progress: SyncProgress = {};
  const ambiguous: ShelfBook = {
    ...first,
    id: 'ambiguous',
    matches: [edition, { ...edition, url: edition.url + '2' }],
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
    search: vi.fn(),
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
