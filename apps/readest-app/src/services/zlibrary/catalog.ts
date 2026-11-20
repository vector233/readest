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
      ...(typeof item['isbn'] === 'string' && item['isbn'] ? { isbn: item['isbn'] } : {}),
      ...(Array.isArray(item['matches'])
        ? { matches: item['matches'].map(decodeBook).filter((b): b is CatalogBook => !!b) }
        : {}),
    });
  }
  return books;
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

export function normalizeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function authorKey(value: string): string {
  return normalizeName(
    value
      .replace(
        /[（(【\[]\s*(?:美|英|德|法|日|中|意|俄|加|澳|瑞典|美国|英国|法国|日本|德国)\s*[）)】\]]/g,
        '',
      )
      .replace(/(?:编著|著)$/u, ''),
  );
}

export function sameBook(
  left: Pick<ShelfBook, 'title' | 'author'>,
  right: Pick<CatalogBook, 'title' | 'author'>,
): boolean {
  const author = authorKey(left.author);
  return (
    !!author &&
    author === authorKey(right.author) &&
    normalizeName(left.title) === normalizeName(right.title)
  );
}

export const editionPreference = ['epub', 'azw3', 'mobi', 'fb2', 'pdf', 'txt'];

export function chooseEdition(shelf: ShelfBook, choices: CatalogBook[]): CatalogBook | undefined {
  const isbn = shelf.isbn?.replace(/[^0-9X]/gi, '').toUpperCase();
  const byIsbn =
    isbn && /^(?:[\dX]{10}|\d{13})$/.test(isbn)
      ? choices.filter((b) =>
          b.isbn?.split(/[,;]/).some((v) => v.replace(/[^0-9X]/gi, '').toUpperCase() === isbn),
        )
      : [];
  const matches = byIsbn.length ? byIsbn : choices.filter((b) => sameBook(shelf, b));
  for (const format of editionPreference) {
    const editions = matches.filter((b) => b.format === format);
    if (editions.length) return editions.length === 1 ? editions[0] : undefined;
  }
  return undefined;
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
