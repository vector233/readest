import { invoke } from '@tauri-apps/api/core';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, expect, it, vi } from 'vitest';
import { downloadEdition, searchCatalog } from '@/services/zlibrary/client';
import {
  CATALOG_ORIGIN,
  downloadLink,
  parseCatalog,
  parsePopular,
} from '@/services/zlibrary/catalog';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const book = {
  title: 'Example',
  author: 'Writer',
  format: 'epub',
  url: CATALOG_ORIGIN + '/book/17/example',
};
const invoked = vi.mocked(invoke);

beforeEach(() => {
  invoked.mockReset();
});

it('downloads the link from the rendered book page in the same browser session', async () => {
  const canonical = CATALOG_ORIGIN + '/book/17/canonical';
  invoked.mockImplementation(async (command) => {
    if (command === 'read_catalog_page') {
      return { url: canonical, html: '<a href="/dl/17/book">Download</a>' };
    }
    if (command === 'download_catalog_book') return '/cache/example.epub';
    throw new Error('The separate HTTP client has no browser page');
  });
  await expect(downloadEdition(book)).resolves.toBe('/cache/example.epub');
  expect(invoked.mock.calls).toEqual([
    ['read_catalog_page', { url: book.url }],
    [
      'download_catalog_book',
      { url: CATALOG_ORIGIN + '/dl/17/book', format: 'epub', referer: canonical },
    ],
  ]);
});

it('stops when the listing in the browser hits a site limit', async () => {
  invoked.mockRejectedValue('Catalog HTTP 429');
  await expect(searchCatalog('Example')).rejects.toBe('Catalog HTTP 429');
  expect(invoked.mock.calls).toEqual([
    ['read_catalog_page', { url: CATALOG_ORIGIN + '/s/Example' }],
  ]);
});

function capture(url: string, body: string, requested = url) {
  const doc = document.implementation.createHTMLDocument();
  const base = doc.createElement('base');
  base.href = url;
  doc.head.append(base);
  doc.body.innerHTML = body;
  const script = readFileSync(
    'src-tauri/plugins/tauri-plugin-native-bridge/android/src/main/assets/readest-catalog-page.js',
    'utf8',
  );
  return runInNewContext(
    script.replace('__READEST_CATALOG_URL__', () => JSON.stringify(requested)),
    {
      document: doc,
      location: new URL(url),
      URL,
    },
  ) as { url: string; html: string; error?: string };
}

it('imports the primary rendered download even when another edition is linked first', () => {
  const page = capture(
    book.url,
    '<a href="/dl/other">Other edition</a><a class="addDownloadedBook" href="/dl/17/file">EPUB</a><input value="private">',
  );
  expect(downloadLink(page.html)).toBe(CATALOG_ORIGIN + '/dl/17/file');
  expect(page.html).not.toContain('private');
});

it('reads rendered catalog listings and pauses on an unexpected page or edition', () => {
  const listing = capture(
    CATALOG_ORIGIN + '/s/Example',
    '<z-bookcard href="/book/17/example" extension="epub"><span slot="title">Example</span><span slot="author">Writer</span></z-bookcard>',
  );
  expect(parseCatalog(listing.html)).toEqual([book]);
  const popular = capture(
    CATALOG_ORIGIN + '/',
    '<z-masonry source="mostpopular"><a href="/book/17/example"><z-cover title="Example" author="Writer"></z-cover></a></z-masonry>',
  );
  expect(parsePopular(popular.html)[0]?.url).toBe(book.url);
  expect(capture(book.url, '<form><input type="password"></form>').error).toBe(
    'Catalog access required',
  );
  expect(
    capture(CATALOG_ORIGIN + '/book/18/other', '<a href="/dl/18/file">Other</a>', book.url).error,
  ).toBe('Catalog access required');
  expect(
    capture(
      'https://elsewhere.example/book/17/example',
      '<a href="/dl/17/file">Other</a>',
      book.url,
    ).error,
  ).toBe('Catalog access required');
});
