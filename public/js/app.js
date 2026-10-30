const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const errEl = document.getElementById("load-error");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const pageIndicatorEl = document.getElementById("page-indicator");
const searchInput = document.getElementById("search-q");
const manualRefreshBtn = document.getElementById("manual-refresh-btn");
const timerEl = document.getElementById("refresh-timer");
const autoRefreshToggleBtn = document.getElementById("auto-refresh-toggle");

let currentPage = 1;
let currentQuery = "";
let inFlightAbort = null;

function readUrlState() {
  const params = new URLSearchParams(location.search);
  const pageParam = params.get("page");
  const pageNum = pageParam ? Number.parseInt(pageParam, 10) : NaN;
  currentPage = Number.isFinite(pageNum) && pageNum > 0 ? pageNum : 1;
  currentQuery = params.get("q") ?? "";
  if (searchInput) searchInput.value = currentQuery;
}

function syncListUrl(page, q) {
  const p = new URLSearchParams();
  if (page > 1) p.set("page", String(page));
  if (q) p.set("q", q);
  const qs = p.toString();
  const path = location.pathname || "/";
  const next = qs ? `${path}?${qs}` : path;
  const cur = `${location.pathname || "/"}${location.search || ""}`;
  if (next !== cur) history.replaceState(null, "", next);
}

function setPaginationControls(page, totalPages) {
  const safeTotalPages = Number.isFinite(totalPages) ? totalPages : 0;
  const safePage = Number.isFinite(page) ? page : 1;

  prevBtn.disabled = safeTotalPages <= 1 || safePage <= 1;
  nextBtn.disabled = safeTotalPages <= 1 || safePage >= safeTotalPages;
  pageIndicatorEl.textContent = safeTotalPages === 0 ? "第 0 / 0 頁" : `第 ${safePage} / ${safeTotalPages} 頁`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-Hant", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function createSkeleton() {
  const li = document.createElement("li");
  li.className = "loading-skeleton";
  li.innerHTML = `<div class="sk-line"></div><div class="sk-line short"></div>`;
  return li;
}

function setLoading(count) {
  listEl.innerHTML = "";
  emptyEl.classList.add("hidden");
  errEl.classList.add("hidden");
  errEl.textContent = "";
  for (let i = 0; i < count; i += 1) {
    listEl.appendChild(createSkeleton());
  }
}

