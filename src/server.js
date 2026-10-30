import express from 'express';
import { db, getMeta, setMeta } from './db.js';
import { crawlTerms, isRunning, normaliseDomain } from './crawler.js';

const PORT = Number(process.env.PORT || 3000);
const CRAWL_HOUR = Number(process.env.CRAWL_HOUR ?? 6); // local hour (set TZ), daily crawl runs at/after this

if (!process.env.SERPAPI_KEY) console.warn('SERPAPI_KEY is not set - crawls will fail.');

const app = express();
app.use(express.json());

// Optional basic auth: BASIC_AUTH=user:password
if (process.env.BASIC_AUTH) {
  const expected = 'Basic ' + Buffer.from(process.env.BASIC_AUTH).toString('base64');
  app.use((req, res, next) => {
    if (req.headers.authorization === expected) return next();
    res.set('WWW-Authenticate', 'Basic realm="gemini-crawler"').status(401).send('Authentication required');
  });
}

app.use(express.static(new URL('../public', import.meta.url).pathname));

// --- Sites ---
app.get('/api/sites', (req, res) => {
  res.json(db.prepare('SELECT * FROM sites ORDER BY name').all());
});

app.post('/api/sites', (req, res) => {
  const name = req.body.name?.trim();
  const domain = req.body.domain && normaliseDomain(req.body.domain);
  if (!name || !domain) return res.status(400).json({ error: 'name and domain are required' });
  const { lastInsertRowid } = db.prepare('INSERT INTO sites (name, domain) VALUES (?, ?)').run(name, domain);
  res.status(201).json(db.prepare('SELECT * FROM sites WHERE id = ?').get(lastInsertRowid));
});

app.delete('/api/sites/:id', (req, res) => {
  db.prepare('DELETE FROM sites WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// --- Terms (with latest result + recent history for the site tab) ---
app.get('/api/sites/:id/terms', (req, res) => {
  const terms = db.prepare('SELECT * FROM terms WHERE site_id = ? ORDER BY term').all(req.params.id);
  const history = db.prepare(`
    SELECT id, crawled_at, has_overview, cited, cited_position, mentioned, error
    FROM results WHERE term_id = ? ORDER BY crawled_at DESC, id DESC LIMIT 30
  `);
  const latest = db.prepare(`
    SELECT id, crawled_at, has_overview, cited, cited_position, mentioned, overview_text, references_json, error
    FROM results WHERE term_id = ? ORDER BY crawled_at DESC, id DESC LIMIT 1
  `);
  res.json(terms.map(t => ({ ...t, latest: latest.get(t.id) ?? null, history: history.all(t.id) })));
});

// Accepts { term } or { terms: "one per line" }
app.post('/api/sites/:id/terms', (req, res) => {
  const list = (req.body.terms ?? req.body.term ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!list.length) return res.status(400).json({ error: 'term is required' });
  const insert = db.prepare('INSERT OR IGNORE INTO terms (site_id, term) VALUES (?, ?)');
  const added = list.reduce((n, term) => n + insert.run(req.params.id, term).changes, 0);
  res.status(201).json({ added });
});

app.delete('/api/terms/:id', (req, res) => {
  db.prepare('DELETE FROM terms WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

app.get('/api/results/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM results WHERE id = ?').get(req.params.id);
  r ? res.json(r) : res.status(404).end();
});

// --- Crawling ---
// Body: {} = all terms, { site_id } = one site, { term_id } = one term. Runs in the background.
app.post('/api/crawl', (req, res) => {
  if (isRunning()) return res.status(409).json({ error: 'A crawl is already running' });
  const { site_id, term_id } = req.body;
  const terms = term_id ? db.prepare('SELECT * FROM terms WHERE id = ?').all(term_id)
    : site_id ? db.prepare('SELECT * FROM terms WHERE site_id = ?').all(site_id)
    : db.prepare('SELECT * FROM terms').all();
  crawlTerms(terms);
  res.status(202).json({ queued: terms.length });
});

app.get('/api/status', async (req, res) => {
  let account = null;
  if (process.env.SERPAPI_KEY) {
    try {
      // account.json does not count against the search quota
      const a = await (await fetch(`https://serpapi.com/account.json?api_key=${process.env.SERPAPI_KEY}`)).json();
      if (!a.error) account = { plan: a.plan_name, searches_left: a.total_searches_left, this_month: a.this_month_usage };
    } catch { /* quota display is best-effort */ }
  }
  res.json({
    running: isRunning(),
    last_daily_crawl: getMeta('last_daily_crawl'),
    crawl_hour: CRAWL_HOUR,
    term_count: db.prepare('SELECT COUNT(*) AS n FROM terms').get().n,
    account,
  });
});

// --- Daily scheduler: checks every minute so a restart after CRAWL_HOUR still runs today's crawl ---
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in TZ

async function dailyTick() {
  if (new Date().getHours() < CRAWL_HOUR || getMeta('last_daily_crawl') === today() || isRunning()) return;
  setMeta('last_daily_crawl', today());
  console.log(`[${new Date().toISOString()}] Daily crawl starting`);
  await crawlTerms(db.prepare('SELECT * FROM terms').all());
  console.log(`[${new Date().toISOString()}] Daily crawl finished`);
}
setInterval(dailyTick, 60_000);
dailyTick();

app.listen(PORT, () => console.log(`gemini-crawler listening on :${PORT} (daily crawl at ${CRAWL_HOUR}:00 ${Intl.DateTimeFormat().resolvedOptions().timeZone})`));
