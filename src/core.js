/* Shared engine for the desktop (app.html) and mobile (mobile.html) pages:
   data, filter state, the canvas map, the SVG chart builders and the counts
   behind every chart. Each page keeps its own markup, layout and wiring. */
var Core = (function () {
"use strict";

var ALL  = JSON.parse(document.getElementById("sightings-data").textContent);
var BASE = JSON.parse(document.getElementById("basemap-data").textContent);

var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
var css = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };
var ORD = function () {
  return [css("--ord-1"),css("--ord-2"),css("--ord-3"),css("--ord-4"),css("--ord-5")];
};
var SEQ = function () {
  return [css("--seq-1"),css("--seq-2"),css("--seq-3"),css("--seq-4"),
          css("--seq-5"),css("--seq-6"),css("--seq-7")];
};

var YEARS = ALL.map(function (r) { return r.year; }).filter(Boolean);
var Y0 = Math.min.apply(null, YEARS), Y1 = Math.max.apply(null, YEARS);
var LATEST = ALL.map(function (r) { return r.date; }).filter(Boolean).sort().pop();
var PARTIAL_YEAR = Number(LATEST.slice(0, 4));

var ACTS = (function () {
  var m = {};
  ALL.forEach(function (r) { if (r.activity) m[r.activity] = (m[r.activity] || 0) + 1; });
  return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; })
         .map(function (k) { return { name: k, n: m[k] }; });
})();

var CATS = (function () {
  var m = {};
  ALL.forEach(function (r) { if (r.caracal_id) (m[r.caracal_id] = m[r.caracal_id] || []).push(r); });
  return Object.keys(m).map(function (k) {
    var rows = m[k].filter(function (r) { return r.date && r.lat != null; })
                   .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return { id: k, name: k.replace(/^TMC\d+\s*/, ""), code: (k.match(/^TMC\d+/) || [""])[0], rows: rows, n: m[k].length };
  }).filter(function (c) { return c.rows.length >= 1; })
    .sort(function (a, b) { return b.n - a.n; });
})();

var S = {
  view: "map",
  yrMin: Y0, yrMax: Y1, hrMin: 0, hrMax: 23,
  acts: {}, tag: "all", dog: "all", grp: "all", park: "all",
  region: "pen", mode: "pts",
  sel: null, cat: CATS.length ? CATS[0].id : null, reveal: 1, playing: false
};

function actsOn() { return Object.keys(S.acts).filter(function (k) { return S.acts[k]; }); }

function pass(r) {
  if (r.year != null && (r.year < S.yrMin || r.year > S.yrMax)) return false;
  if (S.hrMin > 0 || S.hrMax < 23) { if (r.hour == null || r.hour < S.hrMin || r.hour > S.hrMax) return false; }
  var a = actsOn();
  if (a.length && (!r.activity || a.indexOf(r.activity) < 0)) return false;
  if (S.tag === "tag" && !r.tags) return false;
  if (S.tag === "id" && !r.caracal_id) return false;
  if (S.dog === "yes" && !r.dog) return false;
  if (S.dog === "no" && r.dog) return false;
  if (S.grp === "1" && r.caracals !== 1) return false;
  if (S.grp === "2" && !(r.caracals >= 2)) return false;
  if (S.park === "in" && !r.in_park) return false;
  if (S.park === "out" && (r.in_park || r.lat == null)) return false;
  return true;
}
function isDefault() {
  return S.yrMin === Y0 && S.yrMax === Y1 && S.hrMin === 0 && S.hrMax === 23 &&
         !actsOn().length && S.tag === "all" && S.dog === "all" && S.grp === "all" &&
         S.park === "all";
}
/* how many filter groups are narrowed, for the mobile badge */
function activeCount() {
  return [S.yrMin !== Y0 || S.yrMax !== Y1, S.hrMin !== 0 || S.hrMax !== 23,
          actsOn().length > 0, S.tag !== "all", S.dog !== "all", S.grp !== "all",
          S.park !== "all"].filter(Boolean).length;
}
function resetFilters() {
  S.yrMin = Y0; S.yrMax = Y1; S.hrMin = 0; S.hrMax = 23;
  S.acts = {}; S.tag = "all"; S.dog = "all"; S.grp = "all"; S.park = "all";
}
function filter() { return ALL.filter(pass); }

/* ---------------- tooltip ---------------- */
// Pages without a #tip element (mobile) get no hover tooltips at all.
var tipEl;
function tip() { if (tipEl === undefined) tipEl = document.getElementById("tip"); return tipEl; }
function showTip(html, x, y) {
  var el = tip(); if (!el) return;
  el.innerHTML = html; el.hidden = false;
  var r = el.getBoundingClientRect();
  var left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  el.style.left = Math.max(8, left) + "px";
  el.style.top = Math.max(8, top) + "px";
}
function hideTip() { var el = tip(); if (el) el.hidden = true; }

