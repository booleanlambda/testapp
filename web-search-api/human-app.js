(() => {
  "use strict";

  const state = {
    q: "",
    tab: "web",
    rights: "any",
    controller: null
  };

  const byId = (id) => document.getElementById(id);
  const els = {
    header: byId("header"),
    topForm: byId("topForm"),
    topInput: byId("topInput"),
    heroForm: byId("heroForm"),
    heroInput: byId("heroInput"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    filterWrap: byId("filterWrap"),
    rightsFilter: byId("rightsFilter"),
    meta: byId("meta"),
    results: byId("results")
  };

  function host(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
      return (u.hostname.replace(/^www\./, "") + path).slice(0, 92);
    } catch {
      return String(url || "");
    }
  }

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function link(url, className) {
    const a = node("a", className);
    a.href = url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function replaceResults(child) {
    while (els.results.firstChild) els.results.removeChild(els.results.firstChild);
    if (child) els.results.appendChild(child);
  }

  function setStateFromUrl() {
    const p = new URLSearchParams(window.location.search);
    state.q = (p.get("q") || "").trim();

    const requestedTab = p.get("tab");
    state.tab = ["web", "images", "videos"].includes(requestedTab)
      ? requestedTab
      : "web";

    const requestedRights = p.get("rights");
    state.rights = ["any", "known", "no_attribution", "public_domain"].includes(requestedRights)
      ? requestedRights
      : "any";
  }

  function writeUrl(replace) {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.tab !== "web") p.set("tab", state.tab);
    if (state.tab === "images" && state.rights !== "any") p.set("rights", state.rights);

    const next = p.toString() ? "?" + p.toString() : "/";
    if (replace) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }

  function syncUi() {
    document.body.classList.toggle("has-results", Boolean(state.q));
    els.header.classList.toggle("compact", Boolean(state.q));
    els.topInput.value = state.q;
    els.heroInput.value = state.q;
    els.rightsFilter.value = state.rights;

    els.tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === state.tab);
    });

    els.filterWrap.classList.toggle(
      "visible",
      state.tab === "images" && Boolean(state.q)
    );

    document.title = state.q
      ? state.q + " — Crawler Search"
      : "Crawler Search";
  }

  function loading() {
    els.meta.textContent = "Searching…";
    const wrap = node("div", "skeleton");
    for (let i = 0; i < 4; i += 1) {
      wrap.appendChild(node("div", "shimmer sk-row"));
    }
    replaceResults(wrap);
  }

  function renderError(message) {
    els.meta.textContent = "";
    replaceResults(
      node("div", "error", message || "Search failed. Please try again.")
    );
  }

  function renderEmpty(data) {
    els.meta.textContent = "No strong match";

    const box = node("div", "empty");
    box.appendChild(node("div", "empty-title", "Crawler could not find a strong match."));
    box.appendChild(
      node(
        "div",
        "",
        "Rather than show weak or off-topic results, try one of these reformulations."
      )
    );

    const suggestions = Array.isArray(data?.suggestions)
      ? data.suggestions.filter(Boolean).slice(0, 3)
      : [];

    if (suggestions.length) {
      const wrap = node("div", "suggestions");
      suggestions.forEach((query) => {
        const button = node("button", "suggestion-btn", query);
        button.type = "button";
        button.addEventListener("click", () => {
          state.q = String(query);
          runSearch();
        });
        wrap.appendChild(button);
      });
      box.appendChild(wrap);
    }

    replaceResults(box);
  }

  function renderWeb(data, elapsed) {
    const rows = Array.isArray(data.results) ? data.results : [];
    if (!rows.length) {
      renderEmpty(data);
      return;
    }

    els.meta.textContent =
      rows.length + " results · " + (elapsed / 1000).toFixed(2) + " s";

    const list = node("div", "web-list");

    rows.forEach((row) => {
      const article = node("article", "web-result");
      const source = node("div", "source-line");
      const h = host(row.url);

      source.appendChild(
        node("div", "source-dot", (h.charAt(0) || "•").toUpperCase())
      );

      const sourceCopy = node("div", "source-copy");
      sourceCopy.appendChild(node("div", "source-host", h || "Source"));
      sourceCopy.appendChild(node("div", "source-url", shortUrl(row.url)));
      source.appendChild(sourceCopy);
      article.appendChild(source);

      const title = link(row.url, "result-title");
      title.textContent = row.title || row.url || "Result";
      article.appendChild(title);

      const snippetText = row.snippet || row.content || "";
      if (snippetText) article.appendChild(node("p", "snippet", snippetText));
      if (row.provider) {
        article.appendChild(node("span", "provider", row.provider));
      }

      list.appendChild(article);
    });

    replaceResults(list);
  }

  function renderImages(data, elapsed) {
    const rows = Array.isArray(data.results) ? data.results : [];
    if (!rows.length) {
      renderEmpty();
      return;
    }

    els.meta.textContent =
      rows.length + " images · " + (elapsed / 1000).toFixed(2) + " s";

    const grid = node("div", "image-grid");

    rows.forEach((row) => {
      const card = node("article", "image-card");
      const a = link(row.source_url, "image-link");
      const img = document.createElement("img");

      img.loading = "lazy";
      img.decoding = "async";
      img.alt = row.title || "";
      img.src = row.thumbnail_url || row.image_url || "";
      a.appendChild(img);
      card.appendChild(a);

      card.appendChild(
        node("div", "image-title", row.title || "Untitled image")
      );
      card.appendChild(
        node("div", "image-source", host(row.source_url))
      );

      const badges = node("div", "badges");
      if (row.license && row.license !== "unknown") {
        badges.appendChild(node("span", "badge", row.license));
      }

      if (row.attribution_required === false) {
        badges.appendChild(node("span", "badge", "No attribution"));
      } else if (row.attribution_required === true) {
        badges.appendChild(node("span", "badge", "Attribution"));
      }

      if (row.rights && row.rights.rights_verified !== true) {
        badges.appendChild(node("span", "badge", "Source claim"));
      }

      if (badges.childNodes.length) card.appendChild(badges);
      grid.appendChild(card);
    });

    replaceResults(grid);
  }

  function renderVideos(data, elapsed) {
    const rows = Array.isArray(data.results) ? data.results : [];
    if (!rows.length) {
      renderEmpty();
      return;
    }

    els.meta.textContent =
      rows.length + " videos · " + (elapsed / 1000).toFixed(2) + " s";

    const list = node("div", "video-list");

    rows.forEach((row) => {
      const a = link(row.video_url || row.source_url, "video-card");
      const img = document.createElement("img");

      img.className = "video-thumb";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      if (row.thumbnail_url) img.src = row.thumbnail_url;
      a.appendChild(img);

      const copy = node("div");
      copy.appendChild(
        node("div", "video-title", row.title || "Untitled video")
      );

      const bits = [row.creator, row.published_text, row.views_text].filter(Boolean);
      copy.appendChild(
        node("div", "video-meta", bits.join(" · ") || host(row.source_url))
      );

      a.appendChild(copy);
      list.appendChild(a);
    });

    replaceResults(list);
  }

  async function runSearch(options) {
    const updateHistory =
      !options || options.updateHistory === undefined
        ? true
        : Boolean(options.updateHistory);

    const q = state.q.trim();

    if (!q) {
      state.q = "";
      if (updateHistory) history.pushState(null, "", "/");
      syncUi();
      replaceResults(null);
      els.meta.textContent = "";
      return;
    }

    if (updateHistory) writeUrl(false);
    syncUi();
    loading();

    if (state.controller) state.controller.abort();
    state.controller = new AbortController();

    const p = new URLSearchParams();
    p.set("q", q);

    let endpoint = "/human/search";

    if (state.tab === "images") {
      endpoint = "/human/images";
      p.set("rights", state.rights);
    } else if (state.tab === "videos") {
      endpoint = "/human/videos";
    }

    const started = performance.now();

    try {
      const response = await fetch(endpoint + "?" + p.toString(), {
        signal: state.controller.signal,
        headers: { accept: "application/json" }
      });

      const responseText = await response.text();
      let data = {};

      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("Too many searches. Try again in a moment.");
        }
        throw new Error(data.error || "Search failed.");
      }

      const elapsed = performance.now() - started;

      if (state.tab === "images") renderImages(data, elapsed);
      else if (state.tab === "videos") renderVideos(data, elapsed);
      else renderWeb(data, elapsed);
    } catch (error) {
      if (error && error.name === "AbortError") return;
      renderError(error && error.message ? error.message : "Search failed.");
    }
  }

  function submitFrom(input) {
    const q = input.value.trim();
    if (!q) return;
    state.q = q;
    runSearch();
  }

  els.topForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitFrom(els.topInput);
  });

  els.heroForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitFrom(els.heroInput);
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const next = tab.dataset.tab;
      if (!next || next === state.tab) return;

      state.tab = next;

      if (state.q) runSearch();
      else {
        writeUrl(false);
        syncUi();
      }
    });
  });

  els.rightsFilter.addEventListener("change", () => {
    state.rights = els.rightsFilter.value;
    if (state.q && state.tab === "images") runSearch();
  });

  window.addEventListener("popstate", () => {
    setStateFromUrl();
    syncUi();
    if (state.q) runSearch({ updateHistory: false });
  });

  window.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      document.activeElement &&
      document.activeElement.tagName !== "INPUT"
    ) {
      event.preventDefault();
      (state.q ? els.topInput : els.heroInput).focus();
    }
  });

  setStateFromUrl();
  syncUi();

  if (state.q) {
    runSearch({ updateHistory: false });
  }

  window.__crawlerHumanUiReady = true;
})();
