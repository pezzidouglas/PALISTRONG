/* ===========================================================================
   Pali Rebuild Map — application logic
   Leaflet + canvas circle markers, status filters, address search, and a
   time-lapse that replays the rebuild from the January 2025 fire to today.
   =========================================================================== */
(function () {
  "use strict";

  var DATA_URL = "data/homes.geojson";
  var STATS_URL = "data/stats.json";

  // Palisades village center-ish; good default framing of the burn area.
  var CENTER = [34.046, -118.531];
  var DEFAULT_ZOOM = 14;

  var map, canvasRenderer, markers = [], statsData, statuses = [], statusColor = {};
  var timelineMin, timelineMax; // ms
  var activeStatus = { submitted: true, issued: true, construction: true, completed: true };
  var activeHood = "";
  var currentT; // ms currently shown by the timeline
  var playing = false, rafId = null, lastFrame = 0;
  var searchMarker = null;

  var $ = function (id) { return document.getElementById(id); };
  var fmtNum = function (n) { return n.toLocaleString("en-US"); };

  var dfLong = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });
  var dfMonth = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "long", timeZone: "UTC",
  });
  function parseDate(s) { return s ? Date.parse(s + "T00:00:00Z") : null; }
  function fmtDate(ms) { return ms == null ? "—" : dfLong.format(new Date(ms)); }

  /* ----------------------------- bootstrap ------------------------------- */
  Promise.all([
    fetch(DATA_URL).then(function (r) { return r.json(); }),
    fetch(STATS_URL).then(function (r) { return r.json(); }),
  ])
    .then(function (res) { init(res[0], res[1]); })
    .catch(function (err) {
      console.error(err);
      var el = $("mapLoading");
      if (el) {
        el.textContent =
          "Could not load rebuild data. Serve this folder over HTTP (see README).";
      }
    });

  function init(geojson, stats) {
    statsData = stats;
    statuses = stats.statuses.slice().sort(function (a, b) { return a.order - b.order; });
    statuses.forEach(function (s) { statusColor[s.key] = s.color; });

    timelineMin = parseDate(stats.timeline.start);
    timelineMax = parseDate(stats.timeline.end);
    currentT = timelineMax;

    $("lastUpdated").textContent = "Last updated " + fmtDate(timelineMax);
    $("timelineEndLabel").textContent = dfMonth.format(new Date(timelineMax));

    buildStatCards();
    buildLegend();
    buildHoodSelect();
    initMap();
    buildMarkers(geojson.features);
    addNeighborhoodLabels();
    wireControls();

    updateAll();
    var loading = $("mapLoading");
    loading.classList.add("is-hidden");
    setTimeout(function () { loading.style.display = "none"; }, 400);
  }

  /* ----------------------------- stat cards ------------------------------ */
  // Order matters: cumulative funnel across the pipeline.
  var CARD_DEFS = [
    { key: "submitted", label: "Permits Submitted" },
    { key: "issued", label: "Permits Issued" },
    { key: "construction", label: "Under Construction" },
    { key: "completed", label: "Homes Completed" },
  ];
  function buildStatCards() {
    var host = $("stats");
    host.innerHTML = "";
    CARD_DEFS.forEach(function (c) {
      var el = document.createElement("div");
      el.className = "stat-card";
      el.style.setProperty("--accent", statusColor[c.key]);
      el.innerHTML =
        '<div class="num" id="card-' + c.key + '">0</div>' +
        '<div class="lbl"><span class="dot"></span>' + c.label + "</div>";
      host.appendChild(el);
    });
  }
  function setCards(funnel) {
    CARD_DEFS.forEach(function (c) {
      $("card-" + c.key).textContent = fmtNum(funnel[c.key]);
    });
  }

  /* ------------------------------- legend -------------------------------- */
  function buildLegend() {
    var host = $("legend");
    host.innerHTML = "";
    statuses.forEach(function (s) {
      var li = document.createElement("li");
      li.dataset.key = s.key;
      li.innerHTML =
        '<span class="swatch" style="background:' + s.color + '"></span>' +
        '<span class="l-label">' + s.label + "</span>" +
        '<span class="l-count" id="leg-' + s.key + '"></span>';
      li.addEventListener("click", function () {
        activeStatus[s.key] = !activeStatus[s.key];
        li.classList.toggle("is-off", !activeStatus[s.key]);
        updateAll();
      });
      host.appendChild(li);
    });
  }

  function buildHoodSelect() {
    var sel = $("hoodSelect");
    Object.keys(statsData.byNeighborhood).forEach(function (name) {
      var o = document.createElement("option");
      o.value = name;
      o.textContent = name + " (" + fmtNum(statsData.byNeighborhood[name].total) + ")";
      sel.appendChild(o);
    });
  }

  /* -------------------------------- map ---------------------------------- */
  function initMap() {
    map = L.map("map", {
      center: CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: 12,
      maxZoom: 19,
      zoomControl: true,
      preferCanvas: true,
    });

    // Dedicated pane for satellite road labels: above tiles, below markers.
    map.createPane("labels");
    map.getPane("labels").style.zIndex = 350;
    map.getPane("labels").style.pointerEvents = "none";

    var street = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 20,
        subdomains: "abcd",
      }
    );
    var satellite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
        maxZoom: 19,
      }
    );
    var labels = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png",
      { maxZoom: 20, subdomains: "abcd", pane: "labels", opacity: 0.9 }
    );

    street.addTo(map);
    map._bases = { street: street, satellite: satellite, labels: labels };

    canvasRenderer = L.canvas({ padding: 0.5 });
  }

  function setBasemap(which) {
    var b = map._bases;
    if (which === "satellite") {
      map.removeLayer(b.street);
      b.satellite.addTo(map);
      b.labels.addTo(map);
    } else {
      map.removeLayer(b.satellite);
      map.removeLayer(b.labels);
      b.street.addTo(map);
    }
    // keep markers above tiles
    markers.forEach(function (m) { m.marker.bringToFront(); });
  }

  /* ------------------------------ markers -------------------------------- */
  function buildMarkers(features) {
    features.forEach(function (f) {
      var p = f.properties;
      var c = f.geometry.coordinates;
      var m = L.circleMarker([c[1], c[0]], {
        renderer: canvasRenderer,
        radius: 5,
        weight: 1,
        color: "#ffffff",
        fillColor: statusColor[p.status],
        fillOpacity: 0.92,
        interactive: true,
      });
      m.bindPopup(function () { return popupHtml(p, milestone); }, {
        closeButton: true,
        autoPanPadding: [30, 30],
      });
      var milestone = {
        submitted: parseDate(p.submittedDate),
        issued: parseDate(p.issuedDate),
        start: parseDate(p.startDate),
        completed: parseDate(p.completedDate),
        est: parseDate(p.estCompletionDate),
      };
      var rec = { marker: m, p: p, ms: milestone, addr: (p.address + " " + p.neighborhood).toLowerCase() };
      m.addTo(map);
      markers.push(rec);
    });
  }

  // Permanent, non-interactive neighborhood labels at each cluster's centroid.
  // Gives geographic orientation even before basemap tiles paint.
  function addNeighborhoodLabels() {
    var sums = {};
    markers.forEach(function (r) {
      var n = r.p.neighborhood;
      var ll = r.marker.getLatLng();
      if (!sums[n]) sums[n] = { lat: 0, lng: 0, c: 0 };
      sums[n].lat += ll.lat; sums[n].lng += ll.lng; sums[n].c++;
    });
    Object.keys(sums).forEach(function (n) {
      var s = sums[n];
      L.marker([s.lat / s.c, s.lng / s.c], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: "hood-label", html: n, iconSize: [0, 0] }),
      }).addTo(map);
    });
  }

  // Effective status of a lot as of time t (ms). null = not yet in pipeline.
  function statusAt(ms, t) {
    if (ms.submitted == null || t < ms.submitted) return null;
    if (ms.completed != null && t >= ms.completed) return "completed";
    if (ms.start != null && t >= ms.start) return "construction";
    if (ms.issued != null && t >= ms.issued) return "issued";
    return "submitted";
  }

  /* --------------------------- master update ----------------------------- */
  // Recompute marker visibility/color, funnel counts, and legend counts for
  // the current time + filters — the single source of truth for on-screen state.
  function updateAll() {
    var live = currentT >= timelineMax;
    var funnel = { submitted: 0, issued: 0, construction: 0, completed: 0 };
    var perStatus = { submitted: 0, issued: 0, construction: 0, completed: 0 };
    var visible = 0;

    for (var i = 0; i < markers.length; i++) {
      var rec = markers[i];
      var st = live ? rec.p.status : statusAt(rec.ms, currentT);

      // cumulative funnel (as-of currentT), independent of filters
      if (st === "submitted" || st === "issued" || st === "construction" || st === "completed") {
        funnel.submitted++;
        perStatus[st]++;
        if (st === "issued" || st === "construction" || st === "completed") funnel.issued++;
        if (st === "construction" || st === "completed") funnel.construction++;
        if (st === "completed") funnel.completed++;
      }

      var show = st != null && activeStatus[st] &&
        (activeHood === "" || rec.p.neighborhood === activeHood);

      if (show) {
        visible++;
        rec.marker.setStyle({
          radius: 5, fillOpacity: 0.92, opacity: 1,
          fillColor: statusColor[st], stroke: true,
        });
        rec.marker.options.interactive = true;
        rec.hidden = false;
      } else if (!rec.hidden) {
        rec.marker.setStyle({ radius: 0, fillOpacity: 0, opacity: 0, stroke: false });
        rec.marker.options.interactive = false;
        rec.hidden = true;
      }
    }

    setCards(funnel);
    statuses.forEach(function (s) {
      $("leg-" + s.key).textContent = fmtNum(perStatus[s.key]);
    });
    $("visibleCount").textContent = fmtNum(visible) + " of " + fmtNum(markers.length) + " lots shown";

    // timeline UI
    $("timelineDate").textContent = live ? "Today · " + fmtDate(currentT) : fmtDate(currentT);
    var pct = ((currentT - timelineMin) / (timelineMax - timelineMin)) * 100;
    var slider = $("timeline");
    slider.value = String(Math.round(pct * 10)); // 0..1000
    slider.style.setProperty("--fill", pct + "%");
  }

  /* ------------------------------- popup --------------------------------- */
  function popupHtml(p, ms) {
    var color = statusColor[p.status];
    var rows = "";
    function row(label, ms2) {
      if (ms2 == null) return "";
      return "<dt>" + label + "</dt><dd>" + fmtDate(ms2) + "</dd>";
    }
    rows += row("Submitted", ms.submitted);
    rows += row("Issued", ms.issued);
    rows += row("Construction", ms.start);
    rows += row("Completed", ms.completed);

    var estLine = "";
    if (p.status !== "completed" && ms.est != null) {
      estLine =
        '<div class="pop__est">Est. completion: <b>' + fmtDate(ms.est) + "</b></div>";
    }

    return (
      '<div class="pop">' +
      '<p class="pop__addr">' + p.address + "</p>" +
      '<p class="pop__hood">' + p.neighborhood + " · " + p.permitType + "</p>" +
      '<span class="pop__badge" style="background:' + color + '">' + p.statusLabel + "</span>" +
      '<dl class="pop__rows">' + rows + "</dl>" +
      estLine +
      "</div>"
    );
  }

  /* ------------------------------ controls ------------------------------- */
  function wireControls() {
    // legend toggle (collapse)
    var lt = $("legendToggle");
    lt.addEventListener("click", function () {
      var open = lt.getAttribute("aria-expanded") === "true";
      lt.setAttribute("aria-expanded", String(!open));
      $("legendBody").hidden = open;
    });

    // neighborhood
    $("hoodSelect").addEventListener("change", function (e) {
      activeHood = e.target.value;
      updateAll();
      if (activeHood) zoomToHood(activeHood);
    });

    // basemap
    document.querySelectorAll(".seg__btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll(".seg__btn").forEach(function (b) { b.classList.remove("is-active"); });
        btn.classList.add("is-active");
        setBasemap(btn.dataset.base);
      });
    });

    // timeline
    var slider = $("timeline");
    slider.addEventListener("input", function () {
      stopPlay();
      var frac = Number(slider.value) / 1000;
      currentT = timelineMin + frac * (timelineMax - timelineMin);
      updateAll();
    });
    $("playBtn").addEventListener("click", function () {
      if (playing) stopPlay(); else startPlay();
    });
    $("timelineReset").addEventListener("click", function () {
      stopPlay();
      currentT = timelineMax;
      updateAll();
    });

    // search
    wireSearch();
  }

  function zoomToHood(name) {
    var pts = [];
    markers.forEach(function (r) {
      if (r.p.neighborhood === name) pts.push(r.marker.getLatLng());
    });
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 16 });
  }

  /* ---------------------------- time-lapse ------------------------------- */
  var PLAY_MS = 16000; // full timeline duration
  function startPlay() {
    playing = true;
    togglePlayIcon(true);
    if (currentT >= timelineMax) currentT = timelineMin; // restart from the fire
    lastFrame = 0;
    rafId = requestAnimationFrame(step);
  }
  function stopPlay() {
    if (!playing) return;
    playing = false;
    togglePlayIcon(false);
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }
  function step(ts) {
    if (!playing) return;
    if (!lastFrame) lastFrame = ts;
    var dt = ts - lastFrame;
    lastFrame = ts;
    var span = timelineMax - timelineMin;
    currentT += (dt / PLAY_MS) * span;
    if (currentT >= timelineMax) {
      currentT = timelineMax;
      updateAll();
      stopPlay();
      return;
    }
    updateAll();
    rafId = requestAnimationFrame(step);
  }
  function togglePlayIcon(isPlaying) {
    $("playBtn").querySelector(".ico-play").hidden = isPlaying;
    $("playBtn").querySelector(".ico-pause").hidden = !isPlaying;
    $("playBtn").setAttribute(
      "aria-label",
      isPlaying ? "Pause rebuild time-lapse" : "Play rebuild time-lapse"
    );
  }

  /* ------------------------------ search --------------------------------- */
  function wireSearch() {
    var input = $("searchInput");
    var results = $("searchResults");
    var clear = $("searchClear");
    var timer = null;

    function run() {
      var q = input.value.trim().toLowerCase();
      clear.hidden = q.length === 0;
      if (q.length < 2) { results.hidden = true; results.innerHTML = ""; return; }

      var hits = [];
      for (var i = 0; i < markers.length && hits.length < 40; i++) {
        if (markers[i].addr.indexOf(q) !== -1) hits.push(markers[i]);
      }
      hits.sort(function (a, b) { return a.p.address.localeCompare(b.p.address, "en", { numeric: true }); });
      renderResults(hits.slice(0, 8), q);
    }

    function renderResults(hits, q) {
      results.innerHTML = "";
      if (!hits.length) {
        var li = document.createElement("li");
        li.className = "r-empty";
        li.textContent = 'No lots match "' + q + '".';
        results.appendChild(li);
        results.hidden = false;
        return;
      }
      hits.forEach(function (rec) {
        var li = document.createElement("li");
        li.setAttribute("role", "option");
        li.innerHTML =
          '<span class="swatch" style="background:' + statusColor[rec.p.status] + '"></span>' +
          '<span><span class="r-addr">' + rec.p.address + "</span> " +
          '<span class="r-hood">' + rec.p.neighborhood + "</span></span>";
        li.addEventListener("click", function () { gotoLot(rec); });
        results.appendChild(li);
      });
      results.hidden = false;
    }

    function gotoLot(rec) {
      results.hidden = true;
      input.value = rec.p.address;
      clear.hidden = false;
      // make sure it's visible regardless of filters/time
      currentT = timelineMax;
      activeStatus[rec.p.status] = true;
      document.querySelectorAll(".legend li").forEach(function (li) {
        if (li.dataset.key === rec.p.status) li.classList.remove("is-off");
      });
      updateAll();
      map.setView(rec.marker.getLatLng(), 18, { animate: true });
      rec.marker.openPopup();
      pulse(rec.marker.getLatLng());
    }

    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    });
    input.addEventListener("focus", run);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var first = results.querySelector('li[role="option"]');
        if (first) first.click();
      } else if (e.key === "Escape") {
        results.hidden = true;
        input.blur();
      }
    });
    clear.addEventListener("click", function () {
      input.value = "";
      clear.hidden = true;
      results.hidden = true;
      results.innerHTML = "";
      input.focus();
    });
    document.addEventListener("click", function (e) {
      if (!$("searchPanel").contains(e.target)) results.hidden = true;
    });
  }

  // brief highlight ring at a location
  var pulseIv = null;
  function pulse(latlng) {
    if (pulseIv) { clearInterval(pulseIv); pulseIv = null; }
    if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
    var ring = L.circleMarker(latlng, {
      renderer: canvasRenderer,
      radius: 14, color: "#b3282d", weight: 3, fill: false, interactive: false,
    }).addTo(map);
    searchMarker = ring;
    var r = 14;
    pulseIv = setInterval(function () {
      r += 2;
      if (r > 34) {
        clearInterval(pulseIv);
        pulseIv = null;
        map.removeLayer(ring);
        if (searchMarker === ring) searchMarker = null;
        return;
      }
      ring.setStyle({ radius: r, opacity: Math.max(0, 1 - (r - 14) / 22) });
    }, 45);
  }
})();
