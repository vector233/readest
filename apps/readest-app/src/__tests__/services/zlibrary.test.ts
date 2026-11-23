import { describe, expect, it } from 'vitest';
import { workQueries } from '@/services/zlibrary/work';
import {
  chooseEdition,
  decodeShelf,
  parseCatalog,
  reviewEditions,
  sameBook,
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

  it('locates a work in an existing catalog snapshot when its own literal query was empty', () => {
    const wanted = { ...shelf, title: title + '（2024）', matches: [] };
    const [, sibling] = decodeShelf({
      version: 1,
      books: [{ ...shelf, id: 'source', title: 'Another', matches: [book] }, wanted],
    });
    expect(chooseEdition(sibling!, sibling?.matches || [])).toEqual(book);
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

  it('prefers an EPUB by the requested author, including equivalent catalog copies', () => {
    const pdf = { ...book, format: 'pdf', url: origin + '/book/2/a' };
    expect(chooseEdition(shelf, [pdf, book])).toEqual(book);
    expect(chooseEdition(shelf, [book, { ...book, url: origin + '/book/2/b' }])).toEqual(book);
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

describe('matching a work across editions', () => {
  const writer = '林舟';
  const shelfBook = (title: string, author = writer) => ({ id: 'work', title, author });
  const file = (title: string, author = writer): CatalogBook => ({ ...book, title, author });

  it.each([
    ['月港纪事（2024）', '月港纪事'],
    ['月港纪事--国民阅读经典（典藏版）', '月港纪事'],
    ['月港纪事-2024版', '月港纪事'],
    ['月港纪事（同名电影原著）【珍藏版】', '月港纪事'],
    ['月港纪事：潮声里的故事', '月港纪事'],
    ['国民阅读经典：月港纪事', '月港纪事'],
    ['约翰-克里斯', '约翰-克里斯'],
    ['Catch-22', 'Catch-22'],
    ['1932–1972', '1932–1972'],
    ['1984', '1984'],
    ['上下五千年', '上下五千年'],
  ])('retrieves %s by its work title', (title, name) => {
    const row = shelfBook(title, '[唐]林舟著');
    expect(workQueries(row)[0]).toBe(name + ' 林舟');
    expect(chooseEdition(row, [file(name, '林舟（Lin Zhou）')])?.title).toBe(name);
  });

  it('ranks an exact requested edition above another printing of the same work', () => {
    const requested = shelfBook('月港纪事（2024版）');
    const best = file('月港纪事（典藏2024年版）');
    const other = { ...file('月港纪事（2019版）'), url: book.url + '/other' };
    expect(chooseEdition(requested, [other, best])).toBe(best);
  });

  it('searches a documented alternative title and verifies its author and volume', () => {
    const row = shelfBook('月港纪事（又名：《潮痕》）');
    expect(workQueries(row)).toContain('潮痕');
    expect(chooseEdition(row, [file('潮痕', '林海')])).toBeUndefined();
    expect(chooseEdition(row, [file('潮痕（下册）')])).toBeUndefined();
    expect(chooseEdition(row, [file('潮痕')])?.title).toBe('潮痕');
    expect(chooseEdition(shelfBook('潮痕'), [file('月港纪事 = 潮痕')])?.title).toBe(
      '月港纪事 = 潮痕',
    );
  });

  it.each([
    ['月港纪事（上册）', '月港纪事（下册）'],
    ['月港纪事（1）', '月港纪事（2）'],
    ['月港纪事（第2卷）', '月港纪事（全集）'],
    ['月港纪事（全三册）', '月港纪事（全二册）'],
    ['月港纪事（全三册）', '月港纪事'],
    ['月港纪事（全三册｜漫画版）', '月港纪事（全三册）'],
    ['月港纪事：风暴', '月港纪事：初雪'],
    ['月港纪事（英文版）', '月港纪事'],
    ['月港纪事', '月港纪事（漫画版）'],
    ['月港纪事', '月港纪事续集'],
  ])('keeps %s separate from %s', (left, right) => {
    expect(chooseEdition(shelfBook(left), [file(right)])).toBeUndefined();
    expect(sameBook(shelfBook(left), file(right))).toBe(false);
  });

  it('normalizes equivalent set sizes and keeps compatible parts in preferred order for review', () => {
    const row = shelfBook('《月港纪事》（全集，共3册）');
    const correct = file('月港纪事（全三册｜同名影视原著）');
    const wrong = file('月港纪事（上册）');
    expect(chooseEdition(row, [wrong, correct])).toBe(correct);
    expect(reviewEditions(row, [wrong, file('另一部书'), correct])).toEqual([correct, wrong]);
  });

  it('needs an author for a common title, and leaves competing subtitles for review', () => {
    const row = shelfBook('渡口');
    expect(chooseEdition(row, [file('渡口', '林海')])).toBeUndefined();
    expect(
      chooseEdition(shelfBook('渡口', '林舟 & 海青'), [file('渡口', '林舟 & 丁丁')]),
    ).toBeUndefined();
    expect(chooseEdition(shelfBook('渡口', ''), [file('渡口')])).toBeUndefined();
    expect(chooseEdition(row, [file('渡口：黎明'), file('渡口：归航')])).toBeUndefined();
    expect(
      chooseEdition(shelfBook('渡口：黎明'), [file('渡口'), file('渡口：归航')]),
    ).toBeUndefined();
    expect(
      chooseEdition(shelfBook('渡口（2024版）'), [file('渡口（2020版）'), file('渡口（2019版）')]),
    ).toBeUndefined();
  });
});
