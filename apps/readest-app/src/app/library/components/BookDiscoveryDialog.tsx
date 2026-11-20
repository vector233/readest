import { useCallback, useEffect, useRef, useState } from 'react';
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
  decodeShelf,
  sameBook,
  searchUrl,
  type CatalogBook,
  type ShelfBook,
} from '@/services/zlibrary/catalog';
import { searchCatalog, popularCatalog, downloadEdition } from '@/services/zlibrary/client';
import {
  shelfStatus,
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
  const [expanded, setExpanded] = useState('');
  const [filter, setFilter] = useState<'all' | ShelfStatus>('all');
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
        if (mounted.current) setShelf(decodeShelf(JSON.parse(raw)));
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
    (error: unknown) => {
      if (!mounted.current) return;
      const text = String(error);
      setMessage(
        text.includes('429')
          ? _('The site limit was reached. Resume later.')
          : _(
              'The book site could not complete this request. Open the site to check access, then retry.',
            ),
      );
    },
    [_],
  );

  const browse = async (url: string) => {
    if (busy || active.current) return;
    setBusy(true);
    setMessage('');
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
    if (mode === 'search') setResults(undefined);
    try {
      const books =
        mode === 'search'
          ? await searchCatalog(term, controller.signal)
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

  const start = async (books: ShelfBook[]) => {
    if (!appService || busy || active.current) return;
    active.current = true;
    stop.current = false;
    setRunning(true);
    setMessage('');
    setCurrent('');
    try {
      await syncShelf(books, {
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
        search: (book) => searchCatalog(book.title),
        add: async (edition) => {
          const path = await downloadEdition(edition);
          if (!path) return;
          try {
            const library = useLibraryStore.getState();
            const book = await appService.importBook(path, library.library);
            if (!book) throw new Error('Import failed');
            await library.updateBooks(envConfig, [book]);
            return book.hash;
          } finally {
            await remove(path).catch(() => {});
          }
        },
        stopping: () => stop.current,
        current: (book) => {
          if (mounted.current) setCurrent(book.title);
        },
      });
      if (mounted.current)
        setMessage(
          stop.current
            ? _('Sync paused. Your progress is saved.')
            : _('Finished checking the shelf. Review any books that need an edition.'),
        );
    } catch (err) {
      showError(err);
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
  const counts = shelf.reduce(
    (sum, b) => {
      const status = shelfStatus(b, progress[b.id]);
      sum[status] = (sum[status] || 0) + 1;
      return sum;
    },
    {} as Partial<Record<ShelfStatus, number>>,
  );
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
                    disabled={busy}
                    onClick={() => {
                      if (active.current) {
                        stop.current = true;
                        setMessage(_('Finishing the current book…'));
                      } else void start(shelf);
                    }}
                  >
                    {running ? _('Pause sync') : _('One-tap sync')}
                  </button>
                  <select
                    aria-label={_('Sync status')}
                    className='select select-bordered select-sm min-h-10 w-auto'
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as typeof filter)}
                  >
                    <option value='all'>{_('All books')}</option>
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
            void browse(tab === 'search' && query.trim() ? searchUrl(query) : CATALOG_ORIGIN + '/')
          }
        >
          {_('Open Z-Library')}
        </button>
        {tab !== 'shelf' &&
          catalogList &&
          (catalogList.length ? remoteList(catalogList) : <p>{_('No matches')}</p>)}
        {tab === 'shelf' && (
          <ul className='divide-base-200 divide-y'>
            {shelf
              .filter((b) => filter === 'all' || shelfStatus(b, progress[b.id]) === filter)
              .map((b) => {
                const row = progress[b.id] || {};
                const status = shelfStatus(b, row);
                const matches = row.matches ?? b.matches ?? [];
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
                      <span className='text-base-content/65 shrink-0 text-xs'>
                        {labels[status]}
                      </span>
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
                            <button
                              type='button'
                              className={linkButton}
                              disabled={running || busy}
                              onClick={() => void browse(row.selected?.url || searchUrl(b.title))}
                            >
                              {_('View on Z-Library')}
                            </button>
                            {matches.length > 0 && (
                              <>
                                <p className='text-sm'>{_('Select an edition to import')}</p>
                                {remoteList(matches, (choice) => {
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
