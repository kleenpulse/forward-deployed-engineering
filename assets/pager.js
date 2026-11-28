// Pager: previous / next cards at the bottom of the page. The links come from the page's
// own course nav (the "← …" and "… →" entries), so the order is written in one place only.
// Each card shows the nav label at once, then swaps in the target page's real <h1> once it
// has been fetched (same origin only; from disk or on failure the nav label stays).
(function () {
  const clean = (s) => s.replace(/\s+/g, " ").trim();

  function find(nav) {
    let prev = null;
    let next = null;
    for (const a of nav.querySelectorAll("a[href]")) {
      const text = clean(a.textContent);
      if (!prev && text.startsWith("←")) prev = { href: a.getAttribute("href"), label: clean(text.slice(1)) };
      else if (!next && text.endsWith("→")) next = { href: a.getAttribute("href"), label: clean(text.slice(0, -1)) };
    }
    return { prev, next };
  }

  function card(link, dir) {
    const a = document.createElement("a");
    a.className = `pager-${dir}`;
    a.href = link.href;
    a.rel = dir;
    const kicker = document.createElement("span");
    kicker.className = "pager-kicker";
    kicker.textContent = dir === "prev" ? "← Previous" : "Next →";
    const title = document.createElement("span");
    title.className = "pager-title";
    title.textContent = link.label;
    a.append(kicker, title);
    upgrade(a, link, dir, kicker, title);
    return a;
  }

  // Swap the short nav label for the target's full title. When they differ, the short label
  // moves into the kicker ("← Lesson 2"), unless the title already contains it.
  async function upgrade(a, link, dir, kicker, title) {
    if (location.protocol === "file:") return;
    try {
      const res = await fetch(a.href);
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const h1 = clean(doc.querySelector("main h1, h1")?.textContent ?? "");
      if (!h1 || h1 === link.label) return;
      title.textContent = h1;
      // "Lesson 2" adds something above a lesson's title; "Start here" above "Start here: …" does not.
      if (h1.toLowerCase().includes(link.label.toLowerCase())) return;
      kicker.textContent = dir === "prev" ? `← ${link.label}` : `${link.label} →`;
    } catch {
      // Offline or blocked: the nav label is already showing.
    }
  }

  function mount() {
    const nav = document.querySelector("nav.course");
    const main = document.querySelector("main");
    if (!nav || !main || main.querySelector("nav.pager")) return;
    const { prev, next } = find(nav);
    if (!prev && !next) return;

    const pager = document.createElement("nav");
    pager.className = "pager";
    pager.setAttribute("aria-label", "Previous and next page");
    if (prev) pager.append(card(prev, "prev"));
    if (next) pager.append(card(next, "next"));
    main.append(pager);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
