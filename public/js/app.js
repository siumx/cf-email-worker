(function () {
  "use strict";

  const api = window.MailApi;
  const utils = window.MailUtils;
  const { escapeHtml } = utils;
  const actions = new Map();
  let preferences;
  let mailConfig;

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
      mailConfig = await api.getConfig();
      const loginPage = document.querySelector('[data-component="login-page"]');
      const membersPage = document.querySelector('[data-component="members-page"]');
      const passwordPage = document.querySelector('[data-component="password-page"]');
      if (!mailConfig.memberEnabled && (loginPage || membersPage || passwordPage)) { location.replace("/"); return; }
      if (mailConfig.memberEnabled) {
        if (!mailConfig.authenticated && !loginPage) { goToLogin(); return; }
        if (mailConfig.identity?.mustChangePassword && !passwordPage) { location.replace("/password.html"); return; }
        if (loginPage && mailConfig.authenticated) { location.replace(afterLogin(mailConfig.identity)); return; }
        if (membersPage && mailConfig.identity?.role !== "admin") { location.replace("/"); return; }
        if (passwordPage && !databaseMember(mailConfig.identity)) { location.replace("/"); return; }
        if (mailConfig.authenticated) initMemberToolbar();
      }
      if (loginPage) initLogin();
      if (passwordPage) initPasswordChange();
      if (membersPage) await initMembers();
      if (document.querySelector('[data-component="inbox-page"]')) initInbox();
      if (document.querySelector('[data-component="mail-detail-page"]')) initMailDetail();
    } catch (error) {
      console.error("Could not initialize the mail interface", error);
      const alert = document.getElementById("load-error") || document.getElementById("err");
      alert.classList.remove("hidden");
      alert.textContent = "Could not load interface settings. Please reload.";
    }
  }

  function goToLogin() {
    const next = utils.safeReturnPath(location.pathname + location.search);
    location.replace(`/login.html?next=${encodeURIComponent(next)}`);
  }

  function databaseMember(identity) {
    return Boolean(identity) && !identity.id.startsWith("admin:");
  }

  function afterLogin(identity) {
    if (identity.mustChangePassword) return "/password.html";
    const next = new URLSearchParams(location.search).get("next");
    return utils.safeReturnPath(next, identity.role === "admin" ? "/members.html" : "/");
  }

  window.addEventListener("mail-auth-required", (event) => {
    if (event.detail === "PASSWORD_CHANGE_REQUIRED") location.replace("/password.html");
    else goToLogin();
  });

  window.addEventListener("pagehide", () => {
    if (mailConfig?.memberEnabled) document.querySelector("main")?.setAttribute("hidden", "");
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });

  actions.set("toggle-password", (event, button) => {
    const input = document.getElementById(button.dataset.target);
    input.type = input.type === "password" ? "text" : "password";
    button.setAttribute("aria-pressed", String(input.type === "text"));
    button.dataset.i18nAriaLabel = input.type === "text" ? "auth.hidePassword" : "auth.showPassword";
    translate();
  });

  function initMemberToolbar() {
    const identity = mailConfig.identity;
    const toolbar = document.createElement("nav");
    toolbar.className = "member-toolbar";
    toolbar.dataset.i18nAriaLabel = "auth.navigation";
    toolbar.setAttribute("aria-label", t("auth.navigation"));
    toolbar.innerHTML = `<div class="member-navigation"><a class="btn" href="/" data-i18n="members.allMail">${escapeHtml(t("members.allMail"))}</a>
      ${identity.role === "admin" ? `<a class="btn ${location.pathname === "/members.html" ? "btn-pressed" : ""}" href="/members.html" data-i18n="members.title">${escapeHtml(t("members.title"))}</a>` : ""}</div>
      <div class="member-session"><span class="member-account">${escapeHtml(identity.prefix)}</span><span class="member-role" data-i18n="auth.${identity.role}">${escapeHtml(t(`auth.${identity.role}`))}</span>
      ${databaseMember(identity) && !identity.mustChangePassword ? `<a class="btn" href="/password.html" data-i18n="auth.changePassword">${escapeHtml(t("auth.changePassword"))}</a>` : ""}
      <button class="btn" data-action="logout" type="button" data-i18n="auth.signOut">${escapeHtml(t("auth.signOut"))}</button></div>`;
    const anchor = document.querySelector(".page-header") || document.querySelector(".preferences-toolbar");
    if (anchor) anchor.after(toolbar);
    actions.set("logout", async (event, button) => {
      button.disabled = true;
      try { await api.logout(); mailConfig.authenticated = false; api.saveMemberDraft(identity.id, null); location.replace("/login.html"); }
      catch (error) { notifyError("auth.error", error); button.disabled = false; }
    });
  }

  function initLogin() {
    document.addEventListener("submit", async (event) => {
      if (event.target.dataset.action !== "login") return;
      event.preventDefault();
      const button = event.target.querySelector('[type="submit"]');
      if (button.disabled) return;
      button.disabled = true;
      document.getElementById("auth-error").classList.add("hidden");
      try {
        const result = await api.login(document.getElementById("login-prefix").value.trim(), document.getElementById("login-password").value);
        document.getElementById("login-password").value = "";
        location.replace(afterLogin(result.identity));
      } catch (error) { showError(document.getElementById("auth-error"), "auth.error", error); }
      finally { button.disabled = false; }
    });
    document.querySelector('#login-form [type="submit"]').disabled = false;
  }

  function initPasswordChange() {
    document.getElementById("password-required").classList.toggle("hidden", !mailConfig.identity.mustChangePassword);
    document.addEventListener("submit", async (event) => {
      if (event.target.dataset.action !== "change-password") return;
      event.preventDefault();
      const form = event.target;
      const button = form.querySelector('[type="submit"]');
      if (button.disabled) return;
      const password = document.getElementById("new-password").value;
      if (password !== document.getElementById("confirm-password").value) {
        showError(document.getElementById("auth-error"), "auth.error", { code: "PASSWORD_MISMATCH" }); return;
      }
      button.disabled = true;
      try {
        await api.changePassword(document.getElementById("current-password").value, password);
        form.reset(); location.replace("/");
      } catch (error) { showError(document.getElementById("auth-error"), "auth.error", error); }
      finally { button.disabled = false; }
    });
    document.querySelector('#password-form [type="submit"]').disabled = false;
  }

  async function initMembers() {
    const form = document.getElementById("member-form");
    const prefixInput = document.getElementById("member-prefix");
    const passwordInput = document.getElementById("member-password");
    const rows = document.getElementById("member-rows");
    const errorElement = document.getElementById("member-form-error");
    const resultDialog = document.getElementById("member-password-result");
    const confirmDialog = document.getElementById("member-confirm");
    let members = [];
    let domainConfig = { receiveDomains: [], sendDomains: [] };
    let editingId = null;
    let currentPage = 1;
    let query = "";
    let busy = false;
    let pendingOperation = null;
    let loadSequence = 0;

    function domainInputs(receive = [], send = []) {
      const domains = [...new Set([...domainConfig.receiveDomains, ...domainConfig.sendDomains])];
      document.getElementById("domain-options").innerHTML = domains.map((domain) => `<tr><td>${escapeHtml(domain)}</td>${["receive", "send"].map((direction) => {
        const available = domainConfig[`${direction}Domains`].includes(domain);
        const checked = (direction === "receive" ? receive : send).includes(domain);
        return `<td>${available ? `<input type="checkbox" name="${direction}Domains" value="${escapeHtml(domain)}" ${checked ? "checked" : ""} data-i18n-aria-label="members.${direction}Domain" data-i18n-params="${escapeHtml(JSON.stringify({ domain }))}" aria-label="${escapeHtml(t(`members.${direction}Domain`, { domain }))}" />` : '<span aria-hidden="true">—</span>'}</td>`;
      }).join("")}</tr>`).join("");
    }

    function selectedDomains(direction) { return [...form.querySelectorAll(`input[name="${direction}Domains"]:checked`)].map((input) => input.value); }

    function selectedRole() { return document.getElementById("member-role").value === "admin" ? "admin" : "user"; }

    function syncRoleFields() { document.querySelector(".domain-editor").classList.toggle("hidden", selectedRole() === "admin"); }

    function persistDraft() {
      if (busy || !mailConfig.authenticated) return;
      syncRoleFields();
      const prefix = prefixInput.value;
      const role = selectedRole();
      const receiveDomains = selectedDomains("receive");
      const sendDomains = selectedDomains("send");
      api.saveMemberDraft(mailConfig.identity.id, prefix || editingId || role === "admin" || receiveDomains.length || sendDomains.length
        ? { editingId, prefix, role, receiveDomains, sendDomains } : null);
    }

    function resetEditor(member = null) {
      if (busy) return;
      editingId = member?.id ?? null;
      form.reset();
      prefixInput.value = member?.prefix ?? "";
      prefixInput.readOnly = Boolean(member);
      passwordInput.type = "password";
      const passwordToggle = form.querySelector('[data-action="toggle-password"]');
      passwordToggle.dataset.i18nAriaLabel = "auth.showPassword";
      passwordToggle.setAttribute("aria-label", t("auth.showPassword"));
      passwordToggle.setAttribute("aria-pressed", "false");
      document.getElementById("member-password-group").classList.toggle("hidden", Boolean(member));
      document.getElementById("member-role").value = member?.role === "admin" ? "admin" : "user";
      setMessage(document.getElementById("member-editor-title"), member ? "members.editTitle" : "members.addTitle");
      setMessage(document.getElementById("member-save"), member ? "members.save" : "members.create");
      domainInputs(member?.receiveDomains, member?.sendDomains);
      syncRoleFields();
      errorElement.classList.add("hidden");
      persistDraft();
    }

    async function load(page = currentPage) {
      const sequence = ++loadSequence;
      const data = await api.getMembers(page, query);
      if (sequence !== loadSequence) return;
      members = data.members;
      domainConfig = data;
      currentPage = data.page;
      setMessage(document.getElementById("member-count"), "members.count", { total: data.total, active: data.active, disabled: data.total - data.active });
      setMessage(document.getElementById("member-page"), "inbox.page", { page: data.totalPages ? data.page : 0, total: data.totalPages });
      document.getElementById("member-prev").disabled = data.page <= 1;
      document.getElementById("member-next").disabled = !data.totalPages || data.page >= data.totalPages;
      document.getElementById("members-empty").classList.toggle("hidden", members.length > 0);
      rows.innerHTML = members.map((member) => `<tr><td><strong>${escapeHtml(member.prefix)}</strong><span class="member-role" data-i18n="auth.${member.role === "admin" ? "admin" : "user"}">${escapeHtml(t(`auth.${member.role === "admin" ? "admin" : "user"}`))}</span><time datetime="${escapeHtml(member.createdAt)}">${escapeHtml(formatDate(member.createdAt))}</time></td>
        <td><span class="member-domain-line"><span data-i18n="members.receive">${escapeHtml(t("members.receive"))}</span> ${escapeHtml(member.receiveDomains.join(" · ") || "—")}</span><span class="member-domain-line"><span data-i18n="members.send">${escapeHtml(t("members.send"))}</span> ${escapeHtml(member.sendDomains.join(" · ") || "—")}</span></td>
        <td><span class="member-status ${member.status === "disabled" ? "is-disabled" : ""}" data-i18n="members.${member.status}">${escapeHtml(t(`members.${member.status}`))}</span></td>
        <td><details class="member-actions"><summary data-i18n-aria-label="members.actionsFor" data-i18n-params="${escapeHtml(JSON.stringify({ prefix: member.prefix }))}" aria-label="${escapeHtml(t("members.actionsFor", { prefix: member.prefix }))}">•••</summary><div class="member-menu">
        ${["edit", "reset", member.status === "active" ? "disable" : "enable", "delete"].map((operation) => `<button class="btn ${operation === "delete" ? "member-danger" : ""}" type="button" data-action="member-operation" data-id="${escapeHtml(member.id)}" data-operation="${operation}" data-i18n="members.${operation}">${escapeHtml(t(`members.${operation}`))}</button>`).join("")}</div></details></td></tr>`).join("");
    }

    function showInitialPassword(password) {
      document.getElementById("initial-password-value").textContent = password;
      resultDialog.showModal();
    }
    resultDialog.addEventListener("close", () => { document.getElementById("initial-password-value").textContent = ""; });
    confirmDialog.addEventListener("close", () => { if (!busy) pendingOperation = null; });

    actions.set("new-member", () => { resetEditor(); prefixInput.focus(); });
    actions.set("cancel-member", () => resetEditor());
    actions.set("generate-password", () => { passwordInput.value = api.generatePassword(); passwordInput.type = "text"; });
    actions.set("member-prev", async () => { try { await load(currentPage - 1); } catch (error) { notifyError("members.error", error); } });
    actions.set("member-next", async () => { try { await load(currentPage + 1); } catch (error) { notifyError("members.error", error); } });
    actions.set("member-operation", (event, button) => {
      if (busy) return;
      const member = members.find((item) => item.id === button.dataset.id);
      if (!member) return;
      button.closest("details").open = false;
      const operation = button.dataset.operation;
      if (operation === "edit") { resetEditor(member); prefixInput.focus(); return; }
      pendingOperation = { id: member.id, operation };
      setMessage(document.getElementById("member-confirm-title"), `members.${operation}`);
      setMessage(document.getElementById("member-confirm-description"), operation === "delete" ? "members.deleteDescription" : "members.operationDescription", { prefix: member.prefix });
      document.getElementById("member-confirm-error").classList.add("hidden");
      confirmDialog.showModal();
    });
    actions.set("confirm-member-operation", async (event, button) => {
      if (busy || !pendingOperation) return;
      const { id, operation } = pendingOperation;
      busy = true; button.disabled = true;
      try {
        let result;
        if (operation === "delete") result = await api.deleteMember(id);
        else if (operation === "reset") result = await api.resetMemberPassword(id);
        else result = await api.updateMember(id, { status: operation === "enable" ? "active" : "disabled" });
        pendingOperation = null;
        confirmDialog.close();
        busy = false;
        if (editingId === id) resetEditor();
        if (result.initialPassword) showInitialPassword(result.initialPassword);
        else notify("members.updated", "success");
        await load().catch((error) => notifyError("members.error", error));
      } catch (error) { showError(document.getElementById("member-confirm-error"), "members.error", error); }
      finally { busy = false; button.disabled = false; }
    });
    document.addEventListener("submit", async (event) => {
      if (event.target !== form) return;
      event.preventDefault();
      if (busy) return;
      const role = selectedRole();
      const body = role === "admin" ? { role } : { role, receiveDomains: selectedDomains("receive"), sendDomains: selectedDomains("send") };
      busy = true;
      const button = document.getElementById("member-save");
      button.disabled = true;
      try {
        const result = editingId ? await api.updateMember(editingId, body) : await api.createMember({ ...body, prefix: prefixInput.value, password: passwordInput.value });
        api.saveMemberDraft(mailConfig.identity.id, null);
        busy = false; resetEditor();
        if (result.initialPassword) showInitialPassword(result.initialPassword);
        else notify("members.updated", "success");
        await load(1).catch((error) => notifyError("members.error", error));
      } catch (error) { showError(errorElement, "members.error", error); }
      finally { busy = false; button.disabled = false; }
    });
    let searchTimeout;
    document.addEventListener("input", (event) => {
      if (event.target.dataset.action === "member-search") {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => { query = event.target.value.trim(); try { await load(1); } catch (error) { notifyError("members.error", error); } }, 300);
      } else if (form.contains(event.target)) persistDraft();
    });
    form.addEventListener("change", persistDraft);
    const draft = api.readMemberDraft(mailConfig.identity.id);
    await load(1);
    domainInputs();
    if (draft && typeof draft.prefix === "string" && Array.isArray(draft.receiveDomains) && Array.isArray(draft.sendDomains)) {
      const member = draft.editingId ? members.find((item) => item.id === draft.editingId) : null;
      if (!draft.editingId || member) {
        resetEditor(member); prefixInput.value = draft.prefix;
        if (draft.role === "admin" || draft.role === "user") document.getElementById("member-role").value = draft.role;
        domainInputs(draft.receiveDomains, draft.sendDomains); syncRoleFields();
      }
    }
    const heartbeat = setInterval(persistDraft, 15000);
    window.addEventListener("pagehide", () => { persistDraft(); clearInterval(heartbeat); });
    document.getElementById("member-save").disabled = false;
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
    let currentFolder = mailConfig.memberEnabled && new URLSearchParams(location.search).get("folder") === "sent" ? "sent" : "inbox";
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
      if (currentFolder !== "inbox") p.set("folder", currentFolder);
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
        const data = await api.getMails(page, currentQuery, signal, currentFolder);
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
          if (currentFolder !== "inbox") mailQs.set("folder", currentFolder);
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
      if (mailConfig.identity?.role === "user") document.getElementById("compose-from-local").value = mailConfig.identity.prefix;
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

    if (mailConfig.memberEnabled) {
      const tabs = document.createElement("div");
      tabs.className = "tabs folder-tabs";
      tabs.innerHTML = ["inbox", "sent"].map((folder) => `<button type="button" class="tab-btn ${currentFolder === folder ? "active" : ""}" data-action="mail-folder" data-folder="${folder}" data-i18n="auth.${folder}">${escapeHtml(t(`auth.${folder}`))}</button>`).join("");
      document.querySelector(".search-wrap").before(tabs);
      actions.set("mail-folder", (event, button) => {
        currentFolder = button.dataset.folder;
        for (const tab of tabs.children) tab.classList.toggle("active", tab === button);
        loadMails(1);
      });
    }
    readUrlState();
    loadMails(currentPage);
    updateAutoRefreshUi();

    async function initFromDomainSelect() {
      const select = document.getElementById("compose-from-domain");
      try {
        const config = mailConfig;
        if (config.identity?.role === "user") {
          const local = document.getElementById("compose-from-local");
          local.value = config.identity.prefix;
          local.defaultValue = config.identity.prefix;
          local.readOnly = true;
        }
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
    const folderParam = params.get("folder");
    const errEl = document.getElementById("err");
    const contentEl = document.getElementById("content");
    const backLink = document.getElementById("back-link");

    if (backLink) {
      const backParams = new URLSearchParams();
      if (pageParam) backParams.set("page", pageParam);
      if (qParam) backParams.set("q", qParam);
      if (folderParam === "sent" && mailConfig.memberEnabled) backParams.set("folder", "sent");
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

    function selectContentTab(button) {
      const target = button.dataset.target;
      for (const tab of document.querySelectorAll('[data-action="content-tab"]')) {
        const selected = tab === button;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
        panel.classList.toggle("hidden", panel.id !== target);
      }
    }

    actions.set("content-tab", (event, button) => selectContentTab(button));
    document.addEventListener("keydown", (event) => {
      const current = event.target.closest('[data-action="content-tab"]');
      if (!current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const tabs = [...document.querySelectorAll('[data-action="content-tab"]')]
        .filter((tab) => !tab.classList.contains("hidden"));
      let index = tabs.indexOf(current);
      if (event.key === "Home") index = 0;
      else if (event.key === "End") index = tabs.length - 1;
      else index = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      selectContentTab(tabs[index]);
      tabs[index].focus();
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
      const defaults = doc.createElement("style");
      defaults.textContent = `
        :where(html) { color-scheme: light; background: #fff; }
        :where(body) { margin: 0; padding: 20px; color: #1f2937; font: 15px/1.6 system-ui, sans-serif; overflow-wrap: anywhere; }
        :where(a) { color: #008552; }
        :where(img, video) { max-width: 100%; height: auto; }
        :where(pre) { white-space: pre-wrap; }
        :where(body) > :first-child { margin-top: 0; }
        :where(body) > :last-child { margin-bottom: 0; }
      `;
      const charset = doc.createElement("meta");
      charset.setAttribute("charset", "utf-8");
      doc.head.prepend(charset, defaults);
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
        var lastHeight = 0;
        function reportHeight() {
          var body = document.body;
          var styles = getComputedStyle(body);
          var height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height) +
            (parseFloat(styles.marginTop) || 0) + (parseFloat(styles.marginBottom) || 0));
          if (height <= 0 || height === lastHeight) return;
          lastHeight = height;
          parent.postMessage({ source: "cf-email-worker-mail", type: "resize", height: height }, "*");
        }
        new ResizeObserver(reportHeight).observe(document.body);
        window.addEventListener("load", reportHeight);
        reportHeight();
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

      return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
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
      if (!data || data.source !== "cf-email-worker-mail") return;
      if (data.type === "resize") {
        if (Number.isFinite(data.height) && data.height > 0 && data.height <= 100000) {
          mailFrame.style.height = `${Math.ceil(data.height)}px`;
        }
        return;
      }
      if (typeof data.url !== "string") return;

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
        }
        const htmlTab = document.getElementById("rendered-tab");
        const textTab = document.getElementById("text-tab");
        htmlTab.classList.toggle("hidden", !view.renderedHtml);
        textTab.classList.toggle("hidden", !view.renderedText && Boolean(view.renderedHtml));
        const textPre = document.getElementById("text-pre");
        if (view.renderedText) textPre.textContent = view.renderedText;
        else setMessage(textPre, "mail.emptyBody");
        selectContentTab(view.renderedHtml ? htmlTab : textTab);

        document.getElementById("raw-pre").textContent = mail.rawText || "";
        document.getElementById("headers-pre").textContent =
          JSON.stringify(mail.headers, null, 2) || t("common.noHeaders");

        const attachmentsWrap = document.getElementById("attachments-wrap");
        const attachmentsList = document.getElementById("attachments-list");
        const inlineAttachmentIds = new Set(view.inlineAttachmentIds || []);
        const attachments = (Array.isArray(mail.attachments) ? mail.attachments : [])
          .filter((attachment) => !inlineAttachmentIds.has(attachment.id));
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