function pad2(h) { return h < 10 ? "0" + h : String(h); }
function fmtDate(d) {
  if (!d) return "date unrecorded";
  var p = d.split("-");
  return Number(p[2]) + " " + MONTHS[Number(p[1]) - 1] + " " + p[0];
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

/* ---------------- map engine ---------------- */
// A fingertip is far less precise than a cursor, so taps search a wider radius.
var COARSE = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
var PICK_R2 = COARSE ? 22 * 22 : 13 * 13;

function MapView(canvas, opts) {
  this.c = canvas; this.ctx = canvas.getContext("2d");
  this.opts = opts || {}; this.v = null; this.pts = [];
  var self = this;
  var drag = null, pinch = null, ptrs = {};
  var count = function () { return Object.keys(ptrs).length; };

  function startDrag(x, y, moved) {
    drag = { x: x, y: y, cx: self.v.cx, cy: self.v.cy, moved: moved };
  }
  // two-finger zoom keeps the world point under the fingers' midpoint fixed
  function pinchGeom() {
    var ids = Object.keys(ptrs), a = ptrs[ids[0]], b = ptrs[ids[1]];
    var r = canvas.getBoundingClientRect();
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
             mx: (a.x + b.x) / 2 - r.left, my: (a.y + b.y) / 2 - r.top };
  }
  function startPinch() {
    var g = pinchGeom();
    pinch = { d: g.d, k: self.v.k,
              wx: (g.mx - self.w / 2) / self.v.k + self.v.cx,
              wy: (g.my - self.h / 2) / self.v.k + self.v.cy };
    drag = null;
  }

  canvas.addEventListener("pointerdown", function (e) {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (count() === 2) startPinch();
    else if (count() === 1) startDrag(e.clientX, e.clientY, 0);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", function (e) {
    if (ptrs[e.pointerId]) ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (pinch && count() >= 2) {
      var g = pinchGeom(), k1 = self.clampK(pinch.k * g.d / pinch.d);
      self.v.k = k1;
      self.v.cx = pinch.wx - (g.mx - self.w / 2) / k1;
      self.v.cy = pinch.wy - (g.my - self.h / 2) / k1;
      self.draw();
    } else if (drag) {
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      self.v.cx = drag.cx - dx / self.v.k;
      self.v.cy = drag.cy - dy / self.v.k;
      self.draw();
    } else if (e.pointerType !== "touch") self.hover(e);
  });
  function end(e, cancelled) {
    if (!ptrs[e.pointerId]) return;
    delete ptrs[e.pointerId];
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (pinch) {
      pinch = null;
      var rest = Object.keys(ptrs);
      // keep panning with the finger still down; a pinch never ends in a tap
      if (rest.length) { startDrag(ptrs[rest[0]].x, ptrs[rest[0]].y, 99); return; }
      drag = null;
    }
    if (count()) return;
    var wasDrag = !drag || drag.moved > 5;
    drag = null; canvas.classList.remove("dragging");
    if (!wasDrag && !cancelled && self.opts.onPick) {
      var hit = self.pick(e);
      self.opts.onPick(hit ? hit.r : null);
    }
  }
  canvas.addEventListener("pointerup", function (e) { end(e, false); });
  canvas.addEventListener("pointercancel", function (e) { end(e, true); });
  canvas.addEventListener("pointerleave", function () { hideTip(); });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    self.zoomAt(Math.pow(0.9988, e.deltaY), e.clientX, e.clientY);
  }, { passive: false });
}

MapView.prototype.size = function () {
  var dpr = Math.min(devicePixelRatio || 1, 2.5);
  var r = this.c.getBoundingClientRect();
  var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (this.c.width !== w * dpr || this.c.height !== h * dpr) {
    this.c.width = w * dpr; this.c.height = h * dpr;
  }
  this.dpr = dpr; this.w = w; this.h = h; this.rect = r;
};

