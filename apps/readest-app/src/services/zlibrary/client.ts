import { invoke } from '@tauri-apps/api/core';
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
