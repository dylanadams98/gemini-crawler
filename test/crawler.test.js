import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'gc-')), 'test.db');
process.env.SERPAPI_KEY = 'test-key';
const { db } = await import('../src/db.js');
const { normaliseDomain, parseOverview, flattenBlocks, crawlTerms } = await import('../src/crawler.js');

const site = { id: 1, name: 'Acme Bags', domain: 'acmebags.co.uk' };

const overview = {
  text_blocks: [
    { type: 'paragraph', snippet: 'Acme Bags sells durable luggage.', reference_indexes: [1] },
    { type: 'heading', snippet: 'Key options:' },
    { type: 'list', list: [
      { title: 'Cabin bags:', snippet: 'Fit most airlines.', list: [{ snippet: 'Nested point' }] },
    ] },
    { type: 'expandable', title: 'More', text_blocks: [{ type: 'paragraph', snippet: 'Inside expandable' }] },
  ],
  references: [
    { title: 'Other', link: 'https://www.example.com/a', source: 'Example', index: 0 },
    { title: 'Acme', link: 'https://shop.acmebags.co.uk/cabin', source: 'Acme', index: 1 },
  ],
};

test('normaliseDomain strips protocol, www and path', () => {
  assert.equal(normaliseDomain('https://www.AcmeBags.co.uk/path?x=1'), 'acmebags.co.uk');
});

test('flattenBlocks includes nested list and expandable text', () => {
  const text = flattenBlocks(overview.text_blocks);
  assert.match(text, /## Key options:/);
  assert.match(text, /- Cabin bags: Fit most airlines\./);
  assert.match(text, /  - Nested point/);
  assert.match(text, /Inside expandable/);
});

test('parseOverview detects citation (subdomain) and brand mention', () => {
  const r = parseOverview(overview, site);
  assert.equal(r.has_overview, 1);
  assert.equal(r.cited, 1);
  assert.equal(r.cited_position, 2);
  assert.equal(r.mentioned, 1);
  assert.equal(r.references.filter(x => x.ours).length, 1);
});

test('parseOverview does not match lookalike domains', () => {
  const r = parseOverview({ ...overview, references: [{ link: 'https://notacmebags.co.uk/' }] }, site);
  assert.equal(r.cited, 0);
});

test('parseOverview handles no overview', () => {
  assert.equal(parseOverview(null, site).has_overview, 0);
});

test('crawlTerms follows page_token and stores results', async () => {
  db.prepare("INSERT INTO sites (id, name, domain) VALUES (1, 'Acme Bags', 'acmebags.co.uk')").run();
  db.prepare("INSERT INTO terms (id, site_id, term) VALUES (1, 1, 'best cabin bag'), (2, 1, 'no overview term'), (3, 1, 'broken')").run();

  const calls = [];
  globalThis.fetch = async url => {
    const p = new URL(url).searchParams;
    calls.push(Object.fromEntries(p));
    let body;
    if (p.get('engine') === 'google_ai_overview') body = { ai_overview: overview };
    else if (p.get('q') === 'best cabin bag') body = { ai_overview: { page_token: 'tok' } };
    else if (p.get('q') === 'broken') body = { error: 'Invalid API key.' };
    else body = { organic_results: [] };
    return { json: async () => body };
  };

  await crawlTerms(db.prepare('SELECT * FROM terms ORDER BY id').all());

  assert.deepEqual(calls.map(c => c.engine), ['google', 'google_ai_overview', 'google', 'google']);
  assert.equal(calls[1].page_token, 'tok');
  assert.equal(calls[0].api_key, 'test-key');

  const rows = db.prepare('SELECT * FROM results ORDER BY term_id').all();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cited, 1);
  assert.equal(rows[0].cited_position, 2);
  assert.equal(rows[1].has_overview, 0);
  assert.equal(rows[1].error, null);
  assert.equal(rows[2].error, 'Invalid API key.');
});