MapView.prototype.fit = function (bbox, pad, cover) {
  this.size();
  var lat0 = (bbox[1] + bbox[3]) / 2;
  this.kx = Math.cos(lat0 * Math.PI / 180);
  var x0 = bbox[0] * this.kx, x1 = bbox[2] * this.kx;
  var y0 = -bbox[3], y1 = -bbox[1];
  pad = pad == null ? 0.96 : pad;
  var fx = this.w / (x1 - x0), fy = this.h / (y1 - y0);
  var k = (cover ? Math.max(fx, fy) : Math.min(fx, fy)) * pad;
  this.v = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, k: k, k0: k };
  this.bbox = bbox;
};
MapView.prototype.sx = function (lon) { return (lon * this.kx - this.v.cx) * this.v.k + this.w / 2; };
MapView.prototype.sy = function (lat) { return (-lat - this.v.cy) * this.v.k + this.h / 2; };
MapView.prototype.draw = function () {
  if (this.opts.onRedraw) this.opts.onRedraw();
};
MapView.prototype.clampK = function (k) {
  return Math.max(this.v.k0 * 0.85, Math.min(this.v.k0 * 260, k));
};
MapView.prototype.zoomAt = function (f, clx, cly) {
  var r = this.c.getBoundingClientRect();
  var px = (clx == null ? this.w / 2 : clx - r.left), py = (cly == null ? this.h / 2 : cly - r.top);
  var k1 = this.clampK(this.v.k * f);
  var wx = (px - this.w / 2) / this.v.k + this.v.cx, wy = (py - this.h / 2) / this.v.k + this.v.cy;
  this.v.cx = wx - (px - this.w / 2) / k1;
  this.v.cy = wy - (py - this.h / 2) / k1;
  this.v.k = k1;
  this.draw();
};

MapView.prototype.ring = function (ctx, ring) {
  for (var i = 0; i < ring.length; i++) {
    var x = this.sx(ring[i][0]), y = this.sy(ring[i][1]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
};

MapView.prototype.drawBase = function () {
  var ctx = this.ctx, self = this;
  ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  ctx.clearRect(0, 0, this.w, this.h);
  ctx.fillStyle = css("--nodata");
  ctx.fillRect(0, 0, this.w, this.h);

  if (S.region === "pen" || this.opts.forcePen) {
    var P = BASE.peninsula, bb = P.bbox;
    ctx.fillStyle = css("--sea");
    ctx.fillRect(this.sx(bb[0]), this.sy(bb[3]),
                 this.sx(bb[2]) - this.sx(bb[0]), this.sy(bb[1]) - this.sy(bb[3]));
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.sx(bb[0]), this.sy(bb[3]),
             this.sx(bb[2]) - this.sx(bb[0]), this.sy(bb[1]) - this.sy(bb[3]));
    ctx.clip();
    ctx.fillStyle = css("--land");
    ctx.beginPath();
    P.land.forEach(function (p) { self.ring(ctx, p); ctx.closePath(); });
    ctx.fill();

    ctx.fillStyle = css("--reserve"); ctx.globalAlpha = 0.5;
    ctx.beginPath();
    P.reserves.forEach(function (r) { self.ring(ctx, r.ring); ctx.closePath(); });
    ctx.fill("evenodd");
    ctx.globalAlpha = 1;

    if (P.park) {
      ctx.fillStyle = css("--park"); ctx.globalAlpha = 0.55;
      ctx.beginPath();
      P.park.rings.forEach(function (r) { self.ring(ctx, r); ctx.closePath(); });
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = css("--park-line"); ctx.lineWidth = 0.8;
      ctx.lineJoin = "round"; ctx.stroke();
    }

    ctx.strokeStyle = css("--coast"); ctx.lineWidth = 0.9;
    ctx.lineJoin = "round"; ctx.beginPath();
    P.land.forEach(function (p) { self.ring(ctx, p); ctx.closePath(); });
    ctx.stroke();
    ctx.restore();
  } else {
    var N = BASE.national, nb = N.bbox;
    ctx.fillStyle = css("--sea");
    ctx.fillRect(this.sx(nb[0]), this.sy(nb[3]),
                 this.sx(nb[2]) - this.sx(nb[0]), this.sy(nb[1]) - this.sy(nb[3]));
    N.countries.forEach(function (c) {
      ctx.fillStyle = c.focus ? css("--land") : css("--panel-3");
      ctx.strokeStyle = css("--coast"); ctx.lineWidth = 0.8; ctx.lineJoin = "round";
      c.rings.forEach(function (r) {
        ctx.beginPath(); self.ring(ctx, r); ctx.closePath(); ctx.fill(); ctx.stroke();
      });
    });
  }
};

MapView.prototype.drawPoints = function (rows, style) {
  var ctx = this.ctx, self = this;
  style = style || {};
  var pts = [];
  rows.forEach(function (r) {
    if (r.lat == null) return;
    var x = self.sx(r.lon), y = self.sy(r.lat);
    if (x < -40 || y < -40 || x > self.w + 40 || y > self.h + 40) return;
    pts.push({ x: x, y: y, r: r });
  });
  this.pts = pts;

  var zoomBoost = Math.min(1.8, Math.sqrt(this.v.k / this.v.k0));
  ctx.lineWidth = 1.2;
  pts.forEach(function (p) {
    var n = p.r.caracals || 1;
    var rad = (n > 1 ? 4.2 + Math.min(n, 5) * 0.75 : 3.5) * zoomBoost;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, 6.2832);
    ctx.fillStyle = style.fill ? style.fill(p.r) : css("--accent");
    ctx.globalAlpha = style.alpha == null ? 0.82 : style.alpha;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css("--panel");
    ctx.stroke();
  });

  if (S.sel && this.opts.onPick) {
    var hit = pts.filter(function (p) { return p.r.id === S.sel.id; })[0];
    if (hit) {
      ctx.beginPath(); ctx.arc(hit.x, hit.y, 11 * zoomBoost, 0, 6.2832);
      ctx.strokeStyle = css("--accent"); ctx.lineWidth = 2; ctx.stroke();
    }
  }
};

