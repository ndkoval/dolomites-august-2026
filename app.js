/* Доломиты на гравеле — интерактивная карта вариантов */
"use strict";

const DAY_COLORS = ["#d6336c","#1971c2","#f08c00","#2f9e44","#9c36b5",
                    "#0c8599","#e03131","#66a80f","#5f3dc4","#343a40"];
const SURF = [
  ["bikepath", "велодорожка", "#2f7de1"],
  ["gravel",   "гравий/лес",  "#a4713f"],
  ["quiet",    "тихий асфальт","#9aa0a6"],
  ["prov",     "провинциальная","#f0a63a"],
  ["road",     "с трафиком",  "#e0483d"],
  ["ferry",    "паром",       "#28b7d0"],
];

let VARIANTS = [], DAY_CACHE = {}, KOMOOT = {}, cur = null, curDays = [];
let startDate = localStorage.getItem("tripStart") || "2026-08-14";
if (startDate === "2026-08-22") { startDate = "2026-08-14"; localStorage.setItem("tripStart", startDate); }
const RU_DAYS = ["вс","пн","вт","ср","чт","пт","сб"];
const RU_MON = ["янв","фев","мар","апр","мая","июн","июл","авг","сен","окт","ноя","дек"];
function dayDateFor(i) { // i — индекс дня; опциональный хвост живёт в дате последнего базового дня
  const base = curDays.filter(x => !x.optional).length;
  return dayDate(curDays[i] && curDays[i].optional ? base : i + 1);
}
function dayDate(n) {
  const [y, m, d] = startDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n - 1));
  return `${RU_DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${RU_MON[t.getUTCMonth()]}`;
}
let map, routeLayer, photoLayer, markerLayer, arrowLayer, elevCursor = null;
let POIS = [], poiLayers = {};
let selectedDay = null, dayLines = {};
let lbList = [], lbIdx = 0;

/* ---------------- загрузка ---------------- */
async function loadJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + " → " + r.status); return r.json(); }
async function getDay(id) {
  if (!DAY_CACHE[id]) {
    DAY_CACHE[id] = await loadJSON("data/days/" + id + ".json");
    prepGeo(DAY_CACHE[id]);
  }
  return DAY_CACHE[id];
}

