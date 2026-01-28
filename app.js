const DATA_URL = "./data/metodologia.json";
const STORAGE_KEY = "veeduria_forense_multi_v10"; // bump

// Evidencias (IndexedDB)
const EVID_DB = "veeduria_evidences_v2";
const EVID_STORE = "blobs";

let metodologia = null;
let currentPhaseId = null;

let appState = { userName: "", cases: [], activeCaseId: "" };

// Fotos seleccionadas para adjuntar al próximo hallazgo
let pendingHallazgoFiles = [];

// ---------- Helpers DOM ----------
function $(id) { return document.getElementById(id); }

// ---------- IndexedDB ----------
function openEvidenceDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(EVID_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(EVID_STORE)) {
        const store = db.createObjectStore(EVID_STORE, { keyPath: "id" });
        store.createIndex("caseId", "caseId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putEvidenceBlob(record) {
  const db = await openEvidenceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVID_STORE, "readwrite");
    tx.objectStore(EVID_STORE).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function getEvidenceBlob(id) {
  const db = await openEvidenceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVID_STORE, "readonly");
    const req = tx.objectStore(EVID_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteEvidenceBlob(id) {
  const db = await openEvidenceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVID_STORE, "readwrite");
    tx.objectStore(EVID_STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllEvidenceForCase(caseId) {
  const db = await openEvidenceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVID_STORE, "readonly");
    const idx = tx.objectStore(EVID_STORE).index("caseId");
    const req = idx.getAll(caseId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function blobToBase64DataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result || "");
      const base64 = dataUrl.split(",")[1] || "";
      resolve(base64);
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, mime) {
  const bin = atob(base64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime || "application/octet-stream" });
}

// ---------- Persistencia ----------
function loadAppState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.cases)) appState = parsed;
    } catch {}
  }

  if (!appState.userName) appState.userName = "";

  if (!appState.cases.length) {
    const c = makeEmptyCase("Caso 1");
    appState.cases = [c];
    appState.activeCaseId = c.id;
    saveAppState();
  }

  if (!appState.activeCaseId || !appState.cases.some(c => c.id === appState.activeCaseId)) {
    appState.activeCaseId = appState.cases[0].id;
    saveAppState();
  }

  appState.cases.forEach(c => {
    if (!Array.isArray(c.history)) c.history = [];
    if (!Array.isArray(c.evidences)) c.evidences = []; // metadata
  });
}

function saveAppState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
}

function getActiveCase() {
  return appState.cases.find(c => c.id === appState.activeCaseId) || appState.cases[0];
}

function touchCase(c) {
  c.actualizado_en = new Date().toISOString();
}

function getUserName() {
  const u = (appState.userName || "").trim();
  return u || "Usuario (sin nombre)";
}

function addHistory(c, action, field = "", from = "", to = "", note = "") {
  c.history = c.history || [];
  c.history.unshift({
    ts: new Date().toISOString(),
    user: getUserName(),
    action,
    field,
    from: from ?? "",
    to: to ?? "",
    note: note ?? ""
  });
  if (c.history.length > 800) c.history.length = 800;
}

// ---------- Casos ----------
function makeEmptyCase(nombre) {
  const now = new Date().toISOString();
  return {
    id: `C-${Math.random().toString(16).slice(2, 10)}-${Date.now()}`,
    nombre: nombre || "Caso",
    creado_en: now,
    actualizado_en: now,
    caso: { secopUrl: "", entidad: "", procesoId: "", ubicacion: "", tipoInfra: "" },
    checks: {},
    logs: [],
    hallazgos: [],
    docs: {},
    evidences: [],
    history: [
      { ts: now, user: "Sistema", action: "CREAR_CASO", field: "case", from: "", to: nombre || "Caso", note: "" }
    ]
  };
}

function deriveCaseNameFromFields(c) {
  const ent = c.caso.entidad?.trim();
  const pid = c.caso.procesoId?.trim();
  const tipo = getTipoNombre(c.caso.tipoInfra || "");
  const pieces = [pid, ent, tipo].filter(Boolean);
  return pieces.length ? pieces.join(" · ") : c.nombre;
}

function renderCaseSelect() {
  const sel = $("caseSelect");
  const active = getActiveCase();
  sel.innerHTML = appState.cases.map(c => {
    const label = escapeHtml(c.nombre || deriveCaseNameFromFields(c) || c.id);
    return `<option value="${escapeAttr(c.id)}" ${c.id === active.id ? "selected" : ""}>${label}</option>`;
  }).join("");
}

function switchActiveCase(caseId) {
  if (!appState.cases.some(c => c.id === caseId)) return;
  appState.activeCaseId = caseId;
  saveAppState();
  loadActiveCaseToUI();
}

function duplicateActiveCase() {
  const src = getActiveCase();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = `C-${Math.random().toString(16).slice(2, 10)}-${Date.now()}`;
  copy.nombre = `${src.nombre} (copia)`;
  copy.creado_en = new Date().toISOString();
  copy.actualizado_en = copy.creado_en;
  copy.history = copy.history || [];
  copy.history.unshift({ ts: copy.creado_en, user: getUserName(), action: "DUPLICAR_CASO", field: "case", from: src.id, to: copy.id, note: "" });

  // Evidencias: metadata se vacía (blobs se mantienen solo en caso original)
  copy.evidences = [];

  appState.cases.unshift(copy);
  appState.activeCaseId = copy.id;
  saveAppState();
  loadActiveCaseToUI();
}

async function cleanupCaseEvidenceBlobs(caseId) {
  try {
    const recs = await getAllEvidenceForCase(caseId);
    for (const r of recs) await deleteEvidenceBlob(r.id);
  } catch {}
}

function deleteActiveCase() {
  if (appState.cases.length <= 1) {
    alert("No puedes eliminar el único caso. Crea otro primero.");
    return;
  }
  const active = getActiveCase();
  if (!confirm(`¿Eliminar el caso: "${active.nombre}"?\n\n(Se borrará el caso y sus evidencias en este dispositivo)`)) return;

  cleanupCaseEvidenceBlobs(active.id).then(() => {
    appState.cases = appState.cases.filter(c => c.id !== active.id);
    appState.activeCaseId = appState.cases[0].id;
    saveAppState();
    loadActiveCaseToUI();
  });
}

function newCase() {
  const name = prompt("Nombre del nuevo caso:", `Caso ${appState.cases.length + 1}`);
  const c = makeEmptyCase((name || "").trim() || `Caso ${appState.cases.length + 1}`);
  appState.cases.unshift(c);
  appState.activeCaseId = c.id;
  saveAppState();
  loadActiveCaseToUI();
}

// ---------- PWA ----------
function updateOfflineBadge() {
  const el = $("offlineBadge");
  if (!el) return;
  el.classList.toggle("hidden", navigator.onLine);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

// ---------- Tabs ----------
function bindTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach(t => {
    t.addEventListener("click", () => {
      tabs.forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      const id = t.getAttribute("data-tab");
      [...document.querySelectorAll(".tabPanel")].forEach(p => p.classList.remove("active"));
      $(id).classList.add("active");

      if (id === "tab-documentos") renderDocsView();
      if (id === "tab-evidencias") renderEvidenceView();
      if (id === "tab-riesgo") renderRiskView();
      if (id === "tab-peticion") updatePeticionBox(true);
      if (id === "tab-informes") updateInformeBox(true);
      if (id === "tab-historial") renderHistoryView();
    });
  });
}

// ---------- Modal Galería ----------
function bindGalleryModal() {
  $("btnCloseGallery").addEventListener("click", closeGallery);
  $("galleryModal").addEventListener("click", (e) => {
    if (e.target && e.target.id === "galleryModal") closeGallery();
  });
  $("gallerySearch").addEventListener("input", () => {
    const st = $("galleryModal").dataset.state;
    if (!st) return;
    try {
      const parsed = JSON.parse(st);
      openGallery(parsed.linkType, parsed.linkId, parsed.title, true);
    } catch {}
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("galleryModal").classList.contains("hidden")) closeGallery();
  });
}

function closeGallery() {
  $("galleryModal").classList.add("hidden");
  $("galleryContent").innerHTML = "";
  $("galleryTitle").textContent = "Galería";
  $("gallerySubtitle").textContent = "";
  $("gallerySearch").value = "";
  $("galleryEmpty").textContent = "";
  $("galleryModal").dataset.state = "";
}

function getEvidencesLinked(c, linkType, linkId) {
  return (c.evidences || []).filter(e => (e.links || []).some(x => x.type === linkType && x.id === linkId));
}

async function openGallery(linkType, linkId, title, isRefresh = false) {
  const c = getActiveCase();
  const list = getEvidencesLinked(c, linkType, linkId);

  $("galleryModal").dataset.state = JSON.stringify({ linkType, linkId, title });

  $("galleryTitle").textContent = title || `Galería ${linkType}:${linkId}`;
  $("gallerySubtitle").textContent = `Caso: ${c.nombre} · Total: ${list.length}`;

  const q = ($("gallerySearch").value || "").trim().toLowerCase();
  const filtered = list.filter(e => {
    if (!q) return true;
    const blob = `${e.id} ${e.name} ${e.note || ""}`.toLowerCase();
    return blob.includes(q);
  });

  const cards = [];
  for (const e of filtered.slice(0, 120)) {
    const blobRec = await getEvidenceBlob(e.id);
    const url = blobRec?.blob ? URL.createObjectURL(blobRec.blob) : "";
    const links = (e.links || []).map(x => `${x.type}${x.id ? ":"+x.id : ""}`).join(", ") || "—";

    cards.push(`
      <div class="thumb">
        ${url ? `<img src="${escapeAttr(url)}" alt="evidencia" />` : `<div class="pad small">No disponible en este dispositivo.</div>`}
        <div class="pad">
          <div><b>${escapeHtml(shorten(e.name, 30))}</b></div>
          <div class="small">ID: ${escapeHtml(e.id)}</div>
          <div class="small">Vínculo: ${escapeHtml(links)}</div>
          ${e.note ? `<div class="small">Nota: ${escapeHtml(shorten(e.note, 80))}</div>` : ""}
          <button data-open="${escapeAttr(e.id)}">Abrir</button>
          <button data-del="${escapeAttr(e.id)}" class="danger">Eliminar</button>
        </div>
      </div>
    `);
  }

  $("galleryContent").innerHTML = cards.join("");
  $("galleryEmpty").textContent =
    !filtered.length ? "No hay evidencias en esta galería (o el filtro no coincide)." :
    (filtered.length > 120 ? "Mostrando 120 evidencias. Usa el filtro para encontrar más." : "");

  // Bind open/delete
  const view = $("galleryContent");
  [...view.querySelectorAll("button[data-open]")].forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-open");
      const rec = await getEvidenceBlob(id);
      if (!rec?.blob) {
        alert("Esta evidencia no está disponible en este dispositivo.");
        return;
      }
      const url = URL.createObjectURL(rec.blob);
      window.open(url, "_blank");
    });
  });

  [...view.querySelectorAll("button[data-del]")].forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm(`¿Eliminar evidencia ${id}?`)) return;
      const c2 = getActiveCase();
      await deleteEvidenceBlob(id);
      const removed = (c2.evidences || []).find(x => x.id === id);
      c2.evidences = (c2.evidences || []).filter(x => x.id !== id);
      addHistory(c2, "ELIMINAR_EVIDENCIA", `evidences.${id}`, removed?.name || "", "", "");
      touchCase(c2);
      saveAppState();
      renderEvidenceView();
      renderDocsView();
      renderHallazgos();
      renderHistoryView();
      openGallery(linkType, linkId, title, true);
    });
  });

  if (!isRefresh) $("galleryModal").classList.remove("hidden");
}

