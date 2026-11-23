import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BaseDirectory, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { useRouter } from 'next/navigation';
import Dialog from '@/components/Dialog';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { navigateToReader } from '@/utils/nav';
import { openWebBrowser, type WebBrowserPage } from '@/services/webBrowser/webBrowser';
import { getWebBrowserOptions } from '@/services/webBrowser/webBrowserOptions';
import {
  CATALOG_ORIGIN,
  chooseEdition,
  decodeShelf,
  decodeCatalogBooks,
  editionPreference,
  reviewEditions,
  sameBook,
  searchUrl,
  type CatalogBook,
  type ShelfBook,
} from '@/services/zlibrary/catalog';
import {
  searchCatalog,
  searchByTitle,
  popularCatalog,
  downloadEdition,
} from '@/services/zlibrary/client';
import { workQueries } from '@/services/zlibrary/work';
import {
  shelfStatus,
  shelfEditions,
  needsMatch,
  syncShelf,
  type ShelfProgress,
  type ShelfStatus,
  type SyncProgress,
} from '@/services/zlibrary/sync';

const storageKey = 'readest-personal-shelf-progress-v1';
type Tab = 'search' | 'popular' | 'shelf';
type Props = { onClose: () => void; onClip: (page: WebBrowserPage) => Promise<void> };
const button = 'btn btn-sm min-h-10';
const linkButton = 'text-primary min-h-10 px-2 text-start text-sm underline';

function readProgress(): SyncProgress {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}') as SyncProgress | null;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

