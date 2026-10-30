(function () {
  "use strict";

  const DEFAULT_LANGUAGE = "en";
  const DEFAULT_TIME_ZONE = "Asia/Singapore";

  function normalizeTimeZone(value) {
    if (typeof value !== "string" || !value) return DEFAULT_TIME_ZONE;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return value;
    } catch {
      return DEFAULT_TIME_ZONE;
    }
  }

  function resolvePreferences(stored, languages) {
    const savedLanguage = languages.find(({ code }) => code === stored?.language)?.code;
    return {
      language: savedLanguage ?? DEFAULT_LANGUAGE,
      timeZone: normalizeTimeZone(stored?.timeZone)
    };
  }

  function getTimeZones(selected) {
    const supported = typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["Asia/Taipei", "Asia/Tokyo", "Europe/London", "America/New_York", "America/Los_Angeles"];
    return [...new Set(["UTC", DEFAULT_TIME_ZONE, normalizeTimeZone(selected), ...supported])];
  }

  function formatDate(iso, language, timeZone, options = {}) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(language, {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      ...options,
      timeZone
    }).format(date);
  }

  function formatBytes(bytes, language) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
    const value = new Intl.NumberFormat(language, { maximumFractionDigits: index === 0 ? 0 : 2 })
      .format(bytes / (1024 ** index));
    return `${value} ${sizes[index]}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  window.MailUtils = {
    DEFAULT_LANGUAGE, DEFAULT_TIME_ZONE, normalizeTimeZone,
    resolvePreferences, getTimeZones, formatDate, formatBytes, escapeHtml
  };
})();
