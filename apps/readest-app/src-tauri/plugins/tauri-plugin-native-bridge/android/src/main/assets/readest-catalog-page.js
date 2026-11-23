(function (requested) {
  const start = new URL(requested);
  const here = new URL(location.href);
  const access = { error: 'Catalog access required' };
  if (here.origin !== 'https://zh.z-library.sk' || here.origin !== start.origin) return access;
  const bookId = (url) => /^\/book\/([^/]+)/.exec(url.pathname)?.[1];
  const book = bookId(start);
  if (
    book
      ? bookId(here) !== book
      : here.pathname.replace(/\/$/, '') !== start.pathname.replace(/\/$/, '')
  ) {
    return access;
  }
  if (/\bDiamWall\b|^Just a moment\b/i.test(document.title)) return access;

  // Return only book metadata. Forms, scripts, session storage and the rest of the page stay here.
  let nodes;
  if (book) {
    const candidates = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
      try {
        const u = new URL(a.href);
        return (
          u.origin === here.origin && !u.username && !u.password && /^\/dl\/.+/.test(u.pathname)
        );
      } catch {
        return false;
      }
    });
    const primary = candidates.filter((a) => a.matches('.addDownloadedBook, .dlButton'));
    const urls = new Set((primary.length ? primary : candidates).map((a) => a.href));
    nodes = [];
    if (urls.size === 1) {
      const url = new URL([...urls][0]);
      const link = document.createElement('a');
      link.setAttribute('href', url.pathname + url.search);
      nodes.push(link);
    }
    if (
      !candidates.length &&
      !document.querySelector('z-cover, [itemprop="bookFormat"], .book-details, .book-cover')
    ) {
      return document.querySelector('input[type="password"]')
        ? access
        : { error: 'Catalog page not recognized' };
    }
  } else if (start.pathname === '/') {
    const shelf = document.querySelector('z-masonry[source="mostpopular"]');
    nodes = shelf ? [shelf] : [];
  } else {
    nodes = Array.from(document.querySelectorAll('z-bookcard, .notFound, .not-found'));
  }
  if (!book && !nodes.length) {
    return document.querySelector('input[type="password"]')
      ? access
      : { error: 'Catalog page not recognized' };
  }
  const html = nodes.map((node) => node.outerHTML).join('');
  if (html.length > 2_000_000) return { error: 'Catalog page too large' };
  here.hash = '';
  return { url: here.href, html };
})(__READEST_CATALOG_URL__);
