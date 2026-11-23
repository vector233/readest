/** Bibliographic fields used for retrieving and comparing works in the Chinese catalog. */
export interface BookCredit {
  title: string;
  author: string;
}

export function normalizeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

const originLabel =
  /[(【\[〔]\s*(?:[中美英法德日俄加澳奥瑞西意荷波哥巴韩]|中国|美国|英国|法国|德国|日本|瑞典|古希腊|古罗马|(?:先|后)?秦|汉|唐|宋|元|明|清)\s*[)】\]〕]/gu;

function authorName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(originLabel, '')
    .split(
      /\s*[;；&、／/]|\s+和\s+|\s+[(\[]|[(\[][A-Za-z]|\s+[^\s]+(?:译|绘|笺注|整理)(?:\s|$)/u,
      1,
    )[0]!
    .replace(/(?:编著|主编|著|编撰|撰)\s*$/u, '')
    .trim();
}

const series = /(?:丛书|书系|文库|名著|国民阅读经典|作家榜经典|之[一二三四五六七八九十])$/u;
const annotation =
  /^(?:(?:18|19|20)\d{2}(?:年)?(?:版)?|第[\d一二三四五六七八九十]+版)$|修订|增[订补]|精装|平装|精排|典藏|珍藏|纪念版|精校|排版|新版|重印|重版|无删减|插图版|图文版|经典|丛书|书系|文库|作品系列|同名|原著|力作|代表作|获奖|推荐|人生之书|出品|畅销|授权|出版社|巨献|^备注/u;
const forms = [
  ['comic', /漫画/u],
  ['picture', /绘本/u],
  ['abridged', /缩写|缩编|节选|青少版|青少年版|少儿版|儿童版|改写版/u],
  ['guide', /(?:导读|解读|读后感|读书笔记|习题|教学)(?:本|版|手册)?$/u],
  ['bilingual', /双语|英汉对照|中英对照/u],
  ['english', /英文(?:版|原版|经典)|英语版/u],
] as const;

function numberKey(value: string): string {
  if (/^\d+$/u.test(value)) return String(Number(value));
  const digits = '零一二三四五六七八九';
  const num = value.replace(/两/gu, '二');
  const tens = num.split('十');
  if (tens.length === 2)
    return String(
      (tens[0] ? digits.indexOf(tens[0]) : 1) * 10 + (tens[1] ? digits.indexOf(tens[1]) : 0),
    );
  return String(digits.indexOf(num));
}

interface Work {
  name: string;
  key: string;
  aliases: string[];
  aliasKeys: string[];
  subtitle: string;
  scope: string;
  form: string;
  author: string;
  authorKey: string;
  coauthors: string[];
  fullTitle: string;
  edition: string;
}

const parsed = new WeakMap<BookCredit, { title: string; author: string; work: Work }>();

export function identifyWork(book: BookCredit): Work {
  const previous = parsed.get(book);
  if (previous?.title === book.title && previous.author === book.author) return previous.work;
  const author = authorName(book.author);
  const authorKey = normalizeName(author);
  const coauthors = book.author
    .split(/\s*(?:&|、|\s和\s)\s*/u)
    .slice(1)
    .filter((name) => !/(?:译|绘|注|整理)$/u.test(name.trim()))
    .map((name) => normalizeName(authorName(name)))
    .filter(Boolean);
  const notes: string[] = [];
  const aliases: string[] = [];
  const form = new Set<string>();
  let scope = '';
  let edition = '';
  // Scope is content. Removing a collection count or a volume from the search term
  // must never turn one volume into a match for its neighbour or a complete set.
  function takeScope(text: string): string {
    return text
      .replace(
        /(?:全|共)\s*([\d零一二两三四五六七八九十]+)\s*[部卷册集]|上[、和与中\s]*下[册卷部]|^上[、和与中\s]*下$|(?:大?全集|套装|合集)(?=$|[\s，,·:：(]|[全共]\d)|第\s*([\d一二两三四五六七八九十]+)\s*([卷册部集])|([上中下])[册卷部](?=$|[\s，,·:：(])/gu,
        (_label: string, count?: string, part?: string, unit?: string, position?: string) => {
          if (count) scope = 'set:' + numberKey(count);
          else if (part) scope = 'part:' + numberKey(part) + (unit === '部' ? ':部' : '');
          else if (position) scope = 'part:' + position;
          else if (!scope) scope = 'set';
          return ' ';
        },
      )
      .trim();
  }
  function takeNote(raw: string) {
    let note = raw.trim();
    const alias =
      /^(?:又名|亦名|又译(?:作|为)?|原名|原书名)\s*[:：]?\s*《?([^》|，,；;]+)》?$/u.exec(note);
    if (alias) {
      aliases.push(alias[1]!.trim());
      return;
    }
    if (annotation.test(note)) {
      const hint = note.match(/(?:18|19|20)\d{2}|第[\d一二三四五六七八九十]+版/u)?.[0];
      if (hint) edition = hint;
    }
    if (/^(?:[上中下]|\d{1,2})$/u.test(note)) {
      scope = 'part:' + note;
      return;
    }
    const adaptations = forms.filter(([, pattern]) => pattern.test(note));
    for (const [key] of adaptations) form.add(key);
    // A blurb can mention the name or size of another work. Only the leading
    // catalog qualifier describes this item.
    const [leading = '', ...extra] = note.split(/[|｜，,；;]/u);
    const unscoped = takeScope(leading);
    for (const item of extra) {
      if (/^\s*(?:全|共)[\d一二两三四五六七八九十]+[部卷册集]\s*$/u.test(item)) takeScope(item);
    }
    if (!unscoped || adaptations.length) return;
    note = unscoped === leading.trim() ? note : unscoped;
    if (!annotation.test(note)) notes.push(note);
  }
  let title = book.title.normalize('NFKC').trim();
  // Keep round-bracket names that are the entire title, e.g. "(Un)masked".
  // Work from the outside of the title and leave internal punctuation intact.
  title = title.replace(/^【(?:精排|精校|文字版|电子版)】\s*/u, '');
  let noteMatch: RegExpExecArray | null;
  while (
    (noteMatch = /(?:\(([^()]*)\)|【([^【】]*)】|\[([^\[\]]*)\])\s*$/u.exec(title)) &&
    noteMatch.index > 0
  ) {
    takeNote(noteMatch[1] ?? noteMatch[2] ?? noteMatch[3] ?? '');
    title = title.slice(0, noteMatch.index).trimEnd();
  }
  title = title.replace(/\(([上中下]|\d{1,2})\)(?=\s*[:：])/gu, (_, n: string) => {
    scope = 'part:' + n;
    return '';
  });
  title = title.replace(/^(.+?)(?<!-)-(?!-)([^-]+)$/u, (original, main: string, tail: string) =>
    !/\d$/u.test(main) && annotation.test(tail) ? main + ':' + tail : original,
  );
  const parallelTitle = /^(.+?)\s+=\s+([^=]+)$/u.exec(title);
  if (parallelTitle) {
    title = parallelTitle[1]!;
    aliases.push(parallelTitle[2]!.trim());
  }
  const split = title.split(/\s*(?:[:：]|—+|(?<!\d)–|–(?!\d)|--+|\s-\s)\s*/u);
  let main = split.shift()!.trim();
  if (split.length && (series.test(main) || (authorKey && normalizeName(main) === authorKey)))
    main = split.shift()!.trim();
  for (const part of split) takeNote(part);
  main = takeScope(main.replace(/^《(.+)》$/u, '$1')).replace(/[·•\s]+$/u, '') || main;
  const work = {
    name: main.trim(),
    key: normalizeName(main),
    aliases,
    aliasKeys: aliases.map(normalizeName),
    subtitle: normalizeName(notes.reverse().join(' ')),
    scope,
    form: [...form].sort().join(' '),
    author,
    authorKey,
    coauthors,
    fullTitle: normalizeName(book.title),
    edition,
  };
  parsed.set(book, { title: book.title, author: book.author, work });
  return work;
}

export function workQueries(book: BookCredit): string[] {
  const { name, author, scope, aliases } = identifyWork(book);
  const [kind, number, unit] = scope.split(':');
  let volume = '';
  if (kind === 'part' && number)
    volume = /^[上中下]$/u.test(number) ? number + '册' : '第' + number + (unit || '卷');
  if (kind === 'set' && number) volume = '全' + number + '册';
  const scoped = volume ? [name, volume, author].filter(Boolean).join(' ') : '';
  return Array.from(
    new Set(
      [
        scoped,
        author && name ? name + ' ' + author : '',
        name,
        ...aliases,
        book.title.trim(),
      ].filter(Boolean),
    ),
  );
}

export function compatibleScope(left: string, right: string): boolean {
  return left === right || (left === 'set' && right.startsWith('set:'));
}

/** A shorter query retrieves candidates. Author, scope and subtitles establish identity. */
export function workStrength(left: Work, right: Work): number {
  if (!left.authorKey || left.authorKey !== right.authorKey) return 0;
  if (left.coauthors.some((name) => !right.coauthors.includes(name))) return 0;
  if (left.fullTitle === right.fullTitle) return 5;
  if (
    !left.key ||
    (left.key !== right.key &&
      !left.aliasKeys.includes(right.key) &&
      !right.aliasKeys.includes(left.key)) ||
    !compatibleScope(left.scope, right.scope) ||
    left.form !== right.form
  )
    return 0;
  if (left.subtitle && right.subtitle && left.subtitle !== right.subtitle) return 0;
  if (left.edition && left.edition === right.edition && left.subtitle === right.subtitle) return 4;
  return left.subtitle === right.subtitle ? 3 : 2;
}