MapView.prototype.drawDensity = function (rows) {
  var ctx = this.ctx, self = this;
  var cell = 15, bins = {}, max = 0;
  rows.forEach(function (r) {
    if (r.lat == null) return;
    var x = self.sx(r.lon), y = self.sy(r.lat);
    if (x < -cell || y < -cell || x > self.w + cell || y > self.h + cell) return;
    var k = Math.floor(x / cell) + ":" + Math.floor(y / cell);
    bins[k] = (bins[k] || 0) + 1;
    if (bins[k] > max) max = bins[k];
  });
  var ramp = SEQ();
  Object.keys(bins).forEach(function (k) {
    var p = k.split(":"), n = bins[k];
    var t = max <= 1 ? 1 : Math.log(n) / Math.log(max);
    var idx = Math.min(6, Math.max(0, Math.round(t * 6)));
    ctx.fillStyle = ramp[idx];
    ctx.globalAlpha = 0.86;
    ctx.fillRect(Number(p[0]) * cell + 0.5, Number(p[1]) * cell + 0.5, cell - 1, cell - 1);
  });
  ctx.globalAlpha = 1;
  this.pts = [];
  this.densMax = max;
};

MapView.prototype.pick = function (e) {
  var r = this.c.getBoundingClientRect();
  var px = e.clientX - r.left, py = e.clientY - r.top, best = null, bd = PICK_R2;
  this.pts.forEach(function (p) {
    var d = (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
    if (d < bd) { bd = d; best = p; }
  });
  return best;
};
MapView.prototype.hover = function (e) {
  var hit = this.pick(e);
  if (!hit) { hideTip(); return; }
  var r = hit.r;
  var bits = [];
  if (r.caracals > 1) bits.push(r.caracals + " caracals");
  if (r.activity) bits.push(r.activity.toLowerCase());
  if (r.dog) bits.push("dog present");
  showTip("<b>" + esc(r.location) + "</b><div class='meta'>" + fmtDate(r.date) +
          (r.time ? " &middot; " + r.time : "") + "</div>" +
          (bits.length ? "<div class='meta'>" + esc(bits.join(" &middot; ")) + "</div>" : ""),
          e.clientX, e.clientY);
};

function scaleBar(k) {
  var kmPerPx = 110.574 / k;
  var nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  var target = 88 * kmPerPx, pick = nice[0];
  nice.forEach(function (n) { if (n <= target) pick = n; });
  return { km: pick, px: Math.round(pick / kmPerPx) };
}

/* the label/value pairs shown for one selected sighting */
function sightingFields(r) {
  var kv = [];
  kv.push(["Date", fmtDate(r.date) + (r.time ? ", " + r.time : "")]);
  kv.push(["Caracals", r.caracals == null ? "not recorded" : r.caracals]);
  if (r.activity) kv.push(["Observer", r.activity]);
  kv.push(["Company", r.alone ? "alone" : (r.people ? r.people + " people" : "with others")]);
  if (r.dog) kv.push(["Dog", "present"]);
  if (r.lat != null) kv.push(["Position", r.lat.toFixed(4) + ", " + r.lon.toFixed(4)]);
  if (r.caracal_id) kv.push(["Identified", r.caracal_id]);
  if (r.tag_colour) kv.push(["Ear tags", r.tag_colour]);
  if (r.collar) kv.push(["Radio collar", "yes"]);
  return kv;
}

/* ---------------- individual trails ---------------- */
var JOIN_DAYS = 21;

/* Draws cat c onto MapView iv up to fraction `reveal` of its sightings, and
   returns what the caption needs. */
function drawTrail(iv, c, reveal) {
  var rows = c.rows, n = rows.length;
  var upto = Math.max(1, Math.round(reveal * n));
  var shown = rows.slice(0, upto);

  iv.size();
  if (!iv.v || iv._fitW !== iv.w || iv._fitH !== iv.h) {
    iv.fit(BASE.peninsula.bbox, 0.98, false);
    iv._fitW = iv.w; iv._fitH = iv.h;
  }
  iv.drawBase();

  var ctx = iv.ctx, ramp = ORD(), LAST = ramp.length - 1, joined = 0;
  ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (var i = 1; i < shown.length; i++) {
    var gap = (new Date(shown[i].date) - new Date(shown[i - 1].date)) / 864e5;
    if (!(gap <= JOIN_DAYS)) continue;
    joined++;
    ctx.beginPath();
    ctx.moveTo(iv.sx(shown[i - 1].lon), iv.sy(shown[i - 1].lat));
    ctx.lineTo(iv.sx(shown[i].lon), iv.sy(shown[i].lat));
    ctx.strokeStyle = ramp[Math.min(LAST, Math.floor((i / Math.max(1, n - 1)) * LAST))];
    ctx.globalAlpha = 0.4; ctx.stroke(); ctx.globalAlpha = 1;
  }
  shown.forEach(function (r, i) {
    var x = iv.sx(r.lon), y = iv.sy(r.lat), last = i === shown.length - 1;
    ctx.beginPath(); ctx.arc(x, y, last ? 7 : 4.2, 0, 6.2832);
    ctx.fillStyle = last ? css("--accent") : ramp[Math.min(LAST, Math.floor((i / Math.max(1, n - 1)) * LAST))];
    ctx.fill();
    ctx.strokeStyle = css("--panel"); ctx.lineWidth = 1.4; ctx.stroke();
    if (last) {
      ctx.beginPath(); ctx.arc(x, y, 9.5, 0, 6.2832);
      ctx.strokeStyle = css("--ink"); ctx.lineWidth = 1.6; ctx.stroke();
    }
  });
  iv.pts = shown.map(function (r) { return { x: iv.sx(r.lon), y: iv.sy(r.lat), r: r }; });

  var first = rows[0].date, last = rows[n - 1].date;
  var places = {}; rows.forEach(function (r) { places[r.location] = 1; });
  return { n: n, upto: upto, shown: shown, joined: joined, first: first, last: last,
           days: Math.round((new Date(last) - new Date(first)) / 864e5),
           places: Object.keys(places).length };
}
function trailSpan(t) {
  return t.n < 2 ? "a single located sighting"
    : t.n + " located sightings over " +
      (t.days > 400 ? (t.days / 365.25).toFixed(1) + " years" : t.days + " days");
}

/* ---------------- charts ---------------- */
function svgEl(tag, attrs) {
  var e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  return e;
}
function niceTicks(max) {
  if (max <= 0) return [0];
  var step = Math.pow(10, Math.floor(Math.log(max) / Math.LN10));
  if (max / step < 2) step /= 5; else if (max / step < 5) step /= 2;
  var t = [], v = 0;
  while (v <= max + 1e-9) { t.push(v); v += step; }
  if (t[t.length - 1] < max) t.push(t[t.length - 1] + step);
  return t;
}
function barPathH(x, y, w, h, r) {
  r = Math.min(r, h / 2, w);
  if (w <= 0.4) return "";
  return "M" + x + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " +
         (x + w) + "," + (y + r) + "V" + (y + h - r) + "Q" + (x + w) + "," + (y + h) +
         " " + (x + w - r) + "," + (y + h) + "H" + x + "Z";
}
function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  if (h <= 0.4) return "";
  return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y +
         "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) +
         "V" + (y + h) + "Z";
}

