// =========================================================
// 手動修圖：用筆刷「還原」被 AI 誤刪的部分（鍊子、腳…），或「擦除」多餘背景
// 使用：window.openEditor(item, onSave)  — item 需有 file（原圖）與 resultBlob（去背結果）
// =========================================================
(function () {
  const MAX_UNDO = 15;
  const $ = (s) => document.querySelector(s);

  const modal = $("#editor");
  const stage = $("#edStage");
  const wrap = $("#edWrap");
  const canvas = $("#edCanvas");
  const ctx = canvas.getContext("2d");
  const refImg = $("#edRefImg");
  const cursor = $("#edCursor");
  const sizeInput = $("#edSize");
  const sizeVal = $("#edSizeVal");
  const boostInput = $("#edBoost");
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
      brush: new Int8Array(w * h), // 0 = 依 AI；1 = 強制保留；-1 = 強制擦除
      out: new ImageData(w, h),
      lut: new Uint8ClampedArray(256),
      undo: [],
      mode: "keep",
      drawing: false,
      last: null,
    };

    refImg.src = URL.createObjectURL(item.file);
    boostInput.value = 0;
    zoomSelect.value = "1";
    buildLut();
    composeAll();
    setMode("keep");
    updateUndo();

    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(layout);
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
    // 邊緣補強：讓半透明（AI 不確定）的區域變得更不透明
    const boost = Number(boostInput.value) / 100;
    const gamma = 1 / (1 + boost * 4);
    for (let a = 0; a < 256; a++) st.lut[a] = Math.round(255 * Math.pow(a / 255, gamma));
  }

  function composeRect(x0, y0, x1, y1) {
    const { w, rgb, baseAlpha, brush, out, lut } = st;
    const d = out.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x, p = i * 4;
        d[p] = rgb[p]; d[p + 1] = rgb[p + 1]; d[p + 2] = rgb[p + 2];
        const b = brush[i];
        d[p + 3] = b === 1 ? 255 : b === -1 ? 0 : lut[baseAlpha[i]];
      }
    }
    ctx.putImageData(out, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
  const composeAll = () => composeRect(0, 0, st.w, st.h);

  // ---------- 版面 / 縮放 ----------
  function layout() {
    if (!st) return;
    const zoom = Number(zoomSelect.value);
    const maxW = stage.clientWidth - 16, maxH = stage.clientHeight - 16;
    const fit = Math.min(maxW / st.w, maxH / st.h); // 小圖也放大到填滿畫面，方便塗細節
    wrap.style.width = `${Math.round(st.w * fit * zoom)}px`;
    wrap.style.height = `${Math.round(st.h * fit * zoom)}px`;
    refImg.style.opacity = refCheck.checked ? "0.35" : "0";
  }
  window.addEventListener("resize", layout);
  zoomSelect.addEventListener("change", layout);
  refCheck.addEventListener("change", layout);

  // ---------- 工具 ----------
  function setMode(m) {
    st.mode = m;
    document.querySelectorAll("#editor [data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
    cursor.classList.toggle("erase", m === "erase");
  }
  document.querySelectorAll("#editor [data-mode]").forEach((b) =>
    b.addEventListener("click", () => st && setMode(b.dataset.mode))
  );
  sizeInput.addEventListener("input", () => (sizeVal.textContent = sizeInput.value));
  boostInput.addEventListener("input", () => { if (!st) return; buildLut(); composeAll(); });

  function pushUndo() {
    st.undo.push(st.brush.slice());
    if (st.undo.length > MAX_UNDO) st.undo.shift();
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
    buildLut();
    composeAll();
  });

  // ---------- 筆刷 ----------
  function toImg(e) {
    const r = canvas.getBoundingClientRect();
    const sx = st.w / r.width;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sx, scale: sx };
  }

  function stamp(cx, cy, rad) {
    const { w, h, brush } = st;
    const v = st.mode === "keep" ? 1 : -1;
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(w, Math.ceil(cx + rad + 1));
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(h, Math.ceil(cy + rad + 1));
    const r2 = rad * rad;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) brush[y * w + x] = v;
      }
    if (x1 > x0 && y1 > y0) composeRect(x0, y0, x1, y1);
  }

  function strokeTo(p) {
    const rad = Math.max(1, (Number(sizeInput.value) / 2) * p.scale);
    const from = st.last || p;
    const dist = Math.hypot(p.x - from.x, p.y - from.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, rad / 3)));
    for (let s = 1; s <= steps; s++) {
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

  canvas.addEventListener("pointerdown", (e) => {
    if (!st) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    pushUndo();
    st.drawing = true;
    st.last = null;
    strokeTo(toImg(e));
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!st) return;
    moveCursor(e);
    if (st.drawing) strokeTo(toImg(e));
  });
  const endStroke = () => { if (st) { st.drawing = false; st.last = null; } };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("pointerleave", () => (cursor.style.display = "none"));

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
    if (e.key === "b") setMode("keep");
    if (e.key === "e") setMode("erase");
  });
})();