/* предрасчёт: кумулятивные км по геометрии (для курсора профиля) */
function hav(a, b) {
  const R = 6371, dLa = (b[1]-a[1])*Math.PI/180, dLo = (b[0]-a[0])*Math.PI/180;
  const la1 = a[1]*Math.PI/180, la2 = b[1]*Math.PI/180;
  const h = Math.sin(dLa/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function prepGeo(d) {
  d._cum = []; let km = 0;
  for (const seg of d.geometry) {
    const cums = [];
    for (let i = 0; i < seg.length; i++) {
      if (i) km += hav(seg[i-1], seg[i]);
      cums.push(km);
    }
    d._cum.push(cums);
  }
  d._totKm = km;
}
function coordAtKm(d, km) {
  for (let s = 0; s < d._cum.length; s++) {
    const cums = d._cum[s];
    if (!cums.length || km > cums[cums.length-1]) continue;
    let lo = 0, hi = cums.length - 1;
    while (lo < hi) { const m = (lo+hi)>>1; cums[m] < km ? lo = m+1 : hi = m; }
    return d.geometry[s][lo];
  }
  const seg = d.geometry[d.geometry.length-1];
  return seg[seg.length-1];
}

/* ---------------- карта ---------------- */
function initMap() {
  map = L.map("map", { zoomSnap: 0.5 });
  const cyclosm = L.tileLayer("https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | © <a href="https://openstreetmap.org">OSM</a>' });
  cyclosm.addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  arrowLayer = L.layerGroup().addTo(map);
  photoLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  poiLayers = { swim: L.layerGroup().addTo(map), food: L.layerGroup().addTo(map) };
  L.control.layers(null,
    { "📷 Фото дней": photoLayer,
      "🏊 Купание": poiLayers.swim, "🍝 Поесть": poiLayers.food },
    { position: "topright", collapsed: window.innerWidth < 900 }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  const AllBtn = L.Control.extend({ onAdd() {
    const el = L.DomUtil.create("button", "all-btn"); el.id = "all-btn";
    el.textContent = "ALL"; el.title = "Показать все дни";
    el.style.display = "none";
    L.DomEvent.on(el, "click", e => { L.DomEvent.stop(e); window.showAll(); });
    return el;
  } });
  new AllBtn({ position: "topleft" }).addTo(map);
  map.setView([46.4, 12.2], 9);
  setTimeout(() => map.invalidateSize(), 300);
}

function bearingDeg(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[0]-a[0])*r) * Math.cos(b[1]*r);
  const x = Math.cos(a[1]*r)*Math.sin(b[1]*r) - Math.sin(a[1]*r)*Math.cos(b[1]*r)*Math.cos((b[0]-a[0])*r);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function addArrows(d, color) {
  const tot = d._totKm;
  if (!tot) return;
  const step = Math.max(3.5, tot / 8);
  for (let km = step * 0.6; km < tot - 1; km += step) {
    const a = coordAtKm(d, km), b = coordAtKm(d, Math.min(km + 0.15, tot));
    if (!a || !b || (a[0] === b[0] && a[1] === b[1])) continue;
    const deg = bearingDeg(a, b);
    const icon = L.divIcon({
      className: "dir-arrow-wrap",
      html: `<svg width="18" height="18" viewBox="-9 -9 18 18" style="transform:rotate(${deg.toFixed(0)}deg)">
        <path d="M-4.2,3.4 L0,-4.2 L4.2,3.4" fill="none" stroke="#1c1e21" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/>
        <path d="M-4.2,3.4 L0,-4.2 L4.2,3.4" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`,
      iconSize: [18, 18],
    });
    arrowLayer.addLayer(L.marker([a[1], a[0]], { icon, interactive: false, zIndexOffset: 100 }));
  }
}

function setMapInfo(d, i) {
  const el = document.getElementById("map-info");
  if (!el) return;
  if (!d) {
    const j = curDays.findIndex(x => x.id === selectedDay);
    if (j >= 0) { d = curDays[j]; i = j; }
  }
  if (!d) {
    const base = curDays.filter(x => !x.optional);
    el.innerHTML = curDays.length
      ? `<b>Весь маршрут</b> · ${Math.round(base.reduce((s, x) => s + x.km, 0))} км · ${base.length} дней — тапни день или линию`
      : "";
    return;
  }
  el.innerHTML = `<span class="mi-dot" style="background:${DAY_COLORS[i % DAY_COLORS.length]}"></span>
    <b>${d.optional ? "+" : "День " + (i+1)} · ${dayDateFor(i)}</b> · ${d.km} км · ↑${d.ascent} ↓${d.descent}
    <span class="mi-ft">${esc(d.start)} → ${esc(d.finish)}</span>`;
}

function drawVariant() {
  routeLayer.clearLayers(); photoLayer.clearLayers(); markerLayer.clearLayers(); arrowLayer.clearLayers();
  dayLines = {};
  const bounds = L.latLngBounds([]);
  curDays.forEach((d, i) => {
    const color = DAY_COLORS[i % DAY_COLORS.length];
    dayLines[d.id] = [];
    d.geometry.forEach(seg => {
      const ll = seg.map(c => [c[1], c[0]]);
      ll.forEach(p => bounds.extend(p));
      const casing = L.polyline(ll, { color: "#fff", weight: 8, opacity: d.optional ? .55 : .9 });
      const line = L.polyline(ll, { color, weight: 4.5, opacity: d.optional ? .8 : .96,
        dashArray: d.optional ? "10 7" : null });
      line.on("mouseover", () => { line.setStyle({ weight: 7 }); setMapInfo(d, i); });
      line.on("mouseout",  () => { line.setStyle({ weight: selectedDay === d.id ? 6.5 : 4.5 }); setMapInfo(); });
      line.on("click", () => selectDay(d.id, { fit: false }));
      dayLines[d.id].push({ line, casing, color });
      routeLayer.addLayer(casing); routeLayer.addLayer(line);
    });
    (d.ferryGaps || []).forEach(g => {
      routeLayer.addLayer(L.polyline([[g[0][1], g[0][0]], [g[1][1], g[1][0]]],
        { color: "#28b7d0", weight: 3, dashArray: "6 8", opacity: .85 }));
    });
    addArrows(d, color);
    // маркер номера дня на старте
    const st = d.geometry[0][0];
    markerLayer.addLayer(L.marker([st[1], st[0]], {
      icon: L.divIcon({ className: "daynum-icon", html: String(i+1), iconSize: [26, 26] }),
      zIndexOffset: 500,
    }).on("click", () => selectDay(d.id)));
    // финиш всего маршрута
    if (i === curDays.length - 1) {
      const seg = d.geometry[d.geometry.length-1], fin = seg[seg.length-1];
      markerLayer.addLayer(L.marker([fin[1], fin[0]], {
        icon: L.divIcon({ className: "finish-icon", html: "🏁", iconSize: [24, 24] }), zIndexOffset: 600,
      }));
    }
  });
  drawDayPhotos();
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.06));
}

function drawDayPhotos() {
  photoLayer.clearLayers();
  curDays.forEach(d => {
    if (selectedDay && d.id !== selectedDay) return;
    (d.photos || []).forEach((ph, pi) => {
      const icon = L.divIcon({
        className: "photo-marker-wrap",
        html: `<img class="photo-icon" src="${ph.file}_s.jpg" width="40" height="40" alt="" loading="lazy">`,
        iconSize: [40, 40],
      });
      photoLayer.addLayer(L.marker([ph.coord[1], ph.coord[0]], { icon, zIndexOffset: 300 })
        .on("click", () => openLightbox(d, pi)));
    });
  });
}

function applySelectionStyle() {
  Object.entries(dayLines).forEach(([id, arr]) => {
    const on = !selectedDay || id === selectedDay;
    arr.forEach(({ line, casing }) => {
      line.setStyle({ opacity: on ? .96 : .55, weight: id === selectedDay ? 6.5 : 4.5 });
      casing.setStyle({ opacity: on ? .9 : .45 });
    });
  });
  drawDayPhotos();
  const btn = document.getElementById("all-btn");
  if (btn) btn.style.display = selectedDay ? "block" : "none";
}
window.showAll = function () {
  selectedDay = null;
  setMapInfo();
  updatePickerBtn();
  document.querySelectorAll(".day.active").forEach(e => e.classList.remove("active"));
  document.querySelectorAll(".chip.active").forEach(e => e.classList.remove("active"));
  applySelectionStyle();
  const b = L.latLngBounds([]);
  curDays.forEach(d => d.geometry.forEach(seg => seg.forEach(c => b.extend([c[1], c[0]]))));
  if (b.isValid()) map.flyToBounds(b.pad(0.06), { duration: 0.7, easeLinearity: 0.3 });
};

const POI_STYLE = { view: ["👁", "#5f3dc4"], swim: ["🏊", "#0c8599"], food: ["🍝", "#e8590c"], other: ["⭐", "#f08c00"] };
function drawPois() {
  Object.values(poiLayers).forEach(l => l.clearLayers());
  const dayIds = new Set(curDays.map(d => d.id));
  POIS.forEach((p, idx) => {
    if (p.day && !dayIds.has(p.day)) return;
    const [emoji, color] = POI_STYLE[p.type] || POI_STYLE.other;
    const icon = L.divIcon({ className: "poi-pin", iconSize: [26, 26],
      html: `<div class="poi-dot" style="border-color:${color}">${emoji}</div>` });
    const m = L.marker([p.coord[1], p.coord[0]], { icon, zIndexOffset: 400 });
    let html = `<b>${esc(p.name)}</b>`;
    if (p.rating) html += ` <span style="color:#567f22;font-weight:700">★ ${esc(p.rating)}</span>`;
    if (p.note) html += `<div style="margin-top:4px">${esc(p.note)}</div>`;
    if (p.photo) html += `<img src="${p.photo.file}_s.jpg" style="width:240px;border-radius:8px;margin-top:6px;cursor:pointer" onclick="poiLightbox(${idx})">
      <div style="color:#98a1ab;font-size:11px">фото: ${esc(p.photo.credit || "")}</div>`;
    const links = [];
    if (p.gmaps) links.push(`<a href="${p.gmaps}" target="_blank" rel="noopener">📍 Google Maps</a>`);
    if (p.source && p.type !== "food") links.push(`<a href="${p.source}" target="_blank" rel="noopener">подробнее</a>`);
    if (links.length) html += `<div style="margin-top:5px">${links.join(" · ")}</div>`;
    m.bindPopup(html, { maxWidth: 270 });
    (poiLayers[p.type] || poiLayers.food).addLayer(m);
  });
}
window.toKomoot = async function (file) {
  const name = file.split("/").pop();
  try {
    if (navigator.canShare) {
      const blob = await (await fetch(file)).blob();
      const f = new File([blob], name, { type: "application/gpx+xml" });
      if (navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], title: name });
        return; // в шторке выбираешь komoot — трек импортируется в приложение
      }
    }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a");
  a.href = file; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => window.open("https://www.komoot.com/upload", "_blank"), 350);
};
window.poiLightbox = function (idx) {
  const p = POIS[idx];
  if (!p || !p.photo) return;
  lbList = [{ file: p.photo.file, caption: p.name, credit: p.photo.credit || "", license: "", source: p.source || "" }];
  lbIdx = 0; showLb();
};

