(function () {
  "use strict";

  const PREFERENCES_KEY = "email-worker.preferences";

  async function requestJson(url, options) {
    const headers = { ...options?.headers };
    if (options?.method && !["GET", "HEAD"].includes(options.method)) headers["X-Requested-With"] = "cf-email-worker";
    const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data?.error || `HTTP ${response.status}`);
      error.code = data?.code;
      error.status = response.status;
      if (!url.startsWith("/api/auth/") && typeof window.dispatchEvent === "function" &&
        (response.status === 401 || data?.code === "PASSWORD_CHANGE_REQUIRED")) {
        window.dispatchEvent(new CustomEvent("mail-auth-required", { detail: data?.code }));
      }
      throw error;
    }
    return response.json();
  }

  function writeJson(url, method, body) {
    return requestJson(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  function readPreferences() {
    try {
      return JSON.parse(localStorage.getItem(PREFERENCES_KEY)) ?? {};
    } catch {
      return {};
    }
  }

  function savePreferences(preferences) {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // Preferences still apply to this page when browser storage is unavailable.
    }
  }

  window.MailApi = {
    readPreferences,
    savePreferences,
    login: (prefix, password) => writeJson("/api/auth/login", "POST", { prefix, password }),
    logout: () => writeJson("/api/auth/logout", "POST", {}),
    changePassword: (currentPassword, password) => writeJson("/api/auth/password", "POST", { currentPassword, password }),
    getMembers(page, query) {
      const params = new URLSearchParams({ page: String(page), q: query });
      return requestJson(`/api/members?${params}`, { cache: "no-store" });
    },
    createMember: (body) => writeJson("/api/members", "POST", body),
    updateMember: (id, body) => writeJson(`/api/members/${encodeURIComponent(id)}`, "PATCH", body),
    deleteMember: (id) => writeJson(`/api/members/${encodeURIComponent(id)}`, "DELETE", {}),
    resetMemberPassword: (id) => writeJson(`/api/members/${encodeURIComponent(id)}/password`, "POST", {}),
    generatePassword() {
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
    },
    readMemberDraft(id) {
      try { return JSON.parse(localStorage.getItem(`email-worker.member-draft.${id}`)); } catch { return null; }
    },
    saveMemberDraft(id, draft) {
      try {
        const key = `email-worker.member-draft.${id}`;
        if (draft) localStorage.setItem(key, JSON.stringify(draft));
        else localStorage.removeItem(key);
      } catch { /* A blocked browser store must not prevent member management. */ }
    },
    readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result);
          const index = result.indexOf("base64,");
          resolve(index >= 0 ? result.slice(index + 7) : result);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    },
    getLanguages: () => requestJson("/locales/manifest.json"),
    getTranslations: (language) => requestJson(`/locales/${encodeURIComponent(language)}.json`),
    getConfig: () => requestJson("/api/config", { cache: "no-store" }),
    getMails(page, query, signal, folder = "inbox") {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set("q", query);
      if (folder !== "inbox") params.set("folder", folder);
      return requestJson(`/api/mails?${params}`, { signal, cache: "no-store" });
    },
    getMail: (id) => requestJson(`/api/mails/${encodeURIComponent(id)}`, { cache: "no-store" }),
    sendMail: (payload) => requestJson("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }),
    unsubscribe: (id) => requestJson(`/api/mails/${encodeURIComponent(id)}/unsubscribe`, {
      method: "POST",
      headers: { "X-Requested-With": "cf-email-worker" },
      credentials: "same-origin",
      redirect: "manual"
    })
  };
})();
