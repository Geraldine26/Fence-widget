(function () {
  const DEFAULT_CLIENT = "demo";
  const FT_PER_METER = 3.28084;

  const state = {
    clientKey: DEFAULT_CLIENT,
    config: null,
    polylines: [],
    map: null,
    drawingManager: null,
    drawMode: false,
    editMode: false,
    totalFeet: 0,
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
    editBtn: document.getElementById("editBtn"),
    resetBtn: document.getElementById("resetBtn"),
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
    setStatus("Ready.", false);
  }

  function parseClientFromUrl() {
    const raw = new URLSearchParams(window.location.search).get("client") || DEFAULT_CLIENT;
    const cleaned = raw.trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(cleaned)) {
      return DEFAULT_CLIENT;
    }
    return cleaned;
  }

  async function loadClientConfig(clientKey) {
    const candidate = await fetchJson(`/config/${clientKey}.json`);
    if (candidate) {
      return candidate;
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

    refs.drawBtn.addEventListener("click", () => {
      if (!state.drawingManager) {
        return;
      }
      state.drawMode = !state.drawMode;
      state.drawingManager.setDrawingMode(
        state.drawMode ? google.maps.drawing.OverlayType.POLYLINE : null
      );
      refs.drawBtn.classList.toggle("active", state.drawMode);
    });

    refs.editBtn.addEventListener("click", () => {
      state.editMode = !state.editMode;
      state.polylines.forEach((line) => line.setEditable(state.editMode));
      refs.editBtn.classList.toggle("active", state.editMode);
    });

    refs.resetBtn.addEventListener("click", () => {
      state.polylines.forEach((line) => line.setMap(null));
      state.polylines = [];
      state.editMode = false;
      state.drawMode = false;
      refs.editBtn.classList.remove("active");
      refs.drawBtn.classList.remove("active");
      if (state.drawingManager) {
        state.drawingManager.setDrawingMode(null);
      }
      recomputeAndRender();
    });
  }

  async function maybeInitMap(config) {
    const mapsConfig = config.maps || {};
    if (!mapsConfig.enabled) {
      return false;
    }

    const apiKey =
      (window.FENCE_GOOGLE_MAPS_API_KEY || "").trim() ||
      (mapsConfig.google_maps_api_key || "").trim();

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
      setStatus("Google Maps failed to load. Using manual feet mode.", true);
      console.error(err);
      return false;
    }
  }

  function enableManualFeetMode() {
    refs.mapContainer.hidden = true;
    refs.manualFeetWrap.hidden = false;
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
      )}&libraries=drawing,geometry`;
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
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });

    state.drawingManager = new google.maps.drawing.DrawingManager({
      drawingMode: null,
      drawingControl: false,
      polylineOptions: {
        strokeColor: state.config.primary_color || "#1f7a8c",
        strokeOpacity: 0.95,
        strokeWeight: 4,
        editable: false,
      },
    });
    state.drawingManager.setMap(state.map);

    google.maps.event.addListener(state.drawingManager, "polylinecomplete", (polyline) => {
      polyline.setEditable(state.editMode);
      wirePolylineEvents(polyline);
      state.polylines.push(polyline);
      state.drawingManager.setDrawingMode(null);
      state.drawMode = false;
      refs.drawBtn.classList.remove("active");
      recomputeAndRender();
    });
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
