// ==UserScript==
// @name         ServiceTrade - Pulse Targets w/ Office Criteria + One-time Popup
// @namespace    st.overview.pulse.office.criteria
// @version      1.6.2
// @description  Pulses selected fields based on office criteria
// @match        https://app.servicetrade.com/job*
// @match        file://*/*
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  // =============================
  // MODIFIERS / CONFIG
  // =============================
  const CFG = {
    expectedOffice: 'Briscoe Centereach',        // Office value considered "correct"
    criteriaMode: 'block',                       // 'block' => pulse when office != expected; 'allow' => pulse only when office == expected
    matchType: 'exact',                          // 'exact' | 'contains' | 'regex'
    caseSensitive: false,                        // true => case sensitive comparisons
    regexFlags: 'i',                             // Regex flags used when matchType='regex' (ignored otherwise)
    showPopupOnce: true,                         // true => one-time popup when criteria says "pulse"
    popupMessage: 'Office is incorrect.',        // Base popup message text
    allowRepulseOnStateChange: true,             // true => re-pulse when criteria flips false -> true
    pulseLockRedAfterMs: 5000,                   // How long to pulse before locking into steady highlight
    checkEveryMs: 400,                           // Interval re-check frequency
    pulseScale: 1.08,                            // Pulse size (bigger)
    pulseAnimSeconds: 0.5,                       // Pulse speed (twice as fast)
    glowPx: 16,                                  // Glow radius
    borderPx: 2,                                 // Border thickness
    paddingPxY: 4,                               // Vertical padding
    paddingPxX: 8,                               // Horizontal padding

    // Color modifiers (CSS color strings)
    accentColor: '#ff0000',                      // Main accent color (text/border/glow)
    glowAlpha: 0.08,                             // Glow alpha at 50% keyframe (0..1)
    glowAlphaStart: 0.75,                        // Glow alpha at 0% keyframe (0..1)
    backgroundAlpha: 0.12,                       // Background alpha for locked highlight (0..1)

    debugLog: false                              // true => console logs
  };

  const TARGET_SELECTORS = [
    '#app-frame > div.job-details-page > div > div.job-overview-container > div.job-overview-details > div.job-overview-details__main > div:nth-child(2) > div:nth-child(2)',
    '#job-details-container > div > div.tab-contents.details-tab > div > div.details-grid.break-word > div:nth-child(2) > div:nth-child(2)'
  ];

  const OFFICE_SELECTORS = [
    '#job\\.office > span',
    '#job-details-container > div > div.tab-contents.details-tab > div > div.details-grid.break-word > div:nth-child(2) > div:nth-child(2) > a'
  ];

  // Convert hex (#RRGGBB or #RGB) into "r,g,b" for rgba() usage
  function hexToRgbTriplet(hex) {
    const h = (hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) {
      const r = parseInt(h[0] + h[0], 16);
      const g = parseInt(h[1] + h[1], 16);
      const b = parseInt(h[2] + h[2], 16);
      return `${r},${g},${b}`;
    }
    if (/^[0-9a-fA-F]{6}$/.test(h)) {
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return `${r},${g},${b}`;
    }
    return '255,0,0'; // fallback
  }

  const ACCENT_RGB = hexToRgbTriplet(CFG.accentColor);

  GM_addStyle(`
    @keyframes stPulse {
      0%   { box-shadow: 0 0 0 0 rgba(${ACCENT_RGB},${CFG.glowAlphaStart}); transform: scale(1); }
      50%  { box-shadow: 0 0 0 ${CFG.glowPx}px rgba(${ACCENT_RGB},${CFG.glowAlpha}); transform: scale(${CFG.pulseScale}); }
      100% { box-shadow: 0 0 0 0 rgba(${ACCENT_RGB},0); transform: scale(1); }
    }

    .st-target-pulse {
      color: ${CFG.accentColor} !important;
      border: ${CFG.borderPx}px solid ${CFG.accentColor} !important;
      border-radius: 10px !important;
      padding: ${CFG.paddingPxY}px ${CFG.paddingPxX}px !important;
      display: inline-block !important;
      animation: stPulse ${CFG.pulseAnimSeconds}s ease-in-out infinite !important;
      will-change: transform, box-shadow;
    }

    .st-target-red {
      color: ${CFG.accentColor} !important;
      border: ${CFG.borderPx}px solid ${CFG.accentColor} !important;
      border-radius: 10px !important;
      padding: ${CFG.paddingPxY}px ${CFG.paddingPxX}px !important;
      display: inline-block !important;
      background-color: rgba(${ACCENT_RGB}, ${CFG.backgroundAlpha}) !important;
    }
  `);

  const pulseTimers = new WeakMap();
  let officePopupShown = false;
  let lastShouldPulse = null;

  function log(...args) {
    if (CFG.debugLog) console.log('[st-pulse]', ...args);
  }

  function normalizeText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function pickFirstText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const txt = normalizeText(el ? el.textContent : '');
      if (txt) return txt;
    }
    return '';
  }

  function getOfficeText() {
    return pickFirstText(OFFICE_SELECTORS);
  }

  function toComparable(s) {
    return CFG.caseSensitive ? s : s.toLowerCase();
  }

  function officeMatchesExpected(officeText) {
    const officeNorm = normalizeText(officeText);
    if (!officeNorm) return false;

    if (CFG.matchType === 'regex') {
      const re = new RegExp(CFG.expectedOffice, CFG.regexFlags || '');
      return re.test(officeNorm);
    }

    const office = toComparable(officeNorm);
    const expected = toComparable(normalizeText(CFG.expectedOffice));

    if (CFG.matchType === 'contains') return office.includes(expected);
    return office === expected; // default 'exact'
  }

  function shouldPulseNow(officeText) {
    const matches = officeMatchesExpected(officeText);
    if (CFG.criteriaMode === 'allow') return matches;
    return !matches; // default 'block'
  }

  function maybeShowPopupOnce(officeText) {
    if (!CFG.showPopupOnce) return;
    if (officePopupShown) return;
    if (!officeText) return;

    officePopupShown = true;
    window.alert(
      `${CFG.popupMessage}\nCurrent office: "${officeText}"\nExpected: "${CFG.expectedOffice}"`
    );
  }

  function clearPulse(el) {
    if (!el) return;
    el.classList.remove('st-target-pulse');
    el.classList.remove('st-target-red');
    const t = pulseTimers.get(el);
    if (t) clearTimeout(t);
    pulseTimers.delete(el);
  }

  function startPulse(el) {
    if (!el) return;
    const existing = pulseTimers.get(el);
    if (existing) clearTimeout(existing);

    el.classList.remove('st-target-red');
    el.classList.add('st-target-pulse');

    const timer = setTimeout(() => {
      el.classList.remove('st-target-pulse');
      el.classList.add('st-target-red');
      pulseTimers.delete(el);
    }, CFG.pulseLockRedAfterMs);

    pulseTimers.set(el, timer);
  }

  function getTargets() {
    const out = new Set();
    for (const sel of TARGET_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) out.add(el);
    }
    return Array.from(out);
  }

  function apply() {
    const officeText = getOfficeText();
    const shouldPulse = shouldPulseNow(officeText);
    const targets = getTargets();

    log('officeText=', officeText, 'shouldPulse=', shouldPulse, 'targets=', targets.length);

    if (shouldPulse && officeText) {
      maybeShowPopupOnce(officeText);
    }

    if (!shouldPulse) {
      for (const el of targets) clearPulse(el);
      lastShouldPulse = shouldPulse;
      return;
    }

    const flippedToPulse = (lastShouldPulse === false && shouldPulse === true);

    for (const el of targets) {
      const hasPulse = el.classList.contains('st-target-pulse');
      const hasRed = el.classList.contains('st-target-red');

      if (!hasPulse && !hasRed) {
        startPulse(el);
      } else if (CFG.allowRepulseOnStateChange && flippedToPulse && !hasPulse) {
        el.classList.remove('st-target-red');
        startPulse(el);
      }
    }

    lastShouldPulse = shouldPulse;
  }

  apply();
  setInterval(apply, CFG.checkEveryMs);

  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();