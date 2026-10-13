// =========================================================
// 批量圖片去背 — 純前端（RMBG-1.4 / IS-Net 雙引擎 + JSZip）
// =========================================================
// 引擎 1：IS-Net（@imgly）— 用動態 import 載入，並準備多個 CDN 備援：第一個失敗就自動換下一個
const IMGLY_SOURCES = [
  "https://esm.sh/@imgly/background-removal@1.4.5",
  "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.4.5/+esm",
  "https://esm.sh/@imgly/background-removal",
];
let _removeBackground = null;
let _loading = null;

async function loadLibrary() {
  const errors = [];
  for (const url of IMGLY_SOURCES) {
    try {
      const mod = await import(url);
      const fn = mod.removeBackground || mod.default?.removeBackground || mod.default;
      if (typeof fn === "function") {
        console.info("[去背] 函式庫載入成功：", url);
        return fn;
      }
      errors.push(`${url} → 找不到 removeBackground`);
    } catch (e) {
      console.warn("[去背] 載入失敗：", url, e);
      errors.push(`${url} → ${e?.message || e}`);
    }
  }
  console.error("[去背] 所有來源皆失敗：\n" + errors.join("\n"));
  throw new Error("無法載入 AI 函式庫（所有 CDN 都連不上）。請確認網路、關閉廣告阻擋/VPN 後重試，詳細原因見瀏覽器主控台。");
}

async function removeBackground(input, config) {
  if (!_removeBackground) {
    _loading = _loading || loadLibrary();
    try {
      _removeBackground = await _loading;
    } finally {
      _loading = null;
    }
  }
  return _removeBackground(input, config);
}

// =========================================================
// 引擎 2：BRIA RMBG-1.4（transformers.js）— 商品、飾品、細鍊條較佳
// =========================================================
const TRANSFORMERS_SOURCES = [
  "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2",
  "https://esm.sh/@xenova/transformers@2.17.2",
];
const RMBG_ID = "briaai/RMBG-1.4";
const rmbgCache = {}; // key: quantized true/false

async function importFirst(urls) {
  let lastErr;
  for (const url of urls) {
    try { const m = await import(url); console.info("[去背] 載入成功：", url); return m; }
    catch (e) { console.warn("[去背] 載入失敗：", url, e); lastErr = e; }
  }
  throw new Error("無法載入 AI 函式庫，請確認網路連線（" + (lastErr?.message || lastErr) + "）");
}

async function loadRMBG(quantized, onProgress) {
  const key = String(quantized);
  if (rmbgCache[key]) return rmbgCache[key];
  const T = await importFirst(TRANSFORMERS_SOURCES);
  T.env.allowLocalModels = false;
  const model = await T.AutoModel.from_pretrained(RMBG_ID, {
    config: { model_type: "custom" },
    quantized,
    progress_callback: onProgress,
  });
  const processor = await T.AutoProcessor.from_pretrained(RMBG_ID, {
    config: {
      do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
      image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1],
      feature_extractor_type: "ImageFeatureExtractor",
      resample: 2, rescale_factor: 0.00392156862745098,
      size: { width: 1024, height: 1024 },
    },
  });
  rmbgCache[key] = { T, model, processor };
  return rmbgCache[key];
}