/* vertical bars; single series, so no legend - the card title names it */
function barsV(fig, data, o) {
  o = o || {};
  var W = Math.max(300, Math.round(fig.clientWidth) || 640), H = o.height || 190, mL = 30, mR = 6, mT = 10, mB = 26;
  var iw = W - mL - mR, ih = H - mT - mB;
  var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
  var ticks = niceTicks(max), top = ticks[ticks.length - 1];
  if (o.maxTicks) {
    var every = Math.ceil(ticks.length / o.maxTicks);
    ticks = ticks.filter(function (t, i) { return i % every === 0; });
  }
  var svg = svgEl("svg", { class: "chart", viewBox: "0 0 " + W + " " + H, role: "img" });
  var y = function (v) { return mT + ih - (v / top) * ih; };
  ticks.forEach(function (t) {
    svg.appendChild(svgEl("line", { class: "grid-line", x1: mL, x2: W - mR, y1: y(t), y2: y(t) }));
    var lb = svgEl("text", { x: mL - 6, y: y(t) + 3.2, "text-anchor": "end" });
    lb.textContent = t; svg.appendChild(lb);
  });

  var bw = iw / data.length;
  data.forEach(function (d, i) {
    var x = mL + i * bw, w = Math.max(1.5, bw - 2), h = ih - (y(d.value) - mT);
    var g = svgEl("g", { class: "mark" });
    var p = svgEl("path", { class: "bar" + (d.hot ? " hot" : "") + (d.dim ? " dim" : ""), d: barPath(x + 1, y(d.value), w, h, 4) });
    g.appendChild(p);
    var hit = svgEl("rect", { class: "hit", x: x, y: mT, width: bw, height: ih });
    hit.addEventListener("mousemove", function (e) {
      showTip("<b>" + esc(d.tipLabel || d.label) + "</b><div class='meta'>" +
              d.value + " sighting" + (d.value === 1 ? "" : "s") +
              (d.note ? " &middot; " + esc(d.note) : "") + "</div>", e.clientX, e.clientY);
    });
    hit.addEventListener("mouseleave", hideTip);
    if (o.onClick) { hit.addEventListener("click", function () { hideTip(); o.onClick(d); }); hit.style.cursor = "pointer"; }
    g.appendChild(hit);
    svg.appendChild(g);
    if (!o.labelEvery || i % o.labelEvery === 0) {
      var t = svgEl("text", { x: x + bw / 2, y: H - 9, "text-anchor": "middle" });
      t.textContent = d.label; svg.appendChild(t);
    }
    if (d.peak) {
      var pk = svgEl("text", { class: "val", x: x + bw / 2, y: y(d.value) - 5, "text-anchor": "middle" });
      pk.textContent = d.value; svg.appendChild(pk);
    }
  });
  fig.textContent = ""; fig.appendChild(svg);
}

