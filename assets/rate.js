// Self-rating widget: rate yourself on each item, then get a short "start here" list.
// Usage: <script type="application/json" data-rate="unique-id">
//   { "levels": ["Strong", "Partial", "Thin"],
//     "items": [{ "label": "...", "detail": "...", "short": "Stage 1", "core": true }] }
// </script>
// The last level counts as a gap; the middle levels count as partial. Core gaps are
// listed first, then core partials; non-core items are only mentioned.
// Ratings save to localStorage under fde:rate:<id>.
(function () {
  function render(script) {
    const id = script.dataset.rate;
    const key = "fde:rate:" + id;
    const data = JSON.parse(script.textContent);
    const ratings = JSON.parse(localStorage.getItem(key) || "null") || data.items.map(() => null);
    const last = data.levels.length - 1;

    const host = document.createElement("div");
    host.className = "widget rate";
    const summary = document.createElement("p");
    summary.className = "summary";
    summary.setAttribute("aria-live", "polite");

    data.items.forEach((item, ii) => {
      const wrap = document.createElement("div");
      wrap.className = "item";
      wrap.innerHTML = `<p class="prompt"><span class="n">${ii + 1}/${data.items.length}</span><strong>${item.label}</strong>${
        item.core === false ? ' <span class="tag spec">specialist</span>' : ""
      }${item.detail ? `<br><span class="small">${item.detail}</span>` : ""}</p>`;
      const choices = document.createElement("div");
      choices.className = "choices row" + data.levels.length;
      choices.setAttribute("role", "group");
      choices.setAttribute("aria-label", item.label);

      data.levels.forEach((level, li) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        b.textContent = level;
        b.addEventListener("click", () => {
          ratings[ii] = li;
          localStorage.setItem(key, JSON.stringify(ratings));
          sync();
        });
        choices.appendChild(b);
      });
      wrap.appendChild(choices);
      host.appendChild(wrap);
    });

    function names(filter) {
      return data.items.filter((it, i) => filter(it, ratings[i])).map((it) => it.short || it.label);
    }

    function sync() {
      host.querySelectorAll(".item").forEach((wrap, ii) => {
        wrap.querySelectorAll("button.choice").forEach((b, li) => {
          const on = ratings[ii] === li;
          b.classList.toggle("picked", on);
          b.setAttribute("aria-pressed", String(on));
        });
      });
      const done = ratings.filter((r) => r !== null).length;
      if (done < ratings.length) {
        summary.innerHTML = `<span class="verdict">${done} of ${ratings.length} rated</span>Rate every row to see where to start.`;
        return;
      }
      const gaps = names((it, r) => it.core !== false && r === last);
      const partial = names((it, r) => it.core !== false && r > 0 && r < last);
      const later = names((it, r) => it.core === false && r === last);
      const parts = [];
      if (gaps.length) parts.push(`<strong>Start here:</strong> ${gaps.join(", ")}.`);
      if (partial.length) parts.push(`<strong>Then deepen:</strong> ${partial.join(", ")}.`);
      if (!gaps.length && !partial.length) parts.push("<strong>Every core stage is strong.</strong> Turn the evidence into deployment stories (section 6).");
      if (later.length) parts.push(`<strong>Can wait:</strong> ${later.join(", ")}, unless you target regulated or government roles.`);
      summary.innerHTML = `<span class="verdict">Your map</span>${parts.join(" ")}`;
    }

    const score = document.createElement("div");
    score.className = "score";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "tool";
    reset.textContent = "Clear ratings";
    reset.addEventListener("click", () => {
      ratings.fill(null);
      localStorage.removeItem(key);
      sync();
    });
    score.appendChild(reset);

    host.append(summary, score);
    script.after(host);
    sync();
  }

  document.querySelectorAll("script[data-rate]").forEach(render);
})();
