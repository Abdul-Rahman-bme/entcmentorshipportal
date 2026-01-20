/**
 * ENTC Mentorship Portal Enhancements (drop-in)
 * Adds:
 * - URL state (?q=&chips=&sort=&avail=&fav=1)
 * - localStorage persistence
 * - Favorites + Favorites-only toggle
 * - Availability quick filters with counts
 * - Multi-keyword search + highlighting
 * - Pagination ("Load more")
 * - Modal focus trap + return focus
 * - Lightweight local analytics (views, chip clicks)
 *
 * Works with existing IDs from your page:
 * q, chips, sort, clear, count, cards, modal + modal fields, print, openForm, yearNow, statMentors, statDomains
 */

(() => {
  // -----------------------------
  // 0) Helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  const STORAGE_KEY = "entc_mentorship_portal_state_v2";
  const FAV_KEY = "entc_mentorship_favorites_v1";
  const ANALYTICS_KEY = "entc_mentorship_analytics_v1";

  const PAGE_SIZE = 12;

  const escapeHTML = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const normalize = (x) => String(x || "").toLowerCase();

  const uniq = (arr) => Array.from(new Set(arr));

  const initials = (name) => {
    const parts = String(name || "").trim().split(/\s+/);
    const a = parts[0]?.[0] || "M";
    const b = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] || "");
    return (a + b).toUpperCase();
  };

  const parseCSV = (s) =>
    String(s || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const toCSV = (arr) => (arr || []).join(",");

  function getFavorites() {
    try {
      return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }

  function setFavorites(favs) {
    localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(favs)));
  }

  function getAnalytics() {
    try {
      return JSON.parse(localStorage.getItem(ANALYTICS_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function bumpAnalytics(path, key) {
    const a = getAnalytics();
    a[path] = a[path] || {};
    a[path][key] = (a[path][key] || 0) + 1;
    localStorage.setItem(ANALYTICS_KEY, JSON.stringify(a));
  }

  function readURLState() {
    const p = new URLSearchParams(location.search);
    return {
      q: p.get("q") || "",
      chips: new Set(parseCSV(p.get("chips"))),
      sort: p.get("sort") || "name",
      avail: p.get("avail") || "all", // all|available|limited|unavailable
      favOnly: p.get("fav") === "1",
      page: Math.max(1, parseInt(p.get("page") || "1", 10) || 1),
    };
  }

  function writeURLState(state) {
    const p = new URLSearchParams(location.search);

    const q = (state.q || "").trim();
    const chips = Array.from(state.chips || []);
    const sort = state.sort || "name";
    const avail = state.avail || "all";
    const fav = state.favOnly ? "1" : "";
    const page = String(state.page || 1);

    // Only keep non-defaults (keeps URL clean)
    q ? p.set("q", q) : p.delete("q");
    chips.length ? p.set("chips", toCSV(chips)) : p.delete("chips");
    sort !== "name" ? p.set("sort", sort) : p.delete("sort");
    avail !== "all" ? p.set("avail", avail) : p.delete("avail");
    state.favOnly ? p.set("fav", "1") : p.delete("fav");
    (state.page && state.page !== 1) ? p.set("page", page) : p.delete("page");

    const next = `${location.pathname}${p.toString() ? "?" + p.toString() : ""}${location.hash || ""}`;
    history.replaceState(null, "", next);
  }

  function saveLocalState(state) {
    const payload = {
      q: state.q || "",
      chips: Array.from(state.chips || []),
      sort: state.sort || "name",
      avail: state.avail || "all",
      favOnly: !!state.favOnly,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function loadLocalState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!raw) return null;
      return {
        q: raw.q || "",
        chips: new Set(raw.chips || []),
        sort: raw.sort || "name",
        avail: raw.avail || "all",
        favOnly: !!raw.favOnly,
        page: 1,
      };
    } catch {
      return null;
    }
  }

  // -----------------------------
  // 1) Data source (mentors[])
  // -----------------------------
  // Your existing mentors/globalRequestForm are defined in the HTML.
  // Optionally load mentors from JSON if window.MENTORS_JSON_URL is set.
  async function getMentors() {
    if (window.MENTORS_JSON_URL) {
      try {
        const res = await fetch(window.MENTORS_JSON_URL, { cache: "no-store" });
        if (!res.ok) throw new Error("Fetch failed");
        const json = await res.json();
        if (Array.isArray(json)) return json;
        if (Array.isArray(json.mentors)) return json.mentors;
      } catch (e) {
        console.warn("Could not load mentors JSON, falling back to embedded mentors[]", e);
      }
    }
    return (typeof mentors !== "undefined" && Array.isArray(mentors)) ? mentors : [];
  }

  // -----------------------------
  // 2) UI state + injected controls
  // -----------------------------
  const state = {
    q: "",
    chips: new Set(),
    sort: "name",
    avail: "all",
    favOnly: false,
    page: 1,
  };

  let MENTORS = [];
  let lastOpenerEl = null;
  let loadMoreBtn = null;

  // Inject small style for highlight and favorite button states
  function injectEnhancementStyles() {
    const css = `
      body::before{
        content: "";
        position: fixed;
        inset: 0;
        background: url("assets/college/ENTC_logo_blue.png") center center no-repeat;
        background-size: 420px;
        opacity: 0.08;
        filter: blur(6px);
        z-index: -1;
      }

      mark{ padding: 0 .12em; border-radius: .35em; }
      .fav-btn{
        border: 1px solid rgba(226,232,240,.95);
        background: rgba(255,255,255,.86);
        border-radius: 999px;
        padding: 7px 10px;
        cursor: pointer;
        font-weight: 900;
        color: var(--primary);
        display:inline-flex;
        align-items:center;
        gap:6px;
      }
      .fav-btn[data-on="true"]{
        border-color: rgba(202,160,72,.55);
        background: rgba(202,160,72,.14);
        color: #6b4e10;
      }
      .quickfilters{
        display:flex; flex-wrap:wrap; gap:8px;
        margin-top:10px;
      }
      .qf{
        border: 1px solid rgba(226,232,240,.9);
        background: rgba(255,255,255,.85);
        padding: 8px 10px;
        border-radius: 999px;
        font-size: 12px;
        color: var(--muted);
        cursor:pointer;
        user-select:none;
        font-weight:700;
      }
      .qf[data-on="true"]{
        border-color: rgba(11,42,91,.35);
        background: rgba(11,42,91,.10);
        color: var(--primary);
      }
      .loadmore-wrap{
        display:flex;
        justify-content:center;
        margin: 16px 0 0;
      }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  function interestUniverse() {
    const s = new Set();
    MENTORS.forEach((m) => (m.interests || []).forEach((i) => s.add(i)));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }

  function availabilityRank(x) {
    return x === "Available" ? 0 : (x === "Limited" ? 1 : 2);
  }

  function availabilityBucket(m) {
    const a = (m.availability || "").toLowerCase();
    if (a.includes("available")) return "available";
    if (a.includes("limited")) return "limited";
    return "unavailable";
  }

  function tokenize(q) {
    return uniq(
      String(q || "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
    );
  }

  function matches(m) {
    // Multi-keyword: all tokens must appear somewhere in blob
    const tokens = tokenize(state.q);
    const blob = normalize([m.name, m.role, m.org, (m.interests || []).join(" "), m.notes].join(" | "));
    const qOk = tokens.length === 0 || tokens.every((t) => blob.includes(t));

    const selected = Array.from(state.chips);
    const chipOk = selected.length === 0 || selected.every((sel) => (m.interests || []).includes(sel));

    const availOk = state.avail === "all" || availabilityBucket(m) === state.avail;

    const favs = getFavorites();
    const favOk = !state.favOnly || favs.has(m.id);

    return qOk && chipOk && availOk && favOk;
  }

  function sortMentors(list) {
    const copy = [...list];
    if (state.sort === "name") {
      copy.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } else if (state.sort === "year") {
      copy.sort((a, b) => (b.gradYear || 0) - (a.gradYear || 0));
    } else if (state.sort === "availability") {
      copy.sort((a, b) => availabilityRank(a.availability) - availabilityRank(b.availability) || (a.name || "").localeCompare(b.name || ""));
    }
    return copy;
  }

  function highlight(text, tokens) {
    const raw = String(text || "");
    if (!tokens.length) return escapeHTML(raw);

    // Escape first, then highlight safely by replacing tokens in escaped string.
    // To keep it simple, do case-insensitive token matching on the raw, but insert marks on escaped.
    // We’ll do a conservative approach: split by tokens using regex on raw, then escape pieces.
    let parts = [raw];
    tokens.forEach((t) => {
      const next = [];
      parts.forEach((p) => {
        if (typeof p !== "string") return next.push(p);
        const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig");
        const split = p.split(re);
        split.forEach((seg, idx) => {
          if (idx % 2 === 1) next.push({ mark: seg });
          else next.push(seg);
        });
      });
      parts = next;
    });

    return parts
      .map((p) => {
        if (typeof p === "string") return escapeHTML(p);
        return `<mark>${escapeHTML(p.mark)}</mark>`;
      })
      .join("");
  }

  // Inject availability + favorites toggle UI into the right control card
  function injectQuickFilters() {
    // Find the sort card (the second .control-card inside .controls)
    const controls = document.querySelector(".controls");
    if (!controls) return;
    const cards = controls.querySelectorAll(".control-card");
    const sortCard = cards[1];
    if (!sortCard) return;

    const wrap = document.createElement("div");
    wrap.className = "quickfilters";
    wrap.setAttribute("aria-label", "Quick filters");

    // Availability buttons
    const btnAll = makeQF("All", "all");
    const btnAvail = makeQF("Available", "available");
    const btnLim = makeQF("Limited", "limited");
    const btnUn = makeQF("Unavailable", "unavailable");

    // Favorites-only toggle
    const btnFav = document.createElement("button");
    btnFav.type = "button";
    btnFav.className = "qf";
    btnFav.id = "favOnlyToggle";
    btnFav.textContent = "★ Favorites";
    btnFav.setAttribute("data-on", state.favOnly ? "true" : "false");
    btnFav.addEventListener("click", () => {
      state.favOnly = !state.favOnly;
      state.page = 1;
      renderAll();
    });

    wrap.append(btnAll, btnAvail, btnLim, btnUn, btnFav);

    // Put it under the existing "Privacy notice" block (end of card)
    sortCard.appendChild(wrap);

    function makeQF(label, val) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "qf";
      b.dataset.val = val;
      b.textContent = label;
      b.setAttribute("data-on", state.avail === val ? "true" : "false");
      b.addEventListener("click", () => {
        state.avail = val;
        state.page = 1;
        renderAll();
      });
      return b;
    }
  }

  function updateQuickFilterUI(counts) {
    // Update active states + counts in labels
    const qfs = document.querySelectorAll(".qf[data-val]");
    qfs.forEach((b) => {
      const val = b.dataset.val;
      b.setAttribute("data-on", state.avail === val ? "true" : "false");
      const base =
        val === "all" ? "All" :
        val === "available" ? "Available" :
        val === "limited" ? "Limited" : "Unavailable";

      const n =
        val === "all" ? counts.all :
        val === "available" ? counts.available :
        val === "limited" ? counts.limited : counts.unavailable;

      b.textContent = `${base} (${n})`;
    });

    const favToggle = $("favOnlyToggle");
    if (favToggle) favToggle.setAttribute("data-on", state.favOnly ? "true" : "false");
  }

  // Inject Load more under cards
  function injectLoadMore() {
    const cards = $("cards");
    if (!cards) return;

    const parent = cards.parentElement;
    const wrap = document.createElement("div");
    wrap.className = "loadmore-wrap";
    loadMoreBtn = document.createElement("button");
    loadMoreBtn.type = "button";
    loadMoreBtn.className = "btn";
    loadMoreBtn.textContent = "Load more";
    loadMoreBtn.addEventListener("click", () => {
      state.page += 1;
      renderCards(); // only render cards, keep chips
      writeURLState(state);
      saveLocalState(state);
    });

    wrap.appendChild(loadMoreBtn);
    parent.appendChild(wrap);
  }

  // -----------------------------
  // 3) Rendering
  // -----------------------------
  function renderChips() {
    const wrap = $("chips");
    if (!wrap) return;
    wrap.innerHTML = "";

    const all = interestUniverse();
    all.forEach((label) => {
      const el = document.createElement("button");
      el.className = "chip";
      el.type = "button";
      el.textContent = label;
      el.setAttribute("data-active", state.chips.has(label) ? "true" : "false");
      el.setAttribute("aria-label", `Filter by ${label}`);
      el.addEventListener("click", () => {
        if (state.chips.has(label)) state.chips.delete(label);
        else state.chips.add(label);

        bumpAnalytics("chips", label);

        state.page = 1;
        renderAll();
      });
      wrap.appendChild(el);
    });
  }

  function cardTag(text, cls = "") {
    const t = document.createElement("span");
    t.className = `tag ${cls}`.trim();
    t.textContent = text;
    return t;
  }

  function renderCards() {
    const cards = $("cards");
    if (!cards) return;

    const tokens = tokenize(state.q);

    const filtered = MENTORS.filter(matches);
    const sorted = sortMentors(filtered);

    // counts for availability buttons should reflect current chips+search+favOnly, but before availability filter:
    // We compute counts from "base filtered" that ignores state.avail but respects q/chips/favOnly.
    const baseFiltered = MENTORS.filter((m) => {
      const oldAvail = state.avail;
      state.avail = "all";
      const ok = matches(m);
      state.avail = oldAvail;
      return ok;
    });

    const counts = {
      all: baseFiltered.length,
      available: baseFiltered.filter((m) => availabilityBucket(m) === "available").length,
      limited: baseFiltered.filter((m) => availabilityBucket(m) === "limited").length,
      unavailable: baseFiltered.filter((m) => availabilityBucket(m) === "unavailable").length,
    };
    updateQuickFilterUI(counts);

    // pagination
    const limit = state.page * PAGE_SIZE;
    const pageList = sorted.slice(0, limit);

    cards.innerHTML = "";
    $("count").textContent = String(sorted.length);

    // Stats
    $("statMentors").textContent = String(MENTORS.length);
    $("statDomains").textContent = String(interestUniverse().length);

    if (sorted.length === 0) {
      const empty = document.createElement("div");
      empty.className = "control-card";
      empty.innerHTML = `<strong>No mentors found</strong><div class="meta" style="margin-top:6px">Try clearing filters or searching a broader term.</div>`;
      cards.appendChild(empty);
      if (loadMoreBtn) loadMoreBtn.style.display = "none";
      return;
    }

    const favs = getFavorites();

    pageList.forEach((m) => {
      const isFav = favs.has(m.id);

      const el = document.createElement("article");
      el.className = "card";

      // Highlight in name/role/org line
      const nameHTML = highlight(m.name, tokens);
      const subHTML = highlight(`${m.role} · ${m.org}`, tokens);

      el.innerHTML = `
        <div class="card-top">
          <div class="avatar" aria-hidden="true">${escapeHTML(initials(m.name))}</div>
          <div style="min-width:0;">
            <h3 style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${nameHTML}</h3>
            <p class="sub" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${subHTML}</p>
          </div>
          <div style="margin-left:auto; display:flex; gap:8px; align-items:flex-start;">
            <button class="fav-btn" type="button" aria-label="${isFav ? "Unfavorite" : "Favorite"} mentor" data-on="${isFav ? "true" : "false"}" title="Favorite">
              ★
            </button>
          </div>
        </div>
        <div class="card-mid">
          <div class="tags" aria-label="Mentor tags"></div>
        </div>
        <div class="card-bot">
          <div class="small">${escapeHTML(m.availability || "—")} · Class of ${escapeHTML(m.gradYear || "—")}</div>
          <button class="ghost" type="button" aria-label="View mentor details">View</button>
        </div>
      `;

      const tags = el.querySelector(".tags");
      tags.appendChild(cardTag(m.availability || "—", m.availability === "Available" ? "gold" : ""));
      tags.appendChild(cardTag(m.mode || "—", "primary"));
      (m.interests || []).slice(0, 3).forEach((i) => tags.appendChild(cardTag(i)));
      if ((m.interests || []).length > 3) tags.appendChild(cardTag(`+${(m.interests.length - 3)} more`));

      // Favorite click
      const favBtn = el.querySelector(".fav-btn");
      favBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const favsNow = getFavorites();
        if (favsNow.has(m.id)) favsNow.delete(m.id);
        else favsNow.add(m.id);
        setFavorites(favsNow);
        state.page = 1; // to avoid odd pagination when toggling favOnly
        renderCards();
      });

      // View modal
      el.querySelector(".ghost").addEventListener("click", (e) => {
        lastOpenerEl = e.currentTarget;
        bumpAnalytics("views", m.id);
        openModal(m);
      });

      cards.appendChild(el);
    });

    // load more visibility
    if (loadMoreBtn) {
      loadMoreBtn.style.display = (sorted.length > limit) ? "inline-flex" : "none";
      if (sorted.length > limit) {
        loadMoreBtn.textContent = `Load more (${pageList.length}/${sorted.length})`;
      }
    }
  }

  function renderAll() {
    // keep UI in sync
    const qEl = $("q");
    if (qEl && qEl.value !== state.q) qEl.value = state.q;

    const sEl = $("sort");
    if (sEl && sEl.value !== state.sort) sEl.value = state.sort;

    renderChips();
    renderCards();
    writeURLState(state);
    saveLocalState(state);
  }

  // -----------------------------
  // 4) Modal: focus trap + return focus
  // -----------------------------
  function getFocusable(container) {
    if (!container) return [];
    return Array.from(
      container.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null);
  }

  function trapFocusInDialog(dlg) {
    function onKeyDown(e) {
      if (!dlg.open) return;
      if (e.key !== "Tab") return;

      const focusables = getFocusable(dlg);
      if (!focusables.length) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    dlg.__trapHandler = onKeyDown;
    document.addEventListener("keydown", onKeyDown);
  }

  function untrapFocusInDialog(dlg) {
    if (dlg.__trapHandler) document.removeEventListener("keydown", dlg.__trapHandler);
    dlg.__trapHandler = null;
  }

  function openModal(m) {
    $("modalName").textContent = m.name;
    $("modalRole").textContent = `${m.role} · ${m.org}`;
    $("modalOrg").textContent = m.org || "—";
    $("modalYear").textContent = String(m.gradYear || "—");
    $("modalInterests").textContent = (m.interests || []).join(", ") || "—";
    $("modalMode").textContent = m.mode || "—";
    $("modalAvail").textContent = m.availability || "—";
    $("modalNotes").textContent = m.notes || "—";

    const link = (m.requestLink && m.requestLink !== "#") ? m.requestLink : (typeof globalRequestForm !== "undefined" ? globalRequestForm : "#");
    $("modalRequest").href = link || "#";

    const dlg = $("modal");
    if (typeof dlg.showModal === "function") {
      dlg.showModal();
      trapFocusInDialog(dlg);
      // focus close button for accessibility
      setTimeout(() => $("closeModal")?.focus(), 0);
    } else {
      alert("Your browser does not support dialogs. Please update your browser.");
    }
  }

  function closeModal() {
    const dlg = $("modal");
    if (dlg && dlg.open) {
      untrapFocusInDialog(dlg);
      dlg.close();
      // return focus
      if (lastOpenerEl && typeof lastOpenerEl.focus === "function") lastOpenerEl.focus();
    }
  }

  // -----------------------------
  // 5) Clear/reset
  // -----------------------------
  function clearFilters() {
    state.q = "";
    state.chips.clear();
    state.sort = "name";
    state.avail = "all";
    state.favOnly = false;
    state.page = 1;

    const qEl = $("q");
    if (qEl) qEl.value = "";
    const sEl = $("sort");
    if (sEl) sEl.value = "name";

    renderAll();
  }

  // -----------------------------
  // 6) Init + events
  // -----------------------------
  async function init() {
    injectEnhancementStyles();

    MENTORS = await getMentors();

    // Year footer
    const y = $("yearNow");
    if (y) y.textContent = String(new Date().getFullYear());

    // Prefer URL state; if URL empty, use localStorage state.
    const urlState = readURLState();
    const hasUrlFilters = !!(urlState.q || urlState.chips.size || urlState.sort !== "name" || urlState.avail !== "all" || urlState.favOnly || urlState.page !== 1);

    const local = loadLocalState();

    const seed = hasUrlFilters ? urlState : (local || urlState);

    state.q = seed.q || "";
    state.chips = new Set(seed.chips || []);
    state.sort = seed.sort || "name";
    state.avail = seed.avail || "all";
    state.favOnly = !!seed.favOnly;
    state.page = seed.page || 1;

    // Sync inputs
    if ($("q")) $("q").value = state.q;
    if ($("sort")) $("sort").value = state.sort;

    // Inject UI extras
    injectQuickFilters();
    injectLoadMore();

    // Wire existing events
    on($("q"), "input", (e) => {
      state.q = e.target.value;
      state.page = 1;
      renderAll();
    });

    on($("sort"), "change", (e) => {
      state.sort = e.target.value;
      state.page = 1;
      renderAll();
    });

    on($("clear"), "click", (e) => {
      e.preventDefault();
      clearFilters();
    });

    on($("closeModal"), "click", closeModal);
    on($("modal"), "click", (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
    });

    on($("print"), "click", () => window.print());

    on($("openForm"), "click", (e) => {
      e.preventDefault();
      if (typeof globalRequestForm !== "undefined" && globalRequestForm && globalRequestForm !== "#") {
        window.open(globalRequestForm, "_blank", "noopener,noreferrer");
      } else {
        alert("Add your Google Form link to globalRequestForm in the script.");
      }
    });

    // Render
    renderAll();
    // Initialize AOS (Animate On Scroll)
    AOS.init({
      duration: 1000, // Adjust animation duration
      once: true,     // Ensure animations trigger only once
      offset: 200,    // Offset to trigger the animation earlier or later
    });

  }

  init();
})();