// ---------- Init ----------
async function init() {
  loadAppState();

  const res = await fetch(DATA_URL, { cache: "no-store" });
  metodologia = await res.json();

  registerServiceWorker();
  updateOfflineBadge();
  window.addEventListener("online", updateOfflineBadge);
  window.addEventListener("offline", updateOfflineBadge);

  $("appTitle").textContent = metodologia.titulo || "Metodología";

  bindTabs();
  bindGalleryModal();
  renderTipoInfraSelector();
  renderPhaseList();

  bindUserUI();
  bindCaseUI();
  bindMainUI();
  bindSearchUI();

  loadActiveCaseToUI();

  if (metodologia.fases?.length) openPhase(metodologia.fases[0].id);
}

// ---------- Perfil ----------
function bindUserUI() {
  $("userName").value = appState.userName || "";
  $("btnSaveUser").addEventListener("click", () => {
    const prev = appState.userName || "";
    appState.userName = $("userName").value.trim();
    saveAppState();
    alert("Nombre guardado.");
    const c = getActiveCase();
    addHistory(c, "CAMBIAR_USUARIO", "userName", prev, appState.userName, "");
    touchCase(c);
    saveAppState();
    renderHistoryView();
  });
}

// ---------- UI Caso ----------
function loadActiveCaseToUI() {
  const c = getActiveCase();

  renderCaseSelect();
  updateSubtitle();

  $("secopUrl").value = c.caso.secopUrl || "";
  $("secopEntidad").value = c.caso.entidad || "";
  $("secopId").value = c.caso.procesoId || "";
  $("secopUbicacion").value = c.caso.ubicacion || "";
  $("tipoInfra").value = c.caso.tipoInfra || "";

  renderLogs();
  renderHallazgos();
  renderDocsView();
  renderEvidenceView();
  renderRiskView();
  updateReportBox();
  updatePeticionBox(true);
  updateInformeBox(true);
  renderHistoryView();

  if (currentPhaseId) openPhase(currentPhaseId);
}

function updateSubtitle() {
  const c = getActiveCase();
  const base = (metodologia.descripcion || "").trim();
  const tipoNombre = getTipoNombre(c.caso.tipoInfra || "") || "—";
  const p = computeOverallProgress();
  $("appSubtitle").textContent =
    `${base} · Caso: ${c.nombre} · Progreso: ${p.percent}% (${p.done}/${p.total}) · Tipo: ${tipoNombre} · Ubicación: ${c.caso.ubicacion || "—"}`;
}

// ---------- Bind Caso ----------
function bindCaseUI() {
  $("caseSelect").addEventListener("change", (e) => switchActiveCase(e.target.value));
  $("btnNewCase").addEventListener("click", newCase);
  $("btnDuplicateCase").addEventListener("click", duplicateActiveCase);
  $("btnDeleteCase").addEventListener("click", deleteActiveCase);

  $("btnImportCase").addEventListener("click", () => $("fileImport").click());
  $("fileImport").addEventListener("change", handleImportFile);

  $("btnExportActive").addEventListener("click", exportActiveCaseJSON);
  $("btnExportAll").addEventListener("click", exportAllCasesJSON);

  $("btnReset").addEventListener("click", () => {
    if (!confirm("¿Seguro que deseas reiniciar TODOS los casos y el progreso?")) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

// ---------- Bind búsquedas ----------
function bindSearchUI() {
  $("searchLogs").addEventListener("input", () => renderLogs());
  $("searchHallazgos").addEventListener("input", () => renderHallazgos());
  $("searchDocs").addEventListener("input", () => renderDocsView());
  $("searchHistory").addEventListener("input", () => renderHistoryView());
  $("searchEvidence").addEventListener("input", () => renderEvidenceView());
}

// ---------- Bind general ----------
function bindMainUI() {
  $("btnSaveCase").addEventListener("click", () => {
    const c = getActiveCase();
    const prev = { ...c.caso };

    c.caso.secopUrl = $("secopUrl").value.trim();
    c.caso.entidad = $("secopEntidad").value.trim();
    c.caso.procesoId = $("secopId").value.trim();
    c.caso.ubicacion = $("secopUbicacion").value.trim();
    c.caso.tipoInfra = $("tipoInfra").value;

    const prevName = c.nombre;
    if (c.nombre?.startsWith("Caso")) c.nombre = deriveCaseNameFromFields(c);

    Object.keys(prev).forEach(k => {
      const a = prev[k] || "";
      const b = c.caso[k] || "";
      if (a !== b) addHistory(c, "ACTUALIZAR_CASO", `caso.${k}`, a, b, "");
    });
    if (prevName !== c.nombre) addHistory(c, "ACTUALIZAR_CASO", "case.nombre", prevName, c.nombre, "Nombre derivado/actualizado");

    touchCase(c);
    saveAppState();
    renderCaseSelect();
    updateSubtitle();
    alert("Caso guardado.");

    if (currentPhaseId) openPhase(currentPhaseId);
    renderDocsView();
    renderRiskView();
    updateReportBox();
    updatePeticionBox(true);
    updateInformeBox(true);
    renderHistoryView();
  });

  // Bitácora
  $("btnAddLog").addEventListener("click", () => {
    const c = getActiveCase();
    const text = $("logText").value.trim();
    if (!text) return;

    c.logs.unshift({ ts: new Date().toISOString(), text });
    addHistory(c, "AGREGAR_BITACORA", "logs", "", text, "");

    $("logText").value = "";
    touchCase(c);
    saveAppState();
    renderLogs();
    updateReportBox();
    renderRiskView();
    renderHistoryView();
  });

  $("btnAddLogPhoto").addEventListener("click", () => $("logPhotoInput").click());
  $("logPhotoInput").addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    const c = getActiveCase();

    for (const f of files) {
      await addEvidenceFiles(c, [f], { type: "log", id: "" }, "Foto bitácora");
    }
    e.target.value = "";
    renderEvidenceView();
    renderHistoryView();
    alert("Foto(s) agregada(s) a Evidencias (offline).");
  });

  // Hallazgos
  $("btnAddHallazgo").addEventListener("click", addHallazgo);
  $("btnClearHallazgo").addEventListener("click", () => clearHallazgoForm());

  $("btnAddHallazgoPhotos").addEventListener("click", () => $("hallazgoPhotosInput").click());
  $("hallazgoPhotosInput").addEventListener("change", (e) => {
    pendingHallazgoFiles = [...(e.target.files || [])];
    $("hallazgoPhotosHint").textContent = `${pendingHallazgoFiles.length} foto(s) seleccionada(s) para adjuntar al próximo hallazgo.`;
  });

  // Report
  $("btnCopyReport").addEventListener("click", () => copyText($("reportBox").value, "Informe copiado."));
  $("btnDownloadReportTxt").addEventListener("click", () => downloadText(buildPreliminaryReport(), "informe_preliminar_veeduria.txt"));
  $("btnDownloadHallazgosCsv").addEventListener("click", () => downloadText(buildHallazgosCSV(), "hallazgos_veeduria.csv"));
  $("btnDownloadDocsCsv").addEventListener("click", () => downloadText(buildDocsCSV(), "documentos_veeduria.csv"));
  $("btnDownloadRiskTxt").addEventListener("click", () => downloadText(buildRiskSummaryTxt(), "riesgo_caso_veeduria.txt"));

  // PDF con anexos
  $("btnExportPDF").addEventListener("click", () => exportReportToPDFWithAnnexes());

  // Petición
  $("btnGenPeticion").addEventListener("click", () => updatePeticionBox(true));
  $("btnCopyPeticion").addEventListener("click", () => copyText($("peticionBox").value, "Derecho de petición copiado."));
  $("btnDownloadPeticionTxt").addEventListener("click", () => downloadText($("peticionBox").value, "derecho_peticion_veeduria.txt"));
  $("peticionDest").addEventListener("change", () => updatePeticionBox(true));
  $("peticionFiltro").addEventListener("change", () => updatePeticionBox(true));

  // Informes
  $("btnGenInforme").addEventListener("click", () => updateInformeBox(true));
  $("btnCopyInforme").addEventListener("click", () => copyText($("informeBox").value, "Informe copiado."));
  $("btnDownloadInformeTxt").addEventListener("click", () => downloadText($("informeBox").value, "informe_veeduria_destinatario.txt"));
  $("informeDest").addEventListener("change", () => updateInformeBox(true));
  $("informeEnfoque").addEventListener("change", () => updateInformeBox(true));

  // Historial
  $("btnExportHistoryCsv").addEventListener("click", () => downloadText(buildHistoryCSV(), "historial_cambios.csv"));
  $("btnClearHistory").addEventListener("click", () => {
    const c = getActiveCase();
    if (!confirm("¿Borrar el historial del caso activo?")) return;
    c.history = [];
    addHistory(c, "LIMPIAR_HISTORIAL", "history", "contenía registros", "vacío", "");
    touchCase(c);
    saveAppState();
    renderHistoryView();
  });

  // Evidencias tab
  $("btnAddEvidenceGeneral").addEventListener("click", () => $("evidenceGeneralInput").click());
  $("evidenceGeneralInput").addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    const c = getActiveCase();
    await addEvidenceFiles(c, files, { type: "general", id: "" }, "Evidencia general");
    e.target.value = "";
    renderEvidenceView();
    renderHistoryView();
    alert("Evidencia(s) agregada(s).");
  });

  $("btnExportEvidenceCsv").addEventListener("click", () => downloadText(buildEvidenceCSV(), "evidencias_listado.csv"));
}

