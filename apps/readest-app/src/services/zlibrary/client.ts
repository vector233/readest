import { invoke } from '@tauri-apps/api/core';
import { compatibleScope, identifyWork } from './work';
import type { WebBrowserPage } from '@/services/webBrowser/webBrowser';
import {
  CATALOG_ORIGIN,
  catalogLink,
  downloadLink,
  parseCatalog,
  parsePopular,
  searchUrl,
  type CatalogBook,
} from './catalog';

async function catalogPage(url: string, signal?: AbortSignal): Promise<WebBrowserPage> {
  signal?.throwIfAborted();
  const page = await invoke<WebBrowserPage>('read_catalog_page', { url });
  signal?.throwIfAborted();
  return page;
}

export async function searchCatalog(query: string, signal?: AbortSignal) {
  return parseCatalog((await catalogPage(searchUrl(query), signal)).html);
}

export async function searchByTitle(query: string, signal?: AbortSignal) {
  const literal = query.trim();
  const work = identifyWork({ title: literal, author: '' });
  if (!work.name || work.name === literal) return searchCatalog(literal, signal);
  const books = await searchCatalog(work.name, signal);
  const related = (book: CatalogBook) => {
    const candidate = identifyWork(book);
    return (
      candidate.key === work.key &&
      compatibleScope(work.scope, candidate.scope) &&
      candidate.form === work.form &&
      (!work.subtitle || !candidate.subtitle || candidate.subtitle === work.subtitle)
    );
  };
  if (books.some(related)) return [...books.filter(related), ...books.filter((b) => !related(b))];
  const exact = await searchCatalog(literal, signal);
  return [...new Map([...exact, ...books].map((book) => [book.url, book])).values()];
}

export async function popularCatalog(signal?: AbortSignal) {
  return parsePopular((await catalogPage(CATALOG_ORIGIN + '/', signal)).html);
}

export async function downloadEdition(
  book: CatalogBook,
  onDownload?: () => void,
): Promise<string | null> {
  const url = catalogLink(book.url, '/book/');
  if (!url) return null;
  const page = await catalogPage(url);
  const link = downloadLink(page.html);
  if (!link) return null;
  onDownload?.();
  return invoke<string | null>('download_catalog_book', {
    url: link,
    format: book.format,
    referer: page.url,
  });
}
