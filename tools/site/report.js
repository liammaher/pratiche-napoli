// Sends the report form as JSON and shows the answer in place. The body goes
// as text/plain, which needs no CORS preflight; without JavaScript the form
// posts normally and the backend redirects to /grazie/.
(() => {
  const form = document.querySelector("form[data-report]");
  if (!form) return;
  const status = form.querySelector(".status");
  const section = form.elements["claim_feedback[0][section]"];

  // The page lists the months up to when it was built; add any since then,
  // up to this month in Rome, as the backend counts them (not the browser's).
  const done = form.elements.done;
  const label = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric", timeZone: "UTC" });
  const newest = done.options[1]?.value;
  const [year, month] = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" })
    .format(new Date())
    .split("-")
    .map(Number);
  // Newest first, each one after the last added, before the built list.
  let at = 1;
  for (let d = new Date(Date.UTC(year, month - 1, 1)); newest; d.setUTCMonth(d.getUTCMonth() - 1)) {
    const value = d.toISOString().slice(0, 7);
    if (value <= newest) break;
    done.insertBefore(new Option(label.format(d), value), done.options[at++]);
  }
  // And drop those that have since left the last 12 months, which the backend refuses.
  const oldest = new Date(Date.UTC(year, month - 12, 1)).toISOString().slice(0, 7);
  for (const option of [...done.options]) if (option.value && option.value < oldest) option.remove();

  // "Segnala" links (and a shared ?sezione= link) preset the part of the page
  // the report is about. The links point at #racconta, so nothing reloads.
  const preset = (id) => {
    if ([...section.options].some((o) => o.value === id)) section.value = id;
  };
  const fromUrl = new URLSearchParams(location.search).get("sezione");
  if (fromUrl) preset(fromUrl);
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[data-section]");
    if (link) preset(link.dataset.section);
  });

  // Picking an office presets how it was done, when the page knows.
  form.elements.office.addEventListener("change", (e) => {
    const type = e.target.selectedOptions[0]?.dataset.type;
    if (type) form.elements.channel.value = type;
  });

  // The same fields the backend reads from a plain form post, as JSON.
  const toReport = (data) => {
    const report = {};
    const documents = [];
    const feedback = {};
    for (const [key, raw] of data) {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) continue;
      let m;
      if ((m = key.match(/^documents\[(\d+)\]\[(name|asked)\]$/))) {
        (documents[m[1]] ??= {})[m[2]] = m[2] === "asked" ? value === "si" : value;
      } else if ((m = key.match(/^claim_feedback\[0\]\[(section|verdict|text)\]$/))) {
        feedback[m[1]] = value;
      } else if (key === "days_to_answer" || key === "desk_wait_minutes") {
        report[key] = Number(value);
      } else if (key === "paid_eur") {
        // As the backend reads a plain post: 1.250 or 1.250,50 is a thousand
        // and more; otherwise a comma or a dot is the decimal point.
        report[key] = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(value)
          ? Number(value.replace(/\./g, "").replace(",", "."))
          : Number(value.replace(",", "."));
      } else if (key === "consent_contact") {
        report[key] = true;
      } else {
        report[key] = value;
      }
    }
    const asked = documents.filter((d) => d && "asked" in d);
    if (asked.length) report.documents = asked;
    // As the backend does for a plain post: a correction isn't lost for a
    // missing choice. No section means the whole page; text with no verdict
    // says what was found instead.
    if (feedback.verdict || feedback.text) report.claim_feedback = [{ section: "pagina", verdict: "sbagliata", ...feedback }];
    return report;
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const report = toReport(new FormData(form));
    if (report.contact_email && !report.consent_contact) {
      status.textContent = "Per lasciare l'email spunta la casella che ci permette di scriverti, oppure cancellala.";
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = "Invio in corso…";
    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(report),
      });
      if (res.ok) {
        const { id } = await res.json().catch(() => ({}));
        form.replaceChildren();
        const done = document.createElement("p");
        done.textContent = "Grazie! Il tuo racconto è arrivato: lo leggiamo prima di usarlo per aggiornare la pagina.";
        form.append(done);
        if (id) {
          const code = document.createElement("p");
          code.textContent = `Il codice del tuo racconto è ${id}: conservalo se vorrai chiederci di vederlo o cancellarlo.`;
          form.append(code);
        }
        return;
      }
      const answer = await res.json().catch(() => ({}));
      status.textContent = answer.message ?? "Non siamo riusciti a inviare il racconto: riprova più tardi.";
    } catch {
      status.textContent = "Non siamo riusciti a inviare il racconto: controlla la connessione e riprova.";
    }
    button.disabled = false;
  });
})();
