// ==UserScript==
// @name         ServiceTrade - Accordion Layout (Drag & Drop Fixed)
// @namespace    https://servicetrade.com/
// @version      1.4.1
// @description  Add Accordion Layout button; reorder/hide accordions; persist.
// @match        https://app.servicetrade.com/job/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  "use strict";

  const SEL = {
    FILTER_BTN: ".sub-header button[data-testid='filter-button']",
    ACCORDION_LIST: ".job-details-accordion-list",
    SECTION_TITLE_P: ".custom-accordion-header > p",
    TOP_LEVEL_ACCORDION: ".st-accordion.accordion",
    COLLAPSE: "[data-testid='accordion-collapse']",
  };

  const STORE = { KEY: "st_accordion_layout_v4" };

  // ----------------------------
  // Storage
  // ----------------------------
  function loadPrefs() {
    const raw = GM_getValue(STORE.KEY, "");
    if (!raw) return { order: [], hidden: {}, openByTitle: {} };
    try {
      const p = JSON.parse(raw);
      return {
        order: Array.isArray(p.order) ? p.order : [],
        hidden: p.hidden && typeof p.hidden === "object" ? p.hidden : {},
        openByTitle: p.openByTitle && typeof p.openByTitle === "object" ? p.openByTitle : {},
      };
    } catch {
      return { order: [], hidden: {}, openByTitle: {} };
    }
  }
  function savePrefs(p) { GM_setValue(STORE.KEY, JSON.stringify(p)); }
  function resetPrefs() { GM_deleteValue(STORE.KEY); }

  // ----------------------------
  // Helpers
  // ----------------------------
  const safeText = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function climbToDirectChild(el, container) {
    if (!el || !container) return null;
    let cur = el;
    while (cur && cur.parentElement && cur.parentElement !== container) {
      cur = cur.parentElement;
      if (cur === document.body || cur === document.documentElement) break;
    }
    return cur && cur.parentElement === container ? cur : null;
  }

  function findToggleFromTitleP(titleP) {
    if (!titleP) return null;

    const byRole = titleP.closest("button,[role='button']");
    if (byRole) return byRole;

    const headerish = titleP.closest(".card-header,.accordion-header,.custom-button");
    if (headerish) return headerish;

    const headerArea = titleP.closest(".custom-accordion-header") || titleP.parentElement;
    if (headerArea) {
      const fallback =
        headerArea.querySelector("button,[role='button']") ||
        headerArea.closest("button,[role='button']");
      if (fallback) return fallback;
    }
    return null;
  }

  function getSections() {
    const list = document.querySelector(SEL.ACCORDION_LIST);
    if (!list) return [];

    const titlePs = [...list.querySelectorAll(SEL.SECTION_TITLE_P)];
    const seenBlocks = new Set();
    const out = [];

    for (const p of titlePs) {
      const title = safeText(p.textContent);
      if (!title) continue;

      const acc = p.closest(SEL.TOP_LEVEL_ACCORDION) || p.closest("div");
      const block = climbToDirectChild(acc, list) || acc;
      if (!block || seenBlocks.has(block)) continue;
      seenBlocks.add(block);

      const toggle = findToggleFromTitleP(p);
      const collapse =
        (acc && acc.querySelector(SEL.COLLAPSE)) ||
        block.querySelector(SEL.COLLAPSE) ||
        null;

      out.push({ title, block, toggle, collapse });
    }
    return out;
  }

  function findSectionByTitle(title) {
    const sections = getSections();
    return sections.find((s) => s.title === title) || null;
  }

  function readOpen(section) {
    if (!section) return false;

    const t = section.toggle;
    if (t) {
      const aria = t.getAttribute("aria-expanded");
      if (aria === "true") return true;
      if (aria === "false") return false;
    }

    const c = section.collapse || (section.block && section.block.querySelector(SEL.COLLAPSE));
    if (c) return c.classList.contains("show");
    return false;
  }

  function forceShow(section, open) {
    const c = section.collapse || (section.block && section.block.querySelector(SEL.COLLAPSE));
    if (!c) return;
    c.classList.remove("collapsing");
    c.style.height = "";
    if (open) c.classList.add("show");
    else c.classList.remove("show");
  }

  function clickToggle(section) {
    if (!section?.toggle) return false;
    try {
      section.toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    } catch {
      try { section.toggle.click(); return true; } catch { return false; }
    }
  }

  // ----------------------------
  // Apply order + hide (once)
  // ----------------------------
  function applyOrderAndVisibilityOnce() {
    const list = document.querySelector(SEL.ACCORDION_LIST);
    if (!list) return;

    const prefs = loadPrefs();
    const sections = getSections();
    if (!sections.length) return;

    const existing = new Set(sections.map((s) => s.title));

    const order = [];
    for (const t of prefs.order || []) {
      const k = safeText(t);
      if (k && existing.has(k)) order.push(k);
    }
    for (const s of sections) if (!order.includes(s.title)) order.push(s.title);

    const byTitle = new Map(sections.map((s) => [s.title, s]));
    const blocksSet = new Set(sections.map((s) => s.block));
    const leftovers = [...list.children].filter((ch) => !blocksSet.has(ch));

    const frag = document.createDocumentFragment();
    for (const t of order) {
      const s = byTitle.get(t);
      if (s) frag.appendChild(s.block);
    }
    for (const ch of leftovers) frag.appendChild(ch);
    list.appendChild(frag);

    for (const s of sections) {
      const hidden = !!prefs.hidden?.[s.title];
      s.block.style.display = hidden ? "none" : "";
    }

    if (JSON.stringify(prefs.order) !== JSON.stringify(order)) {
      prefs.order = order;
      savePrefs(prefs);
    }
  }

  // ----------------------------
  // Open ONLY selected with confirm + retry
  // ----------------------------
  async function ensureOpenState(title, desiredOpen, prefs) {
    if (prefs.hidden?.[title]) return { title, ok: true, skipped: "hidden" };

    const delays = [200, 600, 1200];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      let s = findSectionByTitle(title);
      if (!s) return { title, ok: false, reason: "section not found" };

      const cur = readOpen(s);
      if (cur === desiredOpen) return { title, ok: true };

      const clicked = clickToggle(s);
      await sleep(delays[attempt]);

      s = findSectionByTitle(title);
      const after = readOpen(s);
      if (after === desiredOpen) return { title, ok: true };

      if (attempt === delays.length - 1) {
        forceShow(s, desiredOpen);
        await sleep(120);
        const finalS = findSectionByTitle(title);
        const final = readOpen(finalS);
        if (final === desiredOpen) return { title, ok: true, note: clicked ? "click+force" : "force" };
        return { title, ok: false, reason: clicked ? "click did not take" : "no toggle found" };
      }
    }
    return { title, ok: false, reason: "unknown" };
  }

  async function applyOpenStateWithConfirm() {
    const prefs = loadPrefs();
    const sections = getSections();
    if (!sections.length) return;

    const titles = (prefs.order && prefs.order.length) ? prefs.order.slice() : sections.map(s => s.title);

    const results = [];
    for (const title of titles) {
      const desired = prefs.openByTitle?.[title] === true;
      results.push(await ensureOpenState(title, desired, prefs));
    }

    const failed = results.filter(r => !r.ok);
    if (failed.length) {
      console.group("[ST Accordion Layout] Some sections did not reach desired open/closed state");
      console.table(failed);
      console.groupEnd();
    }
  }

  function applyLayoutOnce() {
    applyOrderAndVisibilityOnce();
    setTimeout(() => { applyOpenStateWithConfirm(); }, 350);
    setTimeout(() => { applyOpenStateWithConfirm(); }, 2000);
  }

  // ----------------------------
  // Button injection after Filter
  // ----------------------------
  const BTN_MARKER = "data-st-accordion-layout-btn";
  function ensureButtonAfterFilter() {
    const filterBtn = document.querySelector(SEL.FILTER_BTN);
    if (!filterBtn) return false;

    const parent = filterBtn.parentElement;
    if (!parent) return false;

    if (parent.querySelector(`button[${BTN_MARKER}="1"]`)) return true;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(BTN_MARKER, "1");
    btn.setAttribute("aria-label", "Accordion Layout");
    btn.className = filterBtn.className;
    btn.setAttribute("data-testid", "accordion-layout-button");

    const inner = document.createElement("span");
    inner.className = "st-link-button-inner";
    inner.textContent = "Accordion Layout";
    btn.appendChild(inner);

    btn.addEventListener("click", openLayoutModal);
    parent.insertBefore(btn, filterBtn.nextSibling);
    return true;
  }

  // ----------------------------
  // Modal UI + Drag & Drop (FIXED)
  // ----------------------------
  GM_addStyle(`
    .st-tm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:999999;display:flex;align-items:center;justify-content:center;padding:16px}
    .st-tm-modal{width:min(740px,96vw);background:#fff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
    .st-tm-modal header{padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.08);display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:650}
    .st-tm-body{padding:12px 14px;max-height:70vh;overflow:auto}
    .st-tm-mini{font-size:12px;opacity:.75;margin:6px 0 10px 0}
    .st-tm-list{display:flex;flex-direction:column;gap:8px}

    .st-tm-row{
      display:grid;
      grid-template-columns:auto 1fr auto auto;
      gap:12px;
      align-items:center;
      padding:10px 10px;
      border:1px solid rgba(0,0,0,.08);
      border-radius:10px;
      background:#fff;
      user-select:none;
    }
    .st-tm-row.dragging{opacity:.55}
    .st-tm-row.drop-target{outline:2px dashed rgba(0,0,0,.25); outline-offset:2px}

    .st-tm-handle{
      width:28px;height:28px;
      display:flex;align-items:center;justify-content:center;
      border:1px solid rgba(0,0,0,.12);
      border-radius:8px;
      cursor:grab;
      user-select:none;
      font-size:16px;
      line-height:1;
    }
    .st-tm-handle:active{cursor:grabbing}

    .st-tm-title{min-width:0}
    .st-tm-title .name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    .st-tm-check{display:inline-flex;gap:8px;align-items:center;user-select:none;font-weight:600}
    .st-tm-foot{padding:12px 14px;border-top:1px solid rgba(0,0,0,.08);display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
    .st-tm-foot .left,.st-tm-foot .right{display:flex;gap:8px;align-items:center}
    .st-tm-btn{border:1px solid rgba(0,0,0,.18);background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;font-weight:600}
    .st-tm-btn:disabled{opacity:.5;cursor:default}
  `);

  function closeModal() {
    document.getElementById("st-tm-overlay")?.remove();
    document.removeEventListener("keydown", escClose, true);
  }
  function escClose(e) { if (e.key === "Escape") closeModal(); }

  function openLayoutModal() {
    const sections = getSections();
    if (!sections.length) {
      alert("No accordions found on this page.");
      return;
    }

    const prefs = loadPrefs();
    const currentTitles = sections.map((s) => s.title);

    const initialOrder = [
      ...(prefs.order || []).filter((t) => currentTitles.includes(t)),
      ...currentTitles.filter((t) => !(prefs.order || []).includes(t)),
    ];

    const hidden = { ...(prefs.hidden || {}) };

    const openByTitle = {};
    for (const s of sections) {
      if (typeof prefs.openByTitle?.[s.title] === "boolean") openByTitle[s.title] = prefs.openByTitle[s.title];
      else openByTitle[s.title] = readOpen(s);
    }

    closeModal();

    const overlay = document.createElement("div");
    overlay.id = "st-tm-overlay";
    overlay.className = "st-tm-overlay";
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

    const modal = document.createElement("div");
    modal.className = "st-tm-modal";

    const head = document.createElement("header");
    head.innerHTML = `<div>Layout</div>`;

    const headClose = document.createElement("button");
    headClose.className = "st-tm-btn";
    headClose.textContent = "Close";
    headClose.addEventListener("click", closeModal);
    head.appendChild(headClose);

    const body = document.createElement("div");
    body.className = "st-tm-body";

    const note = document.createElement("p");
    note.className = "st-tm-mini";
    note.textContent = "Drag the ⋮⋮ handle to reorder. Only sections checked “Open” will be opened on page load.";
    body.appendChild(note);

    const listWrap = document.createElement("div");
    listWrap.className = "st-tm-list";
    body.appendChild(listWrap);

    // ---- Drag state (FIX) ----
    let dragArmed = false;
    let draggingRow = null;

    function makeRow(title) {
      const row = document.createElement("div");
      row.className = "st-tm-row";
      row.draggable = true;
      row.dataset.title = title;

      const handle = document.createElement("div");
      handle.className = "st-tm-handle";
      handle.title = "Drag to reorder";
      handle.textContent = "⋮⋮";

      // Arm dragging ONLY when handle is pressed
      handle.addEventListener("pointerdown", () => { dragArmed = true; }, { passive: true });
      handle.addEventListener("mousedown", () => { dragArmed = true; }, { passive: true }); // fallback
      document.addEventListener("pointerup", () => { dragArmed = false; }, { passive: true });

      const titleBox = document.createElement("div");
      titleBox.className = "st-tm-title";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = title;
      titleBox.appendChild(name);

      const hideLbl = document.createElement("label");
      hideLbl.className = "st-tm-check";
      const hideCb = document.createElement("input");
      hideCb.type = "checkbox";
      hideCb.checked = !!hidden[title];
      hideCb.addEventListener("change", () => (hidden[title] = hideCb.checked));
      hideLbl.appendChild(hideCb);
      hideLbl.appendChild(document.createTextNode("Hide"));

      const openLbl = document.createElement("label");
      openLbl.className = "st-tm-check";
      const openCb = document.createElement("input");
      openCb.type = "checkbox";
      openCb.checked = openByTitle[title] === true;
      openCb.addEventListener("change", () => (openByTitle[title] = openCb.checked));
      openLbl.appendChild(openCb);
      openLbl.appendChild(document.createTextNode("Open"));

      row.appendChild(handle);
      row.appendChild(titleBox);
      row.appendChild(hideLbl);
      row.appendChild(openLbl);

      row.addEventListener("dragstart", (e) => {
        if (!dragArmed) {
          e.preventDefault();
          return;
        }
        draggingRow = row;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", row.dataset.title);
      });

      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        draggingRow = null;
        dragArmed = false;
        [...listWrap.querySelectorAll(".drop-target")].forEach(el => el.classList.remove("drop-target"));
      });

      return row;
    }

    function render(order) {
      listWrap.innerHTML = "";
      for (const title of order) listWrap.appendChild(makeRow(title));
    }

    function readOrderFromDOM() {
      return [...listWrap.querySelectorAll(".st-tm-row")].map(r => r.dataset.title);
    }

    // Compute insertion point
    function getDragAfterElement(container, y) {
      const rows = [...container.querySelectorAll(".st-tm-row:not(.dragging)")];
      let closest = { offset: Number.NEGATIVE_INFINITY, element: null };

      for (const r of rows) {
        const box = r.getBoundingClientRect();
        const offset = y - (box.top + box.height / 2);
        if (offset < 0 && offset > closest.offset) {
          closest = { offset, element: r };
        }
      }
      return closest.element;
    }

    listWrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!draggingRow) return;

      const after = getDragAfterElement(listWrap, e.clientY);
      [...listWrap.querySelectorAll(".drop-target")].forEach(el => el.classList.remove("drop-target"));
      if (after) after.classList.add("drop-target");

      if (after == null) listWrap.appendChild(draggingRow);
      else listWrap.insertBefore(draggingRow, after);
    });

    listWrap.addEventListener("drop", (e) => {
      e.preventDefault();
      [...listWrap.querySelectorAll(".drop-target")].forEach(el => el.classList.remove("drop-target"));
    });

    render(initialOrder);

    const foot = document.createElement("div");
    foot.className = "st-tm-foot";

    const left = document.createElement("div");
    left.className = "left";

    const resetBtn = document.createElement("button");
    resetBtn.className = "st-tm-btn";
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", () => {
      resetPrefs();
      closeModal();
      applyLayoutOnce();
    });

    const showAllBtn = document.createElement("button");
    showAllBtn.className = "st-tm-btn";
    showAllBtn.textContent = "Show All";
    showAllBtn.addEventListener("click", () => {
      for (const t of readOrderFromDOM()) hidden[t] = false;
      render(readOrderFromDOM());
    });

    const openNoneBtn = document.createElement("button");
    openNoneBtn.className = "st-tm-btn";
    openNoneBtn.textContent = "Open None";
    openNoneBtn.addEventListener("click", () => {
      for (const t of readOrderFromDOM()) openByTitle[t] = false;
      render(readOrderFromDOM());
    });

    left.appendChild(resetBtn);
    left.appendChild(showAllBtn);
    left.appendChild(openNoneBtn);

    const right = document.createElement("div");
    right.className = "right";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "st-tm-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", closeModal);

    const saveBtn = document.createElement("button");
    saveBtn.className = "st-tm-btn";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      const newOrder = readOrderFromDOM();

      const explicitOpen = {};
      for (const t of newOrder) explicitOpen[t] = openByTitle[t] === true;

      savePrefs({
        order: newOrder,
        hidden: { ...hidden },
        openByTitle: explicitOpen,
      });

      closeModal();
      applyLayoutOnce();
    });

    right.appendChild(cancelBtn);
    right.appendChild(saveBtn);

    foot.appendChild(left);
    foot.appendChild(right);

    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", escClose, true);
  }

  // ----------------------------
  // Init (no MutationObserver; limited retries)
  // ----------------------------
  function initOnceWithRetries() {
    const maxTries = 28;
    let tries = 0;

    const tick = () => {
      tries++;
      ensureButtonAfterFilter();

      if (document.querySelector(SEL.ACCORDION_LIST)) {
        applyLayoutOnce();
        return;
      }
      if (tries < maxTries) setTimeout(tick, 250);
    };
    tick();
  }

  function hookUrlChanges() {
    let last = location.href;

    const onChange = () => {
      const now = location.href;
      if (now === last) return;
      last = now;
      setTimeout(initOnceWithRetries, 250);
    };

    const _push = history.pushState;
    history.pushState = function () {
      const r = _push.apply(this, arguments);
      onChange();
      return r;
    };

    const _replace = history.replaceState;
    history.replaceState = function () {
      const r = _replace.apply(this, arguments);
      onChange();
      return r;
    };

    window.addEventListener("popstate", onChange, true);
  }

  hookUrlChanges();
  initOnceWithRetries();
})();