async function loadMails(pageToLoad) {
  const page = pageToLoad ?? currentPage;

  if (inFlightAbort) {
    inFlightAbort.abort();
  }
  inFlightAbort = new AbortController();
  const signal = inFlightAbort.signal;

  setLoading(4);

  try {
    const apiQs = new URLSearchParams();
    apiQs.set("page", String(page));
    if (currentQuery) apiQs.set("q", currentQuery);
    const r = await fetch(`/api/mails?${apiQs.toString()}`, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const data = await r.json();
    const mails = data.mails ?? [];
    currentPage = data.page ?? page;
    setPaginationControls(data.page, data.totalPages);
    syncListUrl(currentPage, currentQuery);

    listEl.innerHTML = "";
    errEl.classList.add("hidden");
    emptyEl.classList.toggle("hidden", mails.length > 0);
    if (mails.length === 0) return;

    for (const m of mails) {
      const li = document.createElement("li");
      const a = document.createElement("a");

      const mailQs = new URLSearchParams();
      mailQs.set("id", m.id);
      mailQs.set("page", String(currentPage));
      if (currentQuery) mailQs.set("q", currentQuery);
      a.href = `/mail.html?${mailQs.toString()}`;
      a.className = "mail-card";

      const subject = document.createElement("div");
      subject.className = "mail-card-subject";
      subject.textContent = m.subject || "(no subject)";

      const meta = document.createElement("div");
      meta.className = "mail-card-meta";
      meta.innerHTML = `
        <span>From: ${escapeHtml(m.from ?? "")}</span>
        <span>To: ${escapeHtml(m.to ?? "")}</span>
        <span>${escapeHtml(formatDate(m.receivedAt))}</span>
      `;

      a.appendChild(subject);
      a.appendChild(meta);
      li.appendChild(a);
      listEl.appendChild(li);
    }
  } catch (e) {
    if (e.name === "AbortError") return;
    listEl.innerHTML = "";
    emptyEl.classList.add("hidden");
    errEl.classList.remove("hidden");
    errEl.textContent = `無法載入列表：${e?.message || String(e)}`;
    setPaginationControls(1, 0);
  } finally {
    inFlightAbort = null;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

prevBtn.addEventListener("click", () => loadMails(currentPage - 1));
nextBtn.addEventListener("click", () => loadMails(currentPage + 1));

let searchDebounceId = null;
if (searchInput) {
  searchInput.addEventListener("input", () => {
    if (searchDebounceId !== null) clearTimeout(searchDebounceId);
    searchDebounceId = setTimeout(() => {
      searchDebounceId = null;
      currentQuery = (searchInput.value || "").trim();
      loadMails(1);
    }, 500);
  });
}

const REFRESH_SECONDS = 30;
let remain = REFRESH_SECONDS;
let autoRefreshEnabled = false;
let refreshIntervalId = null;

function updateAutoRefreshUi() {
  if (timerEl) timerEl.textContent = autoRefreshEnabled ? String(remain) : "--";
  if (!autoRefreshToggleBtn) return;
  autoRefreshToggleBtn.textContent = autoRefreshEnabled ? "開啟中" : "已關閉";
  autoRefreshToggleBtn.setAttribute("aria-pressed", autoRefreshEnabled ? "true" : "false");
  autoRefreshToggleBtn.classList.toggle("btn-pressed", autoRefreshEnabled);
}

function tick() {
  if (!autoRefreshEnabled) return;
  remain -= 1;
  if (remain <= 0) {
    remain = REFRESH_SECONDS;
    loadMails(currentPage);
  }
  updateAutoRefreshUi();
}

function startAutoRefresh() {
  autoRefreshEnabled = true;
  if (remain <= 0 || remain > REFRESH_SECONDS) remain = REFRESH_SECONDS;
  if (refreshIntervalId !== null) return;
  updateAutoRefreshUi();
  refreshIntervalId = setInterval(tick, 1000);
}

function stopAutoRefresh() {
  autoRefreshEnabled = false;
  if (refreshIntervalId !== null) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
  updateAutoRefreshUi();
}

if (autoRefreshToggleBtn) {
  autoRefreshToggleBtn.addEventListener("click", () => {
    if (autoRefreshEnabled) stopAutoRefresh();
    else startAutoRefresh();
  });
}

if (manualRefreshBtn) {
  manualRefreshBtn.addEventListener("click", () => {
    remain = REFRESH_SECONDS;
    loadMails(currentPage);
    updateAutoRefreshUi();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (refreshIntervalId !== null) clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  } else if (autoRefreshEnabled) {
    remain = REFRESH_SECONDS;
    updateAutoRefreshUi();
    refreshIntervalId = setInterval(tick, 1000);
  }
});

// Compose modal
const composeBackdrop = document.getElementById("compose-backdrop");
const composeBtn = document.getElementById("compose-btn");
const composeClose = document.getElementById("compose-close");
const composeCancel = document.getElementById("compose-cancel");
const composeForm = document.getElementById("compose-form");
const dropZone = document.getElementById("drop-zone");
const attachmentInput = document.getElementById("attachment-input");
const attachmentList = document.getElementById("attachment-list");
const composeSubmit = document.getElementById("compose-submit");

let composeAttachments = [];

function openCompose() {
  composeBackdrop.classList.add("open");
  composeBackdrop.setAttribute("aria-hidden", "false");
  document.getElementById("compose-to").focus();
}

function closeCompose() {
  composeBackdrop.classList.remove("open");
  composeBackdrop.setAttribute("aria-hidden", "true");
}

function resetCompose() {
  composeForm.reset();
  composeAttachments = [];
  renderAttachmentList();
}

function renderAttachmentList() {
  attachmentList.innerHTML = "";
  for (const file of composeAttachments) {
    const li = document.createElement("li");
    li.className = "attachment-item";
    li.innerHTML = `
      <span class="attachment-info">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21.44 11.05 12.94 19.54a6.001 6.001 0 0 1-8.49-8.49l8.49-8.49a4.002 4.002 0 0 1 5.66 5.66l-8.49 8.49a2.002 2.002 0 0 1-2.83-2.83l8.49-8.49" />
        </svg>
        <span class="attachment-name">${escapeHtml(file.name)}</span>
        <span class="attachment-size">${formatBytes(file.size)}</span>
      </span>
      <button type="button" class="attachment-remove" data-name="${escapeHtml(file.name)}" aria-label="移除 ${escapeHtml(file.name)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    `;
    attachmentList.appendChild(li);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 2)} ${sizes[i]}`;
}

function addFiles(files) {
  for (const file of files) {
    if (!composeAttachments.some((f) => f.name === file.name && f.size === file.size)) {
      composeAttachments.push(file);
    }
  }
  renderAttachmentList();
}

function splitAddressList(value) {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const idx = result.indexOf("base64,");
      resolve(idx >= 0 ? result.slice(idx + 7) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

if (composeBtn) composeBtn.addEventListener("click", openCompose);
if (composeClose) composeClose.addEventListener("click", closeCompose);
if (composeCancel) composeCancel.addEventListener("click", closeCompose);
composeBackdrop.addEventListener("click", (e) => {
  if (e.target === composeBackdrop) closeCompose();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && composeBackdrop.classList.contains("open")) {
    closeCompose();
  }
});

dropZone.addEventListener("click", () => attachmentInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    attachmentInput.click();
  }
});
attachmentInput.addEventListener("change", () => {
  if (attachmentInput.files) addFiles(Array.from(attachmentInput.files));
  attachmentInput.value = "";
});

["dragenter", "dragover"].forEach((name) => {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add("drag-over");
  });
});
["dragleave", "drop"].forEach((name) => {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove("drag-over");
  });
});
dropZone.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files) addFiles(Array.from(e.dataTransfer.files));
});

attachmentList.addEventListener("click", (e) => {
  const removeBtn = e.target.closest(".attachment-remove");
  if (!removeBtn) return;
  const name = removeBtn.getAttribute("data-name");
  composeAttachments = composeAttachments.filter((f) => f.name !== name);
  renderAttachmentList();
});

let isSending = false;

composeForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Debounce guard: early-return if already sending
  if (isSending) return;

  const fromLocal = document.getElementById("compose-from-local").value.trim();
  const fromDomain = document.getElementById("compose-from-domain").value;
  const fromValue = fromLocal && fromDomain ? `${fromLocal}@${fromDomain}` : "";
  const toValue = document.getElementById("compose-to").value.trim();
  const subjectValue = document.getElementById("compose-subject").value.trim();

  if (!fromValue) {
    notify("請填寫寄件者地址", "danger");
    return;
  }
  if (!toValue) {
    notify("請至少填寫一位收件者", "danger");
    return;
  }
  if (!subjectValue) {
    notify("請填寫郵件主旨", "danger");
    return;
  }

  isSending = true;
  composeSubmit.disabled = true;
  composeSubmit.classList.add("btn-loading");
  composeSubmit.innerHTML = '<span class="btn-spinner"></span> 送出中…';

  try {
    const to = splitAddressList(toValue);
    const cc = splitAddressList(document.getElementById("compose-cc").value);
    const bcc = splitAddressList(document.getElementById("compose-bcc").value);
    const subject = subjectValue;
    const text = document.getElementById("compose-body").value;
    const nameValue = document.getElementById("compose-name").value.trim();

    const attachments = [];
    for (const file of composeAttachments) {
      const content = await readFileAsBase64(file);
      attachments.push({
        content,
        filename: file.name,
        type: file.type || "application/octet-stream",
        disposition: "attachment"
      });
    }

    const payload = {
      to,
      from: fromValue,
      name: nameValue || undefined,
      subject,
      text,
      cc,
      bcc,
      attachments,
      headers: {}
    };

    // /api/send 為預留端點，請於 src/index.ts 中實作郵件發送邏輯。
    const r = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${r.status}`);
    }

    notify("郵件已送出", "success");
    resetCompose();
    setTimeout(() => closeCompose(), 800);
  } catch (e) {
    notify(`送出失敗：${e?.message || String(e)}`, "danger");
  } finally {
    isSending = false;
    composeSubmit.disabled = false;
    composeSubmit.classList.remove("btn-loading");
    composeSubmit.textContent = "送出";
  }
});

readUrlState();
loadMails(currentPage);
updateAutoRefreshUi();
