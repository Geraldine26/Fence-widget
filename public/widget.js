(() => {
  const SCRIPT = document.currentScript;
  const urlClient = new URLSearchParams(window.location.search).get("client");
  const CLIENT = (urlClient || SCRIPT?.dataset?.client || "demo").trim();
  const ROOT = document.getElementById("fence-quote");

  if (!ROOT) return;

  async function loadConfig() {
    try {
      const res = await fetch(`/config/${CLIENT}.json`);
      if (!res.ok) throw new Error("Config not found");
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

    // Set primary color dynamically
    document.documentElement.style.setProperty(
      "--qw-primary",
      config.primary_color || "#16a34a"
    );

    ROOT.innerHTML = `
      <div class="qw">
        <div class="qw-topbar">
          <div class="qw-brand">
            <div class="qw-logo">
              ${config.logo_url ? `<img src="${config.logo_url}" />` : ""}
            </div>
            <div>
              <h2>${config.company_name}</h2>
              <p>Instant Fence Estimate</p>
            </div>
          </div>
        </div>

        <div class="qw-grid">
          <div class="qw-map">
            <div style="color:white;padding:20px;">
              Map will go here (Google Maps next step)
            </div>
          </div>

          <div class="qw-panel">
            <div class="qw-section">
              <div class="qw-label">Fence Type</div>
              <select class="qw-select" id="fenceType">
                ${Object.keys(config.pricing).map(type => `
                  <option value="${type}">${type}</option>
                `).join("")}
              </select>
            </div>

            <div class="qw-section">
              <div class="qw-label">Estimated Linear Feet</div>
              <input class="qw-input" id="linearFeet" type="number" placeholder="Enter feet" />
            </div>

            <div class="qw-section">
              <div class="qw-row">
                <div>Total Estimate</div>
                <div class="qw-value" id="total">$0</div>
              </div>
            </div>

            <button class="qw-btn" id="calculateBtn">Calculate</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById("calculateBtn").addEventListener("click", () => {
      const type = document.getElementById("fenceType").value;
      const feet = parseFloat(document.getElementById("linearFeet").value || 0);
      const price = config.pricing[type]?.per_ft || 0;
      const total = feet * price;

      document.getElementById("total").innerText =
        "$" + total.toLocaleString();
    });
  }

  loadConfig().then(render);
})();