/* horizontal bars for long category names */
function barsH(fig, data, o) {
  o = o || {};
  var W = Math.max(300, Math.round(fig.clientWidth) || 640), rowH = o.rowH || 22,
      mL = Math.min(138, Math.round(W * 0.34)), mR = 44, mT = 4;
  var H = mT + data.length * rowH + 6;
  var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
  var svg = svgEl("svg", { class: "chart", viewBox: "0 0 " + W + " " + H, role: "img" });
  var iw = W - mL - mR;
  data.forEach(function (d, i) {
    var yy = mT + i * rowH, h = Math.min(15, rowH - 7), ty = yy + h - 2;
    var w = (d.value / max) * iw;
    var g = svgEl("g", { class: "mark" });
    g.appendChild(svgEl("path", { class: "bar" + (d.hot ? " hot" : ""), d: barPathH(mL, yy, Math.max(1.5, w), h, 4) }));
    var lb = svgEl("text", { x: mL - 8, y: ty, "text-anchor": "end" });
    lb.textContent = d.label; svg.appendChild(lb);
    var vl = svgEl("text", { class: "val", x: mL + Math.max(1.5, w) + 6, y: ty });
    vl.textContent = d.value; svg.appendChild(vl);
    var hit = svgEl("rect", { class: "hit", x: 0, y: yy - (rowH - h) / 2, width: W, height: rowH });
    hit.addEventListener("mousemove", function (e) {
      showTip("<b>" + esc(d.label) + "</b><div class='meta'>" + d.value + " sightings" +
              (d.pct != null ? " &middot; " + d.pct + "% of those recorded" : "") + "</div>", e.clientX, e.clientY);
    });
    hit.addEventListener("mouseleave", hideTip);
    if (o.onClick) { hit.addEventListener("click", function () { hideTip(); o.onClick(d); }); hit.style.cursor = "pointer"; }
    g.appendChild(hit); svg.appendChild(g);
  });
  fig.textContent = ""; fig.appendChild(svg);
}