// ---------- Tipos/Fases ----------
function renderTipoInfraSelector() {
  const sel = $("tipoInfra");
  const tipos = metodologia.tipos_infraestructura || [];
  sel.innerHTML =
    `<option value="">— Selecciona —</option>` +
    tipos.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.nombre)}</option>`).join("");

  sel.addEventListener("change", () => {
    const c = getActiveCase();
    const prev = c.caso.tipoInfra || "";
    c.caso.tipoInfra = sel.value;
    addHistory(c, "ACTUALIZAR_CASO", "caso.tipoInfra", prev, c.caso.tipoInfra, "");
    touchCase(c);
    saveAppState();
    updateSubtitle();
    if (currentPhaseId) openPhase(currentPhaseId);
    renderDocsView();
    renderRiskView();
    updateReportBox();
    updatePeticionBox(true);
    updateInformeBox(true);
    renderHistoryView();
  });
}

function renderPhaseList() {
  const ul = $("phaseList");
  ul.innerHTML = "";
  (metodologia.fases || []).forEach(f => {
    const li = document.createElement("li");
    li.textContent = f.nombre;
    li.dataset.id = f.id;
    li.addEventListener("click", () => openPhase(f.id));
    ul.appendChild(li);
  });
}

function setActivePhase(id) {
  [...$("phaseList").children].forEach(li => {
    li.classList.toggle("active", li.dataset.id === id);
  });
}

function openPhase(phaseId) {
  const phase = (metodologia.fases || []).find(f => f.id === phaseId);
  if (!phase) return;
  currentPhaseId = phaseId;
  setActivePhase(phaseId);
  renderPhase(phase);
}

function getChecklistForPhase(phase) {
  const c = getActiveCase();
  const tipo = c.caso.tipoInfra || "";
  const gen = phase.checklist_general || [];
  const porTipo = (phase.checklist_por_tipo || {})[tipo] || [];
  const seen = new Set();
  const out = [];
  for (const it of gen) { if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } }
  for (const it of porTipo) { if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } }
  return out;
}

function renderPhase(phase) {
  const c = getActiveCase();
  const tipo = c.caso.tipoInfra || "";
  const tipoNombre = getTipoNombre(tipo);

  const checklist = getChecklistForPhase(phase);
  const phaseProg = computePhaseProgressByItems(checklist);

  const badgesHtml = `
    <div class="badges">
      <span class="badge"><b>Entidad:</b> ${escapeHtml(c.caso.entidad || "—")}</span>
      <span class="badge"><b>Proceso:</b> ${escapeHtml(c.caso.procesoId || "—")}</span>
      <span class="badge"><b>Ubicación:</b> ${escapeHtml(c.caso.ubicacion || "—")}</span>
      <span class="badge"><b>Tipo:</b> ${escapeHtml(tipoNombre || "—")}</span>
      <span class="badge"><b>SECOP II:</b> ${
        c.caso.secopUrl
          ? `<a href="${escapeAttr(c.caso.secopUrl)}" target="_blank" rel="noreferrer">Abrir</a>`
          : "—"
      }</span>
      <span class="badge"><b>Checklist fase:</b> ${phaseProg.percent}% (${phaseProg.done}/${phaseProg.total})</span>
    </div>
  `;

  const checklistHtml = checklist.map(item => renderCheckItem(item)).join("");
  const flagsHtml = renderFlagsForPhase(phase, tipo);

  $("phaseView").innerHTML = `
    <h2>${escapeHtml(phase.nombre)}</h2>
    <p><b>Objetivo:</b> ${escapeHtml(phase.objetivo || "")}</p>
    ${badgesHtml}

    <h3>Lista de verificación (general + específica por tipo)</h3>
    ${checklistHtml || `<p class="small">No hay checklist configurado para esta fase.</p>`}

    <hr/>

    <h3>Banderas rojas (alertas) para esta fase</h3>
    ${flagsHtml}
  `;

  checklist.forEach(item => {
    const cb = document.querySelector(`input[data-check="${cssEscape(item.id)}"]`);
    if (!cb) return;
    cb.addEventListener("change", (e) => {
      const c2 = getActiveCase();
      const prev = !!c2.checks[item.id];
      const next = !!e.target.checked;
      c2.checks[item.id] = next;
      addHistory(c2, "CHECKLIST", `checks.${item.id}`, String(prev), String(next), item.texto || "");
      touchCase(c2);
      saveAppState();
      updateSubtitle();
      updateReportBox();
      renderRiskView();
      renderHistoryView();
      openPhase(phase.id);
    });
  });
}

function renderCheckItem(item) {
  const c = getActiveCase();
  const checked = !!c.checks[item.id];
  return `
    <div class="item">
      <label>
        <input type="checkbox" data-check="${escapeAttr(item.id)}" ${checked ? "checked" : ""} />
        <b>${escapeHtml(item.texto)}</b>
      </label>
      <div class="small"><b>Evidencia sugerida:</b> ${escapeHtml(item.evidencia || "—")}</div>
    </div>
  `;
}

function renderFlagsForPhase(phase, tipoId) {
  const catalogo = metodologia.catalogo_banderas_rojas || {};
  const gen = catalogo.generales || {};
  const porTipo = (catalogo.por_tipo || {})[tipoId] || {};

  const keys = phase.flag_keys || [];
  let flags = [];

  for (const k of keys) {
    if (Array.isArray(gen[k])) flags = flags.concat(gen[k].map(x => ({ ...x, _origen: "General", _cat: k })));
    if (Array.isArray(porTipo[k])) flags = flags.concat(porTipo[k].map(x => ({ ...x, _origen: "Por tipo", _cat: k })));
  }

  if (!flags.length) {
    return `<p class="small">No hay banderas rojas configuradas para esta fase (o no has seleccionado tipo de obra).</p>`;
  }

  return flags.map(f => `
    <div class="flag">
      <div><b>${escapeHtml(f.senal || "")}</b></div>
      <div class="meta small">
        <b>Origen:</b> ${escapeHtml(f._origen)} · <b>Categoría:</b> ${escapeHtml(f._cat)}
        ${f.evidencia_sugerida ? ` · <b>Evidencia:</b> ${escapeHtml(f.evidencia_sugerida)}` : ""}
      </div>
    </div>
  `).join("");
}

// ---------- Bitácora ----------
function getFilterValue(id) {
  const el = $(id);
  return (el?.value || "").trim().toLowerCase();
}

function renderLogs() {
  const c = getActiveCase();
  const ul = $("logList");
  ul.innerHTML = "";

  const q = getFilterValue("searchLogs");
  const items = (c.logs || []).filter(l => !q || (l.text || "").toLowerCase().includes(q));

  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = q ? "No hay resultados con ese filtro." : "Aún no hay registros en bitácora.";
    ul.appendChild(li);
    return;
  }

  items.slice(0, 12).forEach(l => {
    const li = document.createElement("li");
    li.textContent = `${new Date(l.ts).toLocaleString()} — ${l.text}`;
    ul.appendChild(li);
  });
}

// ---------- Hallazgos ----------
function addHallazgo() {
  const c = getActiveCase();

  const fase = $("hallazgoFase").value.trim();
  const severidad = $("hallazgoSeveridad").value.trim();
  const hecho = $("hallazgoHecho").value.trim();
  const evidencia = $("hallazgoEvidencia").value.trim();
  const impacto = $("hallazgoImpacto").value.trim();
  const solicitud = $("hallazgoSolicitud").value.trim();

  if (!fase || !hecho || !evidencia || !solicitud) {
    alert("Completa mínimo: Fase, Hecho, Evidencia y Solicitud.");
    return;
  }
  if (hecho.length < 15) {
    alert("El hecho observado es muy corto. Agrega más detalle.");
    return;
  }

  const id = nextHallazgoId(c);

  const h = {
    id,
    ts: new Date().toISOString(),
    fase,
    severidad: severidad || "Observación",
    hecho,
    evidencia,
    impacto,
    solicitud
  };

  c.hallazgos = c.hallazgos || [];
  c.hallazgos.unshift(h);

  addHistory(c, "AGREGAR_HALLAZGO", "hallazgos", "", `${h.id} (${h.severidad})`, `Fase: ${h.fase}`);
  touchCase(c);
  saveAppState();

  (async () => {
    if (pendingHallazgoFiles.length) {
      await addEvidenceFiles(c, pendingHallazgoFiles, { type: "hallazgo", id: h.id }, `Fotos hallazgo ${h.id}`);
      pendingHallazgoFiles = [];
      $("hallazgoPhotosInput").value = "";
      $("hallazgoPhotosHint").textContent = `0 foto(s) seleccionada(s) para adjuntar al próximo hallazgo.`;
      renderEvidenceView();
      renderHistoryView();
    }
  })();

  renderHallazgos();
  clearHallazgoForm(true);

  updateReportBox();
  renderRiskView();
  updatePeticionBox(true);
  updateInformeBox(true);
  renderHistoryView();
}

function nextHallazgoId(c) {
  const hs = c.hallazgos || [];
  const nums = hs.map(x => parseInt(String(x.id || "").replace(/[^\d]/g, ""), 10)).filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `H-${String(max + 1).padStart(3, "0")}`;
}

function clearHallazgoForm(keepSeverity = false) {
  $("hallazgoFase").value = "";
  if (!keepSeverity) $("hallazgoSeveridad").value = "Observación";
  $("hallazgoHecho").value = "";
  $("hallazgoEvidencia").value = "";
  $("hallazgoImpacto").value = "";
  $("hallazgoSolicitud").value = "";
}

function renderHallazgos() {
  const c = getActiveCase();
  const ul = $("hallazgoList");
  ul.innerHTML = "";

  const q = getFilterValue("searchHallazgos");

  const items = (c.hallazgos || []).filter(h => {
    if (!q) return true;
    const blob = `${h.id} ${h.fase} ${h.severidad} ${h.hecho} ${h.evidencia} ${h.impacto || ""} ${h.solicitud}`.toLowerCase();
    return blob.includes(q);
  });

  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = q ? "No hay resultados con ese filtro." : "Aún no hay hallazgos registrados.";
    ul.appendChild(li);
    return;
  }

  items.slice(0, 6).forEach(h => {
    const evidCount = countEvidenceLinked(c, { type: "hallazgo", id: h.id });

    const li = document.createElement("li");
    li.innerHTML = `
      <b>${escapeHtml(h.id)}</b> (${escapeHtml(h.severidad)}) — ${escapeHtml(h.fase)}
      <span class="small">· fotos: ${evidCount}</span><br/>
      <span class="small">${escapeHtml(new Date(h.ts).toLocaleString())}</span><br/>
      <span class="small"><b>Hecho:</b> ${escapeHtml(shorten(h.hecho, 120))}</span><br/>
      <span class="small"><b>Evidencia:</b> ${escapeHtml(shorten(h.evidencia, 120))}</span><br/>
      <div class="row" style="margin-top:6px;">
        <button data-attach="${escapeAttr(h.id)}">Adjuntar foto</button>
        <button data-gallery="${escapeAttr(h.id)}">Galería</button>
        <button data-del="${escapeAttr(h.id)}" class="danger">Eliminar</button>
      </div>
    `;
    ul.appendChild(li);
  });

  [...ul.querySelectorAll("button[data-attach]")].forEach(btn => {
    btn.addEventListener("click", async () => {
      const hid = btn.getAttribute("data-attach");
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = async () => {
        const files = [...(input.files || [])];
        if (!files.length) return;
        const c2 = getActiveCase();
        await addEvidenceFiles(c2, files, { type: "hallazgo", id: hid }, `Fotos hallazgo ${hid}`);
        renderEvidenceView();
        renderHallazgos();
        renderHistoryView();
      };
      input.click();
    });
  });

  [...ul.querySelectorAll("button[data-gallery]")].forEach(btn => {
    btn.addEventListener("click", async () => {
      const hid = btn.getAttribute("data-gallery");
      await openGallery("hallazgo", hid, `Galería del hallazgo ${hid}`);
    });
  });

  [...ul.querySelectorAll("button[data-del]")].forEach(btn => {
    btn.addEventListener("click", () => {
      const c2 = getActiveCase();
      const id = btn.getAttribute("data-del");
      if (!confirm(`¿Eliminar hallazgo ${id}?`)) return;
      const removed = (c2.hallazgos || []).find(x => x.id === id);
      c2.hallazgos = (c2.hallazgos || []).filter(x => x.id !== id);
      addHistory(c2, "ELIMINAR_HALLAZGO", "hallazgos", id, "", removed ? removed.hecho : "");
      touchCase(c2);
      saveAppState();
      renderHallazgos();
      updateReportBox();
      renderRiskView();
      updatePeticionBox(true);
      updateInformeBox(true);
      renderHistoryView();
    });
  });
}

// ---------- Evidencias ----------
function makeEvidenceId() {
  return `EV-${Math.random().toString(16).slice(2, 10)}-${Date.now()}`;
}

function countEvidenceLinked(c, link) {
  const evs = c.evidences || [];
  return evs.filter(e => (e.links || []).some(x => x.type === link.type && x.id === link.id)).length;
}

async function addEvidenceFiles(c, files, link, note = "") {
  c.evidences = c.evidences || [];
  for (const file of files) {
    const evidId = makeEvidenceId();
    const rec = {
      id: evidId,
      caseId: c.id,
      ts: new Date().toISOString(),
      name: file.name || `foto_${evidId}.jpg`,
      mime: file.type || "image/jpeg",
      size: file.size || 0,
      note: note || "",
      links: [link]
    };

    await putEvidenceBlob({ id: evidId, caseId: c.id, mime: rec.mime, name: rec.name, blob: file });

    c.evidences.unshift(rec);
    addHistory(c, "AGREGAR_EVIDENCIA", `evidences.${evidId}`, "", rec.name, `${link.type}:${link.id || "-"}`);
  }

  touchCase(c);
  saveAppState();
}

async function renderEvidenceView() {
  const view = $("evidenceView");
  if (!view) return;

  const c = getActiveCase();
  const q = getFilterValue("searchEvidence");

  const evs = (c.evidences || []).filter(e => {
    if (!q) return true;
    const blob = `${e.id} ${e.name} ${e.note || ""} ${(e.links||[]).map(x=>`${x.type}:${x.id}`).join(" ")}`.toLowerCase();
    return blob.includes(q);
  });

  if (!evs.length) {
    view.innerHTML = `<p class="small">${q ? "No hay resultados con ese filtro." : "Aún no hay evidencias en este caso."}</p>`;
    return;
  }

  const cards = [];
  for (const e of evs.slice(0, 80)) {
    const blobRec = await getEvidenceBlob(e.id);
    const url = blobRec?.blob ? URL.createObjectURL(blobRec.blob) : "";
    const links = (e.links || []).map(x => `${x.type}${x.id ? ":"+x.id : ""}`).join(", ") || "—";

    cards.push(`
      <div class="thumb">
        ${url ? `<img src="${escapeAttr(url)}" alt="evidencia" />` : `<div class="pad small">No disponible en este dispositivo.</div>`}
        <div class="pad">
          <div><b>${escapeHtml(shorten(e.name, 26))}</b></div>
          <div class="small">ID: ${escapeHtml(e.id)}</div>
          <div class="small">Vínculo: ${escapeHtml(links)}</div>
          ${e.note ? `<div class="small">Nota: ${escapeHtml(shorten(e.note, 60))}</div>` : ""}
          <button data-open="${escapeAttr(e.id)}">Abrir</button>
          <button data-del="${escapeAttr(e.id)}" class="danger">Eliminar</button>
        </div>
      </div>
    `);
  }

  view.innerHTML = `<div class="thumbGrid">${cards.join("")}</div>`;

  [...view.querySelectorAll("button[data-open]")].forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-open");
      const rec = await getEvidenceBlob(id);
      if (!rec?.blob) {
        alert("Esta evidencia no está disponible en este dispositivo (puede faltar el blob).");
        return;
      }
      const url = URL.createObjectURL(rec.blob);
      window.open(url, "_blank");
    });
  });

  [...view.querySelectorAll("button[data-del]")].forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      if (!confirm(`¿Eliminar evidencia ${id}?`)) return;
      const c2 = getActiveCase();

      await deleteEvidenceBlob(id);
      const removed = (c2.evidences || []).find(x => x.id === id);
      c2.evidences = (c2.evidences || []).filter(x => x.id !== id);
      addHistory(c2, "ELIMINAR_EVIDENCIA", `evidences.${id}`, removed?.name || "", "", "");
      touchCase(c2);
      saveAppState();
      renderEvidenceView();
      renderHallazgos();
      renderDocsView();
      renderHistoryView();
    });
  });
}

function buildEvidenceCSV() {
  const c = getActiveCase();
  const headers = ["id", "fecha", "nombre", "mime", "size", "note", "links"];
  const rows = [headers];
  (c.evidences || []).slice().reverse().forEach(e => {
    rows.push([
      e.id,
      new Date(e.ts).toLocaleString(),
      e.name,
      e.mime,
      String(e.size || 0),
      e.note || "",
      (e.links || []).map(x => `${x.type}:${x.id || ""}`).join("|")
    ]);
  });
  return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}

// ---------- Documentos mínimos (adjuntar foto por doc + galería por doc) ----------
function getDocsForSelectedType() {
  const docs = metodologia.documentos_minimos || {};
  const general = docs.generales || [];
  const c = getActiveCase();
  const tipo = c.caso.tipoInfra || "";
  const specific = (docs.por_tipo || {})[tipo] || [];
  return [...general, ...specific];
}

function renderDocsView() {
  const view = $("docsView");
  if (!view) return;

  const c = getActiveCase();
  const tipo = c.caso.tipoInfra || "";
  const tipoNombre = getTipoNombre(tipo) || "—";

  if (!tipo) {
    view.innerHTML = `<p class="small">Selecciona un <b>Tipo de obra</b> para ver documentos mínimos.</p>`;
    return;
  }

  const q = getFilterValue("searchDocs");
  let docs = getDocsForSelectedType();

  if (q) {
    docs = docs.filter(d => {
      const entry = c.docs?.[d.id] || { estado: "pendiente", evidencia: "" };
      const fotos = countEvidenceLinked(c, { type: "doc", id: d.id });
      const blob = `${d.id} ${d.nombre} ${d.fase} ${entry.estado} ${entry.evidencia || ""} fotos:${fotos}`.toLowerCase();
      return blob.includes(q);
    });
  }

  const rows = docs.map(d => {
    const entry = c.docs?.[d.id] || { estado: "pendiente", evidencia: "" };
    const estado = entry.estado || "pendiente";
    const evid = entry.evidencia || "";
    const fotos = countEvidenceLinked(c, { type: "doc", id: d.id });

    return `
      <tr>
        <td><b>${escapeHtml(d.id)}</b></td>
        <td>${escapeHtml(d.nombre)}</td>
        <td>${escapeHtml(d.fase)}</td>
        <td>
          <select data-docestado="${escapeAttr(d.id)}">
            <option value="pendiente" ${estado==="pendiente"?"selected":""}>Pendiente</option>
            <option value="disponible" ${estado==="disponible"?"selected":""}>Disponible</option>
            <option value="solicitado" ${estado==="solicitado"?"selected":""}>Solicitado</option>
            <option value="no_disponible" ${estado==="no_disponible"?"selected":""}>No disponible</option>
            <option value="no_aplica" ${estado==="no_aplica"?"selected":""}>No aplica</option>
          </select>
        </td>
        <td>
          <input data-docevid="${escapeAttr(d.id)}" placeholder="Enlace SECOP II / archivo / nota" value="${escapeAttr(evid)}" />
          <div class="miniRow">
            <button data-docattach="${escapeAttr(d.id)}">Adjuntar foto</button>
            <button data-docgallery="${escapeAttr(d.id)}">Ver fotos (${fotos})</button>
            <span class="miniHint">Fotos quedan offline y se incluyen en export JSON.</span>
          </div>
          <div class="small">La evidencia/nota se registra en historial al salir del campo (no en cada tecla).</div>
        </td>
      </tr>
    `;
  }).join("");

  const allDocs = getDocsForSelectedType();
  view.innerHTML = `
    <div class="badges">
      <span class="badge"><b>Tipo:</b> ${escapeHtml(tipoNombre)}</span>
      <span class="badge"><b>Total docs:</b> ${allDocs.length}</span>
      <span class="badge"><b>Faltantes:</b> ${computeMissingDocsCount(allDocs)}</span>
      ${q ? `<span class="badge"><b>Filtro:</b> ${escapeHtml(q)}</span>` : ""}
    </div>

    <table class="table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Documento</th>
          <th>Fase</th>
          <th>Estado</th>
          <th>Evidencia/Nota + Fotos</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="5">Sin resultados</td></tr>`}
      </tbody>
    </table>
  `;

  // Estado
  [...view.querySelectorAll("select[data-docestado]")].forEach(sel => {
    sel.addEventListener("change", () => {
      const c2 = getActiveCase();
      const id = sel.getAttribute("data-docestado");
      c2.docs = c2.docs || {};
      const prev = c2.docs[id]?.estado || "pendiente";
      c2.docs[id] = c2.docs[id] || { estado: "pendiente", evidencia: "" };
      c2.docs[id].estado = sel.value;

      addHistory(c2, "ACTUALIZAR_DOCUMENTO", `docs.${id}.estado`, prev, sel.value, "");
      touchCase(c2);
      saveAppState();
      renderRiskView();
      updatePeticionBox(true);
      updateInformeBox(true);
      renderDocsView();
      updateReportBox();
      renderHistoryView();
    });
  });

  // Evidencia/nota (blur)
  [...view.querySelectorAll("input[data-docevid]")].forEach(inp => {
    const docId = inp.getAttribute("data-docevid");
    inp.dataset.prev = inp.value;

    inp.addEventListener("blur", () => {
      const c2 = getActiveCase();
      c2.docs = c2.docs || {};
      c2.docs[docId] = c2.docs[docId] || { estado: "pendiente", evidencia: "" };

      const prev = inp.dataset.prev ?? (c2.docs[docId].evidencia || "");
      const next = inp.value;

      if (prev !== next) {
        c2.docs[docId].evidencia = next;
        addHistory(c2, "ACTUALIZAR_DOCUMENTO", `docs.${docId}.evidencia`, shorten(prev, 120), shorten(next, 120), "Cambio evidencia/nota (blur)");
        inp.dataset.prev = next;
        touchCase(c2);
        saveAppState();
        updateReportBox();
        updatePeticionBox(true);
        updateInformeBox(true);
        renderHistoryView();
      } else {
        c2.docs[docId].evidencia = next;
        touchCase(c2);
        saveAppState();
      }
    });
  });

  // Adjuntar foto por doc
  [...view.querySelectorAll("button[data-docattach]")].forEach(btn => {
    btn.addEventListener("click", async () => {
      const docId = btn.getAttribute("data-docattach");
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = async () => {
        const files = [...(input.files || [])];
        if (!files.length) return;
        const c2 = getActiveCase();
        await addEvidenceFiles(c2, files, { type: "doc", id: docId }, `Fotos documento ${docId}`);
        renderEvidenceView();
        renderDocsView();
        renderHistoryView();
      };
      input.click();
    });
  });

  // Galería por doc
  [...view.querySelectorAll("button[data-docgallery]")].forEach(btn => {
    btn.addEventListener("click", async () => {
      const docId = btn.getAttribute("data-docgallery");
      await openGallery("doc", docId, `Galería del documento ${docId}`);
    });
  });
}

