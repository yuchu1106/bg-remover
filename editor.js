// =========================================================
// 手動修圖
//  - 🖌 還原 / 🧽 擦除：柔邊筆刷
//  - 🪄 點選還原：點一下，自動把顏色相近的相連區域補回來（適合腳、鍊子）
//  - 邊緣補強：讓半透明的主體變實
//  - 去除殘影：清掉背景殘留的淡淡痕跡
//  - 清除雜點：刪掉和主體不相連的小碎片
// 使用：window.openEditor(item, onSave)  — item 需有 file（原圖）與 resultBlob（去背結果）
// =========================================================
(function () {
  const $ = (s) => document.querySelector(s);

  const modal = $("#editor");
  const stage = $("#edStage");
  const wrap = $("#edWrap");
  const canvas = $("#edCanvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const refImg = $("#edRefImg");
  const cursor = $("#edCursor");
  const sizeInput = $("#edSize");
  const sizeVal = $("#edSizeVal");
  const boostInput = $("#edBoost");
  const cutInput = $("#edCut");
  const tolInput = $("#edTol");
  const tolWrap = $("#edTolWrap");
  const zoomSelect = $("#edZoom");
  const refCheck = $("#edRef");
  const undoBtn = $("#edUndo");

  let st = null; // 目前編輯狀態

  // ---------- 開啟 ----------
  window.openEditor = async function (item, onSave) {
    const [origBmp, resBmp] = await Promise.all([
      createImageBitmap(item.file),
      createImageBitmap(item.resultBlob),
    ]);
    const w = resBmp.width, h = resBmp.height;
    canvas.width = w;
    canvas.height = h;

    // 原圖 RGB（尺寸對齊結果圖）
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(origBmp, 0, 0, w, h);
    const rgb = ctx.getImageData(0, 0, w, h).data;

    // AI 結果的 alpha
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(resBmp, 0, 0);
    const resData = ctx.getImageData(0, 0, w, h).data;
    const baseAlpha = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) baseAlpha[i] = resData[i * 4 + 3];

    st = {
      item, onSave, w, h, rgb, baseAlpha,
      // 筆刷圖層：-255（完全擦除）… 0（依 AI）… 255（完全保留），柔邊為中間值
      brush: new Int16Array(w * h),
      out: new ImageData(w, h),
      lut: new Uint8ClampedArray(256),
      undo: [],
      maxUndo: w * h > 2_000_000 ? 6 : 15, // 大圖少存幾步，避免手機記憶體不足
      mode: "keep",
      drawing: false,
      last: null,
    };

    refImg.src = URL.createObjectURL(item.file);
    boostInput.value = 0;
    cutInput.value = 0;
    zoomSelect.value = "1";
    buildLut();
    composeAll();
    setMode("keep");
    updateUndo();

    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => requestAnimationFrame(layout));
  };

  function close() {
    if (!st) return;
    URL.revokeObjectURL(refImg.src);
    st = null;
    modal.classList.add("hidden");
    document.body.style.overflow = "";
  }

  // ---------- 合成 ----------
  function buildLut() {
    const boost = Number(boostInput.value) / 100; // 邊緣補強
    const cut = (Number(cutInput.value) / 100) * 0.6 * 255; // 去除殘影：低於門檻的透明度歸零
    const gamma = 1 / (1 + boost * 4);
    for (let a = 0; a < 256; a++) {
      let v = a <= cut ? 0 : ((a - cut) / (255 - cut)) * 255;
      st.lut[a] = Math.round(255 * Math.pow(v / 255, gamma));
    }
  }

  function composeRect(x0, y0, x1, y1) {
    const { w, rgb, baseAlpha, brush, out, lut } = st;
    const d = out.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x, p = i * 4;
        d[p] = rgb[p]; d[p + 1] = rgb[p + 1]; d[p + 2] = rgb[p + 2];
        const a0 = lut[baseAlpha[i]], b = brush[i];
        d[p + 3] = b > 0 ? a0 + ((255 - a0) * b) / 255 : b < 0 ? (a0 * (255 + b)) / 255 : a0;
      }
    }
    ctx.putImageData(out, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
  const composeAll = () => composeRect(0, 0, st.w, st.h);

  // ---------- 版面 / 縮放 ----------
  function layout() {
    if (!st) return;
    const zoom = Number(zoomSelect.value);
    const maxW = Math.max(50, stage.clientWidth - 16);
    const maxH = Math.max(50, stage.clientHeight - 16);
    const fit = Math.min(maxW / st.w, maxH / st.h); // 整張圖完整放進畫面
    wrap.style.width = `${Math.floor(st.w * fit * zoom)}px`;
    wrap.style.height = `${Math.floor(st.h * fit * zoom)}px`;
    refImg.style.opacity = refCheck.checked ? "0.35" : "0";
    // 放大時捲到中間
    stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
    stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
  }
  window.addEventListener("resize", () => requestAnimationFrame(layout));
  window.addEventListener("orientationchange", () => setTimeout(layout, 300));
  zoomSelect.addEventListener("change", layout);
  refCheck.addEventListener("change", () => (refImg.style.opacity = refCheck.checked ? "0.35" : "0"));

  // ---------- 工具 ----------
  function setMode(m) {
    st.mode = m;
    document.querySelectorAll("#editor [data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    cursor.classList.toggle("erase", m === "erase");
    canvas.style.cursor = m === "pan" ? "grab" : m === "magic" ? "crosshair" : "none";
    tolWrap.classList.toggle("hidden", m !== "magic");
  }
  document.querySelectorAll("#editor [data-mode]").forEach((b) =>
    b.addEventListener("click", () => st && setMode(b.dataset.mode))
  );
  sizeInput.addEventListener("input", () => (sizeVal.textContent = sizeInput.value));
  const relut = () => { if (!st) return; buildLut(); composeAll(); };
  boostInput.addEventListener("input", relut);
  cutInput.addEventListener("input", relut);

  function pushUndo() {
    st.undo.push(st.brush.slice());
    if (st.undo.length > st.maxUndo) st.undo.shift();
    updateUndo();
  }
  function updateUndo() { undoBtn.disabled = !st || !st.undo.length; }
  undoBtn.addEventListener("click", () => {
    if (!st?.undo.length) return;
    st.brush = st.undo.pop();
    composeAll();
    updateUndo();
  });
  $("#edReset").addEventListener("click", () => {
    if (!st) return;
    pushUndo();
    st.brush.fill(0);
    boostInput.value = 0;
    cutInput.value = 0;
    relut();
  });

  // ---------- 清除雜點：只保留最大塊主體與夠大的區塊 ----------
  $("#edClean").addEventListener("click", () => {
    if (!st) return;
    const { w, h, out, brush } = st;
    const a = out.data;
    const n = w * h;
    const label = new Int32Array(n);
    const queue = new Int32Array(n);
    const sizes = [0];
    let cur = 0;
    for (let s = 0; s < n; s++) {
      if (label[s] || a[s * 4 + 3] < 40) continue;
      cur++;
      let head = 0, tail = 0, size = 0;
      queue[tail++] = s; label[s] = cur;
      while (head < tail) {
        const i = queue[head++]; size++;
        const x = i % w, y = (i / w) | 0;
        const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
        for (const j of nb) if (j >= 0 && !label[j] && a[j * 4 + 3] >= 40) { label[j] = cur; queue[tail++] = j; }
      }
      sizes.push(size);
    }
    if (cur <= 1) { flash("沒有找到需要清除的雜點"); return; }
    const largest = Math.max(...sizes);
    const minKeep = Math.max(30, largest * 0.01);
    pushUndo();
    let removed = 0;
    for (let i = 0; i < n; i++) {
      const l = label[i];
      if (l && sizes[l] < minKeep) { brush[i] = -255; removed++; }
    }
    composeAll();
    flash(removed ? `已清除 ${sizes.filter((s, k) => k && s < minKeep).length} 個雜點` : "沒有找到需要清除的雜點");
  });

  // ---------- 🪄 點選還原：顏色相近 + 相連的區域 ----------
  function magicFill(px, py) {
    const { w, h, rgb, brush } = st;
    const sx = Math.round(px), sy = Math.round(py);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    const tol = Number(tolInput.value);
    const t2 = tol * tol * 3;
    const s = sy * w + sx, sp = s * 4;
    const r0 = rgb[sp], g0 = rgb[sp + 1], b0 = rgb[sp + 2];
    const seen = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    queue[tail++] = s; seen[s] = 1;
    pushUndo();
    let x0 = sx, x1 = sx, y0 = sy, y1 = sy;
    while (head < tail) {
      const i = queue[head++];
      brush[i] = 255;
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || seen[j]) continue;
        seen[j] = 1;
        const p = j * 4, dr = rgb[p] - r0, dg = rgb[p + 1] - g0, db = rgb[p + 2] - b0;
        if (dr * dr + dg * dg + db * db <= t2) queue[tail++] = j;
      }
    }
    composeRect(x0, y0, x1 + 1, y1 + 1);
    if (tail > w * h * 0.4) flash("還原範圍很大，可能連背景也補回來了。可按「復原」再把容許度調低。");
  }

  // ---------- 柔邊筆刷 ----------
  function toImg(e) {
    const r = canvas.getBoundingClientRect();
    const sx = st.w / r.width;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sx, scale: sx };
  }

  function stamp(cx, cy, rad) {
    const { w, h, brush } = st;
    const keep = st.mode === "keep";
    const inner = rad < 3 ? rad : rad * 0.55; // 內圈全力、外圈漸弱 → 邊緣自然
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(w, Math.ceil(cx + rad + 1));
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(h, Math.ceil(cy + rad + 1));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > rad) continue;
        let k = d <= inner ? 1 : 1 - (d - inner) / (rad - inner);
        k = k * k * (3 - 2 * k); // smoothstep
        const v = Math.round(255 * k);
        const i = y * w + x;
        if (keep) { if (v > brush[i]) brush[i] = v; }
        else if (-v < brush[i]) brush[i] = -v;
      }
    if (x1 > x0 && y1 > y0) composeRect(x0, y0, x1, y1);
  }

  function strokeTo(p) {
    const rad = Math.max(1, (Number(sizeInput.value) / 2) * p.scale);
    const from = st.last || p;
    const dist = Math.hypot(p.x - from.x, p.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, rad / 4)));
    for (let s = st.last ? 1 : 0; s <= steps; s++) {
      const t = s / steps;
      stamp(from.x + (p.x - from.x) * t, from.y + (p.y - from.y) * t, rad);
    }
    st.last = p;
  }

  function moveCursor(e) {
    const r = wrap.getBoundingClientRect();
    const size = Number(sizeInput.value);
    cursor.style.width = cursor.style.height = `${size}px`;
    cursor.style.left = `${e.clientX - r.left - size / 2}px`;
    cursor.style.top = `${e.clientY - r.top - size / 2}px`;
    cursor.style.display = "block";
  }

  // ---- 觸控 / Apple Pencil / 滑鼠 ----
  // 單指或筆：依工具操作；雙指：拖曳畫面
  const pointers = new Map();
  let pan = null;

  function midpoint() {
    const pts = [...pointers.values()];
    return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  }
  function startPan() {
    const m = midpoint();
    pan = { x: m.x, y: m.y, sl: stage.scrollLeft, st: stage.scrollTop };
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!st) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      // 第二根手指放下：取消剛開始的那一筆，改成拖曳畫面
      if (st.drawing && st.undo.length) { st.brush = st.undo.pop(); composeAll(); updateUndo(); }
      st.drawing = false;
      startPan();
      return;
    }
    if (st.mode === "pan") { startPan(); return; }
    if (st.mode === "magic") { const p = toImg(e); magicFill(p.x, p.y); return; }

    pushUndo();
    st.drawing = true;
    st.last = null;
    strokeTo(toImg(e));
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!st) return;
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pan) {
      const m = midpoint();
      stage.scrollLeft = pan.sl - (m.x - pan.x);
      stage.scrollTop = pan.st - (m.y - pan.y);
      return;
    }
    if (e.pointerType === "mouse" && (st.mode === "keep" || st.mode === "erase")) moveCursor(e);
    if (st.drawing) strokeTo(toImg(e));
  });
  const endStroke = (e) => {
    pointers.delete(e.pointerId);
    if (!st) return;
    if (pointers.size === 0) pan = null;
    else if (pan) startPan();
    st.drawing = false;
    st.last = null;
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("pointerleave", () => (cursor.style.display = "none"));

  // ---------- 小提示 ----------
  let flashTimer;
  function flash(msg) {
    const el = $("#edFlash");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove("show"), 2800);
  }

  // ---------- 儲存 / 關閉 ----------
  $("#edSave").addEventListener("click", () => {
    if (!st) return;
    const { onSave } = st;
    canvas.toBlob((blob) => { if (blob) onSave(blob); close(); }, "image/png");
  });
  $("#edCancel").addEventListener("click", close);
  $("#edClose").addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (!st) return;
    if (e.key === "Escape") close();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undoBtn.click(); }
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "b") setMode("keep");
    if (e.key === "e") setMode("erase");
    if (e.key === "m") setMode("magic");
    if (e.key === " ") { e.preventDefault(); setMode("pan"); }
  });
})();
