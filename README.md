# Gemini AI Overview Crawler

Tracks Google's AI Overview (Gemini) summaries for client search terms, once a day.

- One tab per client site, each with its own list of search terms
- For every term it records: whether an AI Overview appeared, the full summary text, its sources, whether the client's domain is cited (and at which position), and whether the brand name is mentioned
- Each term keeps a history (coloured dots), and clicking a dot shows that day's overview
- The daily crawl runs at `CRAWL_HOUR` (local `TZ`). Use the "Crawl now" buttons to run all terms, one site or one term on demand

Data is fetched through [SerpApi](https://serpapi.com) (`engine=google`, plus `engine=google_ai_overview` when Google loads the overview separately).

## Quota

The free SerpApi plan gives **250 searches/month**, about 8 per day. A term costs 1 search, or 2 when the overview loads separately. So a daily crawl on the free plan covers roughly **4–8 terms in total across all sites**. The header shows how many searches you have left.

## Run with Docker

```sh
cp .env.example .env   # add SERPAPI_KEY
docker compose up -d --build
```

Open `http://<server>:3000`. The SQLite database lives in `./data/crawler.db`; back up that folder.

## Run locally

```sh
npm install
SERPAPI_KEY=... npm start
npm test
```
