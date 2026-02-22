(function () {
  const DEFAULT_CLIENT = "demo";
  const FT_PER_METER = 3.28084;
  const MIN_SUBMIT_INTERVAL_MS = 15000;

  const state = {
    clientKey: DEFAULT_CLIENT,
    config: null,
    map: null,
    drawingManager: null,
    geocoder: null,
    addressMarker: null,
    polylines: [],
    drawMode: true,
    totalFeet: 0,
    priceLow: 0,
    priceHigh: 0,
    hasWarning: false,
    lastSubmitAt: 0,
  };

  const refs = {
    status: document.getElementById("globalStatus"),
    companyName: document.getElementById("companyName"),
    disclaimer: document.getElementById("disclaimer"),
    companyLogo: document.getElementById("companyLogo"),

    mapContainer: document.getElementById("mapContainer"),
    manualFeetWrap: document.getElementById("manualFeetWrap"),
    manualFeetInput: document.getElementById("manualFeetInput"),

    addressInput: document.getElementById("addressInput"),
    addressSearchBtn: document.getElementById("addressSearchBtn"),
    mapHint: document.getElementById("mapHint"),

    drawBtn: document.getElementById("drawBtn"),
    removeLastBtn: document.getElementById("removeLastBtn"),
    clearAllBtn: document.getElementById("clearAllBtn"),

    fenceType: document.getElementById("fenceType"),
    walkGateQty: document.getElementById("walkGateQty"),
    doubleGateQty: document.getElementById("doubleGateQty"),
    removeOldFence: document.getElementById("removeOldFence"),

    totalFeet: document.getElementById("totalFeet"),
    estimatedPrice: document.getElementById("estimatedPrice"),
    estimateBreakdown: document.getElementById("estimateBreakdown"),

    leadForm: document.getElementById("leadForm"),
    submitLeadBtn: document.getElementById("submitLeadBtn"),
    customerName: document.getElementById("customerName"),
    customerPhone: document.getElementById("customerPhone"),
    customerEmail: document.getElementById("customerEmail"),
    customerAddress: document.getElementById("customerAddress"),
    websiteTrap: document.getElementById("websiteTrap"),
  };

  init().catch((err) => {
    setStatus("Unexpected error loading widget.", true);
    console.error("Widget init error", err);
  });

  async function init() {
    state.clientKey = parseClientFromUrl();
    state.config = await loadClientConfig(state.clientKey);

    applyBranding(state.config);
    setupFenceTypes(state.config);
    wireUIEvents();

    const mapStarted = await maybeInitMap(state.config);
    if (!mapStarted) {
      refs.mapContainer.hidden = true;
      refs.manualFeetWrap.hidden = false;
    }

    recomputeAndRender();
    if (!state.hasWarning) {
      setStatus("Ready.", false);
    }
  }

  function parseClientFromUrl() {
    const raw = new URLSearchParams(window.location.search).get("client") || DEFAULT_CLIENT;
    const cleaned = String(raw).trim().toLowerCase();
    if (!cleaned) {
      return DEFAULT_CLIENT;
    }
    return cleaned.replace(/[^a-z0-9_-]/g, "");
  }

  function normalizeClientAlias(clientKey) {
    return String(clientKey || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9_-]/g, "");
  }

  async function loadClientConfig(clientKey) {
    const aliases = [normalizeClientAlias(clientKey), normalizeClientAlias(clientKey).replace(/[-_]/g, "")];
    for (const alias of [...new Set(aliases)]) {
      if (!alias) {
        continue;
      }
      const cfg = await fetchJson(`/config/${alias}.json`);
      if (cfg) {
        state.clientKey = alias;
        return cfg;
      }
    }

    if (clientKey !== DEFAULT_CLIENT) {
      setStatus(`Client '${clientKey}' not found. Falling back to '${DEFAULT_CLIENT}'.`, true);
      const fallback = await fetchJson(`/config/${DEFAULT_CLIENT}.json`);
      if (fallback) {
        state.clientKey = DEFAULT_CLIENT;
        return fallback;
      }
    }

    throw new Error("Unable to load client configuration");
  }

  async function fetchJson(path) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) {
        return null;
      }
      return await res.json();
    } catch (err) {
      console.warn("Failed to fetch", path, err);
      return null;
    }
  }

  function applyBranding(config) {
    refs.companyName.textContent = sanitizeText(config.company_name || "Fence Quote");
    refs.disclaimer.textContent = sanitizeText(config.disclaimer || "");

    const color = String(config.primary_color || "").trim();
    if (color) {
      document.documentElement.style.setProperty("--primary-color", color);
    }

    if (config.logo_url) {
      refs.companyLogo.src = config.logo_url;
      refs.companyLogo.hidden = false;
    }
  }

  function setupFenceTypes(config) {
    refs.fenceType.innerHTML = "";
    const options = getFenceTypesFromConfig(config);
    options.forEach((type) => {
      const opt = document.createElement("option");
      opt.value = type;
      opt.textContent = formatLabel(type);
      refs.fenceType.appendChild(opt);
    });
  }

  function getFenceTypesFromConfig(config) {
    const typesFromLegacy = Object.keys(config.pricing_per_ft || {});
    const typesFromAdvanced = Object.keys(config.pricing || {});
    const unique = [...new Set([...typesFromAdvanced, ...typesFromLegacy])].filter(Boolean);
    return unique.length ? unique : ["wood"];
  }

  function wireUIEvents() {
    refs.manualFeetInput.addEventListener("input", recomputeAndRender);
    refs.fenceType.addEventListener("change", recomputeAndRender);
    refs.walkGateQty.addEventListener("input", recomputeAndRender);
    refs.doubleGateQty.addEventListener("input", recomputeAndRender);
    refs.removeOldFence.addEventListener("change", recomputeAndRender);

    refs.addressSearchBtn.addEventListener("click", geocodeAddressFromInput);
    refs.addressInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        geocodeAddressFromInput();
      }
    });

    refs.drawBtn.addEventListener("click", toggleDrawMode);
    refs.removeLastBtn.addEventListener("click", removeLastSegment);
    refs.clearAllBtn.addEventListener("click", clearAllSegments);

    refs.leadForm.addEventListener("submit", submitLead);
  }

  async function maybeInitMap(config) {
    const maps = config.maps || {};
    if (!maps.enabled) {
      setStatus("Map disabled in tenant config. Using manual feet mode.", true);
      return false;
    }

    const apiKey = await resolveMapsApiKey(maps);
    if (!apiKey) {
      setStatus("Map disabled: missing Google Maps API key. Using manual feet mode.", true);
      return false;
    }

    try {
      await loadGoogleMapsApi(apiKey);
      initMap(maps);
      refs.mapContainer.hidden = false;
      refs.manualFeetWrap.hidden = true;
      return true;
    } catch (err) {
      console.error(err);
      setStatus(`Google Maps failed to load. Using manual mode. (${err.message || "unknown"})`, true);
      return false;
    }
  }

  async function resolveMapsApiKey(mapsConfig) {
    const fromWindow = String(window.FENCE_GOOGLE_MAPS_API_KEY || "").trim();
    const fromQuery = String(new URLSearchParams(window.location.search).get("gmapsKey") || "").trim();
    const fromClient = String(mapsConfig.google_maps_api_key || "").trim();
    if (fromWindow) return fromWindow;
    if (fromQuery) return fromQuery;
    if (fromClient) return fromClient;

    const demoCfg = await fetchJson(`/config/${DEFAULT_CLIENT}.json`);
    return String(demoCfg?.maps?.google_maps_api_key || "").trim();
  }

  function loadGoogleMapsApi(apiKey) {
    if (window.google && window.google.maps && window.google.maps.drawing) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-google-maps-loader]");
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
        apiKey
      )}&libraries=drawing,geometry,places`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMapsLoader = "true";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Google Maps script load failed"));
      document.head.appendChild(script);
    });
  }

  function initMap(mapsConfig) {
    const center = mapsConfig.default_center || { lat: 40.7608, lng: -111.8910 };
    const zoom = Number.isFinite(mapsConfig.default_zoom) ? mapsConfig.default_zoom : 19;

    state.map = new google.maps.Map(document.getElementById("map"), {
      center,
      zoom,
      mapTypeId: google.maps.MapTypeId.SATELLITE,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      rotateControl: false,
      tilt: 0,
      heading: 0,
      gestureHandling: "greedy",
    });
    state.map.setTilt(0);

    state.geocoder = new google.maps.Geocoder();
    setupAddressAutocomplete();

    state.drawingManager = new google.maps.drawing.DrawingManager({
      drawingMode: google.maps.drawing.OverlayType.POLYLINE,
      drawingControl: false,
      polylineOptions: {
        strokeColor: state.config.primary_color || "#1f7a8c",
        strokeOpacity: 0.95,
        strokeWeight: 4,
        editable: true,
        geodesic: true,
      },
    });
    state.drawingManager.setMap(state.map);
    refs.drawBtn.classList.add("active");

    google.maps.event.addListener(state.drawingManager, "polylinecomplete", (polyline) => {
      polyline.setEditable(true);
      wirePolylineEvents(polyline);
      state.polylines.push(polyline);
      recomputeAndRender();
      if (state.drawMode) {
        state.drawingManager.setDrawingMode(google.maps.drawing.OverlayType.POLYLINE);
      }
    });
  }

  function setupAddressAutocomplete() {
    if (!google.maps.places || !refs.addressInput) {
      return;
    }

    const autocomplete = new google.maps.places.Autocomplete(refs.addressInput, {
      fields: ["formatted_address", "geometry", "name"],
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place?.geometry?.location) {
        return;
      }
      refs.customerAddress.value = place.formatted_address || refs.addressInput.value;
      focusMapOnProperty(place.geometry.location, place.formatted_address || place.name || "Property", place.geometry.viewport);
      setStatus("Address located. Start drawing fence segments.", false);
    });
  }

  function geocodeAddressFromInput() {
    if (!state.geocoder || !state.map) {
      setStatus("Map is unavailable, address lookup is disabled.", true);
      return;
    }

    const address = String(refs.addressInput.value || "").trim();
    if (!address) {
      setStatus("Please enter a property address.", true);
      return;
    }

    setStatus("Locating address...", false);
    state.geocoder.geocode({ address, region: "us" }, (results, status) => {
      if (status !== "OK" || !results?.length || !results[0].geometry?.location) {
        setStatus("Address not found. Try a fuller street address.", true);
        return;
      }

      const result = results[0];
      refs.addressInput.value = result.formatted_address;
      refs.customerAddress.value = result.formatted_address;
      focusMapOnProperty(result.geometry.location, result.formatted_address, result.geometry.viewport);

      if (result.geometry.location_type && result.geometry.location_type !== "ROOFTOP") {
        setStatus("Address found with approximate location. You can adjust by dragging points.", true);
      } else {
        setStatus("Address located. Start drawing fence segments.", false);
      }
    });
  }

  function focusMapOnProperty(location, title, viewport) {
    if (viewport) {
      state.map.fitBounds(viewport);
      const currentZoom = state.map.getZoom() || 20;
      state.map.setZoom(Math.max(currentZoom, 20));
    } else {
      state.map.panTo(location);
      state.map.setZoom(21);
    }
    state.map.setTilt(0);

    if (state.addressMarker) {
      state.addressMarker.setMap(null);
    }

    state.addressMarker = new google.maps.Marker({
      map: state.map,
      position: location,
      title: sanitizeText(title || "Property"),
    });
  }

  function toggleDrawMode() {
    if (!state.drawingManager) {
      return;
    }

    state.drawMode = !state.drawMode;
    refs.drawBtn.classList.toggle("active", state.drawMode);
    refs.drawBtn.textContent = state.drawMode ? "Pause Draw" : "Resume Draw";

    state.drawingManager.setDrawingMode(
      state.drawMode ? google.maps.drawing.OverlayType.POLYLINE : null
    );
  }

  function removeLastSegment() {
    const last = state.polylines.pop();
    if (!last) {
      return;
    }
    last.setMap(null);
    recomputeAndRender();
  }

  function clearAllSegments() {
    state.polylines.forEach((line) => line.setMap(null));
    state.polylines = [];
    recomputeAndRender();
  }

  function wirePolylineEvents(polyline) {
    polyline.addListener("rightclick", () => {
      polyline.setMap(null);
      state.polylines = state.polylines.filter((line) => line !== polyline);
      recomputeAndRender();
    });

    const path = polyline.getPath();
    ["insert_at", "set_at", "remove_at"].forEach((eventName) => {
      google.maps.event.addListener(path, eventName, recomputeAndRender);
    });
  }

  function getCurrentLinearFeet() {
    const mapFeet = computeFeetFromSegments();
    const manualFeet = toPositiveNumber(refs.manualFeetInput.value);
    return mapFeet > 0 ? mapFeet : manualFeet;
  }

  function computeFeetFromSegments() {
    if (!window.google?.maps?.geometry) {
      return 0;
    }
    let totalMeters = 0;
    state.polylines.forEach((polyline) => {
      const path = polyline.getPath();
      if (path.getLength() < 2) return;
      totalMeters += google.maps.geometry.spherical.computeLength(path);
    });
    return Number((totalMeters * FT_PER_METER).toFixed(1));
  }

  function getPriceConfigForType(type) {
    const pricingAdvanced = state.config.pricing?.[type];
    if (pricingAdvanced) {
      return {
        low: toPositiveNumber(pricingAdvanced.price_per_ft_low),
        high: toPositiveNumber(pricingAdvanced.price_per_ft_high || pricingAdvanced.price_per_ft_low),
      };
    }

    const legacy = state.config.pricing_per_ft?.[type];
    if (typeof legacy === "number") {
      return { low: legacy, high: legacy };
    }
    return {
      low: toPositiveNumber(legacy?.low),
      high: toPositiveNumber(legacy?.high || legacy?.low),
    };
  }

  function getAddonsConfig() {
    const raw = state.config.add_ons || {};
    return {
      walkGate: {
        low: toPositiveNumber(raw.walk_gate?.low ?? raw.walk_gate_low),
        high: toPositiveNumber(raw.walk_gate?.high ?? raw.walk_gate_high ?? raw.walk_gate?.low ?? raw.walk_gate_low),
      },
      doubleGate: {
        low: toPositiveNumber(raw.double_gate?.low ?? raw.drive_gate?.low ?? raw.double_gate_low),
        high: toPositiveNumber(
          raw.double_gate?.high ?? raw.drive_gate?.high ?? raw.double_gate_high ?? raw.double_gate?.low ?? raw.drive_gate?.low
        ),
      },
      removeOldFencePerFt: {
        low: toPositiveNumber(raw.remove_old_fence_per_ft?.low ?? raw.removal_fee_per_ft?.low),
        high: toPositiveNumber(
          raw.remove_old_fence_per_ft?.high ?? raw.removal_fee_per_ft?.high ?? raw.remove_old_fence_per_ft?.low ?? raw.removal_fee_per_ft?.low
        ),
      },
    };
  }

  function computeEstimate() {
    const fenceType = refs.fenceType.value;
    const feet = getCurrentLinearFeet();
    const perFt = getPriceConfigForType(fenceType);
    const addons = getAddonsConfig();

    const walkQty = toPositiveInt(refs.walkGateQty.value);
    const doubleQty = toPositiveInt(refs.doubleGateQty.value);
    const removalEnabled = refs.removeOldFence.checked;

    const materialLow = perFt.low * feet;
    const materialHigh = perFt.high * feet;

    const walkLow = addons.walkGate.low * walkQty;
    const walkHigh = addons.walkGate.high * walkQty;

    const doubleLow = addons.doubleGate.low * doubleQty;
    const doubleHigh = addons.doubleGate.high * doubleQty;

    const removalLow = removalEnabled ? addons.removeOldFencePerFt.low * feet : 0;
    const removalHigh = removalEnabled ? addons.removeOldFencePerFt.high * feet : 0;

    const totalLow = materialLow + walkLow + doubleLow + removalLow;
    const totalHigh = materialHigh + walkHigh + doubleHigh + removalHigh;

    return {
      fenceType,
      feet,
      totalLow,
      totalHigh,
      breakdown: { materialLow, materialHigh, walkLow, walkHigh, doubleLow, doubleHigh, removalLow, removalHigh },
      gatesSelected: { walk_gate: walkQty, double_gate: doubleQty },
      removalSelected: removalEnabled,
    };
  }

  function recomputeAndRender() {
    const estimate = computeEstimate();

    state.totalFeet = estimate.feet;
    state.priceLow = estimate.totalLow;
    state.priceHigh = estimate.totalHigh;

    refs.totalFeet.textContent = `${formatNumber(estimate.feet)} ft`;
    refs.estimatedPrice.textContent = `${formatCurrency(estimate.totalLow)} - ${formatCurrency(estimate.totalHigh)}`;

    refs.estimateBreakdown.innerHTML = [
      `Material: ${formatCurrency(estimate.breakdown.materialLow)} - ${formatCurrency(estimate.breakdown.materialHigh)}`,
      `Walk gates: ${formatCurrency(estimate.breakdown.walkLow)} - ${formatCurrency(estimate.breakdown.walkHigh)}`,
      `Double gates: ${formatCurrency(estimate.breakdown.doubleLow)} - ${formatCurrency(estimate.breakdown.doubleHigh)}`,
      `Removal: ${formatCurrency(estimate.breakdown.removalLow)} - ${formatCurrency(estimate.breakdown.removalHigh)}`,
      `Segments: ${state.polylines.length}`,
    ]
      .map((line) => `<div>${line}</div>`)
      .join("");
  }

  function buildCoordinatesArray() {
    return state.polylines.map((polyline) => {
      const points = [];
      polyline.getPath().forEach((latLng) => {
        points.push({ lat: Number(latLng.lat().toFixed(7)), lng: Number(latLng.lng().toFixed(7)) });
      });
      return points;
    });
  }

  async function submitLead(event) {
    event.preventDefault();

    const now = Date.now();
    if (now - state.lastSubmitAt < MIN_SUBMIT_INTERVAL_MS) {
      setStatus("Please wait a few seconds before resubmitting.", true);
      return;
    }

    if (String(refs.websiteTrap.value || "").trim()) {
      setStatus("Submission blocked.", true);
      return;
    }

    const name = String(refs.customerName.value || "").trim();
    const phone = String(refs.customerPhone.value || "").trim();
    const email = String(refs.customerEmail.value || "").trim();
    const propertyAddress = String(refs.customerAddress.value || refs.addressInput.value || "").trim();

    if (!name || !phone || !isValidEmail(email) || !propertyAddress) {
      setStatus("Please complete all lead fields with a valid email.", true);
      return;
    }

    const estimate = computeEstimate();
    const payload = {
      client_key: state.clientKey,
      company_name: state.config.company_name || "",
      fence_type: estimate.fenceType,
      total_linear_feet: Number(estimate.feet.toFixed(1)),
      price_low: Math.round(estimate.totalLow),
      price_high: Math.round(estimate.totalHigh),
      gates_selected: estimate.gatesSelected,
      removal_selected: estimate.removalSelected,
      customer_name: name,
      customer_phone: phone,
      customer_email: email,
      property_address: propertyAddress,
      drawing_coordinates_array: buildCoordinatesArray(),
      submitted_at: new Date().toISOString(),
    };

    const webhookUrl = String(state.config.webhook_url || "").trim();
    if (!webhookUrl) {
      setStatus("Webhook URL is not configured for this client.", true);
      return;
    }

    refs.submitLeadBtn.disabled = true;
    refs.submitLeadBtn.textContent = "Sending...";

    try {
      await postJsonWithTimeout(webhookUrl, payload, 12000);
      state.lastSubmitAt = now;
      setStatus("Lead submitted successfully.", false);
      refs.leadForm.reset();
      refs.customerAddress.value = refs.addressInput.value;
    } catch (err) {
      console.error("Webhook submit failed", err);
      setStatus("Failed to submit lead. Please try again.", true);
    } finally {
      refs.submitLeadBtn.disabled = false;
      refs.submitLeadBtn.textContent = "Send Quote Request";
    }
  }

  async function postJsonWithTimeout(url, payload, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function setStatus(message, isWarning) {
    if (isWarning) {
      state.hasWarning = true;
    }
    refs.status.textContent = message;
    refs.status.style.borderLeftColor = isWarning ? "#c48211" : "var(--primary-color)";
  }

  function sanitizeText(value) {
    return String(value || "").replace(/[<>]/g, "");
  }

  function formatLabel(raw) {
    return String(raw || "")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  function toPositiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function toPositiveInt(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
      value || 0
    );
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value || 0);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
  }
})();
