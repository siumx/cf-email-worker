(function () {
  "use strict";

  const api = window.MailApi;
  const utils = window.MailUtils;
  const { escapeHtml } = utils;
  const actions = new Map();
  let preferences;

  const t = (key, params) => window.i18next.t(key, params);
  const formatDate = (iso, options) => utils.formatDate(iso, preferences.language, preferences.timeZone, options);
  const formatBytes = (bytes) => utils.formatBytes(bytes, preferences.language);

  function setMessage(element, key, params = {}) {
    element.dataset.i18n = key;
    element.dataset.i18nParams = JSON.stringify(params);
    element.textContent = t(key, params);
  }

  function renderError(element) {
    const { errorContext, errorCode, errorStatus } = element.dataset;
    const codeKey = `errors.codes.${errorCode}`;
    let reason = t("errors.codes.NETWORK_ERROR");
    if (window.i18next.exists(codeKey)) reason = t(codeKey);
    else if (errorStatus) reason = t("errors.http", { status: errorStatus });
    element.textContent = t(errorContext, { reason });
  }

  function showError(element, context, error) {
    delete element.dataset.i18n;
    element.dataset.errorContext = context;
    element.dataset.errorCode = error?.code || "";
    element.dataset.errorStatus = error?.status || "";
    element.classList.remove("hidden");
    renderError(element);
  }

  function translate() {
    document.documentElement.lang = preferences.language;
    for (const element of document.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n, JSON.parse(element.dataset.i18nParams || "{}"));
    }
    for (const attribute of ["title", "placeholder", "aria-label"]) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        const key = element.getAttribute(`data-i18n-${attribute}`);
        element.setAttribute(attribute, t(key, JSON.parse(element.dataset.i18nParams || "{}")));
      }
    }
    for (const element of document.querySelectorAll("[data-error-context]")) renderError(element);
    for (const element of document.querySelectorAll("time[datetime]")) {
      const options = element.hasAttribute("data-include-seconds") ? { second: "2-digit" } : {};
      element.textContent = formatDate(element.getAttribute("datetime"), options);
    }
    for (const element of document.querySelectorAll("[data-bytes]")) {
      element.textContent = formatBytes(Number(element.dataset.bytes));
    }
  }

  function dismissToast(toast) {
    if (!toast || toast.dataset.dismissed) return;
    toast.dataset.dismissed = "1";
    toast.classList.add("toast-out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  }

  function createToast(type) {
    let container = document.querySelector(".toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "toast-container";
      container.setAttribute("aria-live", "polite");
      container.setAttribute("aria-atomic", "false");
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.setAttribute("role", "alert");
    const message = document.createElement("span");
    message.className = "toast-message";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.dataset.action = "dismiss-toast";
    close.dataset.i18nAriaLabel = "common.close";
    close.setAttribute("aria-label", t("common.close"));
    close.textContent = "×";
    toast.append(message, close);
    container.appendChild(toast);
    setTimeout(() => dismissToast(toast), 3000);
    return message;
  }

  function notify(key, type = "info", params) {
    setMessage(createToast(type), key, params);
  }

  function notifyError(context, error) {
    showError(createToast("danger"), context, error);
  }

  async function initPreferences() {
    const languages = await api.getLanguages();
    preferences = utils.resolvePreferences(api.readPreferences(), languages);
    const resources = {
      [utils.DEFAULT_LANGUAGE]: { translation: await api.getTranslations(utils.DEFAULT_LANGUAGE) }
    };
    let languageFailed = false;
    if (preferences.language !== utils.DEFAULT_LANGUAGE) {
      try {
        resources[preferences.language] = { translation: await api.getTranslations(preferences.language) };
      } catch {
        preferences.language = utils.DEFAULT_LANGUAGE;
        languageFailed = true;
      }
    }
    await window.i18next.init({
      lng: preferences.language,
      fallbackLng: utils.DEFAULT_LANGUAGE,
      supportedLngs: languages.map(({ code }) => code),
      load: "currentOnly",
      resources,
      returnEmptyString: false,
      // Translations are written through textContent/setAttribute, never interpreted as HTML.
      interpolation: { escapeValue: false }
    });

    const languageSelect = document.getElementById("language-select");
    languageSelect.replaceChildren();
    for (const language of languages) {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.label;
      languageSelect.appendChild(option);
    }
    languageSelect.value = preferences.language;
    languageSelect.disabled = false;

    const timeZoneSelect = document.getElementById("timezone-select");
    timeZoneSelect.replaceChildren();
    for (const timeZone of utils.getTimeZones(preferences.timeZone)) {
      const option = document.createElement("option");
      option.value = timeZone;
      option.textContent = timeZone === utils.DEFAULT_TIME_ZONE ? `UTC+08:00 — ${timeZone}` : timeZone.replaceAll("_", " ");
      timeZoneSelect.appendChild(option);
    }
    timeZoneSelect.value = preferences.timeZone;
    timeZoneSelect.disabled = false;
    api.savePreferences(preferences);
    translate();
    if (languageFailed) notify("errors.languageFailed", "danger");

    document.addEventListener("change", async (event) => {
      const select = event.target.closest("select[data-action]");
      if (!select) return;
      if (select.dataset.action === "change-timezone") {
        preferences.timeZone = utils.normalizeTimeZone(select.value);
        select.value = preferences.timeZone;
        api.savePreferences(preferences);
        translate();
      }
      if (select.dataset.action === "change-language") {
        const language = select.value;
        if (!languages.some(({ code }) => code === language)) return;
        select.disabled = true;
        try {
          if (!window.i18next.hasResourceBundle(language, "translation")) {
            window.i18next.addResourceBundle(language, "translation", await api.getTranslations(language));
          }
          await window.i18next.changeLanguage(language);
          preferences.language = language;
          api.savePreferences(preferences);
          translate();
        } catch {
          notify("errors.languageFailed", "danger");
        } finally {
          select.value = preferences.language;
          select.disabled = false;
        }
      }
    });
  }

  actions.set("dismiss-toast", (event, element) => dismissToast(element.closest(".toast")));
  document.addEventListener("click", (event) => {
    const element = event.target.closest("[data-action]");
    if (element) actions.get(element.dataset.action)?.(event, element);
  });

  async function start() {
    try {
      await initPreferences();
      if (document.querySelector('[data-component="inbox-page"]')) initInbox();
      if (document.querySelector('[data-component="mail-detail-page"]')) initMailDetail();
    } catch (error) {
      console.error("Could not initialize the mail interface", error);
      const alert = document.getElementById("load-error") || document.getElementById("err");
      alert.classList.remove("hidden");
      alert.textContent = "Could not load interface settings. Please reload.";
    }
  }

  function initInbox() {
    const listEl = document.getElementById("list");
    const emptyEl = document.getElementById("empty");
    const errEl = document.getElementById("load-error");
    const prevBtn = document.getElementById("prev-btn");
    const nextBtn = document.getElementById("next-btn");
    const pageIndicatorEl = document.getElementById("page-indicator");
    const searchInput = document.getElementById("search-q");
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
      setMessage(pageIndicatorEl, "inbox.page", { page: safeTotalPages === 0 ? 0 : safePage, total: safeTotalPages });
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
      delete errEl.dataset.errorContext;
      for (let i = 0; i < count; i += 1) {
        listEl.appendChild(createSkeleton());
      }
    }

    async function loadMails(pageToLoad) {
      const page = pageToLoad ?? currentPage;

      if (inFlightAbort) {
        inFlightAbort.abort();
      }
      const controller = new AbortController();
      inFlightAbort = controller;
      const signal = controller.signal;

      setLoading(4);

      try {
        const data = await api.getMails(page, currentQuery, signal);
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
          if (m.subject) subject.textContent = m.subject;
          else setMessage(subject, "common.noSubject");

          const meta = document.createElement("div");
          meta.className = "mail-card-meta";
          meta.innerHTML = `
            <span><span data-i18n="common.from">${escapeHtml(t("common.from"))}</span>: ${escapeHtml(m.from ?? "")}</span>
            <span><span data-i18n="common.to">${escapeHtml(t("common.to"))}</span>: ${escapeHtml(m.to ?? "")}</span>
            <time datetime="${escapeHtml(m.receivedAt ?? "")}">${escapeHtml(formatDate(m.receivedAt))}</time>
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
        showError(errEl, "errors.loadList", e);
        setPaginationControls(1, 0);
      } finally {
        if (inFlightAbort === controller) inFlightAbort = null;
      }
    }

    actions.set("previous-page", () => loadMails(currentPage - 1));
    actions.set("next-page", () => loadMails(currentPage + 1));

    let searchDebounceId = null;
    document.addEventListener("input", (event) => {
      if (event.target.dataset.action === "search") {
        if (searchDebounceId !== null) clearTimeout(searchDebounceId);
        searchDebounceId = setTimeout(() => {
          searchDebounceId = null;
          currentQuery = (searchInput.value || "").trim();
          loadMails(1);
        }, 500);
      }
    });

    const REFRESH_SECONDS = 30;
    let remain = REFRESH_SECONDS;
    let autoRefreshEnabled = false;
    let refreshIntervalId = null;

    function updateAutoRefreshUi() {
      if (timerEl) setMessage(timerEl, autoRefreshEnabled ? "inbox.refreshCountdown" : "inbox.refreshPaused", { count: remain });
      if (!autoRefreshToggleBtn) return;
      setMessage(autoRefreshToggleBtn, autoRefreshEnabled ? "inbox.on" : "inbox.off");
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

    actions.set("toggle-refresh", () => {
      if (autoRefreshEnabled) stopAutoRefresh();
      else startAutoRefresh();
    });

    actions.set("refresh", () => {
      remain = REFRESH_SECONDS;
      loadMails(currentPage);
      updateAutoRefreshUi();
    });

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
    let canSend = false;

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
      for (const [index, file] of composeAttachments.entries()) {
        const li = document.createElement("li");
        li.className = "attachment-item";
        li.innerHTML = `
          <span class="attachment-info">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21.44 11.05 12.94 19.54a6.001 6.001 0 0 1-8.49-8.49l8.49-8.49a4.002 4.002 0 0 1 5.66 5.66l-8.49 8.49a2.002 2.002 0 0 1-2.83-2.83l8.49-8.49" />
            </svg>
            <span class="attachment-name">${escapeHtml(file.name)}</span>
            <span class="attachment-size" data-bytes="${file.size}">${formatBytes(file.size)}</span>
          </span>
          <button type="button" class="attachment-remove" data-action="remove-attachment" data-index="${index}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        `;
        const removeButton = li.querySelector(".attachment-remove");
        removeButton.dataset.i18nAriaLabel = "compose.removeAttachment";
        removeButton.dataset.i18nParams = JSON.stringify({ filename: file.name });
        removeButton.setAttribute("aria-label", t("compose.removeAttachment", { filename: file.name }));
        attachmentList.appendChild(li);
      }
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

    actions.set("compose-open", openCompose);
    actions.set("compose-close", closeCompose);
    actions.set("compose-backdrop", (event) => {
      if (event.target === composeBackdrop) closeCompose();
    });
    actions.set("choose-attachments", () => attachmentInput.click());
    actions.set("remove-attachment", (event, element) => {
      composeAttachments.splice(Number(element.dataset.index), 1);
      renderAttachmentList();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && composeBackdrop.classList.contains("open")) closeCompose();
      if ((event.key === "Enter" || event.key === " ") && event.target === dropZone) {
        event.preventDefault();
        attachmentInput.click();
      }
    });
    document.addEventListener("change", (event) => {
      if (event.target.dataset.action !== "add-attachments") return;
      if (attachmentInput.files) addFiles(Array.from(attachmentInput.files));
      attachmentInput.value = "";
    });
    for (const name of ["dragenter", "dragover", "dragleave", "drop"]) {
      document.addEventListener(name, (event) => {
        if (!dropZone.contains(event.target)) return;
        event.preventDefault();
        dropZone.classList.toggle("drag-over", name === "dragenter" || name === "dragover");
        if (name === "drop") addFiles(Array.from(event.dataTransfer?.files || []));
      });
    }

    let isSending = false;

    document.addEventListener("submit", async (e) => {
      if (e.target.dataset.action !== "send-mail") return;
      e.preventDefault();

      // Debounce guard: early-return if already sending
      if (isSending) return;

      const fromLocal = document.getElementById("compose-from-local").value.trim();
      const fromDomain = document.getElementById("compose-from-domain").value;
      const fromValue = fromLocal && fromDomain ? `${fromLocal}@${fromDomain}` : "";
      const toValue = document.getElementById("compose-to").value.trim();
      const subjectValue = document.getElementById("compose-subject").value.trim();

      if (!fromValue) {
        notify("compose.fromRequired", "danger");
        return;
      }
      if (!toValue) {
        notify("compose.toRequired", "danger");
        return;
      }
      if (!subjectValue) {
        notify("compose.subjectRequired", "danger");
        return;
      }

      isSending = true;
      composeSubmit.disabled = true;
      composeSubmit.classList.add("btn-loading");
      composeSubmit.querySelector(".btn-spinner").classList.remove("hidden");
      setMessage(document.getElementById("compose-submit-label"), "compose.sending");

      try {
        const to = splitAddressList(toValue);
        const cc = splitAddressList(document.getElementById("compose-cc").value);
        const bcc = splitAddressList(document.getElementById("compose-bcc").value);
        const subject = subjectValue;
        const text = document.getElementById("compose-body").value;
        const nameValue = document.getElementById("compose-name").value.trim();

        const attachments = [];
        for (const file of composeAttachments) {
          const content = await api.readFileAsBase64(file);
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

        await api.sendMail(payload);

        notify("compose.sent", "success");
        resetCompose();
        setTimeout(() => closeCompose(), 800);
      } catch (e) {
        notifyError("errors.send", e);
      } finally {
        isSending = false;
        composeSubmit.disabled = !canSend;
        composeSubmit.classList.remove("btn-loading");
        composeSubmit.querySelector(".btn-spinner").classList.add("hidden");
        setMessage(document.getElementById("compose-submit-label"), "compose.send");
      }
    });

    readUrlState();
    loadMails(currentPage);
    updateAutoRefreshUi();

    async function initFromDomainSelect() {
      const select = document.getElementById("compose-from-domain");
      try {
        const config = await api.getConfig();
        for (const domain of config.sendableDomains) {
          const option = document.createElement("option");
          option.value = domain;
          option.textContent = domain;
          select.appendChild(option);
        }
        canSend = config.canSend && config.sendableDomains.length > 0;
        select.disabled = !canSend;
        composeBtn.disabled = !canSend;
        composeSubmit.disabled = !canSend;
        if (canSend) {
          delete composeBtn.dataset.i18nTitle;
          composeBtn.removeAttribute("title");
        } else {
          composeBtn.dataset.i18nTitle = "compose.unavailable";
        }
      } catch (error) {
        composeBtn.dataset.i18nTitle = "compose.configFailed";
        notifyError("errors.loadConfig", error);
      }
      translate();
    }
    initFromDomainSelect();

  }

  function initMailDetail() {
    const params = new URLSearchParams(location.search);
    const id = params.get("id");
    const pageParam = params.get("page");
    const qParam = params.get("q");
    const errEl = document.getElementById("err");
    const contentEl = document.getElementById("content");
    const backLink = document.getElementById("back-link");

    if (backLink) {
      const backParams = new URLSearchParams();
      if (pageParam) backParams.set("page", pageParam);
      if (qParam) backParams.set("q", qParam);
      const qs = backParams.toString();
      backLink.href = qs ? `/?${qs}` : "/";
    }

    const linkConfirmBackdrop = document.getElementById("link-confirm-backdrop");
    const linkConfirmHost = document.getElementById("link-confirm-host");
    const linkConfirmUrl = document.getElementById("link-confirm-url");
    const linkConfirmContinue = document.getElementById("link-confirm-continue");
    const unsubscribeBtn = document.getElementById("unsubscribe-btn");
    const unsubscribeConfirmBackdrop = document.getElementById("unsubscribe-confirm-backdrop");
    const unsubscribeConfirmHost = document.getElementById("unsubscribe-confirm-host");
    const unsubscribeConfirmUrl = document.getElementById("unsubscribe-confirm-url");
    const unsubscribeConfirmSubmit = document.getElementById("unsubscribe-confirm-submit");
    let pendingExternalUrl = "";
    let unsubscribeTarget = null;
    let mailFrame = null;

    actions.set("content-tab", (event, button) => {
      const target = button.dataset.target;
      for (const tab of document.querySelectorAll(".tab-btn")) {
        const selected = tab === button;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
      }
      document.getElementById("rendered-panel").classList.toggle("hidden", target !== "rendered-panel");
      document.getElementById("headers-panel").classList.toggle("hidden", target !== "headers-panel");
    });

    function parseListUnsubscribe(header) {
      const result = { httpsUrl: "", mailtoUrl: "" };
      if (typeof header !== "string") return result;

      for (const match of header.matchAll(/<([^>]+)>/g)) {
        const raw = (match[1] || "").trim();
        let parsed;
        try {
          parsed = new URL(raw);
        } catch {
          continue;
        }

        if (!result.httpsUrl && parsed.protocol === "https:") {
          result.httpsUrl = parsed.href;
        } else if (!result.mailtoUrl && parsed.protocol === "mailto:") {
          result.mailtoUrl = parsed.href;
        }
      }

      return result;
    }

    function supportsOneClick(header) {
      return typeof header === "string" &&
        /(?:^|[;\s])list-unsubscribe\s*=\s*one-click(?:$|[;\s])/i.test(header.trim());
    }

    function configureUnsubscribe(headers) {
      const values = parseListUnsubscribe(headers?.["list-unsubscribe"]);
      const hasTarget = Boolean(values.httpsUrl || values.mailtoUrl);

      unsubscribeTarget = hasTarget
        ? {
            ...values,
            oneClick: Boolean(values.httpsUrl && supportsOneClick(headers?.["list-unsubscribe-post"]))
          }
        : null;
      unsubscribeBtn.classList.toggle("hidden", !unsubscribeTarget);
    }

    function openUnsubscribeConfirm() {
      if (!unsubscribeTarget?.httpsUrl || !unsubscribeTarget.oneClick) return;
      const parsed = parseSafeExternalUrl(unsubscribeTarget.httpsUrl);
      if (!parsed || parsed.protocol !== "https:") return;

      unsubscribeConfirmHost.textContent = parsed.host;
      unsubscribeConfirmUrl.textContent = parsed.href;
      unsubscribeConfirmBackdrop.classList.add("open");
      unsubscribeConfirmBackdrop.setAttribute("aria-hidden", "false");
      unsubscribeConfirmSubmit.focus();
    }

    function closeUnsubscribeConfirm() {
      unsubscribeConfirmBackdrop.classList.remove("open");
      unsubscribeConfirmBackdrop.setAttribute("aria-hidden", "true");
      unsubscribeConfirmHost.textContent = "";
      unsubscribeConfirmUrl.textContent = "";
    }

    async function submitOneClickUnsubscribe() {
      if (!unsubscribeTarget?.httpsUrl || !unsubscribeTarget.oneClick) return;
      const parsed = parseSafeExternalUrl(unsubscribeTarget.httpsUrl);
      if (!parsed || parsed.protocol !== "https:") return;

      closeUnsubscribeConfirm();
      unsubscribeBtn.disabled = true;
      unsubscribeConfirmSubmit.disabled = true;
      setMessage(unsubscribeBtn, "mail.unsubscribing");

      try {
        await api.unsubscribe(id);
        notify("mail.unsubscribeSent", "success");
        setMessage(unsubscribeBtn, "mail.unsubscribed");
      } catch {
        notify("mail.unsubscribeFallback", "danger");
        unsubscribeBtn.disabled = false;
        setMessage(unsubscribeBtn, "mail.unsubscribe");
        openLinkConfirm(parsed.href);
      } finally {
        unsubscribeConfirmSubmit.disabled = false;
      }
    }

    function handleUnsubscribe() {
      if (!unsubscribeTarget) return;

      if (unsubscribeTarget.oneClick && unsubscribeTarget.httpsUrl) {
        openUnsubscribeConfirm();
        return;
      }

      if (unsubscribeTarget.httpsUrl) {
        openLinkConfirm(unsubscribeTarget.httpsUrl);
        return;
      }

      if (unsubscribeTarget.mailtoUrl) {
        window.location.href = unsubscribeTarget.mailtoUrl;
      }
    }

    function parseSafeExternalUrl(raw) {
      if (typeof raw !== "string") return null;
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        return null;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return parsed;
    }

    function openLinkConfirm(url) {
      const parsed = parseSafeExternalUrl(url);
      if (!parsed) return;
      pendingExternalUrl = parsed.href;
      linkConfirmHost.textContent = parsed.host;
      linkConfirmUrl.textContent = parsed.href;
      linkConfirmBackdrop.classList.add("open");
      linkConfirmBackdrop.setAttribute("aria-hidden", "false");
      linkConfirmContinue.focus();
    }

    function closeLinkConfirm() {
      pendingExternalUrl = "";
      linkConfirmBackdrop.classList.remove("open");
      linkConfirmBackdrop.setAttribute("aria-hidden", "true");
      linkConfirmHost.textContent = "";
      linkConfirmUrl.textContent = "";
    }

    function continueExternalLink() {
      const parsed = parseSafeExternalUrl(pendingExternalUrl);
      closeLinkConfirm();
      if (!parsed) return;
      window.open(parsed.href, "_blank", "noopener,noreferrer");
    }

    function prepareHtmlForIframe(html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const anchor of doc.querySelectorAll("a[href]")) {
        const href = (anchor.getAttribute("href") || "").trim();
        if (!href) {
          anchor.removeAttribute("href");
          continue;
        }

        let parsed;
        try {
          parsed = new URL(href);
        } catch {
          anchor.removeAttribute("href");
          anchor.removeAttribute("target");
          continue;
        }

        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          anchor.setAttribute("data-external-url", parsed.href);
          anchor.setAttribute("href", "#");
          anchor.removeAttribute("target");
          anchor.setAttribute("rel", "noopener noreferrer");
          continue;
        }

        if (parsed.protocol === "mailto:" || parsed.protocol === "tel:") {
          anchor.setAttribute("data-direct-url", parsed.href);
          anchor.setAttribute("href", "#");
          anchor.removeAttribute("target");
          continue;
        }

        anchor.removeAttribute("href");
        anchor.removeAttribute("target");
      }

      const script = doc.createElement("script");
      script.textContent = `
        document.addEventListener("click", function (event) {
          var target = event.target;
          if (!target || !target.closest) return;
          var anchor = target.closest("a");
          if (!anchor) return;
          var externalUrl = anchor.getAttribute("data-external-url");
          if (externalUrl) {
            event.preventDefault();
            event.stopPropagation();
            parent.postMessage({ source: "cf-email-worker-mail", type: "external-link", url: externalUrl }, "*");
            return;
          }
          var directUrl = anchor.getAttribute("data-direct-url");
          if (directUrl) {
            event.preventDefault();
            event.stopPropagation();
            parent.postMessage({ source: "cf-email-worker-mail", type: "direct-link", url: directUrl }, "*");
          }
        }, true);
      `;
      (doc.body || doc.documentElement).appendChild(script);

      const headHtml = doc.head ? doc.head.innerHTML : "";
      const bodyHtml = doc.body ? doc.body.innerHTML : doc.documentElement.innerHTML;
      return `<!DOCTYPE html><html><head><meta charset="utf-8">${headHtml}</head><body>${bodyHtml}</body></html>`;
    }

    function mountRenderedHtml(html) {
      const renderedBody = document.getElementById("rendered-body");
      renderedBody.innerHTML = "";

      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.dataset.i18nTitle = "mail.bodyTitle";
      iframe.title = t("mail.bodyTitle");
      iframe.srcdoc = prepareHtmlForIframe(html);
      renderedBody.appendChild(iframe);
      mailFrame = iframe;
    }

    actions.set("link-close", closeLinkConfirm);
    actions.set("link-continue", continueExternalLink);
    actions.set("link-backdrop", (event) => {
      if (event.target === linkConfirmBackdrop) closeLinkConfirm();
    });
    actions.set("unsubscribe", handleUnsubscribe);
    actions.set("unsubscribe-close", closeUnsubscribeConfirm);
    actions.set("unsubscribe-submit", submitOneClickUnsubscribe);
    actions.set("unsubscribe-backdrop", (event) => {
      if (event.target === unsubscribeConfirmBackdrop) closeUnsubscribeConfirm();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (linkConfirmBackdrop.classList.contains("open")) closeLinkConfirm();
      if (unsubscribeConfirmBackdrop.classList.contains("open")) closeUnsubscribeConfirm();
    });

    window.addEventListener("message", (event) => {
      if (!mailFrame || event.source !== mailFrame.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== "cf-email-worker-mail" || typeof data.url !== "string") return;

      if (data.type === "external-link") {
        openLinkConfirm(data.url);
        return;
      }

      if (data.type === "direct-link") {
        let parsed;
        try {
          parsed = new URL(data.url);
        } catch {
          return;
        }
        if (parsed.protocol !== "mailto:" && parsed.protocol !== "tel:") return;
        window.location.href = parsed.href;
      }
    });

    async function load() {
      if (!id) {
        errEl.classList.remove("hidden");
        setMessage(errEl, "errors.missingId");
        return;
      }

      try {
        const { mail, view } = await api.getMail(id);

        if (mail.subject) {
          document.querySelector("title").removeAttribute("data-i18n");
          document.title = mail.subject;
        }
        const subject = document.getElementById("subject");
        if (mail.subject) subject.textContent = mail.subject;
        else setMessage(subject, "common.noSubject");
        configureUnsubscribe(mail.headers);
        document.getElementById("from").textContent = mail.from || "";
        document.getElementById("to").textContent = mail.to || "";
        const received = document.createElement("time");
        received.setAttribute("datetime", mail.receivedAt || "");
        received.setAttribute("data-include-seconds", "");
        received.textContent = formatDate(mail.receivedAt, { second: "2-digit" });
        document.getElementById("received").replaceChildren(received);

        const ccList = Array.isArray(mail.cc) ? mail.cc.filter((v) => typeof v === "string" && v.trim()) : [];
        const ccRow = document.getElementById("cc-row");
        const ccEl = document.getElementById("cc");
        if (ccList.length > 0) {
          ccEl.textContent = ccList.join(", ");
          ccRow.classList.remove("hidden");
        } else {
          ccEl.textContent = "";
          ccRow.classList.add("hidden");
        }

        const replyTo = typeof mail.headers?.["reply-to"] === "string" ? mail.headers["reply-to"].trim() : "";
        const replyToRow = document.getElementById("reply-to-row");
        const replyToEl = document.getElementById("reply-to");
        if (replyTo) {
          replyToEl.textContent = replyTo;
          replyToRow.classList.remove("hidden");
        } else {
          replyToEl.textContent = "";
          replyToRow.classList.add("hidden");
        }

        const renderedBody = document.getElementById("rendered-body");
        renderedBody.innerHTML = "";
        mailFrame = null;

        if (view.renderedHtml) {
          mountRenderedHtml(view.renderedHtml);
        } else if (view.renderedText) {
          const pre = document.createElement("pre");
          pre.className = "pre-wrap";
          pre.textContent = view.renderedText;
          renderedBody.appendChild(pre);
        }

        document.getElementById("raw-pre").textContent = mail.rawText || "";
        document.getElementById("headers-pre").textContent =
          JSON.stringify(mail.headers, null, 2) || t("common.noHeaders");

        const attachmentsWrap = document.getElementById("attachments-wrap");
        const attachmentsList = document.getElementById("attachments-list");
        const attachments = Array.isArray(mail.attachments) ? mail.attachments : [];
        attachmentsList.innerHTML = "";
        if (attachments.length > 0) {
          attachmentsWrap.classList.remove("hidden");
          for (const attachment of attachments) {
            const li = document.createElement("li");
            li.className = "mail-card";
            li.style = "padding: 12px 14px;";

            const link = document.createElement("a");
            link.className = "attachment-download";
            link.href = `/api/mails/${encodeURIComponent(mail.id)}/attachments/${encodeURIComponent(attachment.id)}`;
            link.innerHTML = `
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21.44 11.05 12.94 19.54a6.001 6.001 0 0 1-8.49-8.49l8.49-8.49a4.002 4.002 0 0 1 5.66 5.66l-8.49 8.49a2.002 2.002 0 0 1-2.83-2.83l8.49-8.49" />
              </svg>
              <span class="attachment-name">${escapeHtml(attachment.filename || t("common.unnamed"))}</span>
            `;

            if (!attachment.filename) setMessage(link.querySelector(".attachment-name"), "common.unnamed");
            const meta = document.createElement("p");
            meta.className = "mail-card-meta";
            const size = Number.isFinite(attachment.size) ? attachment.size : 0;
            meta.appendChild(document.createTextNode(`${attachment.contentType || "application/octet-stream"} · `));
            const sizeLabel = document.createElement("span");
            sizeLabel.dataset.bytes = String(size);
            sizeLabel.textContent = formatBytes(size);
            meta.appendChild(sizeLabel);

            li.appendChild(link);
            li.appendChild(meta);
            attachmentsList.appendChild(li);
          }
        } else {
          attachmentsWrap.classList.add("hidden");
        }

        contentEl.hidden = false;
      } catch (e) {
        errEl.classList.remove("hidden");
        showError(errEl, "errors.loadMail", e);
      }
    }

    load();
  }

  start();
})();