/* rows x 24 hours, sequential ramp normalised within each row */
function heat(fig, rows) {
  var W = Math.max(300, Math.round(fig.clientWidth) || 640),
      mL = Math.min(138, Math.round(W * 0.26)), mT = 16, cw = (W - mL - 34) / 24, ch = 17;
  var H = mT + rows.length * ch + 16;
  var svg = svgEl("svg", { class: "chart", viewBox: "0 0 " + W + " " + H, role: "img" });
  var ramp = SEQ();
  [0, 6, 12, 18, 23].forEach(function (h) {
    var t = svgEl("text", { x: mL + h * cw + cw / 2, y: mT - 5, "text-anchor": "middle" });
    t.textContent = pad2(h) + "h"; svg.appendChild(t);
  });
  rows.forEach(function (r, i) {
    var yy = mT + i * ch;
    var lb = svgEl("text", { x: mL - 8, y: yy + ch - 6, "text-anchor": "end" });
    lb.textContent = r.label; svg.appendChild(lb);
    var rmax = Math.max.apply(null, r.counts.concat([1]));
    r.counts.forEach(function (n, h) {
      var t = n === 0 ? -1 : Math.round((n / rmax) * 6);
      var cell = svgEl("rect", {
        x: mL + h * cw + 0.75, y: yy + 0.75, width: cw - 1.5, height: ch - 2.5, rx: 2,
        fill: n === 0 ? "var(--panel-2)" : ramp[Math.max(0, t)]
      });
      cell.addEventListener("mousemove", function (e) {
        showTip("<b>" + esc(r.label) + "</b><div class='meta'>" +
                pad2(h) + ":00 &middot; " + n + " sighting" + (n === 1 ? "" : "s") +
                "</div>", e.clientX, e.clientY);
      });
      cell.addEventListener("mouseleave", hideTip);
      svg.appendChild(cell);
    });
    var tot = svgEl("text", { class: "val", x: W - 4, y: yy + ch - 6, "text-anchor": "end" });
    tot.textContent = r.counts.reduce(function (a, b) { return a + b; }, 0); svg.appendChild(tot);
  });
  fig.textContent = ""; fig.appendChild(svg);
}

/* ---------------- counts behind the charts ---------------- */
function hourCounts(rows) {
  var a = new Array(24).fill(0);
  rows.forEach(function (r) { if (r.hour != null) a[r.hour]++; });
  return a;
}
function dowCounts(rows) {
  var a = new Array(7).fill(0);
  rows.forEach(function (r) { if (r.dow != null) a[r.dow]++; });
  return a;
}
function monthCounts(rows) {
  var a = new Array(12).fill(0);
  rows.forEach(function (r) { if (r.month) a[r.month - 1]++; });
  return a;
}
function yearCounts(rows) {
  var m = {};
  rows.forEach(function (r) { if (r.year) m[r.year] = (m[r.year] || 0) + 1; });
  return m;
}
/* counts for 1..5 caracals, 5 meaning five or more */
function groupCounts(rows) {
  var m = {};
  rows.forEach(function (r) { if (r.caracals) m[Math.min(r.caracals, 5)] = (m[Math.min(r.caracals, 5)] || 0) + 1; });
  return m;
}
/* activity -> count, plus the keys by size and how many rows record one */
function actCounts(rows) {
  var m = {}, total = 0;
  rows.forEach(function (r) { if (r.activity) { m[r.activity] = (m[r.activity] || 0) + 1; total++; } });
  return { m: m, total: total, order: Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }) };
}
function encTiles(rows) {
  var n = rows.length;
  var c = function (f) { return rows.filter(f).length; };
  return [
    { t: "Observer was alone", v: c(function (r) { return r.alone; }), d: n, note: "The rest were in company." },
    { t: "Dog present", v: c(function (r) { return r.dog; }), d: n, note: "Dogs are the commonest conflict flashpoint." },
    { t: "More than one caracal", v: c(function (r) { return r.caracals >= 2; }), d: n, note: "Usually a mother with kittens." },
    { t: "After dark (20:00–05:00)", v: c(function (r) { return r.hour != null && (r.hour >= 20 || r.hour < 5); }), d: n, note: "Few people are out to report them." }
  ];
}

/* ---------------- data notes ---------------- */
/* o.animals names the individuals view; o.tally says whether a reporter
   count is on screen for the privacy note to point at */