export default function BookDiscoveryDialog({ onClose, onClip }: Props) {
  const _ = useTranslation();
  const router = useRouter();
  const { appService, envConfig } = useEnv();
  const [tab, setTab] = useState<Tab>('shelf');
  const [shelf, setShelf] = useState<ShelfBook[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [progress, setProgress] = useState<SyncProgress>(readProgress);
  const records = useRef(progress);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogBook[]>();
  const [popular, setPopular] = useState<CatalogBook[]>();
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState('');
  const [message, setMessage] = useState('');
  const [failedPage, setFailedPage] = useState('');
  const [expanded, setExpanded] = useState('');
  const [filter, setFilter] = useState<'all' | 'unresolved' | ShelfStatus>('all');
  const active = useRef(false);
  const stop = useRef(false);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const labels: Record<ShelfStatus, string> = {
    added: _('In library'),
    manual: _('Open book page'),
    pending: _('Pending search'),
    missing: _('No matches'),
    ready: _('Ready to import'),
    choose: _('Choose edition'),
  };

  useEffect(() => {
    mounted.current = true;
    void readTextFile('files/personal-shelf.json', { baseDir: BaseDirectory.AppData })
      .then((raw) => {
        if (!mounted.current) return;
        const seed = JSON.parse(raw);
        const owned = decodeShelf(seed);
        setShelf(owned);
        const initialPopular = decodeCatalogBooks(seed.popular).filter(
          (b) => !owned.some((s) => sameBook(s, b)),
        );
        if (initialPopular.length) setPopular(initialPopular.slice(0, 30));
      })
      .catch(() => {
        if (mounted.current) setTab('search');
      })
      .finally(() => {
        if (mounted.current) setLoaded(true);
      });
    return () => {
      mounted.current = false;
      stop.current = true;
      request.current?.abort();
    };
  }, []);

  const save = (id: string, record: ShelfProgress) => {
    const next = { ...records.current, [id]: record };
    localStorage.setItem(storageKey, JSON.stringify(next));
    records.current = next;
    if (mounted.current) setProgress(next);
  };

  const showError = useCallback(
    (error: unknown, book?: { title: string; url: string; stage: string }) => {
      if (!mounted.current) return;
      const text = String(error);
      const status = /Catalog HTTP (\d{3})\b/.exec(text)?.[1];
      let reason = _('The request failed.');
      if (status === '429') reason = _('The site limit was reached. Resume later.');
      else if (status) reason = _('The site returned HTTP {{status}}.', { status });
      else if (text.includes('Catalog access required'))
        reason = _('The site requested verification or sign-in.');
      else if (text.includes('timed out')) reason = _('The request timed out.');
      else if (text.includes('Catalog returned a page') || text.includes('unexpected file'))
        reason = _('The download did not return a book file.');
      else if (text.includes('Catalog page not recognized'))
        reason = _('Could not read the book page. Check the download on the site.');
      else if (text.includes('network error') || text.includes('file transfer failed'))
        reason = _('The connection to the book site failed.');
      setFailedPage(book?.url || '');
      setMessage(book ? [book.title, book.stage, reason].join(' · ') : reason);
    },
    [_],
  );

  const browse = async (url: string) => {
    if (busy || active.current) return;
    setBusy(true);
    setMessage('');
    setFailedPage('');
    try {
      const outcome = await openWebBrowser(url, getWebBrowserOptions(_, !!appService?.isEink));
      if (outcome.openBookHash) {
        onClose();
        navigateToReader(router, [outcome.openBookHash]);
      } else if (outcome.page) await onClip(outcome.page);
    } catch (err) {
      showError(err);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const lookup = async (mode: 'search' | 'popular', term = '') => {
    if (active.current || (mode === 'search' && !term.trim())) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setMessage('');
    setFailedPage('');
    if (mode === 'search') setResults(undefined);
    try {
      const books =
        mode === 'search'
          ? await searchByTitle(term, controller.signal)
          : await popularCatalog(controller.signal);
      if (!controller.signal.aborted) {
        if (mode === 'popular')
          setPopular(books.filter((b) => !shelf.some((owned) => sameBook(owned, b))).slice(0, 30));
        else setResults(books);
      }
    } catch (err) {
      if (!controller.signal.aborted) showError(err);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const start = async (books: ShelfBook[], { refresh = false, matchOnly = false } = {}) => {
    if (!appService || busy || active.current) return;
    active.current = true;
    stop.current = false;
    setRunning(true);
    setMessage('');
    setFailedPage('');
    setCurrent('');
    let context: { title: string; url: string; stage: string } | undefined;
    try {
      const ready = (book: ShelfBook) => shelfStatus(book, records.current[book.id]) === 'ready';
      // Import the verified editions first, even if later searches need the site to be unlocked.
      const ordered = [...books.filter(ready), ...books.filter((b) => !ready(b))];
      await syncShelf(ordered, {
        refresh,
        matchOnly,
        read: (id) => records.current[id],
        save,
        existing: (book, hash) =>
          useLibraryStore
            .getState()
            .library.find(
              (b) =>
                !b.deletedAt &&
                (b.hash === hash || sameBook(book, b)) &&
                (b.downloadedAt || b.filePath),
            )?.hash,
        search: (query) => {
          if (context) context.url = searchUrl(query);
          return searchCatalog(query);
        },
        add: async (edition) => {
          const entry = {
            title: edition.title,
            url: edition.url,
            stage: _('Opening book details'),
          };
          context = entry;
          const path = await downloadEdition(edition, () => {
            entry.stage = _('Downloading book');
          });
          if (!path) return;
          try {
            entry.stage = _('Importing');
            const library = useLibraryStore.getState();
            const book = await appService.importBook(path, library.library);
            if (!book) throw new Error('Import failed');
            if (!book.title || /^catalog-[0-9a-f-]{36}(?:\.\w+)?$/i.test(book.title))
              book.title = edition.title;
            if (!book.author) book.author = edition.author;
            await library.updateBooks(envConfig, [book]);
            return book.hash;
          } finally {
            await remove(path).catch(() => {});
          }
        },
        stopping: () => stop.current,
        current: (book) => {
          context = { title: book.title, url: searchUrl(book.title), stage: _('Search') };
          if (mounted.current) setCurrent(book.title);
        },
      });
      if (mounted.current)
        setMessage(
          stop.current
            ? _('Sync paused. Your progress is saved.')
            : matchOnly
              ? _('Finished matching. Confirmed books are ready to import.')
              : _('Finished checking the shelf. Review any books that need an edition.'),
        );
    } catch (err) {
      showError(err, context);
    } finally {
      active.current = false;
      if (mounted.current) {
        setRunning(false);
        setCurrent('');
      }
    }
  };

  const close = () => {
    if (active.current) {
      stop.current = true;
      setMessage(_('Finishing the current book…'));
    } else onClose();
  };
  const { counts, statuses } = useMemo(() => {
    const counts: Partial<Record<ShelfStatus, number>> = {};
    const statuses = new Map<string, ShelfStatus>();
    for (const book of shelf) {
      const status = shelfStatus(book, progress[book.id]);
      statuses.set(book.id, status);
      counts[status] = (counts[status] || 0) + 1;
    }
    return { counts, statuses };
  }, [shelf, progress]);
  const matchingFilter = filter === 'unresolved' || (filter !== 'all' && needsMatch(filter));
  const visibleBooks = shelf.filter((b) => {
    const status = statuses.get(b.id)!;
    return filter === 'all' || (filter === 'unresolved' ? needsMatch(status) : status === filter);
  });
  const catalogList = tab === 'search' ? results : popular;
  const remoteList = (items: CatalogBook[], select?: (book: CatalogBook) => void) => (
    <ul className='divide-base-200 divide-y'>
      {items.map((book) => (
        <li key={book.url}>
          <button
            type='button'
            disabled={busy || running}
            className='hover:bg-base-200 w-full rounded px-2 py-2 text-start'
            onClick={() => (select ? select(book) : void browse(book.url))}
          >
            <span className='block font-medium'>{book.title}</span>
            <span className='text-base-content/65 text-sm'>
              {[book.author, book.format.toUpperCase()].filter(Boolean).join(' · ')}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <Dialog
      isOpen
      onClose={close}
      title={_('Book discovery')}
      boxClassName='sm:max-w-xl! sm:max-h-[85vh]!'
    >
      <div className='flex flex-col gap-3 pb-5'>
        <div className='tabs tabs-box flex flex-wrap' aria-label={_('Book discovery')}>
          {(['shelf', 'search', 'popular'] as const).map((value) => (
            <button
              type='button'
              key={value}
              className={'tab flex-1 ' + (tab === value ? 'tab-active' : '')}
              aria-pressed={value === tab}
              disabled={running || busy}
              onClick={() => {
                setTab(value);
                setMessage('');
                setFailedPage('');
                if (value === 'popular' && !popular) void lookup('popular');
              }}
            >
              {value === 'shelf'
                ? _('WeRead shelf')
                : value === 'popular'
                  ? _('Recommendations')
                  : _('Search')}
            </button>
          ))}
        </div>
        {tab === 'shelf' && (
          <>
            {loaded && shelf.length === 0 && <p>{_('This build has no preloaded shelf.')}</p>}
            {shelf.length > 0 && (
              <>
                <p className='text-sm'>
                  {_('{{total}} books · {{ready}} ready · {{added}} imported', {
                    total: shelf.length,
                    ready: counts.ready || 0,
                    added: counts.added || 0,
                  })}
                </p>
                <div className='flex flex-wrap items-center gap-2'>
                  <button
                    type='button'
                    className={button + ' btn-primary'}
                    disabled={busy || (!running && visibleBooks.length === 0)}
                    onClick={() => {
                      if (active.current) {
                        stop.current = true;
                        setMessage(_('Finishing the current book…'));
                      } else
                        void start(visibleBooks, {
                          matchOnly: matchingFilter,
                          refresh: filter === 'missing',
                        });
                    }}
                  >
                    {running
                      ? _('Pause sync')
                      : matchingFilter
                        ? _('Match these books')
                        : _('One-tap sync')}
                  </button>
                  <select
                    aria-label={_('Sync status')}
                    className='select select-bordered select-sm min-h-10 w-auto'
                    value={filter}
                    disabled={running}
                    onChange={(e) => setFilter(e.target.value as typeof filter)}
                  >
                    <option value='all'>{_('All books')}</option>
                    <option value='unresolved'>
                      {_('Needs matching')} (
                      {(counts.pending || 0) + (counts.missing || 0) + (counts.choose || 0)})
                    </option>
                    {Object.entries(labels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label} ({counts[key as ShelfStatus] || 0})
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </>
        )}
        {tab === 'search' && (
          <form
            className='flex items-center gap-2'
            onSubmit={(e) => {
              e.preventDefault();
              void lookup('search', query);
            }}
          >
            <input
              type='search'
              aria-label={_('Title, author or ISBN')}
              placeholder={_('Title, author or ISBN')}
              className='input input-bordered min-w-0 flex-1'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type='submit'
              className={button + ' btn-primary'}
              disabled={busy || !query.trim()}
            >
              {_('Search')}
            </button>
          </form>
        )}
        {tab === 'popular' && (
          <div className='flex items-center justify-between'>
            <h3 className='font-medium'>{_('Popular on Z-Library')}</h3>
            <button
              type='button'
              disabled={busy}
              className={linkButton}
              onClick={() => void lookup('popular')}
            >
              {_('Refresh')}
            </button>
          </div>
        )}
        {(message || current || busy) && (
          <p role='status' className='bg-base-200 rounded px-3 py-2 text-sm'>
            {message || current || _('Loading…')}
          </p>
        )}
        <button
          type='button'
          className={linkButton + ' self-start'}
          disabled={busy || running}
          onClick={() =>
            void browse(
              failedPage ||
                (tab === 'search' && query.trim() ? searchUrl(query) : CATALOG_ORIGIN + '/'),
            )
          }
        >
          {failedPage ? _('View on Z-Library') : _('Open Z-Library')}
        </button>
        {tab !== 'shelf' &&
          catalogList &&
          (catalogList.length ? remoteList(catalogList) : <p>{_('No matches')}</p>)}
        {tab === 'shelf' && (
          <ul className='divide-base-200 divide-y'>
            {visibleBooks.map((b) => {
              const row = progress[b.id] || {};
              const status = statuses.get(b.id)!;
              const matches = expanded === b.id ? reviewEditions(b, shelfEditions(b, row)) : [];
              return (
                <li key={b.id} className='py-1'>
                  <button
                    type='button'
                    aria-expanded={expanded === b.id}
                    onClick={() => setExpanded(expanded === b.id ? '' : b.id)}
                    className='flex w-full items-center justify-between gap-3 py-2 text-start'
                  >
                    <span className='min-w-0'>
                      <span className='block font-medium'>{b.title}</span>
                      <span className='text-base-content/65 text-sm'>{b.author}</span>
                    </span>
                    <span className='text-base-content/65 shrink-0 text-xs'>{labels[status]}</span>
                  </button>
                  {expanded === b.id && (
                    <div className='border-base-300 border-s-2 ps-2'>
                      {status === 'added' && row.hash && (
                        <button
                          type='button'
                          className={linkButton}
                          onClick={() => {
                            onClose();
                            navigateToReader(router, [row.hash!]);
                          }}
                        >
                          {_('Read now')}
                        </button>
                      )}
                      {status !== 'added' && (
                        <>
                          {needsMatch(status) && (
                            <button
                              type='button'
                              className={button}
                              disabled={running || busy}
                              onClick={() => void start([b], { refresh: true })}
                            >
                              {_('Find and import this book')}
                            </button>
                          )}
                          <button
                            type='button'
                            className={linkButton}
                            disabled={running || busy}
                            onClick={() =>
                              void browse(
                                row.selected?.url ||
                                  chooseEdition(b, matches)?.url ||
                                  searchUrl(workQueries(b)[0] || b.title),
                              )
                            }
                          >
                            {_('View on Z-Library')}
                          </button>
                          {matches.length > 0 && (
                            <>
                              <p className='text-sm'>{_('Select an edition to import')}</p>
                              {remoteList(matches, (choice) => {
                                if (!editionPreference.includes(choice.format)) {
                                  void browse(choice.url);
                                  return;
                                }
                                save(b.id, { ...row, selected: choice, manual: false });
                                void start([b]);
                              })}
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
