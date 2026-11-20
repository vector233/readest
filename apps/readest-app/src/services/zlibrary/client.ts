import { invoke } from '@tauri-apps/api/core';
import { browserFetch } from '@/services/webBrowser/browserFetch';
import {
  CATALOG_ORIGIN,
  catalogLink,
  downloadLink,
  parseCatalog,
  parsePopular,
  searchUrl,
  type CatalogBook,
} from './catalog';

async function catalogPage(url: string, signal?: AbortSignal): Promise<string> {
  const response = await browserFetch(url, {
    signal,
    headers: {
      'User-Agent': navigator.userAgent,
      Accept: 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  if (!response.ok || new URL(response.url).origin !== CATALOG_ORIGIN) {
    throw new Error('Catalog HTTP ' + response.status);
  }
  return response.text();
}

export async function searchCatalog(query: string, signal?: AbortSignal) {
  return parseCatalog(await catalogPage(searchUrl(query), signal));
}

export async function popularCatalog(signal?: AbortSignal) {
  return parsePopular(await catalogPage(CATALOG_ORIGIN + '/', signal));
}

export async function downloadEdition(book: CatalogBook): Promise<string | null> {
  const url = catalogLink(book.url, '/book/');
  if (!url) return null;
  const link = downloadLink(await catalogPage(url));
  if (!link) return null;
  return invoke<string | null>('download_catalog_book', {
    url: link,
    format: book.format,
    userAgent: navigator.userAgent,
  });
}