function notesHTML(o) {
  o = o || {};
  var animals = o.animals || "Known animals";
  var noCoord = ALL.filter(function (r) { return r.lat == null; }).length;
  var noDate = ALL.filter(function (r) { return !r.date; }).length;
  var pen = ALL.filter(function (r) { return r.peninsula; }).length;
  var out = ALL.filter(function (r) { return r.lat != null && !r.peninsula; }).length;
  return "<h3>Where this comes from</h3><p>" + ALL.length.toLocaleString() +
    " public caracal sighting reports from South Africa, " + fmtDate(ALL.map(function (r) { return r.date; }).filter(Boolean).sort()[0]) +
    " to " + fmtDate(LATEST) + ". " + pen.toLocaleString() + " fall on the Cape Peninsula and around greater Cape Town; " +
    out + " are scattered across the rest of the country, from the West Coast and Cederberg to the Garden Route and KwaZulu-Natal.</p>" +

    "<h3>Corrections applied to the source data</h3>" +
    "<p>Three problems were found in the spreadsheet and handled before anything was plotted. They are listed here because they change where points land.</p><ul>" +
    "<li><strong>The latitude and longitude columns were swapped.</strong> The column headed <code>Latitude</code> held values near 18.4 (a longitude) and <code>Longitude</code> held values near −34.0. This was true of every row but two, which were entered the correct way round — and one of those also had both signs flipped. Rather than assume one rule, each row's pair is tested against South Africa's bounds and the reading that fits is used. All 1,637 rows carrying coordinates resolve unambiguously.</li>" +
    "<li><strong>Observer activity had 26 spellings of about 10 things</strong> — case variants, typos such as &ldquo;Cyling&rdquo;, and synonyms such as &ldquo;Riding&rdquo; against &ldquo;Horseback Riding&rdquo;. These are merged; no report lost its activity in the process.</li>" +
    "<li><strong>Eleven groups of rows, 20 in all, share a coordinate to six decimal places with an unrelated sighting</strong> — the signature of a copy-paste while the data was entered. One is certain: a sighting on Kloof Road in Cape Town carries the latitude of a Langebaan report entered just before it, and plots about 90&nbsp;km off. For the rest there is no way to tell which row of a pair is wrong without geocoding every place name, so they are flagged here and left as recorded rather than quietly rewritten.</li></ul>" +

    "<h3>What is missing</h3><ul>" +
    "<li>" + noCoord + " reports have no coordinates and never appear on the map.</li>" +
    "<li>" + noDate + " report has no date.</li>" +
    "<li>About one report in fifty has no recorded time, and just under half do not say how many people were present.</li></ul>" +

    "<h3>Reading the individual trails</h3>" +
    "<p>On the " + animals + " view a hairline is drawn between two consecutive reports of the same cat only when they fall less than three weeks apart. Even then it is a straight line between two places the animal happened to be seen, not a route anyone observed &mdash; these are chance public sightings, not telemetry. Only six records in the whole dataset come from a radio collar.</p>" +

    "<h3>How to read the counts</h3>" +
    "<p>This is opportunistic citizen-science data, not a survey. A point marks <em>a person who saw a caracal and chose to report it</em> — so the map reflects where people walk, drive and cycle as much as where caracals are. The steep growth in reports after 2015 tracks the project's public profile, not a population boom, and " +
    PARTIAL_YEAR + " is a part year, shown greyed on the yearly chart. Hour-of-day is shaped the same way: the dawn and dusk peaks are real caracal behaviour, but the quiet small hours partly mean nobody was out looking.</p>" +

    "<h3>Privacy</h3><p>Every report carried a contact name and email address. Both were removed when the data was prepared and never reach this page; names and addresses that appeared inside the free-text comments were redacted too. Reporters are counted through an anonymous hash" +
    (o.tally === false ? ", so they can be told apart without storing anyone's identity." : ", which is how the reporter tally above is possible without storing anyone's identity.") + "</p>" +

    "<h3>Credits</h3><p>Sighting records collected by the <a href='https://www.urbancaracal.org/' target='_blank' rel='noopener'>Urban Caracal Project</a>, whose colours and typography this page follows. Coastline and protected-area outlines &copy; OpenStreetMap contributors, licensed ODbL. Table Mountain National Park boundary &copy; SANParks (2017). Country outlines from Natural Earth (public domain). This is an independent visualisation of their data, not an official project page.</p>";
}

return {
  ALL: ALL, BASE: BASE, MONTHS: MONTHS, Y0: Y0, Y1: Y1, LATEST: LATEST,
  PARTIAL_YEAR: PARTIAL_YEAR, ACTS: ACTS, CATS: CATS, S: S,
  css: css, SEQ: SEQ, ORD: ORD, pad2: pad2, fmtDate: fmtDate, esc: esc,
  actsOn: actsOn, pass: pass, isDefault: isDefault, activeCount: activeCount,
  resetFilters: resetFilters, filter: filter,
  showTip: showTip, hideTip: hideTip,
  MapView: MapView, scaleBar: scaleBar, sightingFields: sightingFields,
  drawTrail: drawTrail, trailSpan: trailSpan,
  barsV: barsV, barsH: barsH, heat: heat,
  hourCounts: hourCounts, dowCounts: dowCounts, monthCounts: monthCounts,
  yearCounts: yearCounts, groupCounts: groupCounts, actCounts: actCounts,
  encTiles: encTiles, notesHTML: notesHTML
};
})();
