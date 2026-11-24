// Section rail: a fixed column of ticks in the right gutter, one per numbered section.
// Idle, every tick is a dot. While the page scrolls, or the pointer or focus is in the
// gutter, they grow into lines. Hover a tick for the section's title; click it and the
// page glides there. The left gutter's scroll ring is the way back to the top, so there
// is no "Top" tick. Desktop with a real pointer only: below 1024px the gutter is too
// narrow, and a tick rail has no place on touch.
(function () {
  const RAIL_MEDIA = "(min-width: 1024px) and (hover: hover) and (pointer: fine)";
  // px from the window's top. A section is current once its heading crosses this line.
  // Deeper than the 2.5rem the headings land at, so a jump never hands the tick back.
  const ACTIVE_LINE = 120;
  // Extra hold after scrolling stops or the pointer leaves, before the ticks shrink.
  const HOLD_MS = 600;
  // The glide: 1.4s, ease-out cubic.
  const JUMP_MS = 1400;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  // The dot-to-line change ripples outward from the current tick, this much per step.
  const TICK_STAGGER_MS = 25;
  // Gap between a tick and its label.
  const TIP_OFFSET = 8;

  const reduce = matchMedia("(prefers-reduced-motion: reduce)");

  let teardown = null;

  function mount() {
    const headings = [...document.querySelectorAll("main h2[id]")];
    if (headings.length === 0) return;

    const ac = new AbortController();
    const on = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });

    const rail = document.createElement("div");
    rail.className = "section-rail";
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Sections");
    const list = document.createElement("ol");
    nav.appendChild(list);
    rail.appendChild(nav);

    const ticks = headings.map((h) => {
      const label = h.textContent.replace(/\s+/g, " ").trim();
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "rail-tick";
      a.href = `#${h.id}`;
      a.setAttribute("aria-label", label);
      const bar = document.createElement("span");
      bar.className = "rail-bar";
      bar.setAttribute("aria-hidden", "true");
      a.appendChild(bar);
      li.appendChild(a);
      list.appendChild(li);
      return { heading: h, label, a, bar };
    });

    // One shared label. The tick's aria-label already names it, so it is hidden from
    // screen readers.
    const tip = document.createElement("div");
    tip.className = "rail-tip";
    tip.setAttribute("aria-hidden", "true");

    document.body.append(rail, tip);

    // ---- Current section ----

    let activeIndex = -1;

    // Each tick's width change waits |i - current| steps, so the change spreads out
    // from the current tick.
    const setDelays = () => {
      const from = Math.max(0, activeIndex);
      ticks.forEach((t, i) => t.bar.style.setProperty("--delay", `${Math.abs(i - from) * TICK_STAGGER_MS}ms`));
    };

    // The last heading that has crossed the line, or the last section once the page
    // bottoms out (a short final section never reaches the line). Above the first
    // heading, nothing is current.
    const spy = () => {
      const limit = document.documentElement.scrollHeight - innerHeight;
      const scroll = Math.max(0, Math.min(scrollY, limit));
      let next = -1;
      if (limit > 0 && scroll >= limit - 2) {
        next = ticks.length - 1;
      } else {
        ticks.forEach((t, i) => {
          if (t.heading.getBoundingClientRect().top <= ACTIVE_LINE) next = i;
        });
      }
      if (next === activeIndex) return;
      activeIndex = next;
      setDelays();
      ticks.forEach((t, i) => {
        if (i === next) t.a.setAttribute("aria-current", "true");
        else t.a.removeAttribute("aria-current");
      });
    };

    let frame = 0;
    const scheduleSpy = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        spy();
      });
    };

    // ---- Expanded: scrolling, or pointer / focus in the gutter ----

    let hovering = false;
    let focusWithin = false;
    let scrolling = false;
    let hold = 0;

    const sync = () => {
      const expanded = hovering || focusWithin || scrolling;
      if (expanded === rail.hasAttribute("data-expanded")) return;
      setDelays();
      if (expanded) rail.dataset.expanded = "";
      else delete rail.dataset.expanded;
    };
    const armHold = () => {
      clearTimeout(hold);
      hold = setTimeout(() => {
        scrolling = false;
        sync();
      }, HOLD_MS);
    };

    // Only a real change of position counts as scrolling, so a reload mid-page (the
    // browser restoring the scroll) does not pop the rail open.
    let lastScroll = scrollY;
    on(window, "scroll", () => {
      scheduleSpy();
      if (scrollY === lastScroll) return;
      lastScroll = scrollY;
      if (!scrolling) {
        scrolling = true;
        sync();
      }
      armHold();
    }, { passive: true });
    on(window, "resize", scheduleSpy);
    // Widgets render after load and move the headings without any scroll.
    const ro = new ResizeObserver(scheduleSpy);
    ro.observe(document.documentElement);

    on(rail, "pointerenter", () => {
      hovering = true;
      sync();
    });
    on(rail, "pointerleave", () => {
      hovering = false;
      armHold();
    });
    on(rail, "focusin", () => {
      focusWithin = true;
      sync();
    });
    on(rail, "focusout", (e) => {
      if (rail.contains(e.relatedTarget)) return;
      focusWithin = false;
      armHold();
    });

    // ---- Label ----

    let hideTimer = 0;
    const showTip = (t) => {
      clearTimeout(hideTimer);
      // Already open on another tick: it moves there without fading again.
      tip.textContent = t.label;
      const r = t.a.getBoundingClientRect();
      tip.style.left = `${r.left - TIP_OFFSET}px`;
      tip.style.top = `${r.top + r.height / 2}px`;
      tip.dataset.open = "";
    };
    // A short grace period, so moving from one tick to the next does not close it.
    const hideTip = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => delete tip.dataset.open, 40);
    };

    // ---- Jump ----

    let glide = 0;
    const stopGlide = () => {
      cancelAnimationFrame(glide);
      glide = 0;
    };
    // Any scroll input of the reader's own ends the glide.
    ["wheel", "touchmove", "keydown"].forEach((type) => on(window, type, stopGlide, { passive: true }));

    const jumpTo = (t) => {
      stopGlide();
      const margin = parseFloat(getComputedStyle(t.heading).scrollMarginTop) || 0;
      const limit = document.documentElement.scrollHeight - innerHeight;
      const from = scrollY;
      const to = Math.max(0, Math.min(t.heading.getBoundingClientRect().top + scrollY - margin, limit));
      const start = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - start) / JUMP_MS);
        scrollTo(0, from + (to - from) * easeOut(p));
        glide = p < 1 ? requestAnimationFrame(step) : 0;
      };
      glide = requestAnimationFrame(step);
      history.pushState(null, "", `#${t.heading.id}`);
    };

    ticks.forEach((t) => {
      on(t.a, "pointerenter", () => showTip(t));
      on(t.a, "pointerleave", hideTip);
      on(t.a, "focus", () => {
        if (t.a.matches(":focus-visible")) showTip(t);
      });
      on(t.a, "blur", hideTip);
      on(t.a, "click", (e) => {
        hideTip();
        // Reduced motion: the browser's own instant jump (it honours scroll-margin).
        if (reduce.matches) return;
        e.preventDefault();
        jumpTo(t);
      });
    });

    spy();

    teardown = () => {
      ac.abort();
      ro.disconnect();
      stopGlide();
      cancelAnimationFrame(frame);
      clearTimeout(hold);
      clearTimeout(hideTimer);
      rail.remove();
      tip.remove();
      teardown = null;
    };
  }

  function start() {
    const media = matchMedia(RAIL_MEDIA);
    const apply = () => {
      if (media.matches && !teardown) mount();
      else if (!media.matches && teardown) teardown();
    };
    apply();
    media.addEventListener("change", apply);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
