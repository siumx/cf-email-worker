/**
 * Unified Toast Notification System
 * Usage: notify(message, type) where type = 'success' | 'danger' | 'info'
 */
(function () {
  "use strict";

  let container = null;

  async function initFromDomainSelect() {
    const select = document.getElementById("compose-from-domain");
    const composeButton = document.getElementById("compose-btn");
    const submitButton = document.getElementById("compose-submit");
    if (!select || !composeButton || !submitButton) return;

    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json();

      for (const domain of config.sendableDomains) {
        const option = document.createElement("option");
        option.value = domain;
        option.textContent = domain;
        select.appendChild(option);
      }

      const canSend = config.canSend && config.sendableDomains.length > 0;
      select.disabled = !canSend;
      composeButton.disabled = !canSend;
      submitButton.disabled = !canSend;
      composeButton.title = canSend ? "" : "此網域未開放發件或尚未設定寄件網域";
    } catch (error) {
      composeButton.title = "無法載入發件設定";
      notify(`無法載入發件設定：${error?.message || String(error)}`, "danger");
    }
  }

  function getContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement("div");
    container.className = "toast-container";
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "false");
    document.body.appendChild(container);
    return container;
  }

  function dismiss(toast) {
    if (toast.dataset.dismissed) return;
    toast.dataset.dismissed = "1";
    toast.classList.add("toast-out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    // Fallback removal in case animationend doesn't fire
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 400);
  }

  /**
   * Show a toast notification.
   * @param {string} message - The message to display
   * @param {'success'|'danger'|'info'} type - Notification type
   */
  function notify(message, type) {
    const ct = getContainer();
    const validTypes = ["success", "danger", "info"];
    const safeType = validTypes.includes(type) ? type : "info";

    const toast = document.createElement("div");
    toast.className = `toast toast-${safeType}`;
    toast.setAttribute("role", "alert");

    const msgSpan = document.createElement("span");
    msgSpan.className = "toast-message";
    msgSpan.textContent = message;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.setAttribute("aria-label", "關閉");
    closeBtn.innerHTML = "&#215;";
    closeBtn.addEventListener("click", () => dismiss(toast));

    toast.appendChild(msgSpan);
    toast.appendChild(closeBtn);
    ct.appendChild(toast);

    // Auto-dismiss after 3s
    const timer = setTimeout(() => dismiss(toast), 3000);
    // If manually dismissed, clear the auto timer
    closeBtn.addEventListener("click", () => clearTimeout(timer), { once: true });
  }

  // Expose globally
  window.notify = notify;
  initFromDomainSelect();
})();
