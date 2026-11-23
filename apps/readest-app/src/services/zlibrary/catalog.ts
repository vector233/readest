import { identifyWork, normalizeName, workStrength, type BookCredit } from './work';

export const CATALOG_ORIGIN = 'https://zh.z-library.sk';

export interface CatalogBook {
  title: string;
  author: string;
  format: string;
  url: string;
  isbn?: string;
}

export interface ShelfBook {
  id: string;
  title: string;
  author: string;
  isbn?: string;
  /** Missing until searched. An empty array means the catalog returned no books. */
  matches?: CatalogBook[];
  isbnChecked?: boolean;
}

export function searchUrl(query: string): string {
  return CATALOG_ORIGIN + '/s/' + encodeURIComponent(query.trim());
}

export function catalogLink(value: unknown, prefix: '/book/' | '/dl/'): string | undefined {
  if (typeof value !== 'string' || !value) return;
  try {
    const url = new URL(value, CATALOG_ORIGIN);
    if (
      url.origin === CATALOG_ORIGIN &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith(prefix) &&
      url.pathname.length > prefix.length
    ) {
      return url.href;
    }
  } catch {
    // An incomplete or external card is not a catalog item.
  }
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeBook(value: unknown): CatalogBook | undefined {
  if (!record(value)) return;
  const url = catalogLink(value['url'], '/book/');
  if (!url || typeof value['title'] !== 'string' || !value['title'].trim()) return;
  return {
    title: value['title'].trim(),
    author: typeof value['author'] === 'string' ? value['author'].trim() : '',
    format: typeof value['format'] === 'string' ? value['format'].toLowerCase().trim() : '',
    url,
    ...(typeof value['isbn'] === 'string' && value['isbn'] ? { isbn: value['isbn'] } : {}),
  };
}

export function decodeCatalogBooks(input: unknown): CatalogBook[] {
  return Array.isArray(input) ? input.map(decodeBook).filter((b): b is CatalogBook => !!b) : [];
}

export function decodeShelf(input: unknown): ShelfBook[] {
  if (!record(input) || input['version'] !== 1 || !Array.isArray(input['books'])) return [];
  const seen = new Set<string>();
  const books: ShelfBook[] = [];
  for (const item of input['books']) {
    if (
      !record(item) ||
      typeof item['id'] !== 'string' ||
      !item['id'] ||
      typeof item['title'] !== 'string' ||
      !item['title'].trim() ||
      seen.has(item['id'])
    )
      continue;
    seen.add(item['id']);
    books.push({
      id: item['id'],
      title: item['title'].trim(),
      author: typeof item['author'] === 'string' ? item['author'].trim() : '',
      ...(item['isbnChecked'] === true ? { isbnChecked: true } : {}),
      ...(typeof item['isbn'] === 'string' && item['isbn'] ? { isbn: item['isbn'] } : {}),
      ...(Array.isArray(item['matches'])
        ? { matches: item['matches'].map(decodeBook).filter((b): b is CatalogBook => !!b) }
        : {}),
    });
  }
  // A lookup for a different shelf entry may already have returned this work.
  // Reuse verified catalog records before issuing another request from the phone.
  const byTitle = new Map<string, CatalogBook[]>();
  const byIsbn = new Map<string, CatalogBook[]>();
  const seenUrls = new Set<string>();
  for (const shelf of books) {
    for (const candidate of shelf.matches || []) {
      if (seenUrls.has(candidate.url)) continue;
      seenUrls.add(candidate.url);
      const work = identifyWork(candidate);
      for (const key of [work.key, ...work.aliasKeys]) {
        if (!byTitle.has(key)) byTitle.set(key, []);
        byTitle.get(key)!.push(candidate);
      }
      for (const id of isbns(candidate.isbn)) {
        if (!byIsbn.has(id)) byIsbn.set(id, []);
        byIsbn.get(id)!.push(candidate);
      }
    }
  }
  for (const shelf of books) {
    if (chooseEdition(shelf, shelf.matches || [])) continue;
    const work = identifyWork(shelf);
    const additional = [
      ...isbns(shelf.isbn).flatMap((id) => byIsbn.get(id) || []),
      ...[work.key, ...work.aliasKeys].flatMap((key) => byTitle.get(key) || []),
    ];
    if (!additional.length) continue;
    const combined = mergeEditions(shelf.matches || [], additional);
    if (chooseEdition(shelf, combined)) shelf.matches = combined;
  }
  return books;
}

export function mergeEditions(first: CatalogBook[], other: CatalogBook[]) {
  const found = new Map<string, CatalogBook>();
  for (const book of [...first, ...other]) {
    const key = /\/book\/(\d+)\/[^/]+/u.exec(book.url)?.[1] || book.url;
    const previous = found.get(key);
    if (!previous || (!previous.isbn && book.isbn)) found.set(key, book);
  }
  return [...found.values()];
}

export function parseCatalog(html: string): CatalogBook[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const empty = doc.querySelector('.notFound, .not-found');
  if (
    empty &&
    /没有找到|未找到|没有搜索到|nothing found|no (books|results)|not found/i.test(
      empty.textContent || '',
    )
  )
    return [];
  const seen = new Set<string>();
  const books: CatalogBook[] = [];
  for (const card of doc.querySelectorAll('z-bookcard:not([nofollow]):not([deleted="1"])')) {
    const item = decodeBook({
      url: card.getAttribute('href'),
      title: card.querySelector('[slot="title"]')?.textContent,
      author: card.querySelector('[slot="author"]')?.textContent,
      format: card.getAttribute('extension'),
      isbn: card.getAttribute('isbn'),
    });
    if (item && !seen.has(item.url)) {
      seen.add(item.url);
      books.push(item);
    }
  }
  if (!books.length) throw new Error('Catalog unavailable');
  return books;
}

export { normalizeName } from './work';

export function sameBook(left: BookCredit, right: BookCredit): boolean {
  // A library item has no catalog context to disambiguate a missing subtitle.
  return workStrength(identifyWork(left), identifyWork(right)) >= 3;
}

export const editionPreference = ['epub', 'azw3', 'mobi', 'fb2', 'pdf', 'txt'];

function isbns(value?: string): string[] {
  return (value || '')
    .toUpperCase()
    .split(/[,;；，]/u)
    .map((v) => v.replace(/[\s-]/gu, ''))
    .filter((v) => /^(?:\d{9}[\dX]|\d{13})$/u.test(v));
}

function editionStrength(shelf: ShelfBook, choice: CatalogBook): number {
  const isbn = isbns(shelf.isbn);
  if (isbn.length && isbns(choice.isbn).some((id) => isbn.includes(id))) return 10;
  return workStrength(identifyWork(shelf), identifyWork(choice));
}

export function chooseEdition(shelf: ShelfBook, choices: CatalogBook[]): CatalogBook | undefined {
  const scored = choices
    .filter((b) => editionPreference.includes(b.format))
    .map((b) => ({ book: b, strength: editionStrength(shelf, b) }));
  const best = Math.max(0, ...scored.map((m) => m.strength));
  if (!best) return;
  const matches = scored.filter((m) => m.strength === best).map((m) => m.book);
  const work = identifyWork(shelf);
  if (best === 2) {
    if (new Set(matches.map((b) => identifyWork(b).subtitle)).size > 1) return;
    if (
      work.subtitle &&
      choices.some((b) => {
        const other = identifyWork(b);
        return (
          other.key === work.key &&
          other.authorKey === work.authorKey &&
          other.scope === work.scope &&
          !!other.subtitle &&
          other.subtitle !== work.subtitle
        );
      })
    )
      return;
  }
  for (const format of editionPreference) {
    const editions = matches.filter((b) => b.format === format);
    if (!editions.length) continue;
    if (editions.length === 1 || best === 10) return editions[0];
    // Interchangeable copies of a known edition do not require a manual decision.
    const ids = isbns(editions[0]!.isbn);
    if (ids.some((id) => editions.every((b) => isbns(b.isbn).includes(id)))) return editions[0];
    // Multiple files of the same confirmed work are common. Keep explicit,
    // competing revisions for review when the requested revision is missing.
    const revisions = new Set(editions.map((b) => identifyWork(b).edition).filter(Boolean));
    if (work.edition && !revisions.has(work.edition) && revisions.size > 1) return;
    if (new Set(editions.map((b) => identifyWork(b).scope)).size === 1) {
      return editions.find((b) => isbns(b.isbn).length > 0) || editions[0];
    }
    return;
  }
  return undefined;
}

/** Only show plausible results for a shelf entry. Keep conflicting volumes available for review. */
export function reviewEditions(shelf: ShelfBook, choices: CatalogBook[]): CatalogBook[] {
  const work = identifyWork(shelf);
  return choices
    .map((book) => {
      const candidate = identifyWork(book);
      const strength = editionStrength(shelf, book);
      const related =
        candidate.key === work.key ||
        (work.key.length >= 3 &&
          normalizeName(book.title).includes(work.key) &&
          !!work.authorKey &&
          candidate.authorKey === work.authorKey);
      return {
        book,
        score: strength
          ? 10 + strength
          : related
            ? work.authorKey === candidate.authorKey
              ? 2
              : 1
            : 0,
      };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((m) => m.book);
}

export function downloadLink(html: string): string | undefined {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const anchor of doc.querySelectorAll(
    'a.addDownloadedBook[href], a.dlButton[href], a[href^="/dl/"]',
  )) {
    const url = catalogLink(anchor.getAttribute('href'), '/dl/');
    if (url) return url;
  }
  return undefined;
}

/** The Chinese homepage places its live popular shelf inside this masonry element. */
export function parsePopular(html: string): CatalogBook[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set<string>();
  const books: CatalogBook[] = [];
  for (const cover of doc.querySelectorAll('z-masonry[source="mostpopular"] a[href] z-cover')) {
    const book = decodeBook({
      url: cover.closest('a')?.getAttribute('href'),
      title: cover.getAttribute('title'),
      author: cover.getAttribute('author'),
      isbn: cover.getAttribute('isbn'),
    });
    if (book && !seen.has(book.url)) {
      books.push(book);
      seen.add(book.url);
    }
  }
  if (!books.length) throw new Error('Popular shelf unavailable');
  return books;
}
