// Morph tooltip for jargon: one floating pill that glides and morphs between dotted terms.
//
// The pill and its arrow sit inside an SVG goo filter (blur, then alpha threshold),
// which melts them together. On open the pill starts shrunk against the term and
// travels out, stretching a "stem" from the arrow until the stem shrinks and the neck
// snaps. Closing shrinks the whole popup back into the term. Moving between nearby
// terms glides the open pill instead of reopening it. The label sits outside the
// filter so the text stays crisp.
//
// Needs window.FDE_TERMS (assets/terms.js). Marks the first use of each term per
// block (paragraph, cell, quiz item) and watches for content added later by widgets.
(function () {
  const TERMS = window.FDE_TERMS || [];
  if (!TERMS.length) return;

  const GAP = 8; // px between term and pill
  const PAD = 8; // px kept clear of the viewport edge
  const GRACE = 60; // ms to bridge the gap between neighbouring terms
  const instant = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- Matching ----------
  const byVariant = new Map();
  TERMS.forEach((t, i) => {
    t.id = "t" + i;
    t.match.forEach((v) => byVariant.set(v.toLowerCase(), { t, v }));
  });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const variants = [...byVariant.keys()].sort((a, b) => b.length - a.length).map(esc);
  const pattern = new RegExp(`(?<![\\w-])(${variants.join("|")})(?![\\w-])`, "gi");

  const SKIP = "a, code, kbd, script, style, textarea, nav, .term, .tip, .no-terms";
  const BLOCK = "p, li, td, th, h1, h2, h3, label, button, .prompt";
  const seen = new WeakMap(); // block element -> Set of term ids already marked

  function lookup(text) {
    const hit = byVariant.get(text.toLowerCase());
    if (!hit) return null;
    if (!hit.t.ci && hit.v !== text) return null; // acronyms are case-sensitive
    return hit.t;
  }

  function annotate(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        !n.nodeValue.trim() || !n.parentElement || n.parentElement.closest(SKIP)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    nodes.forEach((node) => {
      const text = node.nodeValue;
      // Answer buttons repeat the same words in every item, so inside a widget's
      // buttons each term is marked once per widget, not once per button.
      const block =
        (node.parentElement.closest("button") && node.parentElement.closest(".widget")) ||
        node.parentElement.closest(BLOCK) ||
        node.parentElement;
      if (!seen.has(block)) seen.set(block, new Set());
      const used = seen.get(block);
      const inControl = !!node.parentElement.closest("button, label");
      const frag = document.createDocumentFragment();
      let last = 0;
      let changed = false;
      pattern.lastIndex = 0;
      for (const m of text.matchAll(pattern)) {
        const t = lookup(m[0]);
        if (!t || used.has(t.id)) continue;
        used.add(t.id);
        frag.append(text.slice(last, m.index));
        const span = document.createElement("span");
        span.className = "term";
        span.dataset.term = t.id;
        span.textContent = m[0];
        if (!inControl) span.tabIndex = 0; // no nested focus targets inside buttons
        frag.append(span);
        last = m.index + m[0].length;
        changed = true;
      }
      if (!changed) return;
      frag.append(text.slice(last));
      node.replaceWith(frag);
    });
  }

  // ---------- The popup ----------
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.id = "fde-tip";
  tip.setAttribute("role", "tooltip");
  if (instant) tip.dataset.instant = "";
  tip.innerHTML = `
    <svg aria-hidden="true" width="0" height="0" style="position:absolute">
      <filter id="fde-tip-goo" x="-20%" y="-50%" width="140%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
        <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
      </filter>
    </svg>
    <span class="tip-goo" aria-hidden="true">
      <span class="tip-body"></span>
      <span class="tip-frame"><span class="tip-arrow"><span class="tip-stem"></span></span></span>
    </span>
    <span class="tip-label"></span>`;
  const label = tip.querySelector(".tip-label");
  const arrow = tip.querySelector(".tip-arrow");
  const measure = document.createElement("span");
  measure.className = "tip-label tip-measure";
  measure.setAttribute("aria-hidden", "true");

  let current = null;
  let closeTimer = 0;
  let endTimer = 0;
  let glideTimer = 0;

  function content(t) {
    const full = t.full ? ` <span class="tip-full">${t.full}</span>` : "";
    return `<span class="tip-term">${t.term}</span>${full}<span class="tip-def">${t.def}</span>`;
  }

  function place(trigger) {
    // A term can wrap across lines; point at its first line box.
    const r = trigger.getClientRects()[0] || trigger.getBoundingClientRect();
    const w = Math.ceil(measure.getBoundingClientRect().width);
    const h = Math.ceil(measure.getBoundingClientRect().height);
    const side = r.top - GAP - h >= PAD ? "top" : "bottom";
    const cx = r.left + r.width / 2;
    const left = Math.min(Math.max(cx - w / 2, PAD), innerWidth - w - PAD);
    const top = side === "top" ? r.top - GAP - h : r.bottom + GAP;
    const ax = Math.min(Math.max(cx - left, 12), w - 12);
    tip.dataset.side = side;
    tip.style.setProperty("--gap", GAP + "px");
    Object.assign(tip.style, {
      left: left + "px",
      top: top + "px",
      width: w + "px",
      height: h + "px",
      transformOrigin: `${ax}px ${side === "top" ? h + GAP : -GAP}px`,
    });
    arrow.style.left = ax - 6 + "px";
    label.style.width = w + "px";
  }

  function show(trigger) {
    clearTimeout(closeTimer);
    const t = TERMS.find((x) => x.id === trigger.dataset.term);
    if (!t) return;
    const isOpen = tip.hasAttribute("data-open") && !tip.hasAttribute("data-ending");
    if (current === trigger && isOpen) return;
    if (current) current.removeAttribute("aria-describedby");
    current = trigger;
    trigger.setAttribute("aria-describedby", tip.id);
    measure.innerHTML = content(t);

    if (isOpen && !instant) {
      // Glide: slide and resize the open pill while the labels cross-fade.
      const prev = label.cloneNode(true);
      prev.classList.add("tip-prev");
      prev.removeAttribute("style");
      prev.style.width = label.style.width;
      tip.appendChild(prev);
      label.innerHTML = content(t);
      label.dataset.entering = "";
      tip.dataset.glide = "";
      place(trigger);
      void tip.offsetWidth;
      requestAnimationFrame(() => {
        label.removeAttribute("data-entering");
        prev.dataset.leaving = "";
      });
      setTimeout(() => prev.remove(), 200);
      clearTimeout(glideTimer);
      glideTimer = setTimeout(() => tip.removeAttribute("data-glide"), 260);
      return;
    }

    // Fresh open (or re-open while closing).
    clearTimeout(endTimer);
    tip.removeAttribute("data-ending");
    tip.removeAttribute("data-glide");
    tip.querySelectorAll(".tip-prev").forEach((n) => n.remove());
    label.innerHTML = content(t);
    place(trigger);
    tip.dataset.open = "";
    tip.dataset.starting = "";
    void tip.offsetWidth; // commit the starting styles before releasing them
    requestAnimationFrame(() => requestAnimationFrame(() => tip.removeAttribute("data-starting")));
  }

  function hide() {
    clearTimeout(closeTimer);
    if (!tip.hasAttribute("data-open")) return;
    if (current) current.removeAttribute("aria-describedby");
    current = null;
    tip.dataset.ending = "";
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      tip.removeAttribute("data-open");
      tip.removeAttribute("data-ending");
    }, instant ? 0 : 260);
  }

  const later = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(hide, GRACE);
  };
  const termOf = (el) => (el && el.closest ? el.closest(".term") : null);

  // ---------- Wiring ----------
  function init() {
    document.body.append(tip, measure);
    const main = document.querySelector("main") || document.body;
    annotate(main);

    // Widgets (quiz feedback, resets) add text later: mark it too.
    const observer = new MutationObserver((records) => {
      observer.disconnect();
      records.forEach((r) =>
        r.addedNodes.forEach((n) => {
          if (n.nodeType === 1 && !n.closest(".tip")) annotate(n);
          else if (n.nodeType === 3 && n.parentElement) annotate(n.parentElement);
        })
      );
      observer.observe(main, { childList: true, subtree: true });
    });
    observer.observe(main, { childList: true, subtree: true });

    document.addEventListener("pointerover", (e) => {
      const t = termOf(e.target);
      if (t) show(t);
    });
    document.addEventListener("pointerout", (e) => {
      if (e.pointerType === "touch") return; // touch closes on the next tap elsewhere
      const t = termOf(e.target);
      if (t && !t.contains(e.relatedTarget)) later();
    });
    document.addEventListener("pointerdown", (e) => {
      if (!termOf(e.target)) hide();
    });
    document.addEventListener("focusin", (e) => {
      const t = termOf(e.target);
      if (t) show(t);
    });
    document.addEventListener("focusout", (e) => {
      if (termOf(e.target)) later();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hide();
    });
    const follow = () => {
      if (current && !tip.hasAttribute("data-ending")) place(current);
    };
    addEventListener("scroll", follow, { passive: true, capture: true });
    addEventListener("resize", follow);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
