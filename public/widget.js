(() => {
  const SCRIPT = document.currentScript;
  const urlClient = new URLSearchParams(window.location.search).get("client");
  const CLIENT = (urlClient || SCRIPT?.dataset?.client || "demo").trim();
  const ROOT = document.getElementById("fence-quote");

  if (!ROOT) return;

  async function loadConfig() {
    try {
      const res = await fetch(`/config/${CLIENT}.json`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Config not found: ${CLIENT}`);
      return await res.json();
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  function render(config) {
    if (!config) {
      ROOT.innerHTML = "<p style='padding:20px'>Config not found.</p>";
      return;
    }

    // ✅ White-label demo page title/subtitle
    const t = document.getElementById("pageTitle");
    const s = document.getElementById("pageSubtitle");
    if (t) t.textContent = config.company_name || "Instant Fence Estimate";
    if (s) s.textContent = config.disclaimer || "";

    // ✅ Set primary color dynamically (keeps your existing variable)
    document.documentElement.style.setProperty(
      "--qw-primary",
      config.primary_color || "#16a34a"
    );

    ROOT.innerHTML = `
      <div class="qw">
        <div class="qw-topbar">
          <div class="qw-brand">
            <div class="qw-logo">
              ${
                config.logo_url
                  ? `<img src="${config.logo_url}" alt="Logo" />`
                  : ""
              }
            </div>
            <div class="qw-brand-text">
              <div class="qw-company">${config.company_name || ""}</div>
              <div class="qw-tagline">${config.tagline || "Instant Fence Estimate"}</div>
            </div>
          </div>
        </div>

        <div class="qw-grid">
          <div class="qw-map">
            <div class="qw-map-placeholder">
              Map will go here (Google Maps next step)
            </div>
          </div>

          <div class="qw-panel">
            <label class="qw-label">Fence Type</label>
            <select id="qwFenceType" class="qw-input">
              ${(config.fence_types || ["chainlink", "vinyl", "wood"])
                .map((t) => `<option value="${t}">${t}</option>`)
                .join("")}
            </select>

            <label class="qw-label" style="margin-top:14px;">Estimated Linear Feet</label>
            <input id="qwFeet" class="qw-input" type="number" min="0" placeholder="Enter feet" />

            <div class="qw-total">
              <span>Total Estimate</span>
              <strong id="qwTotal">$0</strong>
            </div>

            <button id="qwCalc" class="qw-btn">Calculate</button>
          </div>
        </div>
      </div>
    `;

    // --- Simple calculator demo ---
    const fenceTypeEl = document.getElementById("qwFenceType");
    const feetEl = document.getElementById("qwFeet");
    const totalEl = document.getElementById("qwTotal");
    const btnEl = document.getElementById("qwCalc");

    function money(n) {
      const v = Number(n || 0);
      return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
    }

    function calc() {
      const feet = Number(feetEl.value || 0);
      const type = fenceTypeEl.value;

      const pricing = config.pricing_per_ft || {};
      const perFt = Number(pricing[type] ?? pricing.default ?? 0);

      const total = feet * perFt;
      totalEl.textContent = money(total);
    }

    btnEl.addEventListener("click", calc);
  }

  (async () => {
    const cfg = await loadConfig();
    render(cfg);
  })();
})();
