// Practice widget: a short writing task with a self-check list.
// Usage: <script type="application/json" data-practice="unique-id">
//   { "title": "...", "fields": [{ "key": "k", "label": "...", "hint": "..." }], "checks": ["...", ...] }
// </script>
// Text and ticks autosave to localStorage under fde:practice:<id>.
// "Copy as Markdown" puts the answer on the clipboard, ready to paste into a discussion or your notes.
(function () {
  function render(script) {
    const id = script.dataset.practice;
    const key = "fde:practice:" + id;
    const data = JSON.parse(script.textContent);
    const saved = JSON.parse(localStorage.getItem(key) || "{}");
    saved.fields = saved.fields || {};
    saved.checks = saved.checks || [];

    const host = document.createElement("div");
    host.className = "widget practice";
    const persist = () => localStorage.setItem(key, JSON.stringify(saved));

    data.fields.forEach((f) => {
      const label = document.createElement("label");
      label.className = "field";
      label.htmlFor = `${id}-${f.key}`;
      label.innerHTML = `${f.label}${f.hint ? `<span class="hint">${f.hint}</span>` : ""}`;
      const ta = document.createElement("textarea");
      ta.id = `${id}-${f.key}`;
      ta.value = saved.fields[f.key] || "";
      ta.addEventListener("input", () => {
        saved.fields[f.key] = ta.value;
        persist();
        count();
      });
      host.append(label, ta);
    });

    const meter = document.createElement("p");
    meter.className = "meter";
    host.appendChild(meter);
    function count() {
      const words = data.fields
        .map((f) => (saved.fields[f.key] || "").trim().split(/\s+/).filter(Boolean).length)
        .reduce((a, b) => a + b, 0);
      meter.textContent = `${words} words` + (data.maxWords ? ` (aim for ${data.maxWords} or fewer)` : "");
    }

    if (data.checks && data.checks.length) {
      const ul = document.createElement("ul");
      ul.className = "checks";
      data.checks.forEach((c, ci) => {
        const li = document.createElement("li");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.id = `${id}-check-${ci}`;
        cb.checked = !!saved.checks[ci];
        cb.addEventListener("change", () => {
          saved.checks[ci] = cb.checked;
          persist();
        });
        const l = document.createElement("label");
        l.htmlFor = cb.id;
        l.innerHTML = c;
        li.append(cb, l);
        ul.appendChild(li);
      });
      host.appendChild(ul);
    }

    const bar = document.createElement("div");
    bar.className = "score";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "tool";
    copy.textContent = "Copy as Markdown";
    copy.addEventListener("click", async () => {
      const md =
        `## ${data.title}\n\n` +
        data.fields.map((f) => `**${f.label}**\n${(saved.fields[f.key] || "").trim()}\n`).join("\n");
      try {
        await navigator.clipboard.writeText(md);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed: select the text by hand";
      }
      setTimeout(() => (copy.textContent = "Copy as Markdown"), 1800);
    });
    bar.appendChild(copy);
    host.appendChild(bar);

    script.after(host);
    count();
  }

  document.querySelectorAll("script[data-practice]").forEach(render);
})();
