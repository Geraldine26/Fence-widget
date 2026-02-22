(function () {
  const DEFAULT_CLIENT = "demo";
  const FT_PER_METER = 3.28084;

  const state = {
    clientKey: DEFAULT_CLIENT,
    config: null,
    polylines: [],
    map: null,
    drawMode: false,
    editMode: true,
    totalFeet: 0,
    hasWarning: false,
    geocoder: null,
    addressMarker: null,
    activeDraft: null,
  };

  const refs = {
    status: document.getElementById("globalStatus"),
    companyName: document.getElementById("companyName"),
    disclaimer: document.getElementById("disclaimer"),
    companyLogo: document.getElementById("companyLogo"),
    mapContainer: document.getElementById("mapContainer"),
    manualFeetWrap: document.getElementById("manualFeetWrap"),
    manualFeetInput: document.getElementById("manualFeetInput"),
    drawBtn: document.getElementById("drawBtn"),
    resetBtn: document.getElementById("resetBtn"),
    addressInput: document.getElementById("addressInput"),
    addressSearchBtn: document.getElementById("addressSearchBtn"),
    fenceType: document.getElementById("fenceType"),
    totalFeet: document.getElementById("totalFeet"),
    estimatedPrice: document.getElementById("estimatedPrice"),
  };

  init().catch((err) => {
    setStatus("Unexpected error loading widget.", true);
    console.error("Widget init error", err);
  });

  async function init() {
    state.clientKey = parseClientFromUrl();
    const config = await loadClientConfig(state.clientKey);
    state.config = config;
    applyBranding(config);
    setupFenceTypes(config);
    wireStaticEvents();

    const mapStarted = await maybeInitMap(config);
    if (!mapStarted) {
      enableManualFeetMode();
    }

    recomputeAndRender();
    if (!state.hasWarning) {
      setStatus("Ready.", false);
    }
  }

  function parseClientFromUrl() {
    const raw = new URLSearchParams(window.location.search).get("client") || DEFAULT_CLIENT;
    const cleaned = raw.trim().toLowerCase().replace(/\s+/g, "");
    if (!cleaned) {
      return DEFAULT_CLIENT;
    }
    return cleaned.replace(/[^a-z0-9_-]/g, "");
  }

  async function loadClientConfig(clientKey) {
    const aliases = uniqueClientAliases(clientKey);
    for (const alias of aliases) {
      const candidate = await fetchJson(`/config/${alias}.json`);
      if (candidate) {
        state.clientKey = alias;
        return candidate;
      }
    }

    if (clientKey !== DEFAULT_CLIENT) {
      setStatus(`Client '${clientKey}' not found. Falling back to '${DEFAULT_CLIENT}'.`, true);
      state.clientKey = DEFAULT_CLIENT;
      const fallback = await fetchJson(`/config/${DEFAULT_CLIENT}.json`);
      if (fallback) {
        return fallback;
      }
    }

    throw new Error("Unable to load configuration");
  }

  async function fetchJson(path) {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) {
        return null;
      }
      return await response.json();
    } catch (err) {
      console.warn("Failed to fetch JSON", path, err);
      return null;
    }
  }

  function uniqueClientAliases(clientKey) {
    const trimmed = String(clientKey || "").trim().toLowerCase();
    const collapsed = trimmed.replace(/[-_]/g, "");
    return [...new Set([trimmed, collapsed])];
  }

  function applyBranding(config) {
    refs.companyName.textContent = sanitizeText(config.company_name || "Fence Quote");
    refs.disclaimer.textContent = sanitizeText(config.disclaimer || "");

    const color = typeof config.primary_color === "string" ? config.primary_color.trim() : "";
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
    const pricing = config.pricing_per_ft || {};
    const types = Object.keys(pricing);

    if (!types.length) {
      const fallback = document.createElement("option");
      fallback.value = "default";
      fallback.textContent = "Standard";
      refs.fenceType.appendChild(fallback);
      return;
    }

    types.forEach((type) => {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = formatLabel(type);
      refs.fenceType.appendChild(option);
    });
  }

  function wireStaticEvents() {
    refs.manualFeetInput.addEventListener("input", recomputeAndRender);
    refs.fenceType.addEventListener("change", recomputeAndRender);
    refs.addressSearchBtn.addEventListener("click", geocodeAddressFromInput);
    refs.addressInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        geocodeAddressFromInput();
      }
    });

    refs.drawBtn.addEventListener("click", () => {
      if (!state.map) {
        return;
      }
      state.drawMode = !state.drawMode;
      refs.drawBtn.classList.toggle("active", state.drawMode);
      refs.drawBtn.textContent = state.drawMode ? "Pause Draw" : "Resume Draw";
    });

    refs.resetBtn.addEventListener("click", () => {
      state.polylines.forEach((line) => line.setMap(null));
      state.polylines = [];
      if (state.activeDraft) {
        state.activeDraft.setMap(null);
        state.activeDraft = null;
      }
      state.drawMode = true;
      refs.drawBtn.classList.add("active");
      refs.drawBtn.textContent = "Pause Draw";
      recomputeAndRender();
    });
  }

  async function maybeInitMap(config) {
    const mapsConfig = config.maps || {};
    if (!mapsConfig.enabled) {
      return false;
    }

    const apiKey = await resolveMapsApiKey(mapsConfig);

    if (!apiKey) {
      setStatus("Map disabled: missing Google Maps API key. Using manual feet mode.", true);
      return false;
    }

    try {
      await loadGoogleMapsApi(apiKey);
      initMapInstance(mapsConfig);
      refs.mapContainer.hidden = false;
      refs.manualFeetWrap.hidden = true;
      return true;
    } catch (err) {
      const detail = err && err.message ? ` (${err.message})` : "";
      setStatus(`Google Maps failed to load. Using manual feet mode.${detail}`, true);
      console.error(err);
      return false;
    }
  }

  async function resolveMapsApiKey(mapsConfig) {
    const fromWindow = String(window.FENCE_GOOGLE_MAPS_API_KEY || "").trim();
    const fromQuery = String(new URLSearchParams(window.location.search).get("gmapsKey") || "").trim();
    const fromClientConfig = String(mapsConfig.google_maps_api_key || "").trim();
    if (fromWindow) {
      return fromWindow;
    }
    if (fromQuery) {
      return fromQuery;
    }
    if (fromClientConfig) {
      return fromClientConfig;
    }

    // Optional fallback so all tenants can work while sharing one key.
    const demoConfig = await fetchJson(`/config/${DEFAULT_CLIENT}.json`);
    return String(demoConfig?.maps?.google_maps_api_key || "").trim();
  }

  function enableManualFeetMode() {
    refs.mapContainer.hidden = true;
    refs.manualFeetWrap.hidden = false;
  }

  function loadGoogleMapsApi(apiKey) {
    if (window.google && window.google.maps && window.google.maps.geometry) {
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
      )}&libraries=geometry,places`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMapsLoader = "true";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Google Maps script load failed"));
      document.head.appendChild(script);
    });
  }

  function initMapInstance(mapsConfig) {
    const center = mapsConfig.default_center || { lat: 40.7608, lng: -111.891 };
    const zoom = Number.isFinite(mapsConfig.default_zoom) ? mapsConfig.default_zoom : 18;

    state.map = new google.maps.Map(document.getElementById("map"), {
      center,
      zoom,
      mapTypeId: google.maps.MapTypeId.HYBRID,
      mapTypeControl: true,
      streetViewControl: false,
      fullscreenControl: true,
      disableDoubleClickZoom: true,
    });
    state.geocoder = new google.maps.Geocoder();
    setupAddressAutocomplete();
    state.drawMode = true;
    refs.drawBtn.classList.add("active");
    refs.drawBtn.textContent = "Pause Draw";

    state.map.addListener("click", (event) => {
      if (!state.drawMode) {
        return;
      }
      addPointToDraft(event.latLng);
    });

    state.map.addListener("dblclick", () => {
      if (!state.drawMode) {
        return;
      }
      finalizeDraftPolyline();
    });
  }

  function setupAddressAutocomplete() {
    if (!google.maps.places || !refs.addressInput) {
      return;
    }
    const autocomplete = new google.maps.places.Autocomplete(refs.addressInput, {
      fields: ["formatted_address", "geometry"],
    });
    autocomplete.addListener("place_changed", () => {
      const place = autocomplete.getPlace();
      if (!place || !place.geometry || !place.geometry.location) {
        return;
      }
      focusMapOnLocation(
        place.geometry.location,
        place.formatted_address || refs.addressInput.value,
        place.geometry.viewport
      );
    });
  }

  function geocodeAddressFromInput() {
    if (!state.map || !state.geocoder) {
      setStatus("Map is unavailable, address lookup disabled.", true);
      return;
    }

    const address = String(refs.addressInput.value || "").trim();
    if (!address) {
      setStatus("Please enter an address to locate the property.", true);
      return;
    }

    setStatus("Locating address...", false);
    state.geocoder.geocode({ address, region: "us" }, (results, status) => {
      if (status !== "OK" || !results || !results[0] || !results[0].geometry) {
        setStatus("Address not found. Please refine the address.", true);
        return;
      }
      const location = results[0].geometry.location;
      const formatted = results[0].formatted_address || address;
      refs.addressInput.value = formatted;
      focusMapOnLocation(location, formatted, results[0].geometry.viewport);
      setStatus("Address located. Draw fence lines on the property.", false);
    });
  }

  function focusMapOnLocation(location, title, viewport) {
    if (viewport) {
      state.map.fitBounds(viewport);
      const z = state.map.getZoom() || 20;
      state.map.setZoom(Math.max(z, 20));
    } else {
      state.map.panTo(location);
      state.map.setZoom(21);
    }
    if (state.addressMarker) {
      state.addressMarker.setMap(null);
    }
    state.addressMarker = new google.maps.Marker({
      map: state.map,
      position: location,
      title: sanitizeText(title || "Property location"),
    });
  }

  function addPointToDraft(latLng) {
    if (!state.activeDraft) {
      state.activeDraft = new google.maps.Polyline({
        map: state.map,
        path: [],
        editable: true,
        geodesic: true,
        strokeColor: state.config.primary_color || "#1f7a8c",
        strokeOpacity: 0.95,
        strokeWeight: 4,
      });
      wirePolylineEvents(state.activeDraft);
    }

    state.activeDraft.getPath().push(latLng);
    recomputeAndRender();
  }

  function finalizeDraftPolyline() {
    if (!state.activeDraft) {
      return;
    }

    const path = state.activeDraft.getPath();
    if (path.getLength() < 2) {
      state.activeDraft.setMap(null);
    } else {
      state.polylines.push(state.activeDraft);
    }
    state.activeDraft = null;
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

  function recomputeAndRender() {
    const feetFromMap = computeFeetFromMap();
    const feetFromManual = toPositiveNumber(refs.manualFeetInput.value);
    const totalFeet = feetFromMap > 0 ? feetFromMap : feetFromManual;

    state.totalFeet = totalFeet;
    refs.totalFeet.textContent = `${formatNumber(totalFeet)} ft`;

    const price = computeSimplePrice(totalFeet);
    refs.estimatedPrice.textContent = price;
  }

  function computeFeetFromMap() {
    if (!window.google || !google.maps || !google.maps.geometry) {
      return 0;
    }

    let totalMeters = 0;
    state.polylines.forEach((polyline) => {
      const path = polyline.getPath();
      if (path.getLength() < 2) {
        return;
      }
      totalMeters += google.maps.geometry.spherical.computeLength(path);
    });
    if (state.activeDraft && state.activeDraft.getPath().getLength() >= 2) {
      totalMeters += google.maps.geometry.spherical.computeLength(state.activeDraft.getPath());
    }

    return Number((totalMeters * FT_PER_METER).toFixed(1));
  }

  function computeSimplePrice(totalFeet) {
    const fenceType = refs.fenceType.value;
    const pricing = (state.config && state.config.pricing_per_ft) || {};
    const perFtConfig = pricing[fenceType];

    let low = 0;
    let high = 0;

    if (typeof perFtConfig === "number") {
      low = perFtConfig;
      high = perFtConfig;
    } else if (perFtConfig && typeof perFtConfig === "object") {
      low = toPositiveNumber(perFtConfig.low);
      high = toPositiveNumber(perFtConfig.high || perFtConfig.low);
    }

    if (!low && !high) {
      return "$0";
    }

    const lowTotal = low * totalFeet;
    const highTotal = high * totalFeet;

    if (Math.abs(highTotal - lowTotal) < 0.01) {
      return formatCurrency(lowTotal);
    }
    return `${formatCurrency(lowTotal)} - ${formatCurrency(highTotal)}`;
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
    return raw
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  function toPositiveNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      return 0;
    }
    return n;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value || 0);
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value || 0);
  }
})();
