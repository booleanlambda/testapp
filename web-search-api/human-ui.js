export function humanSearchPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <meta name="theme-color" content="#ffffff" />
  <meta name="description" content="Crawler — fast web, image, and video search." />
  <title>Crawler Search</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #fff;
      --surface: #fff;
      --surface-soft: #f7f8fb;
      --text: #17181c;
      --muted: #6f737d;
      --line: #e7e9ef;
      --accent: #375dfb;
      --accent-2: #7b4dff;
      --shadow: 0 10px 36px rgba(22, 30, 53, .09);
      --max: 920px;
    }
    * { box-sizing: border-box; }
    html { min-height: 100%; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    button, input, select { font: inherit; }
    a { color: inherit; }
    .shell { min-height: 100vh; display: flex; flex-direction: column; }
    header {
      position: sticky; top: 0; z-index: 20;
      background: rgba(255,255,255,.92);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid transparent;
      transition: border-color .2s ease;
    }
    header.compact { border-bottom-color: var(--line); }
    .top {
      max-width: 1180px; margin: 0 auto; padding: 18px 24px;
      display: flex; align-items: center; gap: 18px;
    }
    .brand {
      display: inline-flex; align-items: center; gap: 10px;
      text-decoration: none; color: var(--text); flex: 0 0 auto;
      font-weight: 760; letter-spacing: -.03em; font-size: 20px;
    }
    .mark {
      width: 34px; height: 34px; border-radius: 11px;
      display: grid; place-items: center; color: white; font-weight: 800;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 8px 22px rgba(72, 71, 242, .22);
    }
    .search-wrap { flex: 1; max-width: 760px; position: relative; }
    .search-box {
      height: 48px; width: 100%; border: 1px solid var(--line); border-radius: 24px;
      padding: 0 96px 0 46px; background: var(--surface);
      outline: none; color: var(--text); box-shadow: 0 2px 9px rgba(22,30,53,.04);
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    .search-box:focus {
      border-color: #bcc5ff;
      box-shadow: 0 4px 18px rgba(55,93,251,.12);
    }
    .search-icon {
      position: absolute; left: 17px; top: 50%; transform: translateY(-50%);
      width: 18px; height: 18px; opacity: .55; pointer-events: none;
    }
    .search-submit {
      position: absolute; right: 6px; top: 6px; height: 36px;
      border: 0; border-radius: 18px; padding: 0 16px; cursor: pointer;
      background: var(--text); color: white; font-weight: 650;
    }
    .hero {
      flex: 1; display: grid; place-items: center; padding: 48px 22px 96px;
    }
    .hero-inner { width: min(680px, 100%); text-align: center; }
    .hero .brand-large {
      display: inline-flex; align-items: center; gap: 13px; margin-bottom: 28px;
      font-size: clamp(34px, 8vw, 54px); font-weight: 800; letter-spacing: -.055em;
    }
    .hero .brand-large .mark {
      width: 54px; height: 54px; border-radius: 17px; font-size: 27px;
    }
    .hero-search { position: relative; }
    .hero-search .search-box {
      height: 58px; border-radius: 29px; font-size: 17px;
      padding-left: 50px; padding-right: 110px; box-shadow: var(--shadow);
    }
    .hero-search .search-submit { height: 44px; top: 7px; border-radius: 22px; padding: 0 20px; }
    .tagline { color: var(--muted); margin: 18px 0 0; font-size: 14px; }
    .results-page { display: none; }
    body.has-results .hero { display: none; }
    body.has-results .results-page { display: block; }
    body:not(.has-results) header .search-wrap { visibility: hidden; }
    .tabs {
      max-width: 1180px; margin: 0 auto; padding: 0 24px;
      display: flex; gap: 4px; align-items: center;
    }
    .tab {
      appearance: none; border: 0; background: none; padding: 12px 14px 11px;
      color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent;
      font-size: 14px; font-weight: 600;
    }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .filter-wrap { margin-left: auto; display: none; align-items: center; gap: 8px; padding-bottom: 6px; }
    .filter-wrap.visible { display: flex; }
    .filter-label { color: var(--muted); font-size: 12px; }
    .rights-filter {
      border: 1px solid var(--line); background: var(--surface); color: var(--text);
      border-radius: 14px; height: 30px; padding: 0 28px 0 10px; font-size: 12px;
    }
    main.results {
      max-width: var(--max); margin: 0 auto; padding: 24px 24px 80px;
    }
    .meta { color: var(--muted); font-size: 12px; margin: 2px 0 22px; min-height: 18px; }
    .web-list { display: grid; gap: 30px; }
    .web-result { max-width: 760px; }
    .source-line {
      display: flex; align-items: center; gap: 10px; min-width: 0; margin-bottom: 5px;
      font-size: 12px; color: #4d5158;
    }
    .source-dot {
      width: 26px; height: 26px; border-radius: 50%; flex: 0 0 auto;
      background: var(--surface-soft); border: 1px solid var(--line);
      display: grid; place-items: center; font-weight: 750; color: #5c6270;
    }
    .source-copy { min-width: 0; }
    .source-host { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .source-url { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 620px; }
    .result-title {
      color: #2444b8; text-decoration: none; font-size: 20px; line-height: 1.3;
      font-weight: 560; letter-spacing: -.012em;
    }
    .result-title:hover { text-decoration: underline; }
    .snippet { margin: 6px 0 0; color: #454951; line-height: 1.58; font-size: 14px; }
    .provider { display: inline-block; margin-top: 6px; color: #9296a0; font-size: 11px; }
    .image-grid {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 14px;
    }
    .image-card { min-width: 0; }
    .image-link {
      display: block; width: 100%; aspect-ratio: 4 / 3; overflow: hidden;
      background: var(--surface-soft); border-radius: 14px; border: 1px solid var(--line);
    }
    .image-link img {
      width: 100%; height: 100%; object-fit: cover; display: block;
      transition: transform .2s ease;
    }
    .image-link:hover img { transform: scale(1.025); }
    .image-title {
      font-size: 13px; line-height: 1.35; font-weight: 600; margin: 8px 2px 3px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .image-source { font-size: 11px; color: var(--muted); margin: 0 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .badges { display: flex; gap: 5px; flex-wrap: wrap; margin: 6px 2px 0; }
    .badge {
      display: inline-flex; align-items: center; min-height: 21px; border-radius: 11px;
      padding: 2px 8px; background: var(--surface-soft); border: 1px solid var(--line);
      color: #565b66; font-size: 10px; font-weight: 650;
    }
    .video-list { display: grid; gap: 20px; }
    .video-card { display: grid; grid-template-columns: 230px minmax(0,1fr); gap: 16px; text-decoration: none; }
    .video-thumb {
      width: 230px; aspect-ratio: 16/9; object-fit: cover; border-radius: 12px;
      background: var(--surface-soft); border: 1px solid var(--line);
    }
    .video-title { font-size: 17px; line-height: 1.38; font-weight: 650; margin: 2px 0 7px; }
    .video-card:hover .video-title { text-decoration: underline; }
    .video-meta { color: var(--muted); font-size: 12px; line-height: 1.55; }
    .empty, .error {
      border: 1px solid var(--line); border-radius: 16px; background: var(--surface-soft);
      padding: 24px; color: var(--muted); line-height: 1.55;
    }
    .empty-title { color: var(--text); font-weight: 650; margin-bottom: 6px; }
    .suggestions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
    .suggestion-btn {
      appearance: none; border: 1px solid var(--line); background: var(--surface);
      color: #303744; border-radius: 18px; padding: 8px 12px; cursor: pointer;
      font-size: 12px; font-weight: 600;
    }
    .suggestion-btn:hover { border-color: #bcc5ff; color: var(--accent); }
    .error { color: #8c3340; background: #fff8f8; border-color: #f2d4d8; }
    .skeleton { display: grid; gap: 16px; }
    .shimmer {
      border-radius: 9px;
      background: linear-gradient(90deg,#f4f5f8 25%,#eceef3 37%,#f4f5f8 63%);
      background-size: 400% 100%; animation: shimmer 1.4s ease infinite;
    }
    .sk-row { height: 118px; }
    @keyframes shimmer { 0% { background-position: 100% 0 } 100% { background-position: 0 0 } }
    footer {
      margin-top: auto; border-top: 1px solid var(--line); color: var(--muted);
      font-size: 12px; padding: 20px 24px;
    }
    .footer-inner {
      max-width: 1180px; margin: 0 auto; display: flex; justify-content: space-between;
      gap: 18px; flex-wrap: wrap;
    }
    .footer-links { display: flex; gap: 16px; }
    .footer-links a { text-decoration: none; }
    .footer-links a:hover { text-decoration: underline; }
    @media (max-width: 760px) {
      .top { padding: 12px 14px; gap: 10px; }
      .brand span:last-child { display: none; }
      .mark { width: 32px; height: 32px; }
      .search-box { height: 44px; padding-right: 78px; }
      .search-submit { height: 32px; padding: 0 12px; font-size: 12px; }
      .tabs { padding: 0 14px; overflow-x: auto; }
      .tab { padding-left: 11px; padding-right: 11px; }
      .filter-wrap { min-width: max-content; }
      main.results { padding: 18px 16px 60px; }
      .image-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 9px; }
      .video-card { grid-template-columns: 130px minmax(0,1fr); gap: 12px; }
      .video-thumb { width: 130px; }
      .video-title { font-size: 14px; margin-top: 0; }
      .video-meta { font-size: 11px; }
      .hero { padding: 40px 18px 90px; }
      .hero .brand-large { font-size: 42px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header id="header">
      <div class="top">
        <a class="brand" href="/" aria-label="Crawler home">
          <span class="mark">C</span><span>Crawler</span>
        </a>
        <form class="search-wrap" id="topForm" action="/" method="get">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>
          <input class="search-box" id="topInput" name="q" autocomplete="off" spellcheck="false" aria-label="Search the web" />
          <button class="search-submit" type="submit">Search</button>
        </form>
      </div>
      <div class="tabs" id="tabs">
        <button class="tab active" data-tab="web">Web</button>
        <button class="tab" data-tab="images">Images</button>
        <button class="tab" data-tab="videos">Videos</button>
        <div class="filter-wrap" id="filterWrap">
          <span class="filter-label">Usage rights</span>
          <select class="rights-filter" id="rightsFilter">
            <option value="any">Any</option>
            <option value="known">Known license</option>
            <option value="no_attribution">No attribution</option>
            <option value="public_domain">Public domain</option>
          </select>
        </div>
      </div>
    </header>

    <section class="hero">
      <div class="hero-inner">
        <div class="brand-large"><span class="mark">C</span><span>Crawler</span></div>
        <form class="hero-search" id="heroForm" action="/" method="get">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>
          <input class="search-box" id="heroInput" name="q" placeholder="Search the web" autocomplete="off" spellcheck="false" aria-label="Search the web" autofocus />
          <button class="search-submit" type="submit">Search</button>
        </form>
        <p class="tagline">Web, images, and video. Powered by Crawler.</p>
      </div>
    </section>

    <section class="results-page">
      <main class="results">
        <div class="meta" id="meta"></div>
        <div id="results"></div>
      </main>
    </section>

    <footer>
      <div class="footer-inner">
        <span>Crawler · human search</span>
        <span class="footer-links">
          <a href="/api">API</a>
          <a href="/openapi.json">OpenAPI</a>
          <a href="/health">Status</a>
        </span>
      </div>
    </footer>
  </div>

<script src="/human-app.js" defer></script>
</body>
</html>`;
}
