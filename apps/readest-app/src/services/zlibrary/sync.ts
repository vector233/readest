import {
  chooseEdition,
  mergeEditions,
  reviewEditions,
  type CatalogBook,
  type ShelfBook,
} from './catalog';
import { identifyWork, workQueries } from './work';

export interface ShelfProgress {
  hash?: string;
  selected?: CatalogBook;
  matches?: CatalogBook[];
  manual?: boolean;
  browserChecked?: boolean;
  isbnChecked?: boolean;
  /** Successful work-title queries. A failed or paused request remains eligible on resume. */
  workSearches?: string[];
}

export type SyncProgress = Record<string, ShelfProgress>;
export type ShelfStatus = 'added' | 'manual' | 'pending' | 'missing' | 'ready' | 'choose';

export function needsMatch(status: ShelfStatus): boolean {
  return status === 'pending' || status === 'missing' || status === 'choose';
}

export function shelfEditions(book: ShelfBook, progress: ShelfProgress): CatalogBook[] {
  if (!progress.matches?.length) return book.matches || [];
  if (!book.matches?.length) return progress.matches;
  return mergeEditions(progress.matches, book.matches);
}

function remainingQueries(book: ShelfBook, row: ShelfProgress, refresh = false): string[] {
  const done = new Set(refresh ? [] : row.workSearches);
  // Older caches already contain the result of the literal title, including a genuine empty list.
  if (!refresh && (book.matches || (row.matches && !row.workSearches))) done.add(book.title);
  if ((book.isbnChecked || row.isbnChecked) && book.isbn && !refresh) done.add(book.isbn);
  const queries = workQueries(book);
  if (book.isbn) {
    if (book.matches && identifyWork(book).name === book.title) queries.unshift(book.isbn);
    else queries.push(book.isbn);
  }
  return [...new Set(queries)].filter((q) => !done.has(q));
}

export function shelfStatus(book: ShelfBook, progress: ShelfProgress = {}): ShelfStatus {
  if (progress.hash) return 'added';
  if (progress.manual && progress.browserChecked) return 'manual';
  if (progress.selected) return 'ready';
  const matches = shelfEditions(book, progress);
  if (chooseEdition(book, matches)) return 'ready';
  if (reviewEditions(book, matches).length) return 'choose';
  return remainingQueries(book, progress).length ? 'pending' : 'missing';
}

interface SyncOptions {
  read: (id: string) => ShelfProgress | undefined;
  save: (id: string, progress: ShelfProgress) => void;
  existing: (book: ShelfBook, hash?: string) => string | undefined;
  search: (query: string) => Promise<CatalogBook[]>;
  /** No available download link for this edition requires a visit to its detail page. */
  add: (book: CatalogBook) => Promise<string | undefined>;
  stopping: () => boolean;
  current: (book: ShelfBook) => void;
  refresh?: boolean;
  matchOnly?: boolean;
}

export async function syncShelf(books: ShelfBook[], options: SyncOptions) {
  for (const book of books) {
    if (options.stopping()) break;
    let row = options.read(book.id) ?? {};
    const existing = options.existing(book, row.hash);
    if (existing) {
      if (row.hash !== existing) options.save(book.id, { ...row, hash: existing });
      continue;
    }
    if (row.hash) {
      row = { ...row, hash: undefined };
      options.save(book.id, row);
    }
    if (row.manual && row.browserChecked) continue;
    let matches = shelfEditions(book, row);
    let choice = row.selected ?? chooseEdition(book, matches);
    const queries = choice ? [] : remainingQueries(book, row, options.refresh);
    if (queries.length && options.refresh) {
      row = { ...row, workSearches: [], isbnChecked: false };
      options.save(book.id, row);
    }
    const done = new Set(row.workSearches);
    if (!row.workSearches && (book.matches || row.matches)) done.add(book.title);
    for (const query of queries) {
      if (choice || options.stopping()) break;
      options.current(book);
      const editions = await options.search(query);
      matches = reviewEditions(book, mergeEditions(editions, matches));
      done.add(query);
      row = {
        ...row,
        matches,
        workSearches: [...done],
        isbnChecked: query === book.isbn || row.isbnChecked,
      };
      options.save(book.id, row);
      choice = chooseEdition(book, matches);
    }
    if (options.matchOnly || !choice || options.stopping()) continue;
    options.current(book);
    const hash = await options.add(choice);
    options.save(book.id, { ...row, selected: choice, hash, manual: !hash, browserChecked: true });
  }
}
