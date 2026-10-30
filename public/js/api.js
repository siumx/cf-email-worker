(function () {
  "use strict";

  const PREFERENCES_KEY = "email-worker.preferences";

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data?.error || `HTTP ${response.status}`);
      error.code = data?.code;
      error.status = response.status;
      throw error;
    }
    return response.json();
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
    getMails(page, query, signal) {
      const params = new URLSearchParams({ page: String(page) });
      if (query) params.set("q", query);
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
