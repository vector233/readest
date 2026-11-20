import { describe, expect, it } from 'vitest';
import {
  chooseEdition,
  decodeShelf,
  parseCatalog,
  searchUrl,
  type CatalogBook,
} from '@/services/zlibrary/catalog';

const origin = 'https://zh.z-library.sk';
const title = 'A Study in Scarlet';
const author = 'Arthur Conan Doyle';
const book: CatalogBook = { title, author, url: origin + '/book/1/abc/test', format: 'epub' };
const shelf = { id: 'one', title, author };

describe('personal book discovery', () => {
  it('encodes the search as a single path segment on the selected host', () => {
    expect(searchUrl('A/B ?')).toBe(origin + '/s/A%2FB%20%3F');
  });

  it('loads unique shelf records and ignores incomplete entries', () => {
    expect(decodeShelf({ version: 1, books: [shelf, shelf, { title }] })).toEqual([shelf]);
  });

  it('reads actual book cards, resolves relative URLs and ignores links to other sites', () => {
    const card = (href: string) => `<z-bookcard href="${href}" extension="EPUB">
      <div slot="title">${title}</div><div slot="author">${author}</div></z-bookcard>`;
    expect(
      parseCatalog(card('/book/1/abc/test') + card('https://elsewhere.example/book/2/x')),
    ).toEqual([book]);
  });

  it('distinguishes explicit empty results from a challenge or unrecognized response', () => {
    expect(parseCatalog('<main class="notFound">没有找到相关书籍</main>')).toEqual([]);
    expect(() => parseCatalog('<title>Access Denied | DiamWall</title>')).toThrow();
    expect(() => parseCatalog('<form>Sign in</form>')).toThrow();
  });

  it('prefers an EPUB by the requested author and leaves ambiguous editions for review', () => {
    const pdf = { ...book, format: 'pdf', url: origin + '/book/2/a' };
    expect(chooseEdition(shelf, [pdf, book])).toEqual(book);
    expect(chooseEdition(shelf, [book, { ...book, url: origin + '/book/2/b' }])).toBeUndefined();
    expect(chooseEdition(shelf, [{ ...book, author: 'Someone Else' }])).toBeUndefined();
    expect(chooseEdition({ ...shelf, author: '' }, [book])).toBeUndefined();
  });
});

it('selects one copy when two files have the same exact ISBN and format', () => {
  const first = { ...book, isbn: '9780306406157' };
  const second = { ...first, url: origin + '/book/2/b' };
  expect(chooseEdition({ ...shelf, isbn: '978-0-306-40615-7' }, [first, second])).toEqual(first);
});

it('ignores the synthetic book card supplied on a real empty results page', () => {
  const empty = '<div class="notFound color3">按照您的查询，没有找到任何信息.</div>';
  const synthetic =
    '<z-bookcard nofollow href="/book/synthetic"><div slot="title">Query</div></z-bookcard>';
  expect(parseCatalog(empty + synthetic)).toEqual([]);
});
