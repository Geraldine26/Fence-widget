(function () {
  const DEFAULT_CLIENT = "demo";
  const FT_PER_METER = 3.28084;

  const state = {
    clientKey: DEFAULT_CLIENT,
    config: null,
    map: null,
    geocoder: null,
    addressMarker: null,
    segments: [],
    activeSegment: null,
    addressReady: false,
    totalFeet: 0,
    estimateMin: 0,
    estimateMax: 0,
    hasWarning: false,
    optionsConfirmed: false,
    overlayOpen: false,
  };

  const refs = {
    status: document.getElementById("globalStatus"),
    companyName: document.getElementById("companyName"),
    tagline: document.getElementById("tagline"),
    companyLogo: document.getElementById("companyLogo"),

    mapContainer: document.getElementById("mapContainer"),
    mapHint: document.getElementById("mapHint"),
    manualFeetWrap: document.getElementById("manualFeetWrap"),
    manualFeetInput: document.getElementById("manualFeetInput"),

    addressInput: document.getElementById("addressInput"),
    addressSearchBtn: document.getElementById("addressSearchBtn"),

    removeLastBtn: document.getElementById("removeLastBtn"),
    clearAllBtn: document.getElementById("clearAllBtn"),

    estimatePanel: document.getElementById("estimatePanel"),
    estimateOptions: document.getElementById("estimateOptions"),
    fenceType: document.getElementById("fenceType"),
    walkGateQty: document.getElementById("walkGateQty"),
    doubleGateQty: document.getElementById("doubleGateQty"),
    walkGateMinus: document.getElementById("walkGateMinus"),
    walkGatePlus: document.getElementById("walkGatePlus"),
    doubleGateMinus: document.getElementById("doubleGateMinus"),
    doubleGatePlus: document.getElementById("doubleGatePlus"),
    removeOldFence: document.getElementById("removeOldFence"),

    totalFeet: document.getElementById("totalFeet"),
    estimatedPrice: document.getElementById("estimatedPrice"),
    estimateBreakdown: document.getElementById("estimateBreakdown"),

    leadToggleBtn: document.getElementById("leadToggleBtn"),
    quoteSuccess: document.getElementById("quoteSuccess"),

    mobileSummaryBar: document.getElementById("mobileSummaryBar"),
    mobileSummaryText: document.getElementById("mobileSummaryText"),
    mobileLeadCta: document.getElementById("mobileLeadCta"),

    quoteOverlay: document.getElementById("quoteOverlay"),
    quoteBackdrop: document.getElementById("quoteBackdrop"),
    quoteCloseBtn: document.getElementById("quoteCloseBtn"),

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
    state.clientKey = getClientKey();
    state.config = await loadClientConfig(state.clientKey);

    applyBranding(state.config);
    setupEstimateInputs();
    wireEvents();

    const mapReady = await initMapIfEnabled(state.config);
    if (!mapReady) {
      refs.mapContainer.hidden = true;
      refs.manualFeetWrap.hidden = false;
    } else {
      refs.mapContainer.hidden = false;
      refs.manualFeetWrap.hidden = true;
      setStatus("Enter an address to start.", false);
    }

    recomputeAndRender();
  }

  function getClientKey() {
    const queryClient = new URLSearchParams(window.location.search).get("client");
    if (queryClient && normalizeClientKey(queryClient)) return normalizeClientKey(queryClient);

    const scriptClient = getClientFromScriptDataset();
    if (scriptClient) return normalizeClientKey(scriptClient);

    return DEFAULT_CLIENT;
  }

  function getClientFromScriptDataset() {
    const current = document.currentScript;
    if (current?.dataset?.client) return current.dataset.client;

    const scripts = Array.from(document.querySelectorAll("script[src]"));
    const widgetScript = scripts.find((s) => /widget\.js(\?|$)/.test(s.getAttribute("src") || ""));
    return widgetScript?.dataset?.client || "";
  }

  function normalizeClientKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9_-]/g, "");
  }

  async function loadClientConfig(clientKey) {
    const aliases = [clientKey, clientKey.replace(/[-_]/g, "")].filter(Boolean);

    for (const key of [...new Set(aliases)]) {
      const cfg = await fetchJson(`/config/${key}.json`);
      if (cfg) {
        state.clientKey = key;
        return cfg;
      }
    }

    if (clientKey !== DEFAULT_CLIENT) {
      const fallback = await fetchJson(`/config/${DEFAULT_CLIENT}.json`);
      if (fallback) {
        state.clientKey = DEFAULT_CLIENT;
        setStatus(`Config not found for '${clientKey}'. Showing '${DEFAULT_CLIENT}'.`, true);
        return fallback;
      }
    }

    setStatus(`Config not found for '${clientKey}'.`, true);
    throw new Error("Config not found");
  }

  async function fetchJson(path) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function applyBranding(config) {
    refs.companyName.textContent = sanitizeText(config.company_name || "Fence Quote");
    refs.tagline.textContent = sanitizeText(config.tagline || config.disclaimer || "");

    const color = String(config.primary_color || "").trim();
    if (color) document.documentElement.style.setProperty("--primary-color", color);

    if (config.logo_url) {
      refs.companyLogo.src = config.logo_url;
      refs.companyLogo.hidden = false;
    }
  }

  function setupEstimateInputs() {
    fillFenceTypeSelect();
    refs.walkGateQty.value = "0";
    refs.doubleGateQty.value = "0";
    updateAddressButtonLabel();
  }

  function fillFenceTypeSelect() {
    refs.fenceType.innerHTML = "";
    getFenceTypes().forEach((type) => {
      const opt = document.createElement("option");
      opt.value = type;
      opt.textContent = formatLabel(type);
      refs.fenceType.appendChild(opt);
    });
  }

  function updateAddressButtonLabel() {
    refs.addressSearchBtn.textContent = window.matchMedia("(max-width: 680px)").matches ? "Find" : "Locate";
  }

  function wireEvents() {
    window.addEventListener("resize", () => {
      updateAddressButtonLabel();
      applyMobileCtaState(computeEstimate());
    });

    refs.manualFeetInput.addEventListener("input", recomputeAndRender);
    refs.fenceType.addEventListener("change", onOptionsChanged);
    refs.removeOldFence.addEventListener("change", onOptionsChanged);

    refs.walkGateMinus.addEventListener("click", () => updateStepperValue(refs.walkGateQty, -1));
    refs.walkGatePlus.addEventListener("click", () => updateStepperValue(refs.walkGateQty, +1));
    refs.doubleGateMinus.addEventListener("click", () => updateStepperValue(refs.doubleGateQty, -1));
    refs.doubleGatePlus.addEventListener("click", () => updateStepperValue(refs.doubleGateQty, +1));

    refs.addressSearchBtn.addEventListener("click", locateAddress);
    refs.addressInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        locateAddress();
      }
    });

    refs.removeLastBtn.addEventListener("click", removeLastSegment);
    refs.clearAllBtn.addEventListener("click", clearAllSegments);

    refs.leadToggleBtn.addEventListener("click", () => {
      if (state.totalFeet <= 0) {
        setStatus("Measure fence first.", true);
        return;
      }
      openQuoteOverlay();
    });

    refs.mobileLeadCta.addEventListener("click", onMobileCtaClick);

    refs.quoteCloseBtn.addEventListener("click", closeQuoteOverlay);
    refs.quoteBackdrop.addEventListener("click", closeQuoteOverlay);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.overlayOpen) closeQuoteOverlay();
    });

    refs.leadForm.addEventListener("submit", submitLead);
  }

  function isMobileViewport() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  function isDesktopLikeViewport() {
    return window.matchMedia("(min-width: 768px)").matches;
  }

  function onOptionsChanged() {
    if (isMobileViewport() && state.totalFeet > 0) {
      state.optionsConfirmed = true;
    }
    recomputeAndRender();
  }

  function updateStepperValue(input, delta) {
    const min = Number(input.min || 0);
    const max = Number(input.max || 10);
    const current = Number(input.value || 0);
    const next = Math.max(min, Math.min(max, current + delta));
    if (next === current) return;
    input.value = String(next);
    onOptionsChanged();
  }

  async function initMapIfEnabled(config) {
    const maps = config.maps || {};
    if (!maps.enabled) {
      setStatus("Map is disabled for this client. Manual feet mode is active.", true);
      return false;
    }

    const apiKey = await resolveMapsApiKey(maps);
    if (!apiKey) {
      setStatus("Map key is missing. Manual feet mode is active.", true);
      return false;
    }

    try {
      await loadGoogleMaps(apiKey);
      createMap(maps);
      setupAutocomplete();
      return true;
    } catch (err) {
      setStatus("Map failed to load. Manual feet mode is active.", true);
      console.error(err);
      return false;
    }
  }

  async function resolveMapsApiKey(mapsConfig) {
    const fromQuery = new URLSearchParams(window.location.search).get("gmapsKey");
    const fromWindow = window.FENCE_GOOGLE_MAPS_API_KEY;
    const fromConfig = mapsConfig.google_maps_api_key;
    if (fromQuery) return String(fromQuery).trim();
    if (fromWindow) return String(fromWindow).trim();
    if (fromConfig) return String(fromConfig).trim();

    const demoCfg = await fetchJson(`/config/${DEFAULT_CLIENT}.json`);
    return String(demoCfg?.maps?.google_maps_api_key || "").trim();
  }

  function loadGoogleMaps(apiKey) {
    if (window.google?.maps?.geometry && window.google?.maps?.places) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-google-maps-loader]");
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry,places`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMapsLoader = "true";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Google Maps script load failed"));
      document.head.appendChild(script);
    });
  }

  function createMap(mapsConfig) {
    const center = mapsConfig.default_center || { lat: 40.7608, lng: -111.891 };
    const zoom = Number.isFinite(mapsConfig.default_zoom) ? mapsConfig.default_zoom : 19;

    state.map = new google.maps.Map(document.getElementById("map"), {
      center,
      zoom,
      mapTypeId: google.maps.MapTypeId.SATELLITE,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      rotateControl: false,
      disableDoubleClickZoom: true,
      gestureHandling: "greedy",
    });
    state.map.setTilt(0);

    state.geocoder = new google.maps.Geocoder();

    state.map.addListener("click", (event) => {
      if (!state.addressReady) {
        setStatus("Enter an address to start.", true);
        return;
      }
      addPoint(event.latLng);
    });

    state.map.addListener("dblclick", () => {
      if (!state.addressReady) return;
      finishActiveSegment();
    });
  }

  function setupAutocomplete() {
    const autocomplete = new google.maps.places.Autocomplete(refs.addressInput, {
      fields: ["formatted_address", "geometry"],
      componentRestrictions: { country: ["us"] },
    });

    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place?.geometry?.location) {
        setStatus("Address not found. Try again.", true);
        return;
      }

      const formatted = place.formatted_address || refs.addressInput.value;
      refs.addressInput.value = formatted;
      refs.customerAddress.value = formatted;
      focusProperty(place.geometry.location, place.geometry.viewport, formatted);
      state.addressReady = true;
      setStatus("Address found. Start drawing.", false);
      applyMobileCtaState(computeEstimate());
    });
  }

  function locateAddress() {
    const value = String(refs.addressInput.value || "").trim();
    if (!value) {
      setStatus("Enter an address to start.", true);
      return;
    }
    if (!state.geocoder || !state.map) {
      setStatus("Map is unavailable.", true);
      return;
    }

    setStatus("Searching address...", false);
    state.geocoder.geocode({ address: value, region: "us" }, (results, status) => {
      if (status !== "OK" || !results?.length) {
        setStatus("Address not found. Try again.", true);
        return;
      }

      const result = results[0];
      refs.addressInput.value = result.formatted_address;
      refs.customerAddress.value = result.formatted_address;
      focusProperty(result.geometry.location, result.geometry.viewport, result.formatted_address);
      state.addressReady = true;
      setStatus("Address found. Start drawing.", false);
      applyMobileCtaState(computeEstimate());
    });
  }

  function focusProperty(location, viewport, title) {
    if (isDesktopLikeViewport() && !fitMapToSegmentsDesktop()) {
      state.map.panTo(location);
      state.map.setZoom(19);
    } else if (viewport) {
      state.map.fitBounds(viewport);
      const z = state.map.getZoom() || 20;
      state.map.setZoom(Math.max(z, 20));
    } else {
      state.map.panTo(location);
      state.map.setZoom(21);
    }
    state.map.setTilt(0);

    if (state.addressMarker) state.addressMarker.setMap(null);
    state.addressMarker = new google.maps.Marker({
      map: state.map,
      position: location,
      title: sanitizeText(title || "Property"),
    });
  }

  function fitMapToSegmentsDesktop() {
    if (!isDesktopLikeViewport() || !state.map || !window.google?.maps?.LatLngBounds) return false;

    const bounds = new google.maps.LatLngBounds();
    let hasPoints = false;

    const polylines = [...state.segments];
    if (state.activeSegment && state.activeSegment.getPath().getLength() >= 2) polylines.push(state.activeSegment);

    polylines.forEach((seg) => {
      const path = seg.getPath();
      if (!path || path.getLength() < 2) return;
      path.forEach((latLng) => {
        bounds.extend(latLng);
        hasPoints = true;
      });
    });

    if (!hasPoints) return false;

    state.map.fitBounds(bounds, 40);
    const z = state.map.getZoom() || 19;
    if (z < 17) state.map.setZoom(17);
    return true;
  }

  function addPoint(latLng) {
    if (!state.activeSegment) {
      state.activeSegment = new google.maps.Polyline({
        map: state.map,
        path: [],
        editable: true,
        geodesic: true,
        strokeColor: state.config.primary_color || "#16a34a",
        strokeOpacity: 0.95,
        strokeWeight: 4,
      });
      bindSegmentEvents(state.activeSegment);
    }

    state.activeSegment.getPath().push(latLng);
    recomputeAndRender();
    setStatus("Drawing... feet updating live.", false);
  }

  function finishActiveSegment() {
    if (!state.activeSegment) return;

    const points = state.activeSegment.getPath().getLength();
    if (points < 2) {
      state.activeSegment.setMap(null);
    } else {
      state.segments.push(state.activeSegment);
    }
    state.activeSegment = null;
    recomputeAndRender();
    setStatus("Drawing... feet updating live.", false);
  }

  function bindSegmentEvents(polyline) {
    polyline.addListener("rightclick", () => {
      if (polyline === state.activeSegment) {
        state.activeSegment.setMap(null);
        state.activeSegment = null;
      } else {
        polyline.setMap(null);
        state.segments = state.segments.filter((seg) => seg !== polyline);
      }
      recomputeAndRender();
      setStatus("Drawing... feet updating live.", false);
    });

    const path = polyline.getPath();
    ["insert_at", "set_at", "remove_at"].forEach((evt) => {
      google.maps.event.addListener(path, evt, () => {
        recomputeAndRender();
        setStatus("Drawing... feet updating live.", false);
      });
    });
  }

  function removeLastSegment() {
    finishActiveSegment();
    const last = state.segments.pop();
    if (!last) return;
    last.setMap(null);
    recomputeAndRender();
    setStatus("Drawing... feet updating live.", false);
  }

  function clearAllSegments() {
    if (state.activeSegment) {
      state.activeSegment.setMap(null);
      state.activeSegment = null;
    }
    state.segments.forEach((seg) => seg.setMap(null));
    state.segments = [];
    recomputeAndRender();
    if (state.addressReady) setStatus("Address found. Start drawing.", false);
  }

  function getFenceTypes() {
    const p1 = Object.keys(state.config.pricing || {});
    const p2 = Object.keys(state.config.pricing_per_ft || {});
    const list = [...new Set([...p1, ...p2])].filter(Boolean);
    return list.length ? list : ["wood"];
  }

  function getPricePerFt(type) {
    const adv = state.config.pricing?.[type];
    if (adv) {
      return {
        low: toPositive(adv.price_per_ft_low),
        high: toPositive(adv.price_per_ft_high ?? adv.price_per_ft_low),
      };
    }

    const legacy = state.config.pricing_per_ft?.[type];
    if (typeof legacy === "number") return { low: legacy, high: legacy };

    return {
      low: toPositive(legacy?.low),
      high: toPositive(legacy?.high ?? legacy?.low),
    };
  }

  function getAddons() {
    const raw = state.config.add_ons || {};
    return {
      walk: {
        low: toPositive(raw.walk_gate?.low ?? raw.walk_gate_low),
        high: toPositive(raw.walk_gate?.high ?? raw.walk_gate_high ?? raw.walk_gate?.low ?? raw.walk_gate_low),
      },
      dbl: {
        low: toPositive(raw.double_gate?.low ?? raw.drive_gate?.low ?? raw.double_gate_low),
        high: toPositive(
          raw.double_gate?.high ?? raw.drive_gate?.high ?? raw.double_gate_high ?? raw.double_gate?.low ?? raw.drive_gate?.low
        ),
      },
      removal: {
        low: toPositive(raw.remove_old_fence_per_ft?.low ?? raw.removal_fee_per_ft?.low),
        high: toPositive(
          raw.remove_old_fence_per_ft?.high ?? raw.removal_fee_per_ft?.high ?? raw.remove_old_fence_per_ft?.low ?? raw.removal_fee_per_ft?.low
        ),
      },
    };
  }

  function computeFeetFromMap() {
    if (!window.google?.maps?.geometry) return 0;

    let meters = 0;
    state.segments.forEach((seg) => {
      const path = seg.getPath();
      if (path.getLength() >= 2) meters += google.maps.geometry.spherical.computeLength(path);
    });

    if (state.activeSegment && state.activeSegment.getPath().getLength() >= 2) {
      meters += google.maps.geometry.spherical.computeLength(state.activeSegment.getPath());
    }

    return Number((meters * FT_PER_METER).toFixed(1));
  }

  function computeEstimate() {
    const fenceType = refs.fenceType.value;
    const feetMap = computeFeetFromMap();
    const feetManual = toPositive(refs.manualFeetInput.value);
    const feet = feetMap > 0 ? feetMap : feetManual;

    const perFt = getPricePerFt(fenceType);
    const addons = getAddons();

    const walkQty = toPositiveInt(refs.walkGateQty.value);
    const doubleQty = toPositiveInt(refs.doubleGateQty.value);
    const removeOld = refs.removeOldFence.checked;

    const materialMin = perFt.low * feet;
    const materialMax = perFt.high * feet;
    const walkMin = addons.walk.low * walkQty;
    const walkMax = addons.walk.high * walkQty;
    const doubleMin = addons.dbl.low * doubleQty;
    const doubleMax = addons.dbl.high * doubleQty;
    const removalMin = removeOld ? addons.removal.low * feet : 0;
    const removalMax = removeOld ? addons.removal.high * feet : 0;

    const estimatedMin = materialMin + walkMin + doubleMin + removalMin;
    const estimatedMax = materialMax + walkMax + doubleMax + removalMax;

    const segmentsCount = state.segments.length + (state.activeSegment ? 1 : 0);

    return {
      fenceType,
      feet,
      walkQty,
      doubleQty,
      removeOld,
      estimatedMin,
      estimatedMax,
      breakdown: { materialMin, materialMax, walkMin, walkMax, doubleMin, doubleMax, removalMin, removalMax },
      segmentsCount,
    };
  }

  function recomputeAndRender() {
    const calc = computeEstimate();

    state.totalFeet = calc.feet;
    state.estimateMin = calc.estimatedMin;
    state.estimateMax = calc.estimatedMax;

    refs.totalFeet.textContent = `${formatNum(calc.feet)} ft`;
    refs.estimatedPrice.textContent = `${formatMoney(calc.estimatedMin)} - ${formatMoney(calc.estimatedMax)}`;
    refs.mobileSummaryText.textContent = `${formatNum(calc.feet)} ft • ${formatMoney(calc.estimatedMin)}–${formatMoney(
      calc.estimatedMax
    )}`;

    refs.estimateBreakdown.innerHTML = [
      `Material: ${formatMoney(calc.breakdown.materialMin)} - ${formatMoney(calc.breakdown.materialMax)}`,
      `Walk gates: ${formatMoney(calc.breakdown.walkMin)} - ${formatMoney(calc.breakdown.walkMax)}`,
      `Double gates: ${formatMoney(calc.breakdown.doubleMin)} - ${formatMoney(calc.breakdown.doubleMax)}`,
      `Removal: ${formatMoney(calc.breakdown.removalMin)} - ${formatMoney(calc.breakdown.removalMax)}`,
      `Segments: ${calc.segmentsCount}`,
    ]
      .map((row) => `<div>${row}</div>`)
      .join("");

    applyMobileCtaState(calc);
  }

  function applyMobileCtaState(calc) {
    if (!isMobileViewport()) {
      refs.mobileSummaryBar.classList.remove("is-visible");
      return;
    }

    if (state.overlayOpen || calc.feet <= 0) {
      refs.mobileSummaryBar.classList.remove("is-visible");
      state.optionsConfirmed = false;
      refs.mobileLeadCta.textContent = "Continue";
      return;
    }

    refs.mobileSummaryBar.classList.add("is-visible");
    refs.mobileLeadCta.textContent = state.optionsConfirmed ? "Request Final Quote" : "Continue";
  }

  function onMobileCtaClick() {
    if (!isMobileViewport()) {
      openQuoteOverlay();
      return;
    }

    if (state.totalFeet <= 0) return;

    if (!state.optionsConfirmed) {
      state.optionsConfirmed = true;
      refs.estimatePanel.scrollIntoView({ behavior: "smooth", block: "start" });
      applyMobileCtaState(computeEstimate());
      return;
    }

    openQuoteOverlay();
  }

  function openQuoteOverlay() {
    state.overlayOpen = true;
    refs.quoteOverlay.classList.add("is-open");
    refs.quoteOverlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("overlay-open");
    refs.mobileSummaryBar.classList.remove("is-visible");

    if (!refs.customerAddress.value && refs.addressInput.value) {
      refs.customerAddress.value = refs.addressInput.value;
    }

    requestAnimationFrame(() => {
      setTimeout(() => {
        refs.customerName.focus();
        if (isMobileViewport()) {
          refs.customerName.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 100);
    });
  }

  function closeQuoteOverlay() {
    state.overlayOpen = false;
    refs.quoteOverlay.classList.remove("is-open");
    refs.quoteOverlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("overlay-open");
    applyMobileCtaState(computeEstimate());
  }

  function buildCoordinatesArray() {
    const all = [...state.segments];
    if (state.activeSegment && state.activeSegment.getPath().getLength() >= 2) {
      all.push(state.activeSegment);
    }

    return all.map((seg) => {
      const points = [];
      seg.getPath().forEach((latLng) => {
        points.push({ lat: Number(latLng.lat().toFixed(7)), lng: Number(latLng.lng().toFixed(7)) });
      });
      return points;
    });
  }

  async function submitLead(e) {
    e.preventDefault();

    if (String(refs.websiteTrap.value || "").trim()) {
      setStatus("Submission blocked.", true);
      return;
    }

    const name = String(refs.customerName.value || "").trim();
    const phone = String(refs.customerPhone.value || "").trim();
    const email = String(refs.customerEmail.value || "").trim();
    const address = String(refs.customerAddress.value || refs.addressInput.value || "").trim();

    if (!name || !phone || !isValidEmail(email) || !address) {
      setStatus("Please complete all fields with a valid email.", true);
      return;
    }

    const calc = computeEstimate();
    const payload = {
      client_key: state.clientKey,
      company_name: state.config.company_name || "",
      fence_type: calc.fenceType,
      walk_gate_qty: calc.walkQty,
      double_gate_qty: calc.doubleQty,
      remove_old_fence: calc.removeOld,
      total_linear_feet: Number(calc.feet.toFixed(1)),
      estimated_min: Math.round(calc.estimatedMin),
      estimated_max: Math.round(calc.estimatedMax),
      breakdown: {
        material_min: Math.round(calc.breakdown.materialMin),
        material_max: Math.round(calc.breakdown.materialMax),
        walk_gate_min: Math.round(calc.breakdown.walkMin),
        walk_gate_max: Math.round(calc.breakdown.walkMax),
        double_gate_min: Math.round(calc.breakdown.doubleMin),
        double_gate_max: Math.round(calc.breakdown.doubleMax),
        removal_min: Math.round(calc.breakdown.removalMin),
        removal_max: Math.round(calc.breakdown.removalMax),
        segments_count: calc.segmentsCount,
      },
      property_address: address,
      name,
      phone,
      email,
      drawing_coordinates_array: buildCoordinatesArray(),
      submitted_at: new Date().toISOString(),
    };

    refs.submitLeadBtn.disabled = true;
    refs.submitLeadBtn.textContent = "Sending...";

    try {
      const webhook = String(state.config.webhook_url || "").trim();
      if (webhook && !/example\.com/.test(webhook)) {
        await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        console.log("Lead payload", payload);
      }

      refs.leadForm.reset();
      refs.customerAddress.value = refs.addressInput.value;
      refs.quoteSuccess.hidden = false;
      setStatus("Lead submitted successfully.", false);
      closeQuoteOverlay();
    } catch (err) {
      console.error(err);
      setStatus("Failed to submit lead. Try again.", true);
    } finally {
      refs.submitLeadBtn.disabled = false;
      refs.submitLeadBtn.textContent = "Send Quote Request";
    }
  }

  function setStatus(message, isWarning) {
    if (isWarning) state.hasWarning = true;
    refs.status.textContent = message;
    refs.status.style.borderLeftColor = isWarning ? "#c48211" : "var(--primary-color)";
  }

  function sanitizeText(v) {
    return String(v || "").replace(/[<>]/g, "");
  }

  function formatLabel(v) {
    return String(v || "")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  function toPositive(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function toPositiveInt(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function formatNum(v) {
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v || 0);
  }

  function formatMoney(v) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(v || 0);
  }

  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());
  }
})();
