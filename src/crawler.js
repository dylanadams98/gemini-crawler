import { db } from './db.js';

const SERPAPI = 'https://serpapi.com';

// Normalise "https://www.Example.com/path" -> "example.com"
export function normaliseDomain(input) {
  return String(input).trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
}

function hostMatches(link, domain) {
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/^www\./, '');
    return host === domain || host.endsWith('.' + domain);
  } catch {
    return false;
  }
}

// Turn SerpApi's nested text_blocks into readable plain text.
export function flattenBlocks(blocks = [], indent = '') {
  const lines = [];
  for (const b of blocks) {
    const text = [b.title, b.snippet].filter(Boolean).join(' ');
    if (text) lines.push(indent + (b.type === 'heading' ? `## ${text}` : text));
    if (Array.isArray(b.list)) {
      for (const item of b.list) {
        const itemText = [item.title, item.snippet].filter(Boolean).join(' ');
        if (itemText) lines.push(`${indent}- ${itemText}`);
        if (item.list) lines.push(flattenBlocks([{ list: item.list }], indent + '  '));
        if (item.text_blocks) lines.push(flattenBlocks(item.text_blocks, indent + '  '));
      }
    }
    if (Array.isArray(b.table)) {
      for (const row of b.table) lines.push(indent + (Array.isArray(row) ? row.join(' | ') : JSON.stringify(row)));
    }
    if (Array.isArray(b.text_blocks)) lines.push(flattenBlocks(b.text_blocks, indent + '  '));
  }
  return lines.filter(Boolean).join('\n');
}

// Extract what we store from an ai_overview object.
export function parseOverview(overview, site) {
  if (!overview?.text_blocks?.length) {
    return { has_overview: 0, cited: 0, cited_position: null, mentioned: 0, overview_text: null, references: [] };
  }
  const domain = normaliseDomain(site.domain);
  const references = (overview.references || []).map((r, i) => ({
    position: i + 1,
    title: r.title,
    link: r.link,
    source: r.source,
    ours: hostMatches(r.link, domain),
  }));
  const ourRef = references.find(r => r.ours);
  const text = flattenBlocks(overview.text_blocks);
  const lower = text.toLowerCase();
  return {
    has_overview: 1,
    cited: ourRef ? 1 : 0,
    cited_position: ourRef?.position ?? null,
    mentioned: lower.includes(site.name.toLowerCase()) || lower.includes(domain) ? 1 : 0,
    overview_text: text,
    references,
  };
}

async function serpapi(params) {
  const url = `${SERPAPI}/search.json?${new URLSearchParams({ ...params, api_key: process.env.SERPAPI_KEY })}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json;
}

export async function fetchOverview(term) {
  const params = {
    engine: 'google',
    q: term,
    gl: process.env.SERPAPI_GL || 'uk',
    hl: process.env.SERPAPI_HL || 'en',
  };
  if (process.env.SERPAPI_GOOGLE_DOMAIN) params.google_domain = process.env.SERPAPI_GOOGLE_DOMAIN;
  if (process.env.SERPAPI_LOCATION) params.location = process.env.SERPAPI_LOCATION;

  let json;
  try {
    json = await serpapi(params);
  } catch (err) {
    // SerpApi reports an empty results page as an error; that's just "no overview".
    if (/hasn't returned any results/i.test(err.message)) return null;
    throw err;
  }
  let overview = json.ai_overview;
  // Google sometimes loads the overview separately; the token expires within a minute.
  if (overview?.page_token) {
    overview = (await serpapi({ engine: 'google_ai_overview', page_token: overview.page_token })).ai_overview;
  }
  return overview ?? null;
}

const insertResult = db.prepare(`
  INSERT INTO results (term_id, has_overview, cited, cited_position, mentioned, overview_text, references_json, raw_json, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export async function crawlTerm(termRow, site) {
  try {
    const overview = await fetchOverview(termRow.term);
    const r = parseOverview(overview, site);
    insertResult.run(termRow.id, r.has_overview, r.cited, r.cited_position, r.mentioned,
      r.overview_text, JSON.stringify(r.references), overview ? JSON.stringify(overview) : null, null);
  } catch (err) {
    insertResult.run(termRow.id, 0, 0, null, 0, null, null, null, err.message);
  }
}

let running = false;
export const isRunning = () => running;

// Crawl the given terms one at a time. Returns false if a crawl is already in progress.
export async function crawlTerms(termRows) {
  if (running) return false;
  running = true;
  try {
    const sites = new Map(db.prepare('SELECT * FROM sites').all().map(s => [s.id, s]));
    for (const t of termRows) {
      await crawlTerm(t, sites.get(t.site_id));
    }
  } finally {
    running = false;
  }
  return true;
}