function computeMissingDocsCount(docs) {
  const c = getActiveCase();
  let missing = 0;
  docs.forEach(d => {
    const st = (c.docs?.[d.id]?.estado) || "pendiente";
    if (st === "no_aplica") return;
    if (st === "pendiente" || st === "no_disponible") missing++;
  });
  return missing;
}

// ---------- Riesgo ----------
function renderRiskView() {
  const view = $("riskView");
  if (!view) return;

  const score = computeRiskScore();
  const level = riskLevel(score);
  const reasons = buildRiskReasons();

  view.innerHTML = `
    <div class="riskCard">
      <div class="riskScore">${score} / 100</div>
      <div><b>Nivel:</b> ${escapeHtml(level)}</div>
      <div class="small">Puntaje orientativo (no dictamen penal).</div>
    </div>

    <h3>Factores que influyen</h3>
    <ul>
      ${reasons.map(r => `<li>${escapeHtml(r)}</li>`).join("")}
    </ul>

    <h3>Recomendación de acción</h3>
    <div class="flag">${escapeHtml(riskRecommendation(level))}</div>
  `;
}

function computeRiskScore() {
  const c = getActiveCase();
  let score = 0;

  const weights = { "Observación": 3, "Alerta": 10, "Alerta crítica": 20 };
  (c.hallazgos || []).forEach(h => score += (weights[h.severidad] || 3));

  const docs = getDocsForSelectedType();
  const missing = docs.length ? computeMissingDocsCount(docs) : 0;
  score += Math.min(30, missing * 3);

  const prog = computeOverallProgress();
  if (prog.total > 0) {
    if (prog.percent < 30) score += 15;
    else if (prog.percent < 60) score += 8;
    else score += 2;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function riskLevel(score) {
  if (score >= 70) return "Alto";
  if (score >= 40) return "Medio";
  return "Bajo";
}

function buildRiskReasons() {
  const c = getActiveCase();
  const reasons = [];
  const counts = countHallazgos();
  reasons.push(`Hallazgos: ${counts.obs} observación(es), ${counts.alerta} alerta(s), ${counts.critica} alerta(s) crítica(s).`);

  const docs = getDocsForSelectedType();
  if (!c.caso.tipoInfra) reasons.push("No se ha seleccionado tipo de obra; no se evalúan documentos específicos.");
  else reasons.push(`Documentos mínimos faltantes/pendientes: ${computeMissingDocsCount(docs)}.`);

  const prog = computeOverallProgress();
  reasons.push(`Avance de verificación (checklist): ${prog.percent}% (${prog.done}/${prog.total}).`);
  reasons.push(`Puntaje calculado: ${computeRiskScore()}/100.`);
  reasons.push(`Evidencias (fotos) guardadas: ${(c.evidences||[]).length}.`);
  return reasons;
}

function riskRecommendation(level) {
  if (level === "Alto") return "Priorizar acciones inmediatas: derecho de petición, exigir publicación/soportes en SECOP II, y (si hay alertas críticas) remitir informe a Personería/Contraloría/Procuraduría.";
  if (level === "Medio") return "Completar documentos mínimos y checklist; formalizar solicitudes; registrar hallazgos con evidencia. Escalar si aparecen alertas críticas o patrones repetidos.";
  return "Continuar monitoreo y trazabilidad; completar checklist y evidencias. Registrar y solicitar aclaraciones cuando existan inconsistencias.";
}

function buildRiskSummaryTxt() {
  const c = getActiveCase();
  const score = computeRiskScore();
  const level = riskLevel(score);
  const reasons = buildRiskReasons();

  const lines = [];
  lines.push("RESUMEN DE RIESGO DEL CASO (orientativo)");
  lines.push(`Fecha: ${new Date().toISOString().slice(0,10)}`);
  lines.push("");
  lines.push(`Caso: ${c.nombre}`);
  lines.push(`Entidad: ${c.caso.entidad || "—"}`);
  lines.push(`Proceso/ID: ${c.caso.procesoId || "—"}`);
  lines.push(`Municipio/Departamento: ${c.caso.ubicacion || "—"}`);
  lines.push(`Tipo: ${getTipoNombre(c.caso.tipoInfra || "") || "—"}`);
  lines.push(`SECOP II: ${c.caso.secopUrl || "—"}`);
  lines.push("");
  lines.push(`Puntaje: ${score}/100`);
  lines.push(`Nivel: ${level}`);
  lines.push("");
  lines.push("Factores:");
  reasons.forEach(r => lines.push(`- ${r}`));
  lines.push("");
  lines.push("Recomendación:");
  lines.push(riskRecommendation(level));
  return lines.join("\n");
}

// ---------- Petición/Informes (sin cambios funcionales relevantes) ----------
function updatePeticionBox(forceGen = false) {
  const box = $("peticionBox");
  if (!box) return;
  if (!forceGen && box.value.trim()) return;
  box.value = buildDerechoPeticion();
}

function buildDerechoPeticion() {
  const c = getActiveCase();
  const dest = $("peticionDest")?.value || "Entidad";
  const filtro = $("peticionFiltro")?.value || "all";
  const extra = $("peticionExtra")?.value?.trim() || "";

  const hoy = new Date().toISOString().slice(0,10);
  const entidad = c.caso.entidad || "______________";
  const proceso = c.caso.procesoId || "______________";
  const ubic = c.caso.ubicacion || "______________";
  const tipo = getTipoNombre(c.caso.tipoInfra || "") || "______________";
  const secop = c.caso.secopUrl || "______________";

  const hallazgos = filterHallazgosBy(filtro);
  const docsFaltantes = listDocsFaltantes();

  const asunto = `Derecho de petición – Solicitud de información y aclaraciones – Proceso ${proceso} (SECOP II)`;
  const saludo = saludoDestinatario(dest, entidad);

  const lines = [];
  lines.push(asunto.toUpperCase());
  lines.push("");
  lines.push(`Fecha: ${hoy}`);
  lines.push("");
  lines.push(saludo);
  lines.push("");
  lines.push("Referencia del contrato/proceso:");
  lines.push(`- Entidad: ${entidad}`);
  lines.push(`- Proceso/ID: ${proceso}`);
  lines.push(`- Tipo de obra: ${tipo}`);
  lines.push(`- Municipio/Departamento: ${ubic}`);
  lines.push(`- Enlace SECOP II: ${secop}`);
  lines.push("");
  lines.push("Respetuosamente, en ejercicio del derecho fundamental de petición, solicito información y aclaraciones relacionadas con la ejecución y/o liquidación del contrato referido, con el fin de ejercer control social y verificar la transparencia y correcta inversión de recursos públicos.");
  lines.push("");

  if (docsFaltantes.length) {
    lines.push("1) Documentos requeridos (faltantes/pendientes):");
    docsFaltantes.slice(0, 20).forEach(d => lines.push(`- ${d}`));
    lines.push("");
  }

  if (hallazgos.length) {
    lines.push("2) Hechos observados (para aclaración y soporte):");
    hallazgos.slice(0, 10).forEach(h => {
      lines.push(`- ${h.id} (${h.severidad} / ${h.fase}): ${h.hecho}`);
      lines.push(`  Evidencia/Fuente: ${h.evidencia}`);
      if (h.impacto) lines.push(`  Impacto/Riesgo: ${h.impacto}`);
      lines.push(`  Solicitud: ${h.solicitud}`);
      const fotos = (c.evidences||[]).filter(e => (e.links||[]).some(x => x.type==="hallazgo" && x.id===h.id));
      if (fotos.length) lines.push(`  Fotos (offline): ${fotos.map(x=>x.id).join(", ")}`);
    });
    lines.push("");
  } else {
    lines.push("2) Hechos observados:");
    lines.push("- (A la fecha, no se registran hechos específicos; se solicita garantizar publicidad y entrega de soportes).");
    lines.push("");
  }

  lines.push("3) Solicitudes puntuales:");
  lines.push("- Indicar responsable (supervisor/interventor) y canal oficial para entrega de información.");
  lines.push("- Señalar fecha de publicación en SECOP II de actas e informes relevantes, o remitirlos si no se han publicado.");
  if (extra) {
    lines.push("- Solicitudes adicionales:");
    extra.split("\n").map(x => x.trim()).filter(Boolean).forEach(x => lines.push(`  - ${x}`));
  }
  lines.push("");
  lines.push("Agradezco su respuesta de fondo y el suministro de soportes documentales, preferiblemente mediante enlaces oficiales en SECOP II o copia digital. Esta solicitud se formula sin acusaciones, con enfoque preventivo/detectivo y basada en hechos verificables.");
  lines.push("");
  lines.push("Atentamente,");
  lines.push("______________________________");
  lines.push(`Nombre veedor / Veeduría: ${getUserName()}`);
  lines.push("Documento / Contacto");
  lines.push("");
  return lines.join("\n");
}

function saludoDestinatario(dest, entidad) {
  switch (dest) {
    case "Interventoria": return "Señores\nINTERVENTORÍA / SUPERVISIÓN DEL CONTRATO\n(Entidad/Contrato relacionado)\nCiudad";
    case "Personeria": return "Señores\nPERSONERÍA MUNICIPAL\nCiudad";
    case "Contraloria": return "Señores\nCONTRALORÍA (Competente)\nCiudad";
    case "Procuraduria": return "Señores\nPROCURADURÍA (Competente)\nCiudad";
    default: return `Señores\n${entidad}\nCiudad`;
  }
}

function filterHallazgosBy(filtro) {
  const c = getActiveCase();
  const hs = c.hallazgos || [];
  if (filtro === "criticas") return hs.filter(h => h.severidad === "Alerta crítica");
  if (filtro === "alertas") return hs.filter(h => h.severidad === "Alerta" || h.severidad === "Alerta crítica");
  return hs;
}

function listDocsFaltantes() {
  const c = getActiveCase();
  const tipo = c.caso.tipoInfra || "";
  if (!tipo) return [];
  const docs = getDocsForSelectedType();
  const falt = [];
  docs.forEach(d => {
    const st = c.docs?.[d.id]?.estado || "pendiente";
    if (st === "no_aplica") return;
    if (st === "pendiente" || st === "no_disponible") falt.push(`${d.id}: ${d.nombre} (fase: ${d.fase})`);
  });
  return falt;
}

function updateInformeBox(forceGen = false) {
  const box = $("informeBox");
  if (!box) return;
  if (!forceGen && box.value.trim()) return;
  box.value = buildInformeDestinatario();
}

function buildInformeDestinatario() {
  const c = getActiveCase();
  const dest = $("informeDest")?.value || "Entidad";
  const enfoque = $("informeEnfoque")?.value || "tecnico";
  const hoy = new Date().toISOString().slice(0,10);

  const entidad = c.caso.entidad || "—";
  const proceso = c.caso.procesoId || "—";
  const ubic = c.caso.ubicacion || "—";
  const tipo = getTipoNombre(c.caso.tipoInfra || "") || "—";
  const secop = c.caso.secopUrl || "—";

  const riskScore = computeRiskScore();
  const level = riskLevel(riskScore);

  const hallazgos = (c.hallazgos || []).slice(0, 10);
  const docsFalt = listDocsFaltantes().slice(0, 20);

  const intro = introPorDest(dest, enfoque, level, riskScore);

  const lines = [];
  lines.push(`INFORME DE VEEDURÍA CIUDADANA – ${dest.toUpperCase()}`);
  lines.push(`Fecha: ${hoy}`);
  lines.push(`Usuario: ${getUserName()}`);
  lines.push("");
  lines.push("1. Identificación del caso (SECOP II)");
  lines.push(`- Caso: ${c.nombre}`);
  lines.push(`- Entidad: ${entidad}`);
  lines.push(`- Proceso/ID: ${proceso}`);
  lines.push(`- Tipo de obra: ${tipo}`);
  lines.push(`- Municipio/Departamento: ${ubic}`);
  lines.push(`- Enlace SECOP II: ${secop}`);
  lines.push("");

  lines.push("2. Enfoque y alcance");
  lines.push(intro);
  lines.push("");

  lines.push("3. Resumen de riesgo (orientativo)");
  lines.push(`- Puntaje: ${riskScore}/100 · Nivel: ${level}`);
  lines.push("");

  if (docsFalt.length) {
    lines.push("4. Documentación pendiente / faltante (según verificación ciudadana)");
    docsFalt.forEach(d => lines.push(`- ${d}`));
    lines.push("");
  }

  lines.push("5. Hallazgos (hechos verificables)");
  if (!hallazgos.length) {
    lines.push("- (Sin hallazgos registrados a la fecha. Se sugiere continuar seguimiento y garantizar publicidad de soportes.)");
  } else {
    hallazgos.forEach(h => {
      lines.push(`${h.id} — ${h.severidad} — ${h.fase}`);
      lines.push(`Hecho: ${h.hecho}`);
      lines.push(`Evidencia: ${h.evidencia}`);
      const fotos = (c.evidences||[]).filter(e => (e.links||[]).some(x => x.type==="hallazgo" && x.id===h.id));
      if (fotos.length) lines.push(`Fotos (offline): ${fotos.map(x=>x.id).join(", ")}`);
      if (h.impacto) lines.push(`Impacto/Riesgo: ${h.impacto}`);
      lines.push(`Solicitud: ${h.solicitud}`);
      lines.push("");
    });
  }

  lines.push("6. Recomendaciones / solicitudes");
  lines.push(recomendacionesPorDest(dest, level));
  lines.push("");

  lines.push("7. Nota metodológica");
  lines.push("Este informe no constituye imputación penal ni dictamen técnico oficial. Resume control social basado en revisión documental SECOP II, bitácora, evidencia (fotos offline) y checklist por tipo.");

  return lines.join("\n");
}

function introPorDest(dest, enfoque, level, score) {
  const base = {
    tecnico: "Este informe presenta verificación documental y trazabilidad de hechos/evidencias (SECOP II y soportes).",
    control: "Este informe se orienta a transparencia, publicidad de información y atención a solicitudes ciudadanas.",
    riesgo: "Este informe prioriza riesgos de costo, plazo, calidad y posibles inconsistencias que requieren verificación institucional."
  }[enfoque] || "Este informe presenta verificación documental y trazabilidad de hechos/evidencias.";

  const extra = {
    Entidad: "Se solicita gestión correctiva, entrega de soportes y publicación oportuna de documentos en SECOP II.",
    Interventoria: "Se solicita soporte técnico-documental de seguimiento, control de calidad y consistencia de reportes.",
    Personeria: "Se solicita acompañamiento al control social y verificación administrativa local.",
    Contraloria: "Se solicita valoración fiscal y verificación de soportes de pagos, actas y modificaciones.",
    Procuraduria: "Se solicita verificación disciplinaria y cumplimiento de deberes de publicidad y control."
  }[dest] || "";

  return `${base} Nivel de riesgo orientativo: ${level} (${score}/100). ${extra}`;
}

function recomendacionesPorDest(dest, level) {
  const recBase = {
    Alto: "Dado el nivel alto, se recomienda respuesta prioritaria, revisión integral y trazabilidad de cambios/pagos, y garantizar entrega de soportes.",
    Medio: "Se recomienda completar documentación, responder solicitudes y ajustar mecanismos de control y publicación.",
    Bajo: "Se recomienda continuidad del seguimiento y asegurar publicidad completa de documentos."
  }[level] || "";

  const recDest = {
    Entidad: "- Publicar y/o remitir actas e informes faltantes.\n- Aclarar y soportar modificaciones, pagos y cronograma.\n- Establecer punto focal para respuesta ciudadana.",
    Interventoria: "- Adjuntar soportes (fotos/mediciones/ensayos) a informes.\n- Explicar diferencias entre avance físico y financiero.\n- Certificar calidad y pruebas según tipo de obra.",
    Personeria: "- Acompañar a la veeduría en respuesta institucional.\n- Verificar atención a peticiones y publicidad de información.",
    Contraloria: "- Verificar soportes de pagos/actas parciales.\n- Revisar cambios contractuales y saldos en liquidación.\n- Recomendar acciones de control fiscal si aplica.",
    Procuraduria: "- Verificar deberes de publicación y control.\n- Evaluar si existen omisiones disciplinarias en supervisión/interventoría."
  }[dest] || "- Garantizar respuesta de fondo y soportes.";

  return `${recBase}\n${recDest}`;
}

// ---------- Informe preliminar ----------
function updateReportBox() {
  $("reportBox").value = buildPreliminaryReport();
}

function buildPreliminaryReport() {
  const c = getActiveCase();
  const tipoNombre = getTipoNombre(c.caso.tipoInfra || "");
  const hoy = new Date().toISOString().slice(0, 10);
  const prog = computeOverallProgress();

  const lines = [];
  lines.push(`INFORME PRELIMINAR DE VEEDURÍA (AUDITORÍA FORENSE PREVENTIVA/DETECTIVA)`);
  lines.push(`Fecha: ${hoy}`);
  lines.push(`Usuario: ${getUserName()}`);
  lines.push(``);
  lines.push(`1. Identificación del caso (SECOP II)`);
  lines.push(`- Caso: ${c.nombre}`);
  lines.push(`- Entidad: ${c.caso.entidad || "—"}`);
  lines.push(`- Proceso/ID: ${c.caso.procesoId || "—"}`);
  lines.push(`- Municipio/Departamento: ${c.caso.ubicacion || "—"}`);
  lines.push(`- Tipo de obra: ${tipoNombre || "—"}`);
  lines.push(`- Enlace SECOP II: ${c.caso.secopUrl || "—"}`);
  lines.push(``);

  lines.push(`2. Avance de verificación (checklist general + específico por tipo)`);
  lines.push(`- Progreso: ${prog.percent}% (${prog.done}/${prog.total} ítems)`);
  lines.push(``);

  lines.push(`3. Documentos mínimos (estado general)`);
  const docs = getDocsForSelectedType();
  if (!c.caso.tipoInfra) lines.push(`- (Seleccione tipo de obra para evaluar documentos específicos)`);
  else lines.push(`- Faltantes/pendientes: ${computeMissingDocsCount(docs)} de ${docs.length}`);
  lines.push(`- Fotos asociadas a documentos: ${countEvidenceByLinkType(c, "doc")}`);
  lines.push(``);

  lines.push(`4. Evidencias (fotos)`);
  lines.push(`- Total evidencias guardadas (offline): ${(c.evidences||[]).length}`);
  lines.push(``);

  lines.push(`5. Bitácora (extracto)`);
  if ((c.logs || []).length === 0) lines.push(`- (Sin registros aún)`);
  else c.logs.slice(0, 5).forEach(l => lines.push(`- ${new Date(l.ts).toLocaleString()} — ${l.text}`));
  lines.push(``);

  const hallazgos = c.hallazgos || [];
  const counts = countHallazgos();

  lines.push(`6. Hallazgos registrados`);
  lines.push(`- Observaciones: ${counts.obs}`);
  lines.push(`- Alertas: ${counts.alerta}`);
  lines.push(`- Alertas críticas: ${counts.critica}`);
  lines.push(`- Fotos asociadas a hallazgos: ${countEvidenceByLinkType(c, "hallazgo")}`);
  lines.push(``);

  if (!hallazgos.length) lines.push(`(Sin hallazgos registrados)`);
  else {
    hallazgos.slice(0, 10).forEach(h => {
      lines.push(`${h.id} — ${h.severidad} — ${h.fase} — ${new Date(h.ts).toLocaleString()}`);
      lines.push(`Hecho: ${h.hecho}`);
      lines.push(`Evidencia: ${h.evidencia}`);
      const fotos = getEvidencesLinked(c, "hallazgo", h.id);
      if (fotos.length) lines.push(`Fotos (offline): ${fotos.map(x=>x.id).join(", ")}`);
      if (h.impacto) lines.push(`Impacto/Riesgo: ${h.impacto}`);
      lines.push(`Solicitud: ${h.solicitud}`);
      lines.push(``);
    });
  }

  const score = computeRiskScore();
  lines.push(`7. Riesgo del caso (orientativo)`);
  lines.push(`- Puntaje: ${score}/100 · Nivel: ${riskLevel(score)}`);
  lines.push(``);

  lines.push(`8. Nota metodológica`);
  lines.push(`Este informe no constituye imputación penal; presenta hechos verificables y solicitudes concretas basadas en SECOP II, bitácora, fotos offline y evidencia organizada.`);

  return lines.join("\n");
}

function countEvidenceByLinkType(c, linkType) {
  return (c.evidences || []).filter(e => (e.links||[]).some(x => x.type === linkType)).length;
}

// ---------- PDF con anexos (miniaturas embebidas) ----------
async function exportReportToPDFWithAnnexes() {
  const c = getActiveCase();
  const reportText = buildPreliminaryReport();
  const title = `Informe preliminar - ${c.nombre}`;

  // Prepara anexos con miniaturas (data URL)
  const hallazgoEvs = (c.evidences || []).filter(e => (e.links||[]).some(x => x.type === "hallazgo"));
  const docEvs = (c.evidences || []).filter(e => (e.links||[]).some(x => x.type === "doc"));
  const otherEvs = (c.evidences || []).filter(e => !(e.links||[]).some(x => x.type === "hallazgo" || x.type === "doc"));

  const MAX_IMG = 36; // para evitar PDFs gigantes
  const picked = [
    ...hallazgoEvs.slice(0, Math.min(MAX_IMG, hallazgoEvs.length)),
    ...docEvs.slice(0, Math.max(0, MAX_IMG - Math.min(MAX_IMG, hallazgoEvs.length))).slice(0, MAX_IMG),
  ].slice(0, MAX_IMG);

  // Si aún hay espacio, agrega algunas "otras"
  const remainingSlots = MAX_IMG - picked.length;
  if (remainingSlots > 0) picked.push(...otherEvs.slice(0, remainingSlots));

  const annexItems = [];
  for (const e of picked) {
    const rec = await getEvidenceBlob(e.id);
    if (!rec?.blob) continue;
    const dataUrl = await blobToBase64DataUrl(rec.blob);
    const links = (e.links || []).map(x => `${x.type}${x.id ? ":"+x.id : ""}`).join(", ") || "—";
    annexItems.push({ id: e.id, name: e.name, links, note: e.note || "", dataUrl });
  }

  const omitted = (c.evidences || []).length - annexItems.length;

  const annexHtml = `
    <h2>Anexos (miniaturas de evidencia)</h2>
    <div class="meta">
      Evidencias anexadas: ${annexItems.length}${omitted > 0 ? ` · Omitidas por límite/tamaño: ${omitted}` : ""}
    </div>
    <div class="annexGrid">
      ${annexItems.map(x => `
        <div class="annexCard">
          <img src="${x.dataUrl}" alt="evidencia"/>
          <div class="cap">
            <div><b>${escapeHtml(x.id)}</b></div>
            <div class="sm">${escapeHtml(shorten(x.name, 40))}</div>
            <div class="sm">Vínculo: ${escapeHtml(shorten(x.links, 50))}</div>
            ${x.note ? `<div class="sm">Nota: ${escapeHtml(shorten(x.note, 60))}</div>` : ""}
          </div>
        </div>
      `).join("")}
    </div>
    <p class="sm">Sugerencia: si necesitas anexar todas las fotos, exporta el caso en JSON (con fotos) y adjúntalo como soporte digital.</p>
  `;

  const html = `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8"/>
    <title>${escapeHtml(title)}</title>
    <style>
      body{ font-family: Arial, Helvetica, sans-serif; margin: 24px; color:#111; }
      h1{ font-size: 18px; margin:0 0 10px; }
      h2{ font-size: 14px; margin:18px 0 10px; }
      .meta{ font-size: 12px; color:#333; margin-bottom: 12px; }
      pre{ white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.35; }
      .sm{ font-size: 10px; color:#333; line-height:1.25; }
      .annexGrid{
        display:grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 10px;
      }
      .annexCard{
        border: 1px solid #ddd;
        border-radius: 10px;
        overflow:hidden;
        page-break-inside: avoid;
      }
      .annexCard img{
        width: 100%;
        height: 130px;
        object-fit: cover;
        display:block;
      }
      .cap{ padding: 8px; }
      @media print{
        body{ margin: 12mm; }
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">Generado por Veeduría Forense (PWA) · ${escapeHtml(new Date().toLocaleString())}</div>
    <pre>${escapeHtml(reportText)}</pre>
    ${annexHtml}
    <script>
      setTimeout(()=>{ window.print(); }, 250);
    </script>
  </body>
  </html>`;

  const w = window.open("", "_blank");
  if (!w) {
    alert("El navegador bloqueó la ventana emergente. Habilita popups para exportar PDF.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// ---------- Progreso ----------
function computeOverallProgress() {
  const c = getActiveCase();
  const allItems = [];
  (metodologia.fases || []).forEach(f => {
    const items = (f.checklist_general || []);
    items.forEach(it => allItems.push(it.id));
    const tipo = c.caso.tipoInfra || "";
    const extra = ((f.checklist_por_tipo || {})[tipo] || []);
    extra.forEach(it => allItems.push(it.id));
  });
  const uniq = [...new Set(allItems)];
  const total = uniq.length;
  const done = uniq.filter(id => !!c.checks[id]).length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return { total, done, percent };
}

function computePhaseProgressByItems(items) {
  const c = getActiveCase();
  const ids = (items || []).map(it => it.id);
  const total = ids.length;
  const done = ids.filter(id => !!c.checks[id]).length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return { total, done, percent };
}

function countHallazgos() {
  const c = getActiveCase();
  const counts = { obs: 0, alerta: 0, critica: 0 };
  (c.hallazgos || []).forEach(h => {
    if (h.severidad === "Alerta crítica") counts.critica++;
    else if (h.severidad === "Alerta") counts.alerta++;
    else counts.obs++;
  });
  return counts;
}

// ---------- CSV ----------
function buildHallazgosCSV() {
  const c = getActiveCase();
  const headers = ["id", "fecha", "fase", "severidad", "hecho", "evidencia", "impacto", "solicitud", "fotos_ids"];
  const rows = [headers];
  (c.hallazgos || []).slice().reverse().forEach(h => {
    const fotos = getEvidencesLinked(c, "hallazgo", h.id).map(x=>x.id).join("|");
    rows.push([h.id, new Date(h.ts).toLocaleString(), h.fase, h.severidad, h.hecho, h.evidencia, h.impacto || "", h.solicitud, fotos]);
  });
  return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}

function buildDocsCSV() {
  const c = getActiveCase();
  const docs = getDocsForSelectedType();
  const headers = ["doc_id", "documento", "fase", "estado", "evidencia_nota", "fotos_ids"];
  const rows = [headers];
  docs.forEach(d => {
    const st = c.docs?.[d.id]?.estado || "pendiente";
    const ev = c.docs?.[d.id]?.evidencia || "";
    const fotos = getEvidencesLinked(c, "doc", d.id).map(x=>x.id).join("|");
    rows.push([d.id, d.nombre, d.fase, st, ev, fotos]);
  });
  return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------- Historial ----------
function renderHistoryView() {
  const view = $("historyView");
  if (!view) return;

  const c = getActiveCase();
  const q = getFilterValue("searchHistory");

  const items = (c.history || []).filter(h => {
    if (!q) return true;
    const blob = `${h.ts} ${h.user} ${h.action} ${h.field} ${h.from} ${h.to} ${h.note}`.toLowerCase();
    return blob.includes(q);
  });

  if (!items.length) {
    view.innerHTML = `<p class="small">${q ? "No hay resultados con ese filtro." : "Sin historial aún."}</p>`;
    return;
  }

  const rows = items.slice(0, 140).map(h => `
    <div class="item">
      <div><b>${escapeHtml(h.action)}</b> · <span class="small">${escapeHtml(new Date(h.ts).toLocaleString())}</span></div>
      <div class="small"><b>Usuario:</b> ${escapeHtml(h.user || "—")}</div>
      <div class="small"><b>Campo:</b> ${escapeHtml(h.field || "—")}</div>
      <div class="small"><b>De:</b> ${escapeHtml(shorten(h.from, 200))}</div>
      <div class="small"><b>A:</b> ${escapeHtml(shorten(h.to, 200))}</div>
      ${h.note ? `<div class="small"><b>Nota:</b> ${escapeHtml(h.note)}</div>` : ""}
    </div>
  `).join("");

  view.innerHTML = rows;
}

function buildHistoryCSV() {
  const c = getActiveCase();
  const headers = ["fecha_iso", "fecha_local", "usuario", "accion", "campo", "de", "a", "nota"];
  const rows = [headers];
  (c.history || []).slice().reverse().forEach(h => {
    rows.push([
      h.ts,
      new Date(h.ts).toLocaleString(),
      h.user,
      h.action,
      h.field,
      h.from,
      h.to,
      h.note
    ]);
  });
  return rows.map(r => r.map(csvEscape).join(",")).join("\n");
}

// ---------- Export/Import JSON (incluye fotos) ----------
function normalizeProcesoId(pid) {
  return String(pid || "").trim().toLowerCase().replace(/\s+/g, "");
}
function findCaseByProcesoId(procesoId) {
  const key = normalizeProcesoId(procesoId);
  if (!key) return null;
  return appState.cases.find(c => normalizeProcesoId(c.caso?.procesoId) === key) || null;
}

async function buildExportPayloadForCase(c) {
  const evidences = c.evidences || [];
  const evidence_data = [];

  for (const e of evidences) {
    const rec = await getEvidenceBlob(e.id);
    if (!rec?.blob) continue;
    const base64 = await blobToBase64(rec.blob);
    evidence_data.push({
      id: e.id,
      caseId: c.id,
      name: e.name,
      mime: e.mime,
      size: e.size,
      ts: e.ts,
      note: e.note || "",
      links: e.links || [],
      base64
    });
  }

  return {
    exportado_en: new Date().toISOString(),
    formato: "veeduria_case_v3",
    metodologia: { titulo: metodologia.titulo, version: metodologia.version },
    case_meta: { id: c.id, nombre: c.nombre, creado_en: c.creado_en, actualizado_en: c.actualizado_en },
    caso: c.caso,
    checks: c.checks,
    logs: c.logs,
    docs: c.docs,
    hallazgos: c.hallazgos,
    history: c.history,
    evidences_meta: evidences,
    evidence_data,
    riesgo: { score: computeRiskScore(), level: riskLevel(computeRiskScore()) },
    informe_preliminar: buildPreliminaryReport()
  };
}

async function exportActiveCaseJSON() {
  const c = getActiveCase();
  const payload = await buildExportPayloadForCase(c);
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `caso_${safeFileName(c.nombre)}.json`);
}

async function exportAllCasesJSON() {
  const payload = {
    exportado_en: new Date().toISOString(),
    formato: "veeduria_multi_v3",
    metodologia: { titulo: metodologia.titulo, version: metodologia.version },
    userName: appState.userName || "",
    cases: []
  };

  for (const c of appState.cases) {
    payload.cases.push(await buildExportPayloadForCase(c));
  }

  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), "todos_los_casos_veeduria.json");
}

async function handleImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (data?.formato === "veeduria_multi_v3" && Array.isArray(data.cases)) {
      let mergedCount = 0;
      let addedCount = 0;

      for (const x of data.cases) {
        const imp = await convertExportToCaseV3(x);
        const existing = findCaseByProcesoId(imp.caso?.procesoId || "");
        if (existing) {
          mergeCases(existing, imp, "Import multi v3");
          mergedCount++;
        } else {
          appState.cases.unshift(imp);
          addedCount++;
        }
      }

      appState.activeCaseId = appState.cases[0].id;
      saveAppState();
      loadActiveCaseToUI();
      alert(`Importación finalizada. Fusionados: ${mergedCount}. Agregados: ${addedCount}.`);
      return;
    }

    if (data?.formato === "veeduria_case_v3") {
      const imp = await convertExportToCaseV3(data);
      const existing = findCaseByProcesoId(imp.caso?.procesoId || "");
      if (existing) {
        mergeCases(existing, imp, "Import single v3");
        appState.activeCaseId = existing.id;
      } else {
        appState.cases.unshift(imp);
        appState.activeCaseId = imp.id;
      }
      saveAppState();
      loadActiveCaseToUI();
      alert(existing ? "Caso importado y fusionado por Proceso ID." : "Caso importado.");
      return;
    }

    throw new Error("Formato de importación no reconocido (usa export v3).");
  } catch (err) {
    alert(`No se pudo importar: ${err.message || err}`);
  } finally {
    $("fileImport").value = "";
  }
}

async function convertExportToCaseV3(x) {
  const now = new Date().toISOString();
  const meta = x.case_meta || {};
  const c = makeEmptyCase(meta.nombre || "Caso importado");

  c.id = `C-${Math.random().toString(16).slice(2, 10)}-${Date.now()}`;
  c.nombre = meta.nombre || "Caso importado";
  c.creado_en = meta.creado_en || now;
  c.actualizado_en = meta.actualizado_en || now;
  c.caso = x.caso || c.caso;
  c.checks = x.checks || {};
  c.logs = x.logs || [];
  c.docs = x.docs || {};
  c.hallazgos = x.hallazgos || [];
  c.history = Array.isArray(x.history) ? x.history : [];
  c.evidences = Array.isArray(x.evidences_meta) ? x.evidences_meta : [];

  const evData = Array.isArray(x.evidence_data) ? x.evidence_data : [];
  for (const ed of evData) {
    const blob = base64ToBlob(ed.base64 || "", ed.mime || "image/jpeg");
    await putEvidenceBlob({ id: ed.id, caseId: c.id, mime: ed.mime, name: ed.name, blob });

    const idx = c.evidences.findIndex(z => z.id === ed.id);
    const metaRec = {
      id: ed.id,
      caseId: c.id,
      ts: ed.ts || now,
      name: ed.name || `foto_${ed.id}.jpg`,
      mime: ed.mime || "image/jpeg",
      size: ed.size || 0,
      note: ed.note || "",
      links: ed.links || []
    };
    if (idx >= 0) c.evidences[idx] = metaRec;
    else c.evidences.unshift(metaRec);
  }

  if (!c.history.length) {
    c.history.push({ ts: now, user: "Sistema", action: "IMPORTAR", field: "case", from: "", to: c.nombre, note: "Importado v3" });
  }

  return c;
}

// ---------- Fusión ----------
function normalizeTextKey(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function hallazgoSignature(h) {
  return `${h.fase}|${h.severidad}|${normalizeTextKey(h.hecho)}|${normalizeTextKey(h.evidencia)}|${normalizeTextKey(h.solicitud)}`;
}
function pickBetterEstado(a, b) {
  const rank = { "disponible": 5, "solicitado": 4, "pendiente": 3, "no_disponible": 2, "no_aplica": 1 };
  return (rank[b] ?? 0) > (rank[a] ?? 0) ? b : a;
}

function mergeCases(target, incoming, noteSource) {
  const beforeCounts = { logs: (target.logs || []).length, hallazgos: (target.hallazgos || []).length, evid: (target.evidences||[]).length };

  target.caso = target.caso || { secopUrl: "", entidad: "", procesoId: "", ubicacion: "", tipoInfra: "" };
  const fields = ["secopUrl", "entidad", "procesoId", "ubicacion", "tipoInfra"];
  fields.forEach(f => {
    const t = (target.caso[f] || "").trim();
    const inc = (incoming.caso?.[f] || "").trim();
    if (!t && inc) {
      target.caso[f] = inc;
      addHistory(target, "FUSIONAR", `caso.${f}`, "", inc, `Fuente: ${noteSource}`);
    }
  });

  target.checks = target.checks || {};
  const incChecks = incoming.checks || {};
  Object.keys(incChecks).forEach(k => {
    const prev = !!target.checks[k];
    const next = prev || !!incChecks[k];
    if (prev !== next) {
      target.checks[k] = next;
      addHistory(target, "FUSIONAR", `checks.${k}`, String(prev), String(next), `Fuente: ${noteSource}`);
    }
  });

  target.docs = target.docs || {};
  const incDocs = incoming.docs || {};
  Object.keys(incDocs).forEach(id => {
    const cur = target.docs[id] || { estado: "pendiente", evidencia: "" };
    const inc = incDocs[id] || { estado: "pendiente", evidencia: "" };

    const bestEstado = pickBetterEstado(cur.estado, inc.estado);
    const bestEvid = (cur.evidencia || "").trim() ? cur.evidencia : inc.evidencia;

    if (cur.estado !== bestEstado) addHistory(target, "FUSIONAR", `docs.${id}.estado`, cur.estado, bestEstado, `Fuente: ${noteSource}`);
    if ((cur.evidencia || "").trim() === "" && (bestEvid || "").trim() !== "") addHistory(target, "FUSIONAR", `docs.${id}.evidencia`, "", shorten(bestEvid,120), `Fuente: ${noteSource}`);

    target.docs[id] = { estado: bestEstado, evidencia: bestEvid || "" };
  });

  target.logs = target.logs || [];
  const logSet = new Set(target.logs.map(l => normalizeTextKey(l.text)));
  (incoming.logs || []).forEach(l => {
    const key = normalizeTextKey(l.text);
    if (!key) return;
    if (!logSet.has(key)) {
      target.logs.unshift(l);
      logSet.add(key);
    }
  });

  target.hallazgos = target.hallazgos || [];
  const sigSet = new Set(target.hallazgos.map(h => hallazgoSignature(h)));
  const existingIds = new Set(target.hallazgos.map(h => h.id));
  (incoming.hallazgos || []).forEach(h => {
    const sig = hallazgoSignature(h);
    if (sigSet.has(sig)) return;
    const clone = { ...h };
    if (existingIds.has(clone.id)) clone.id = nextHallazgoId(target);
    target.hallazgos.unshift(clone);
    existingIds.add(clone.id);
    sigSet.add(sig);
  });

  target.evidences = target.evidences || [];
  const keySet = new Set(target.evidences.map(e => `${e.name}|${e.size}|${e.ts}`));
  (incoming.evidences || []).forEach(e => {
    const key = `${e.name}|${e.size}|${e.ts}`;
    if (keySet.has(key)) return;
    target.evidences.unshift({ ...e, caseId: target.id });
    keySet.add(key);
  });

  target.history = (target.history || []).concat(Array.isArray(incoming.history) ? incoming.history : []).slice(0, 800);
  addHistory(target, "FUSIONAR_CASO", "merge", "", "", `Fusionado por Proceso ID. Fuente: ${noteSource}`);

  if (target.nombre?.startsWith("Caso")) {
    const prevName = target.nombre;
    target.nombre = deriveCaseNameFromFields(target);
    if (prevName !== target.nombre) addHistory(target, "FUSIONAR", "case.nombre", prevName, target.nombre, "Nombre derivado tras fusión");
  }

  touchCase(target);

  const afterCounts = { logs: (target.logs || []).length, hallazgos: (target.hallazgos || []).length, evid: (target.evidences||[]).length };
  addHistory(target, "RESUMEN_FUSION", "merge.counts",
    `logs:${beforeCounts.logs}, hallazgos:${beforeCounts.hallazgos}, evid:${beforeCounts.evid}`,
    `logs:${afterCounts.logs}, hallazgos:${afterCounts.hallazgos}, evid:${afterCounts.evid}`,
    `Fuente: ${noteSource}`
  );
}

// ---------- Utilidades ----------
function getTipoNombre(id) {
  if (!id) return "";
  const t = (metodologia.tipos_infraestructura || []).find(x => x.id === id);
  return t ? t.nombre : id;
}

function shorten(s, maxLen) {
  const str = String(s || "");
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

function downloadText(text, filename) {
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    alert(okMsg);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    alert(okMsg);
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }
function cssEscape(value) {
  return (window.CSS && CSS.escape) ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
function safeFileName(name) {
  return String(name || "caso")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 60) || "caso";
}

// ---------- Start ----------
init();