async function rmbgRemove(file, quantized, onProgress, onCompute) {
  const { T, model, processor } = await loadRMBG(quantized, onProgress);
  onCompute();
  const url = URL.createObjectURL(file);
  try {
    const image = await T.RawImage.fromURL(url);
    const { pixel_values } = await processor(image);
    const { output } = await model({ input: pixel_values });
    const mask = await T.RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(image.width, image.height);

    const rgba = image.rgba();
    const data = new Uint8ClampedArray(rgba.data);
    for (let i = 0; i < mask.data.length; i++) data[i * 4 + 3] = mask.data[i];

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d").putImageData(new ImageData(data, image.width, image.height), 0, 0);
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG 輸出失敗"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 用 file:// 開啟時提示改用啟動檔
if (location.protocol === "file:") {
  window.addEventListener("DOMContentLoaded", () => {
    const tip = document.createElement("div");
    tip.className = "toast info";
    tip.textContent = "提示：目前是直接開啟檔案（file://）。若無法去背，請改用資料夾內的「啟動.command」開啟（會自動用 http://localhost 執行）。";
    document.getElementById("toastArea")?.appendChild(tip);
  });
}

// ---------- 設定 ----------
const MODEL_ALIASES = { small: "isnet_quint8", medium: "isnet_fp16" };
const MAX_FILES = 50;
const MAX_SIZE_MB = 10;
const ACCEPT_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ACCEPT_EXT = /\.(jpe?g|png|webp)$/i;

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const dropzone = $("#dropzone");
const fileInput = $("#fileInput");
const grid = $("#grid");
const toolbar = $("#toolbar");
const zipBtn = $("#zipBtn");
const clearBtn = $("#clearBtn");
const countText = $("#countText");
const statusText = $("#statusText");
const overallBar = $("#overallBar");
const toastArea = $("#toastArea");
const modelSelect = $("#modelSelect");
const engineSelect = $("#engineSelect");
const cardTpl = $("#cardTpl");

// ---------- 狀態 ----------
/** @type {{id:number,file:File,status:'pending'|'processing'|'done'|'error',origUrl:string,resultBlob?:Blob,resultUrl?:string,el:HTMLElement}[]} */
let items = [];
let nextId = 1;
let isRunning = false;
const readyKeys = new Set(); // 已下載過的「引擎+品質」組合

// =========================================================
// 上傳：點擊 / 拖曳
// =========================================================
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", () => {
  addFiles(fileInput.files);
  fileInput.value = ""; // 允許重複選同一檔案
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

// 防止拖曳到頁面其他位置時瀏覽器直接開啟圖片
["dragover", "drop"].forEach((evt) => window.addEventListener(evt, (e) => e.preventDefault()));

// =========================================================
// 檔案驗證（防呆）
// =========================================================
function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const badType = [];
  const tooBig = [];
  const valid = [];

  for (const f of files) {
    if (!ACCEPT_TYPES.includes(f.type) && !ACCEPT_EXT.test(f.name)) { badType.push(f.name); continue; }
    if (f.size > MAX_SIZE_MB * 1024 * 1024) { tooBig.push(f.name); continue; }
    valid.push(f);
  }

  if (badType.length) toast(`不支援的格式，已略過：${shorten(badType)}（僅支援 JPG / PNG / WEBP）`, "error");
  if (tooBig.length) toast(`超過 ${MAX_SIZE_MB}MB，已略過：${shorten(tooBig)}`, "error");

  const remaining = MAX_FILES - items.length;
  if (remaining <= 0) {
    toast(`⚠ 已達上限 ${MAX_FILES} 張，請先清除部分圖片再上傳。`, "warn");
    return;
  }
  let accepted = valid;
  if (valid.length > remaining) {
    accepted = valid.slice(0, remaining);
    toast(`⚠ 最多只能處理 ${MAX_FILES} 張圖片！本次僅加入前 ${remaining} 張，其餘 ${valid.length - remaining} 張已略過。`, "warn");
  }

  accepted.forEach(createItem);
  updateSummary();
  runQueue();
}

function shorten(names) {
  return names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 個檔案` : names.join("、");
}

// =========================================================
// 建立卡片
// =========================================================
function createItem(file) {
  const el = cardTpl.content.firstElementChild.cloneNode(true);
  const item = { id: nextId++, file, status: "pending", origUrl: URL.createObjectURL(file), el };

  el.querySelector(".orig").src = item.origUrl;
  el.querySelector(".name").textContent = file.name;
  el.querySelector(".name").title = file.name;

  el.querySelector(".dl").addEventListener("click", () => downloadOne(item));
  el.querySelector(".remove").addEventListener("click", () => removeItem(item));
  el.querySelector(".edit").addEventListener("click", () => {
    if (item.status !== "done") return;
    window.openEditor(item, (blob) => {
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
      item.resultBlob = blob;
      item.resultUrl = URL.createObjectURL(blob);
      el.querySelector(".result").src = item.resultUrl;
      setCardState(item, "✓ 已手動修圖", 100, false);
    }).catch((e) => { console.error(e); toast("無法開啟修圖：" + (e?.message || e), "error"); });
  });
  el.querySelector(".retry").addEventListener("click", () => {
    if (item.status === "processing" || item.status === "pending") return;
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    item.resultBlob = item.resultUrl = undefined;
    item.status = "pending";
    el.classList.remove("error", "done");
    el.querySelector(".result").classList.add("hidden");
    el.querySelector(".placeholder").classList.remove("hidden");
    el.querySelector(".dl").disabled = true;
    el.querySelector(".edit").disabled = true;
    el.querySelector(".retry").classList.add("hidden");
    setCardState(item, "等待中", 0);
    updateSummary();
    runQueue();
  });

  items.push(item);
  grid.appendChild(el);
}

function setCardState(item, text, percent = null, indeterminate = false) {
  const el = item.el;
  el.querySelector(".state").textContent = text;
  const prog = el.querySelector(".progress");
  prog.classList.toggle("indeterminate", indeterminate);
  if (percent !== null) el.querySelector(".bar").style.width = `${percent}%`;
}

// =========================================================
// 處理佇列（一次一張，避免記憶體爆掉）
// =========================================================
async function runQueue() {
  if (isRunning) return;
  isRunning = true;
  modelSelect.disabled = true;
  engineSelect.disabled = true;

  let item;
  while ((item = items.find((i) => i.status === "pending"))) {
    await processItem(item);
    updateSummary();
  }

  isRunning = false;
  modelSelect.disabled = false;
  engineSelect.disabled = false;
  updateSummary();
}

async function processItem(item) {
  item.status = "processing";
  item.el.classList.add("processing");
  updateSummary();

  const engine = engineSelect.value;
  const quality = modelSelect.value; // small | medium
  const readyKey = engine + ":" + quality;
  const ready = readyKeys.has(readyKey);
  const alive = () => items.includes(item);
  const showDownload = (pct) => alive() && setCardState(item, `下載 AI 模型中… ${pct}%（僅首次）`, pct);
  const showCompute = () => alive() && setCardState(item, "AI 去背處理中…", null, true);

  setCardState(item, ready ? "AI 去背處理中…" : "準備 AI 模型…", ready ? null : 5, ready);

  try {
    let blob;
    if (engine === "rmbg") {
      blob = await rmbgRemove(
        item.file,
        quality === "small",
        (p) => { if (p?.status === "progress" && /onnx/.test(p.file || "")) showDownload(Math.round(p.progress || 0)); },
        showCompute
      );
    } else {
      const config = {
        model: quality,
        output: { format: "image/png", quality: 1 },
        progress: (key, current, total) => {
          if (key.startsWith("fetch")) showDownload(total ? Math.round((current / total) * 100) : 0);
          else if (key.startsWith("compute")) showCompute();
        },
      };
      try {
        blob = await removeBackground(item.file, config);
      } catch (e) {
        // 不同版本的函式庫模型名稱不同（舊版 small/medium，新版 isnet_*），自動換名稱重試一次
        const alt = MODEL_ALIASES[config.model];
        if (alt && /invalid_enum_value|model/i.test(String(e?.message || e))) {
          console.warn("[去背] 模型名稱不符，改用", alt);
          blob = await removeBackground(item.file, { ...config, model: alt });
        } else throw e;
      }
    }
    if (!items.includes(item)) return; // 處理期間被移除
    readyKeys.add(readyKey);

    item.resultBlob = blob;
    item.resultUrl = URL.createObjectURL(blob);
    item.status = "done";

    const img = item.el.querySelector(".result");
    img.src = item.resultUrl;
    img.classList.remove("hidden");
    item.el.querySelector(".placeholder").classList.add("hidden");
    item.el.querySelector(".dl").disabled = false;
    item.el.querySelector(".edit").disabled = false;
    item.el.classList.remove("processing");
    item.el.classList.add("done");
    item.el.querySelector(".retry").classList.remove("hidden");
    setCardState(item, `✓ 完成（${engine === "rmbg" ? "RMBG" : "IS-Net"}）`, 100, false);
  } catch (err) {
    console.error(err);
    if (!items.includes(item)) return;
    item.status = "error";
    item.el.classList.remove("processing");
    item.el.classList.add("error");
    item.el.querySelector(".retry").classList.remove("hidden");
    setCardState(item, `處理失敗：${err?.message || "未知錯誤"}`, 100, false);
  }
}

// =========================================================
// 下載
// =========================================================
function outputName(file) {
  return file.name.replace(/\.[^.]+$/, "") + "_去背.png";
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadOne(item) {
  if (item.resultBlob) triggerDownload(item.resultBlob, outputName(item.file));
}

zipBtn.addEventListener("click", async () => {
  const done = items.filter((i) => i.status === "done");
  if (!done.length) return;

  zipBtn.disabled = true;
  const original = zipBtn.textContent;
  zipBtn.textContent = "打包中…";

  try {
    const zip = new JSZip();
    const used = new Map(); // 處理重複檔名
    for (const item of done) {
      let name = outputName(item.file);
      const n = used.get(name) || 0;
      used.set(name, n + 1);
      if (n > 0) name = name.replace(/\.png$/, `(${n}).png`);
      zip.file(name, item.resultBlob);
    }
    const content = await zip.generateAsync({ type: "blob" }, (meta) => {
      zipBtn.textContent = `打包中… ${Math.round(meta.percent)}%`;
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    triggerDownload(content, `去背圖片_${stamp}.zip`);
  } catch (err) {
    console.error(err);
    toast("ZIP 打包失敗，請重試。", "error");
  } finally {
    zipBtn.textContent = original;
    updateSummary();
  }
});

// =========================================================
// 移除 / 清除
// =========================================================
function removeItem(item) {
  URL.revokeObjectURL(item.origUrl);
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  item.el.remove();
  items = items.filter((i) => i !== item);
  updateSummary();
}

clearBtn.addEventListener("click", () => {
  if (!items.length) return;
  [...items].forEach(removeItem);
  toastArea.innerHTML = "";
});

// =========================================================
// 總覽
// =========================================================
function updateSummary() {
  const total = items.length;
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "error").length;
  const processing = items.some((i) => i.status === "processing");

  toolbar.classList.toggle("hidden", total === 0);
  countText.textContent = `${total} / ${MAX_FILES} 張`;
  overallBar.style.width = total ? `${((done + failed) / total) * 100}%` : "0";

  if (processing) statusText.textContent = `處理中… 已完成 ${done}/${total}`;
  else if (total && done === total) statusText.textContent = "全部完成 ✓";
  else if (failed) statusText.textContent = `完成 ${done} 張・失敗 ${failed} 張`;
  else statusText.textContent = total ? `已完成 ${done}/${total}` : "等待中";

  if (!zipBtn.textContent.startsWith("打包中")) {
    zipBtn.disabled = done === 0;
    zipBtn.textContent = `⬇ 打包下載全部 (ZIP${done ? `・${done} 張` : ""})`;
  }
}

// =========================================================
// Toast 提示
// =========================================================
function toast(msg, type = "warn") {
  const div = document.createElement("div");
  div.className = `toast ${type}`;
  div.textContent = msg;
  toastArea.appendChild(div);
  setTimeout(() => div.remove(), 6000);
}