/* ---------------- сайдбар ---------------- */
const esc = s => String(s ?? "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

let showArchive = false;
function renderTabs() {
  const nav = document.getElementById("variant-tabs");
  nav.innerHTML = "";
  const act = VARIANTS.filter(v => !v.archived);
  if (act.length <= 1) { nav.style.display = "none"; return; }
  const arc = VARIANTS.filter(v => v.archived);
  act.forEach((v, i) => {
    const b = document.createElement("button");
    b.className = "vtab" + (cur && v.id === cur.id ? " active" : "");
    b.innerHTML = `<span class="dot" style="background:${v.color}"></span><b>${i+1}. ${v.id}</b> ${esc(v.name)}`;
    b.onclick = () => switchVariant(v.id);
    nav.appendChild(b);
  });
  if (arc.length) {
    const t = document.createElement("button");
    t.className = "vtab archive-toggle";
    t.innerHTML = showArchive ? "скрыть архив" : `архив (${arc.map(v => v.id).join(", ")}) — не прошли по обратной логистике`;
    t.onclick = () => { showArchive = !showArchive; renderTabs(); };
    nav.appendChild(t);
    if (showArchive || (cur && cur.archived)) {
      arc.forEach(v => {
        const b = document.createElement("button");
        b.className = "vtab archived" + (cur && v.id === cur.id ? " active" : "");
        b.innerHTML = `<span class="dot" style="background:${v.color}"></span><b>${v.id}</b> ${esc(v.name)}`;
        b.onclick = () => switchVariant(v.id);
        nav.appendChild(b);
      });
    }
  }
}

function renderVariantInfo() {
  const v = cur;
  const el = document.getElementById("variant-info");
  const base = curDays.filter(d => !d.optional);
  const maxUp = Math.max(...base.map(d => d.ascent));
  const optKm = curDays.filter(d => d.optional).reduce((s, d) => s + d.km, 0);
  const cover = (curDays.flatMap(d => d.photos || []).find(p => /Landro|Ponale|Misurina|Garda/i.test(p.caption)) || (curDays[0].photos || [])[0]);
  el.innerHTML = `<div class="vcard hero">
    ${cover ? `<div class="hero-cover" style="background-image:url('${cover.file}_l.jpg')"><h2>${esc(v.name)}</h2></div>` : `<h2 style="padding:14px 14px 0">${esc(v.name)}</h2>`}
    <div class="hero-body">
    <div class="meta">${dayDate(1)} — ${dayDate(base.length)} ${startDate.slice(0,4)}${optKm ? " (+ опц. хвост в последний день)" : ""} · финиш: ${esc(v.finish)}</div>
    <div class="summary">${esc(v.summary)}</div>
    <div class="totals">
      <span>🚴 <b>${Math.round(base.reduce((s, d) => s + d.km, 0))}</b> км</span>
      <span>⛰ <b>${Math.round(base.reduce((s, d) => s + d.ascent, 0))}</b> м</span>
      <span>📅 <b>${base.length}</b> дней${optKm ? ` <span style="color:#98a1ab">(+опц. ${Math.round(optKm)})</span>` : ""}</span>
      <span>макс/день <b>${maxUp}</b> м</span>
    </div>
    <div class="btnrow">
      <a class="btn" href="gpx/full.gpx" download>⬇ GPX всего маршрута</a>
      <button class="btn btn-k" onclick="toKomoot('gpx/full.gpx')" title="Скачает GPX и откроет komoot.com/upload — перетащи файл туда">➜ добавить в komoot</button>
    </div>
    <div class="logi"><b>Обратно:</b> ${esc(v.logistics)}</div>
    </div>
  </div>`;
}

function dayCardHTML(d, i) {
  const color = DAY_COLORS[i % DAY_COLORS.length];
  return `<div class="day" id="card-${d.id}">
    <div class="day-head" onclick="selectDay('${d.id}')">
      <div class="dnum" style="background:${color}">${d.optional ? "+" : i+1}</div>
      <div class="day-title">
        <div class="t">${esc(d.title)}</div>
        <div class="ft"><b class="ddate">${dayDateFor(i)}</b> · ${esc(d.start)} → ${esc(d.finish)}${d.loop ? " · кольцо" : ""}${d.optional ? " · <b style='color:#b3402f'>опционально</b>" : ""}</div>
      </div>
      <div class="day-stats"><b>${d.km}</b> км<br>↑${d.ascent} ↓${d.descent}</div>
    </div>
    <div class="day-body" id="body-${d.id}"></div>
  </div>`;
}

function renderDays() {
  document.getElementById("days-list").innerHTML = curDays.map((d, i) => dayCardHTML(d, i)).join("");
  const chips = curDays.map((d, i) => {
    const c = DAY_COLORS[i % DAY_COLORS.length];
    const dt = dayDateFor(i).split(" ");
    return `<button class="chip${d.optional ? " opt" : ""}" data-d="${d.id}" style="--c:${c}"
      onclick="selectDay('${d.id}')"><b>${d.optional ? "+" : i+1}</b> ${d.optional ? "опция" : dt[1] + " " + dt[2]}</button>`;
  }).join("");
  document.getElementById("day-picker-panel").innerHTML =
    `<button class="chip chip-all" onclick="showAll(); document.getElementById('day-picker-panel').hidden = true;">🗺 все дни</button>` + chips;
  updatePickerBtn();
}
window.togglePicker = function () {
  const p = document.getElementById("day-picker-panel");
  p.hidden = !p.hidden;
};
document.addEventListener("click", e => {
  const p = document.getElementById("day-picker-panel");
  if (!p || p.hidden) return;
  if (!p.contains(e.target) && e.target.id !== "day-picker-btn" && !e.target.closest("#day-picker-btn"))
    p.hidden = true;
}, true);
function updatePickerBtn() {
  const b = document.getElementById("day-picker-btn");
  if (!b) return;
  const i = curDays.findIndex(x => x.id === selectedDay);
  b.innerHTML = i >= 0
    ? `<span class="mi-dot" style="background:${DAY_COLORS[i % DAY_COLORS.length]}"></span> ${curDays[i].optional ? "опция" : "день " + (i+1)} · ${dayDateFor(i).replace(/^\S+ /, "")} ▾`
    : "📅 выбрать день ▾";
}
function todaysDayId() {
  const [y, m, d] = startDate.split("-").map(Number);
  const t0 = Date.UTC(y, m - 1, d);
  const now = new Date();
  const tn = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const idx = Math.round((tn - t0) / 86400000);
  return (idx >= 0 && idx < curDays.length) ? curDays[idx].id : null;
}

function surfBarHTML(d) {
  const tot = SURF.reduce((s, [k]) => s + (d.surfaces[k] || 0), 0) || 1;
  let bar = "", leg = "";
  for (const [k, label, color] of SURF) {
    const km = d.surfaces[k] || 0;
    if (km < 0.05) continue;
    bar += `<i style="width:${(100*km/tot).toFixed(1)}%;background:${color}" title="${label}: ${km.toFixed(1)} км"></i>`;
    leg += `<span><i style="background:${color}"></i>${label} <b>${km.toFixed(1)}</b> км (${Math.round(100*km/tot)}%)</span>`;
  }
  return `<div class="surfbar">${bar}</div><div class="surflegend">${leg}</div>`;
}

function elevSVG(d, i) {
  const P = d.profile;
  if (!P || P.length < 2) return "<div class='elev-tip'>нет данных профиля</div>";
  const W = 560, H = 110, padL = 34, padB = 16, padT = 8;
  const kmMax = P[P.length-1][0] || 1;
  let eMin = Infinity, eMax = -Infinity;
  P.forEach(p => { eMin = Math.min(eMin, p[1]); eMax = Math.max(eMax, p[1]); });
  const span = Math.max(eMax - eMin, 150);
  eMin = Math.max(0, eMin - span * 0.08);
  const X = km => padL + (W - padL - 6) * km / kmMax;
  const Y = e => padT + (H - padT - padB) * (1 - (e - eMin) / (eMax + span*0.05 - eMin));
  let path = `M ${X(P[0][0]).toFixed(1)} ${Y(P[0][1]).toFixed(1)}`;
  for (let j = 1; j < P.length; j++) path += ` L ${X(P[j][0]).toFixed(1)} ${Y(P[j][1]).toFixed(1)}`;
  const area = path + ` L ${X(kmMax).toFixed(1)} ${H-padB} L ${padL} ${H-padB} Z`;
  const color = DAY_COLORS[i % DAY_COLORS.length];
  const gy = [], step = span > 900 ? 400 : span > 450 ? 200 : 100;
  for (let e = Math.ceil(eMin/step)*step; e <= eMax; e += step) gy.push(e);
  return `<svg class="elev" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
       onmousemove="elevHover(event,'${d.id}',${i})" onmouseleave="elevLeave('${d.id}')">
    <defs><linearGradient id="g-${d.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".45"/>
      <stop offset="1" stop-color="${color}" stop-opacity=".06"/></linearGradient></defs>
    ${gy.map(e => `<line x1="${padL}" x2="${W-6}" y1="${Y(e)}" y2="${Y(e)}" stroke="#e3e7ea" stroke-width="1"/>
      <text x="2" y="${Y(e)+3.5}" font-size="9.5" fill="#9aa2ab">${e}</text>`).join("")}
    <path d="${area}" fill="url(#g-${d.id})"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>
    <line id="ec-${d.id}" x1="-10" x2="-10" y1="${padT}" y2="${H-padB}" stroke="#555" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="${W-6}" y="${H-4}" font-size="9.5" fill="#9aa2ab" text-anchor="end">${kmMax.toFixed(0)} км</text>
  </svg>
  <div class="elev-tip" id="etip-${d.id}"></div>`;
}

window.elevHover = function (ev, id, i) {
  const d = DAY_CACHE[id];
  const svg = ev.currentTarget, r = svg.getBoundingClientRect();
  const W = 560, padL = 34;
  const xv = (ev.clientX - r.left) / r.width * W;
  const kmMax = d.profile[d.profile.length-1][0];
  const km = Math.min(Math.max((xv - padL) / (W - padL - 6) * kmMax, 0), kmMax);
  let lo = 0, hi = d.profile.length - 1;
  while (lo < hi) { const m = (lo+hi)>>1; d.profile[m][0] < km ? lo = m+1 : hi = m; }
  const [pk, pe] = d.profile[lo];
  if (!d._cumUp) {
    d._cumUp = [0];
    for (let j = 1; j < d.profile.length; j++) {
      const diff = d.profile[j][1] - d.profile[j-1][1];
      d._cumUp.push(d._cumUp[j-1] + (diff > 2 ? diff : 0));
    }
  }
  svg.querySelector(`#ec-${CSS.escape(id)}`).setAttribute("x1", xv);
  svg.querySelector(`#ec-${CSS.escape(id)}`).setAttribute("x2", xv);
  document.getElementById("etip-" + id).textContent =
    `км ${pk.toFixed(1)} · ${pe} м · ↑${Math.round(d._cumUp[lo])} из ${d.ascent} м`;
  const c = coordAtKm(d, pk);
  if (c) {
    if (!elevCursor) {
      elevCursor = L.circleMarker([c[1], c[0]], { radius: 7, color: "#fff", weight: 2.5,
        fillColor: DAY_COLORS[i % DAY_COLORS.length], fillOpacity: 1, className: "elev-cursor" }).addTo(map);
    } else elevCursor.setLatLng([c[1], c[0]]);
  }
};
window.elevLeave = function (id) {
  if (elevCursor) { map.removeLayer(elevCursor); elevCursor = null; }
  const t = document.getElementById("etip-" + id); if (t) t.textContent = "";
};

function dayBodyHTML(d, i) {
  const ph = (d.photos || []).map((p, pi) =>
    `<img loading="lazy" src="${p.file}_s.jpg" alt="${esc(p.caption)}" title="${esc(p.caption)}"
      onclick="openLightboxById('${d.id}',${pi})">`).join("");
  const km = (KOMOOT[d.id] || d.komoot || []).map(k => {
    const nm = k.url ? `<a href="${k.url}" target="_blank" rel="noopener">${esc(k.name)}</a>` : `<b>${esc(k.name)}</b>`;
    return `<li>${nm} — <span class="part">${esc(k.part)}</span></li>`;
  }).join("");
  return `
    ${d.train ? `<div class="train">🚆 ${esc(d.train)}</div>` : ""}
    <p class="desc">${esc(d.desc)}</p>
    <div class="kv">
      <span>старт <b>${esc(d.start)}</b></span><span>финиш <b>${esc(d.finish)}</b></span>
      <span>макс <b>${d.high} м</b></span><span>мин <b>${d.low} м</b></span>
    </div>
    ${d.sights ? `<div class="kv"><span>👀 ${esc(d.sights)}</span></div>` : ""}
    ${(d.bailouts && d.bailouts.length) ? `<div class="bail"><h4>Едем, пока едется — сойти можно тут</h4>
      <div class="bail-chain">
        <div class="bail-stop start"><i></i><b>Bressanone</b><span>старт продолжения</span></div>
        ${d.bailouts.map(b => `<div class="bail-stop"><i></i><b>${esc(b.name)}</b>
          <span>${b.km} км · ↑${b.up} м от Bressanone · ${esc(b.note)}</span></div>`).join("")}
      </div>
      <div class="bail-note">С любой станции: Regionale → Brenner → REX → Innsbruck, веломеста без брони.</div>
    </div>` : ""}
    <div class="elev-wrap"><h4>Профиль высот</h4>${elevSVG(d, i)}</div>
    <div class="surf-wrap"><h4>По каким дорогам едем</h4>${surfBarHTML(d)}</div>
    ${(d.ferries && d.ferries.length) ? `<div class="kv" style="margin-top:8px">${d.ferries.map(f => `<span>⛴ ${esc(f)}</span>`).join("")}</div>` : ""}
    <div class="btnrow">
      <a class="btn" href="gpx/${d.id}.gpx" download>⬇ GPX дня</a>
      <button class="btn btn-k" onclick="toKomoot('gpx/${d.id}.gpx')" title="Скачает GPX дня и откроет komoot.com/upload — перетащи файл туда">➜ в komoot</button>
    </div>
    ${ph ? `<div class="photos-wrap"><h4>Фотографии (komoot + Wikimedia Commons)</h4><div class="photos">${ph}</div></div>` : ""}
    ${km ? `<div class="komoot-wrap"><h4>Основа на Komoot</h4><ul>${km}</ul></div>` : ""}
    ${(d.notes && d.notes.length) ? `<ul class="notes">${d.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`;
}

function hiliteCard(id, on) { /* рамка при наведении убрана по фидбеку */ }

window.selectDay = function (id, opts = {}) {
  selectedDay = id;
  applySelectionStyle();
  setMapInfo();
  updatePickerBtn();
  const panel = document.getElementById("day-picker-panel");
  if (panel) panel.hidden = true;
  document.querySelectorAll(".chip").forEach(e => e.classList.toggle("active", e.dataset.d === id));
  document.querySelectorAll(".day.active").forEach(e => e.classList.remove("active"));
  const card = document.getElementById("card-" + id);
  const body = document.getElementById("body-" + id);
  const i = curDays.findIndex(x => x.id === id);
  const d = curDays[i];
  if (!card || !d) return;
  card.classList.add("active");
  if (!body.innerHTML) body.innerHTML = dayBodyHTML(d, i);

  if (opts.fit !== false) {
    const b = L.latLngBounds([]);
    d.geometry.forEach(seg => seg.forEach(c => b.extend([c[1], c[0]])));
    map.flyToBounds(b.pad(0.1), { duration: 0.7, easeLinearity: 0.3 });
  }
};

/* ---------------- лайтбокс ---------------- */
function openLightbox(d, pi) { lbList = d.photos || []; lbIdx = pi; showLb(); }
window.openLightboxById = (id, pi) => openLightbox(DAY_CACHE[id], pi);
function showLb() {
  const p = lbList[lbIdx]; if (!p) return;
  const lb = document.getElementById("lightbox");
  const im = document.getElementById("lb-img");
  im.style.opacity = "0";
  im.onload = () => { im.style.opacity = "1"; };
  im.src = p.file + "_l.jpg";
  const src = p.source ? ` · <a href="${p.source}" target="_blank" rel="noopener">источник</a>` : "";
  document.getElementById("lb-caption").innerHTML =
    `<b>${esc(p.caption)}</b> — ${esc(p.credit)}${src}`;
  const c = document.getElementById("lb-count");
  if (c) c.textContent = lbList.length > 1 ? `${lbIdx + 1} / ${lbList.length}` : "";
  if (lbList.length > 1) { new Image().src = lbList[(lbIdx + 1) % lbList.length].file + "_l.jpg"; }
  lb.hidden = false;
}
let touchX = null;
document.addEventListener("touchstart", e => {
  if (document.getElementById("lightbox").hidden) return;
  touchX = e.touches[0].clientX;
}, { passive: true });
document.addEventListener("touchend", e => {
  const lb = document.getElementById("lightbox");
  if (lb.hidden || touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 45 && lbList.length > 1) {
    lbIdx = (lbIdx + (dx < 0 ? 1 : -1) + lbList.length) % lbList.length; showLb();
  }
  touchX = null;
}, { passive: true });
document.addEventListener("keydown", e => {
  const lb = document.getElementById("lightbox");
  if (lb.hidden) return;
  if (e.key === "Escape") lb.hidden = true;
  if (e.key === "ArrowRight") { lbIdx = (lbIdx + 1) % lbList.length; showLb(); }
  if (e.key === "ArrowLeft") { lbIdx = (lbIdx - 1 + lbList.length) % lbList.length; showLb(); }
});

/* ---------------- переключение вариантов ---------------- */
async function switchVariant(id) {
  cur = VARIANTS.find(v => v.id === id) || VARIANTS[0];
  location.hash = cur.id;
  renderTabs();
  curDays = await Promise.all(cur.days.map(x => getDay(x.id || x)));
  renderVariantInfo();
  renderDays();
  drawVariant();
  drawPois();
  const today = todaysDayId();
  if (today) selectDay(today, { fit: true, scroll: false });
  else if (curDays.length) selectDay(curDays[0].id, { fit: false, scroll: false });
}

(async function main() {
  if ("serviceWorker" in navigator) { try { navigator.serviceWorker.register("sw.js"); } catch (e) {} }
  initMap();
  const sd = document.getElementById("start-date");
  if (sd) {
    sd.value = startDate;
    sd.onchange = () => {
      startDate = sd.value || startDate;
      localStorage.setItem("tripStart", startDate);
      if (cur) switchVariant(cur.id);
    };
  }
  const lb = document.getElementById("lightbox");
  document.getElementById("lb-close").onclick = () => lb.hidden = true;
  document.getElementById("lb-prev").onclick = () => { lbIdx = (lbIdx - 1 + lbList.length) % lbList.length; showLb(); };
  document.getElementById("lb-next").onclick = () => { lbIdx = (lbIdx + 1) % lbList.length; showLb(); };
  lb.onclick = e => { if (e.target === lb) lb.hidden = true; };
  try {
    VARIANTS = await loadJSON("data/variants.json");
    try { KOMOOT = await loadJSON("data/komoot.json"); } catch (e) { KOMOOT = {}; }
    try { POIS = await loadJSON("data/pois.json"); } catch (e) { POIS = []; }
  } catch (e) {
    document.getElementById("variant-info").innerHTML =
      "<div class='vcard'>Данные не найдены. Запустите сборку: <code>python3 tools/build.py</code>, " +
      "затем сервер: <code>./run.sh</code></div>";
    return;
  }
  const first = (VARIANTS.find(v => !v.archived) || VARIANTS[0]).id;
  const want = (location.hash || ("#" + first)).slice(1);
  await switchVariant(VARIANTS.some(v => v.id === want) ? want : VARIANTS[0].id);
})();
