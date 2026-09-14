// ==UserScript==
// @name         GeoFS Real Impact — Precision Crash Detection
// @namespace    https://www.geo-fs.com/geofs.php?v=4
// @version      3.4.2
// @description  Forces a real crash (engine cutout + forced loss of control) only when you actually hit a real detected obstacle -- a real tree or a real building at your exact position. Uses geofsRealTrees with cylinder collision support and terrain sampling for buildings. v3.4.2: Quiet & optimized console logging (clean crash banner, debugLogs toggle in panel/API) + universal altitude ceiling + Exit button.
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

  const DEFAULTS = Object.freeze({
    enabled: true,
    minAltitudeFt: 120, // Nudged from 80 -> 120ft to comfortably cover tall 30-35m tree canopies without cruise false alerts
    buildingMaxAltitudeFt: 3300,
    minSpeedKts: 15,
    objectHeightThresholdM: 4,
    buildingsEnabled: true,
    treeRadiusM: 13.5,            // Horizontal radius for tree canopy/trunk collision
    treeCanopyHeightM: 32,        // FIX v3.4: Vertical tree canopy height (meters) passed to Extractor v1.9.0
    sampleOffsetM: 8,
    buildingConfirmChecks: 2,
    buildingVerticalMarginM: 2,
    cooldownMs: 3000,
    spawnGraceMs: 4000,
    debugLogs: false              // Clean, quiet console by default
  });

  const settings = { ...DEFAULTS };

  // ============================================================
  // 0.1 PERSISTENCE (localStorage)
  // ============================================================
  const STORAGE_KEY = "geofs-real-impact-settings";

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      Object.keys(DEFAULTS).forEach((key) => {
        if (key in saved) settings[key] = saved[key];
      });
    } catch (e) {
      console.warn("[Real Impact] Failed to load saved settings:", e);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn("[Real Impact] Failed to save settings:", e);
    }
  }

  loadSettings();

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

  let fallbackWarned = false;

  function sampleHeightAtAircraft(viewer, lat, lon, headingDeg) {
    const Cesium = getCesium();
    if (!Cesium || !viewer) return null;

    const obj3d = window.geofs?.aircraft?.instance?.object3d;
    const canHide = !!(obj3d && typeof obj3d.setVisibility === "function");

    if (!canHide && !fallbackWarned) {
      fallbackWarned = true;
      console.warn("[Real Impact] object3d.setVisibility not available -- falling back to lateral-offset sampling.");
    }

    let sampleLat = lat, sampleLon = lon;
    if (!canHide) {
      const offset = offsetLatLon(lat, lon, headingDeg, settings.sampleOffsetM);
      sampleLat = offset.lat;
      sampleLon = offset.lon;
    }

    const carto = new Cesium.Cartographic(
      Cesium.Math.toRadians(sampleLon),
      Cesium.Math.toRadians(sampleLat)
    );

    let renderedHeight = null;
    try {
      if (canHide) obj3d.setVisibility(false);
      renderedHeight = viewer.scene.sampleHeight(carto);
    } catch (e) {
      renderedHeight = null;
    } finally {
      if (canHide) obj3d.setVisibility(true);
    }

    if (renderedHeight == null) return null;
    return { renderedHeight, sampleLat, sampleLon };
  }

  async function hasBuildingAtExactPosition(viewer, lat, lon, headingDeg, altM) {
    const Cesium = getCesium();
    if (!Cesium || !viewer) return false;

    const sampled = sampleHeightAtAircraft(viewer, lat, lon, headingDeg);
    if (!sampled) return false;
    const { renderedHeight, sampleLat, sampleLon } = sampled;

    const latRad = Cesium.Math.toRadians(sampleLat);
    const lonRad = Cesium.Math.toRadians(sampleLon);
    const carto = new Cesium.Cartographic(lonRad, latRad);

    let terrainHeight;
    try {
      terrainHeight = viewer.scene.globe.getHeight(carto);
    } catch (e) {
      return false;
    }
    if (terrainHeight == null || !Number.isFinite(terrainHeight)) return false;

    const diff = renderedHeight - terrainHeight;
    const hasTallObject = diff >= settings.objectHeightThresholdM;

    let clearance = null;
    let withinVerticalRange = true;
    if (typeof altM === "number" && Number.isFinite(altM)) {
      clearance = altM - renderedHeight;
      withinVerticalRange = clearance <= settings.buildingVerticalMarginM;
    }

    const isHit = hasTallObject && withinVerticalRange;

    if (hasTallObject && settings.debugLogs) {
      console.log(
        `[Real Impact][DEBUG] raw building hit -- lat=${sampleLat.toFixed(6)} lon=${sampleLon.toFixed(6)} ` +
        `renderedHeight=${renderedHeight.toFixed(2)}m terrainHeight=${terrainHeight.toFixed(2)}m diff=${diff.toFixed(2)}m ` +
        `(threshold=${settings.objectHeightThresholdM}m) altM=${altM != null ? altM.toFixed(2) : "n/a"} ` +
        `clearance=${clearance != null ? clearance.toFixed(2) + "m" : "n/a"} ` +
        `(margin=${settings.buildingVerticalMarginM}m) -> ${isHit ? "CONFIRMED" : "too high above it, ignored"}`
      );
    }

    return isHit;
  }

  // FIX v3.4.1: Passes settings.treeCanopyHeightM to the cylinder-aware isTreeNear/findNearestTree,
  // with STRICT universal altitude ceiling enforcement (never trigger if altFt > minAltitudeFt).
  function hasTreeAtExactPosition(lat, lon, heightM, speedKts, altFt) {
    if (typeof window.geofsRealTrees?.isTreeNear !== "function") return false;

    // HARD UNIVERSAL CEILING: If the aircraft AGL altitude exceeds the configured threshold,
    // it is mathematically impossible to hit a tree under any edge case.
    if (typeof altFt === "number" && altFt > settings.minAltitudeFt) {
      return false;
    }

    // Synchronize vertical canopy collision height: canopy collision height in meters
    // is strictly capped by the user-configured altitude gate (converted from feet to meters).
    const maxCanopyFromAltM = settings.minAltitudeFt * 0.3048;
    const effectiveCanopyM = Math.min(settings.treeCanopyHeightM, maxCanopyFromAltM);

    const hit = window.geofsRealTrees.isTreeNear(lat, lon, settings.treeRadiusM, heightM, effectiveCanopyM);
    if (hit && settings.debugLogs) {
      let matchInfo = "";
      if (typeof window.geofsRealTrees?.findNearestTree === "function") {
        const match = window.geofsRealTrees.findNearestTree(lat, lon, settings.treeRadiusM, heightM, effectiveCanopyM);
        if (match) {
          const horizStr = match.horizDistance != null ? ` horizDist=${match.horizDistance.toFixed(2)}m,` : "";
          const relHStr = match.relHeight != null ? ` relHeight=${match.relHeight.toFixed(2)}m (canopy ${match.canopyHeight || effectiveCanopyM.toFixed(1)}m),` : "";
          matchInfo = ` matchedTree{lat=${match.lat.toFixed(6)}, lon=${match.lon.toFixed(6)}, ` +
            `baseAlt=${match.height.toFixed(2)}m,${horizStr}${relHStr} 3dDist=${match.distance.toFixed(2)}m, tile=${match.tileId}}`;
        }
      }
      console.log(
        `[Real Impact][DEBUG] 💥 cylinder tree hit -- lat=${lat.toFixed(6)} lon=${lon.toFixed(6)} ` +
        `altM=${typeof heightM === "number" ? heightM.toFixed(2) : "n/a"} haglFt=${typeof altFt === "number" ? altFt.toFixed(1) : "n/a"} ` +
        `radius=${settings.treeRadiusM}m canopy=${effectiveCanopyM.toFixed(1)}m ` +
        `speed=${typeof speedKts === "number" ? speedKts.toFixed(1) + "kt" : "n/a"}${matchInfo}`
      );
    }
    return hit;
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
  let consecutiveBuildingHits = 0;

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
      consecutiveBuildingHits = 0;
    }
    lastCrashedState = currentCrashed;

    if (performance.now() < spawnGraceUntil) return;
    if (forceFallActive) return;
    if (checkInFlight) return;

    const now = performance.now();
    if (now - lastCrashTime < settings.cooldownMs) return;

    const altFt = values.haglFeet;
    const speedKts = values.kias || 0;
    if (altFt == null) return;
    if (speedKts < settings.minSpeedKts) return;

    const treesArmed = altFt <= settings.minAltitudeFt;
    const buildingsArmed = altFt <= settings.buildingMaxAltitudeFt;

    // FIX v3.4.1: Strictly isolate tree checks to treesArmed.
    // Never allow building altitude checks to accidentally keep tree collision active at high altitudes!
    const treeCheckArmed = treesArmed;
    if (!buildingsArmed) consecutiveBuildingHits = 0;
    if (!treeCheckArmed && !buildingsArmed) return;

    const lla = instance.lastLlaLocation;
    if (!lla) return;
    const [lat, lon, altM] = lla;
    const headingDeg = values.heading || 0;

    checkInFlight = true;
    try {
      let hit = false;

      if (treeCheckArmed && hasTreeAtExactPosition(lat, lon, altM, speedKts, altFt)) {
        hit = true;
      }

      if (!hit && buildingsArmed && settings.buildingsEnabled) {
        const buildingHit = await hasBuildingAtExactPosition(viewer, lat, lon, headingDeg, altM);
        consecutiveBuildingHits = buildingHit ? consecutiveBuildingHits + 1 : 0;
        hit = consecutiveBuildingHits >= settings.buildingConfirmChecks;
      }

      if (hit) {
        consecutiveBuildingHits = 0;
        lastCrashTime = performance.now();
        instance.crash();
        hookControlsForForcedFall();
        startForcedFall();
        showToast("💥 Impact against a real obstacle detected", true);
        const altStr = typeof altFt === "number" ? `${altFt.toFixed(0)}ft AGL` : "n/a";
        const spdStr = typeof speedKts === "number" ? `${speedKts.toFixed(0)}kt` : "n/a";
        console.log(
          `%c[Real Impact]%c 💥 FORCED CRASH -- obstacle confirmed at lat=${lat.toFixed(5)}, lon=${lon.toFixed(5)} (${altStr}, ${spdStr})`,
          "color:#ef4444;font-weight:bold;",
          "color:#fca5a5;"
        );
      }
    } finally {
      checkInFlight = false;
    }
  }

  // ============================================================
  // 5. Console Panel (] key)
  // ============================================================
  function showPanel() {
    if (panel) { panel.remove(); panel = null; return; }

    const style = document.createElement("style");
    style.textContent = `
      #cur-panel {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(20,10,10,0.92); backdrop-filter: blur(12px);
        padding: 18px; border-radius: 14px; z-index: 100000;
        min-width: 320px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
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
      #cur-panel .defaults-btn { background: rgba(255,255,255,0.1); color: #ddd; }
      #cur-panel .status-line {
        margin-top: 10px; padding: 6px 8px; background: rgba(0,0,0,0.25);
        border-radius: 6px; font-size: 11px; color: #cabfbf;
      }
    `;
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.id = "cur-panel";
    const treesStatus = typeof window.geofsRealTrees?.isTreeNear === "function"
      ? "✅ Tree extractor connected (Cylinder Mode)"
      : "⚠️ Tree extractor NOT detected (only buildings are active)";
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:8px;">
        <div class="title" style="margin:0; text-align:left; font-size:15px;">💥 GeoFS Real Impact v3.4.2</div>
        <button id="cur-close-x" style="width:26px; height:26px; margin:0; padding:0; line-height:24px; background:rgba(255,255,255,0.12); hover:bg:rgba(255,255,255,0.25); border:1px solid rgba(255,255,255,0.25); border-radius:6px; color:#fff; font-size:15px; cursor:pointer; font-weight:bold; display:flex; align-items:center; justify-content:center;" title="Cerrar panel (] o clic)">✕</button>
      </div>
      <label>Max tree impact gate (ft, above ground) <span class="val" id="cur-a-val">${settings.minAltitudeFt}</span></label>
      <input type="range" id="cur-alt" min="15" max="300" step="5" value="${settings.minAltitudeFt}">
      <label>Max building impact gate (ft, above ground) <span class="val" id="cur-b-val">${settings.buildingMaxAltitudeFt}</span></label>
      <input type="range" id="cur-balt" min="200" max="3500" step="50" value="${settings.buildingMaxAltitudeFt}">
      <label>Min speed to arm crash check (kts) <span class="val" id="cur-s-val">${settings.minSpeedKts}</span></label>
      <input type="range" id="cur-speed" min="0" max="60" step="1" value="${settings.minSpeedKts}">
      <label>Tree canopy collision height (m) <span class="val" id="cur-th-val">${settings.treeCanopyHeightM}</span></label>
      <input type="range" id="cur-treeheight" min="10" max="50" step="1" value="${settings.treeCanopyHeightM}">
      <label>Tree horizontal radius (m) <span class="val" id="cur-t-val">${settings.treeRadiusM}</span></label>
      <input type="range" id="cur-tree" min="2" max="20" step="0.5" value="${settings.treeRadiusM}">
      <label>Building height threshold (m) <span class="val" id="cur-h-val">${settings.objectHeightThresholdM}</span></label>
      <input type="range" id="cur-height" min="0.5" max="10" step="0.5" value="${settings.objectHeightThresholdM}">
      <label>Building vertical clearance margin (m) <span class="val" id="cur-v-val">${settings.buildingVerticalMarginM}</span></label>
      <input type="range" id="cur-vmargin" min="1" max="30" step="1" value="${settings.buildingVerticalMarginM}">
      <label>Building confirmation passes <span class="val" id="cur-c-val">${settings.buildingConfirmChecks}</span></label>
      <input type="range" id="cur-confirm" min="1" max="5" step="1" value="${settings.buildingConfirmChecks}">
      <button class="toggle-btn" id="cur-toggle">${settings.enabled ? "Disable" : "Enable"}</button>
      <button class="reset-btn" id="cur-bldg-toggle">${settings.buildingsEnabled ? "Disable buildings only" : "Enable buildings only"}</button>
      <button class="reset-btn" id="cur-debug-toggle">Console: ${settings.debugLogs ? "Verbose (Debug)" : "Quiet (Clean)"}</button>
      <button class="reset-btn" id="cur-reset">Force end of fall mode (debug)</button>
      <button class="defaults-btn" id="cur-defaults">↺ Restore default values</button>
      <button id="cur-close-bottom" style="background:#2d1515; color:#ff9999; border:1px solid rgba(255,80,80,0.35); font-size:12px; margin-top:10px;">✕ Cerrar Panel (o tecla ])</button>
      <div class="status-line">${treesStatus}</div>
    `;
    document.body.appendChild(panel);

    panel.querySelector("#cur-debug-toggle").onclick = function () {
      settings.debugLogs = !settings.debugLogs;
      this.textContent = `Console: ${settings.debugLogs ? "Verbose (Debug)" : "Quiet (Clean)"}`;
      saveSettings();
    };

    panel.querySelector("#cur-alt").oninput = function () {
      settings.minAltitudeFt = parseFloat(this.value);
      panel.querySelector("#cur-a-val").textContent = this.value;
      saveSettings();
    };
    panel.querySelector("#cur-balt").oninput = function () {
      settings.buildingMaxAltitudeFt = parseFloat(this.value);
      panel.querySelector("#cur-b-val").textContent = this.value;
      saveSettings();
    };
    panel.querySelector("#cur-speed").oninput = function () {
      settings.minSpeedKts = parseFloat(this.value);
      panel.querySelector("#cur-s-val").textContent = this.value;
      saveSettings();
    };
    panel.querySelector("#cur-treeheight").oninput = function () {
      settings.treeCanopyHeightM = parseFloat(this.value);
      panel.querySelector("#cur-th-val").textContent = this.value;
      saveSettings();
    };
    panel.querySelector("#cur-tree").oninput = function () {
      settings.treeRadiusM = parseFloat(this.value);
      panel.querySelector("#cur-t-val").textContent = this.value;
      saveSettings();
    };
    panel.querySelector("#cur-height").oninput = function () {
      settings.objectHeightThresholdM = parseFloat(this.value);
      panel.querySelector("#cur-h-val").textContent = this.value;
      saveSettings();
    };
    panel.querySelector("#cur-vmargin").oninput = function () {
      settings.buildingVerticalMarginM = parseFloat(this.value);
      panel.querySelector("#cur-v-val").textContent = this.value;
      saveSettings();
    };
    panel.querySelector("#cur-confirm").oninput = function () {
      settings.buildingConfirmChecks = parseFloat(this.value);
      panel.querySelector("#cur-c-val").textContent = this.value;
      saveSettings();
    };
    panel.querySelector("#cur-toggle").onclick = function () {
      settings.enabled = !settings.enabled;
      this.textContent = settings.enabled ? "Disable" : "Enable";
      saveSettings();
    };
    panel.querySelector("#cur-bldg-toggle").onclick = function () {
      settings.buildingsEnabled = !settings.buildingsEnabled;
      this.textContent = settings.buildingsEnabled ? "Disable buildings only" : "Enable buildings only";
      saveSettings();
    };
    panel.querySelector("#cur-reset").onclick = stopForcedFall;
    panel.querySelector("#cur-defaults").onclick = function () {
      Object.assign(settings, DEFAULTS);
      saveSettings();
      panel.remove();
      panel = null;
      showPanel();
    };
    function closePanel() {
      if (panel) {
        panel.remove();
        panel = null;
      }
    }
    panel.querySelector("#cur-close-x").onclick = closePanel;
    panel.querySelector("#cur-close-bottom").onclick = closePanel;
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "]" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      showPanel();
    }
  });

  window.realImpact = {
    settings,
    setDebug: (enabled) => {
      settings.debugLogs = !!enabled;
      saveSettings();
      console.log(`[Real Impact] Debug logs: ${settings.debugLogs ? "ON (verbose)" : "OFF (quiet)"}`);
    },
    stopForcedFall,
    showPanel
  };

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
    console.log(
      `%c[Real Impact]%c 💥 v3.4.2 ready · Trees: ${treesReady ? "CYLINDER (gate: " + settings.minAltitudeFt + "ft, canopy: " + settings.treeCanopyHeightM + "m)" : "NOT detected"} · Press ] for Settings`,
      "color:#f43f5e;font-weight:bold;",
      "color:#94a3b8;"
    );
  }

  let attempts = 0;
  const poller = setInterval(() => {
    tryInit();
    if (injected || ++attempts > 120) clearInterval(poller);
  }, 300);
  window.addEventListener("load", tryInit);
})();
