// ==UserScript==
// @name         GeoFS Real Impact — Precision Crash Detection
// @namespace    https://www.geo-fs.com/geofs.php?v=4
// @version      2.3.0
// @description  Forces a real crash (engine cutout + forced loss of control) only when you actually hit a real detected obstacle -- a real tree or a real building at your exact position. Runways, open fields, and water remain safe even at very low altitude. Uses geofsRealTrees for tree detection (trees are invisible to every standard Cesium picking API) and terrain sampling for buildings.
// @author       yasseristaken
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @match        https://*.geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// @license      CC-BY-4.0
// ==/UserScript==

(function () {
  "use strict";

  // ============================================================
  // 0. State & configuration
  // ============================================================
  let injected = false;
  let panel = null;
  let lastCrashTime = 0;
  let spawnGraceUntil = 0;
  let forceFallActive = false;
  let forceFallElapsed = 0;
  let controlsHooked = false;
  let resetFlightHooked = false;
  let lastCrashedState = false;

  const settings = {
    enabled: true,
    minAltitudeFt: 80, // tuned to 80ft after real flight testing (150 felt
                         // too sensitive; 80 is a reasonable middle ground
                         // for typical tree canopy height without firing
                         // during normal cruise flight)
    minSpeedKts: 15,
    objectHeightThresholdM: 2.5, // threshold for sampleHeight-based detection (buildings)
    treeRadiusM: 10.5,            // FIX v2.2: radius (meters) to consider
                                   // "there's a real tree here" via geofsRealTrees.
                                   // Trees aren't detectable via
                                   // sampleHeight/pick/pickPosition -- confirmed
                                   // with three separate tests that GeoFS
                                   // renders them completely outside Cesium's
                                   // standard pipeline.
    sampleOffsetM: 8,
    cooldownMs: 3000,
    spawnGraceMs: 4000
  };

  function getCesium() {
    return window.Cesium || (window.geofs?.api?.Cesium) || null;
  }
  function getViewer() {
    return (window.geofs?.api?.viewer) || null;
  }

  // ============================================================
  // 1. Simple toast
  // ============================================================
  function showToast(text, isBad) {
    const tip = document.createElement("div");
    tip.style.cssText = `
      position:fixed;top:20px;left:50%;transform:translateX(-50%);
      background:${isBad ? "rgba(190,0,0,0.9)" : "rgba(0,140,0,0.85)"};
      color:#fff;padding:10px 22px;border-radius:8px;z-index:99999;
      font-size:14px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.3);
      transition:opacity 0.6s ease;
    `;
    tip.textContent = text;
    document.body.appendChild(tip);
    setTimeout(() => {
      tip.style.opacity = "0";
      setTimeout(() => tip.remove(), 600);
    }, 2200);
  }

  // ============================================================
  // 2. Object detection: buildings (sampleHeight) + trees (geofsRealTrees)
  // ============================================================
  function offsetLatLon(lat, lon, headingDeg, offsetMeters) {
    const Cesium = getCesium();
    const R = 6378137;
    const perpendicularRad = Cesium.Math.toRadians((headingDeg || 0) + 90);
    const dLat = (offsetMeters * Math.cos(perpendicularRad)) / R;
    const dLon =
      (offsetMeters * Math.sin(perpendicularRad)) /
      (R * Math.cos(Cesium.Math.toRadians(lat)));

    return {
      lat: lat + Cesium.Math.toDegrees(dLat),
      lon: lon + Cesium.Math.toDegrees(dLon)
    };
  }

  // BUILDING detection via sampleHeight (this works because OSM/Google
  // tilesets ARE real Cesium3DTileset objects, unlike GeoFS's native trees).
  async function hasBuildingAtExactPosition(viewer, lat, lon, headingDeg) {
    const Cesium = getCesium();
    if (!Cesium || !viewer) return false;

    const offset = offsetLatLon(lat, lon, headingDeg, settings.sampleOffsetM);
    const latRad = Cesium.Math.toRadians(offset.lat);
    const lonRad = Cesium.Math.toRadians(offset.lon);
    const carto = new Cesium.Cartographic(lonRad, latRad);

    let renderedHeight;
    try {
      renderedHeight = viewer.scene.sampleHeight(carto);
    } catch (e) {
      return false;
    }
    if (renderedHeight == null) return false;

    let terrainHeight;
    try {
      const tp = viewer.terrainProvider;
      if (!tp?.ready || typeof Cesium.sampleTerrainMostDetailed !== "function") return false;
      const sampled = await Cesium.sampleTerrainMostDetailed(tp, [new Cesium.Cartographic(lonRad, latRad)]);
      terrainHeight = sampled?.[0]?.height;
    } catch (e) {
      return false;
    }
    if (terrainHeight == null || !Number.isFinite(terrainHeight)) return false;

    return (renderedHeight - terrainHeight) >= settings.objectHeightThresholdM;
  }

  // FIX v2.2: TREE detection via the real tree position extractor
  // (window.geofsRealTrees), since it was confirmed with three separate
  // tests (sampleHeight, pick/drillPick, pickPosition with and without
  // pickTranslucentDepth) that GeoFS's trees never write to any depth
  // buffer Cesium can read -- they simply don't exist for any standard
  // picking API. If the extractor script isn't installed or hasn't
  // loaded any tiles yet, this just returns false without breaking
  // anything (buildings still get detected fine via sampleHeight).
  // FIX v2.3: do NOT apply the lateral offset here. That offset
  // (sampleOffsetM) exists only for the sampleHeight-based building
  // check, which without it would end up detecting the aircraft's own
  // fuselage as an "object". isTreeNear() is a pure distance check
  // against a list of real coordinates -- it doesn't have that
  // self-detection problem, so applying the same offset only meant
  // checking a point ~8m off to the side of where the aircraft
  // actually is, producing heading-dependent results (sometimes the
  // real tree fell outside the offset point, sometimes a different
  // tree happened to land right on it by chance).
  function hasTreeAtExactPosition(lat, lon) {
    if (typeof window.geofsRealTrees?.isTreeNear !== "function") return false;
    return window.geofsRealTrees.isTreeNear(lat, lon, settings.treeRadiusM);
  }

  async function hasObjectAtExactPosition(viewer, lat, lon, headingDeg) {
    // Check trees first: it's synchronous and much cheaper than
    // sampleHeight + sampleTerrainMostDetailed (which is async and hits
    // the terrain provider). If there's already a tree, there's no need
    // to wait on the async building check at all.
    if (hasTreeAtExactPosition(lat, lon)) return true;
    return await hasBuildingAtExactPosition(viewer, lat, lon, headingDeg);
  }

  // ============================================================
  // 3. Forced fall mode
  // ============================================================
  function hookControlsForForcedFall() {
    if (controlsHooked || typeof window.controls === "undefined") return;
    controlsHooked = true;

    const originalUpdate = window.controls.update.bind(window.controls);
    window.controls.update = function (...args) {
      const result = originalUpdate(...args);
      if (forceFallActive) {
        forceFallElapsed += 1 / 60;
        const intensity = Math.min(1, forceFallElapsed / 2);
        window.controls.throttle = 0;
        window.controls.pitch = (Math.random() * 2 - 1) * 0.6 * intensity;
        window.controls.roll = (Math.random() * 2 - 1) * 0.9 * intensity;
        window.controls.yaw = (Math.random() * 2 - 1) * 0.5 * intensity;
        const instance = window.geofs?.aircraft?.instance;
        if (instance?.engine) instance.engine.on = false;
      }
      return result;
    };
  }

  function startForcedFall() {
    forceFallActive = true;
    forceFallElapsed = 0;
  }

  function stopForcedFall() {
    forceFallActive = false;
    forceFallElapsed = 0;
  }

  function hookResetFlight() {
    if (resetFlightHooked || typeof window.geofs?.resetFlight !== "function") return;
    resetFlightHooked = true;
    const originalReset = window.geofs.resetFlight.bind(window.geofs);
    window.geofs.resetFlight = function (...args) {
      stopForcedFall();
      lastCrashTime = 0;
      return originalReset(...args);
    };
  }

  // ============================================================
  // 4. Main loop
  // ============================================================
  let checkInFlight = false;

  async function mainLoop() {
    if (!settings.enabled) return;
    const instance = window.geofs?.aircraft?.instance;
    const values = window.geofs?.animation?.values;
    const viewer = getViewer();
    if (!instance || !values || !viewer) return;

    const currentCrashed = !!instance.crashed;
    if (lastCrashedState && !currentCrashed) {
      spawnGraceUntil = performance.now() + settings.spawnGraceMs;
      stopForcedFall();
    }
    lastCrashedState = currentCrashed;

    if (performance.now() < spawnGraceUntil) return;
    if (forceFallActive) return;
    if (checkInFlight) return;

    const now = performance.now();
    if (now - lastCrashTime < settings.cooldownMs) return;

    const altFt = values.haglFeet;
    const speedKts = values.kias || 0;
    if (altFt == null || altFt > settings.minAltitudeFt) return;
    if (speedKts < settings.minSpeedKts) return;

    const lla = instance.lastLlaLocation;
    if (!lla) return;
    const [lat, lon] = lla;
    const headingDeg = values.heading || 0;

    checkInFlight = true;
    try {
      const hit = await hasObjectAtExactPosition(viewer, lat, lon, headingDeg);
      if (hit) {
        lastCrashTime = performance.now();
        instance.crash();
        hookControlsForForcedFall();
        startForcedFall();
        showToast("💥 Impact against a real obstacle detected", true);
        console.log("[Real Impact] Forced crash -- object confirmed at the exact position.");
      }
    } finally {
      checkInFlight = false;
    }
  }

  // ============================================================
  // 5. Own console (] key)
  // ============================================================
  function showPanel() {
    if (panel) { panel.remove(); panel = null; return; }

    const style = document.createElement("style");
    style.textContent = `
      #cur-panel {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(20,10,10,0.92); backdrop-filter: blur(12px);
        padding: 18px; border-radius: 14px; z-index: 100000;
        min-width: 300px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        border: 1px solid rgba(255,80,80,0.25);
        font-family: 'Segoe UI', sans-serif; color: #fff;
      }
      #cur-panel .title { font-weight: bold; font-size: 15px; margin-bottom: 10px; text-align: center; }
      #cur-panel label { display: block; font-size: 11px; color: #e0a0a0; margin: 8px 0 2px; }
      #cur-panel input[type="range"] { width: 100%; }
      #cur-panel .val { float: right; color: #ff8a8a; font-family: monospace; }
      #cur-panel button {
        width: 100%; margin-top: 8px; padding: 6px 0; border: none; border-radius: 6px;
        font-weight: 600; cursor: pointer;
      }
      #cur-panel .toggle-btn { background: linear-gradient(135deg,#a01f1f,#5a0f0f); color: #fff; }
      #cur-panel .reset-btn { background: rgba(255,255,255,0.1); color: #ddd; }
      #cur-panel .status-line {
        margin-top: 10px; padding: 6px 8px; background: rgba(0,0,0,0.25);
        border-radius: 6px; font-size: 11px; color: #cabfbf;
      }
    `;
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.id = "cur-panel";
    const treesStatus = typeof window.geofsRealTrees?.isTreeNear === "function"
      ? "✅ Tree extractor connected"
      : "⚠️ Tree extractor NOT detected (only buildings are active)";
    panel.innerHTML = `
      <div class="title">💥 GeoFS Real Impact v2.3</div>
      <label>Max altitude to count as impact (ft, above bare terrain) <span class="val" id="cur-a-val">${settings.minAltitudeFt}</span></label>
      <input type="range" id="cur-alt" min="15" max="300" step="5" value="${settings.minAltitudeFt}">
      <label>Min speed to arm the crash check (kts) <span class="val" id="cur-s-val">${settings.minSpeedKts}</span></label>
      <input type="range" id="cur-speed" min="0" max="60" step="1" value="${settings.minSpeedKts}">
      <label>Object height threshold -- buildings (m) <span class="val" id="cur-h-val">${settings.objectHeightThresholdM}</span></label>
      <input type="range" id="cur-height" min="0.5" max="10" step="0.5" value="${settings.objectHeightThresholdM}">
      <label>Tree detection radius (m) <span class="val" id="cur-t-val">${settings.treeRadiusM}</span></label>
      <input type="range" id="cur-tree" min="2" max="20" step="0.5" value="${settings.treeRadiusM}">
      <label>Sampling offset (m) <span class="val" id="cur-o-val">${settings.sampleOffsetM}</span></label>
      <input type="range" id="cur-offset" min="2" max="20" step="1" value="${settings.sampleOffsetM}">
      <button class="toggle-btn" id="cur-toggle">${settings.enabled ? "Disable" : "Enable"}</button>
      <button class="reset-btn" id="cur-reset">Force end of fall mode (debug)</button>
      <div class="status-line">${treesStatus}</div>
    `;
    document.body.appendChild(panel);

    panel.querySelector("#cur-alt").oninput = function () {
      settings.minAltitudeFt = parseFloat(this.value);
      panel.querySelector("#cur-a-val").textContent = this.value;
    };
    panel.querySelector("#cur-speed").oninput = function () {
      settings.minSpeedKts = parseFloat(this.value);
      panel.querySelector("#cur-s-val").textContent = this.value;
    };
    panel.querySelector("#cur-height").oninput = function () {
      settings.objectHeightThresholdM = parseFloat(this.value);
      panel.querySelector("#cur-h-val").textContent = this.value;
    };
    panel.querySelector("#cur-tree").oninput = function () {
      settings.treeRadiusM = parseFloat(this.value);
      panel.querySelector("#cur-t-val").textContent = this.value;
    };
    panel.querySelector("#cur-offset").oninput = function () {
      settings.sampleOffsetM = parseFloat(this.value);
      panel.querySelector("#cur-o-val").textContent = this.value;
    };
    panel.querySelector("#cur-toggle").onclick = function () {
      settings.enabled = !settings.enabled;
      this.textContent = settings.enabled ? "Disable" : "Enable";
    };
    panel.querySelector("#cur-reset").onclick = stopForcedFall;
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "]" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      showPanel();
    }
  });

  // ============================================================
  // 6. Initialization
  // ============================================================
  function tryInit() {
    if (injected) return;
    if (!window.geofs?.aircraft?.instance || typeof window.controls === "undefined") return;
    injected = true;

    if (window.geofs.preferences && !geofs.preferences.crashDetection) {
      geofs.preferences.crashDetection = true;
    }
    hookControlsForForcedFall();
    hookResetFlight();

    setInterval(mainLoop, 200);
    const treesReady = typeof window.geofsRealTrees?.isTreeNear === "function";
    console.log(`[Real Impact] 💥 v2.3 ready. Tree detection: ${treesReady ? "active" : "NOT available (install GeoFS Real Tree Positions Extractor)"}. Press ] to open the console.`);
  }

  let attempts = 0;
  const poller = setInterval(() => {
    tryInit();
    if (injected || ++attempts > 120) clearInterval(poller);
  }, 300);
  window.addEventListener("load", tryInit);
})();
