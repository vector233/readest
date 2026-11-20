import { chooseEdition, type CatalogBook, type ShelfBook } from './catalog';

export interface ShelfProgress {
  hash?: string;
  selected?: CatalogBook;
  matches?: CatalogBook[];
  manual?: boolean;
}

export type SyncProgress = Record<string, ShelfProgress>;
export type ShelfStatus = 'added' | 'manual' | 'pending' | 'missing' | 'ready' | 'choose';

export function shelfStatus(book: ShelfBook, progress: ShelfProgress = {}): ShelfStatus {
  if (progress.hash) return 'added';
  if (progress.manual) return 'manual';
  if (progress.selected) return 'ready';
  const matches = progress.matches ?? book.matches;
  if (!matches) return 'pending';
  if (!matches.length) return 'missing';
  return chooseEdition(book, matches) ? 'ready' : 'choose';
}

interface SyncOptions {
  read: (id: string) => ShelfProgress | undefined;
  save: (id: string, progress: ShelfProgress) => void;
  existing: (book: ShelfBook, hash?: string) => string | undefined;
  search: (book: ShelfBook) => Promise<CatalogBook[]>;
  /** No available download link for this edition requires a visit to its detail page. */
  add: (book: CatalogBook) => Promise<string | undefined>;
  stopping: () => boolean;
  current: (book: ShelfBook) => void;
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
    if (row.manual) continue;
    let matches = row.matches ?? book.matches;
    if (!matches && !row.selected) {
      options.current(book);
      matches = await options.search(book);
      row = { ...row, matches };
      options.save(book.id, row);
    }
    const choice = row.selected ?? chooseEdition(book, matches ?? []);
    if (!choice || options.stopping()) continue;
    options.current(book);
    const hash = await options.add(choice);
    options.save(book.id, { ...row, selected: choice, hash, manual: !hash });
  }
}
