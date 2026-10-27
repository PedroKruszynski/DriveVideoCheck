(() => {
  "use strict";

  const MENU_ITEM_CLASS = "dvt-menu-item";
  const STORAGE_PREFIX = "dvt-watched:";
  const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|avi|mkv|webm|mpeg|mpg|wmv|3gp|ogv|mpe|m2v)$/i;

  let activeFile = null;
  let observer = null;
  let scanQueued = false;
  const stateCache = new Map();

  function getFileId(row) {
    return row?.getAttribute("data-id") ||
      row?.querySelector("[data-id][jsname='vtaz5c']")?.getAttribute("data-id") ||
      row?.querySelector("[data-file-icon][data-id]")?.getAttribute("data-id") ||
      null;
  }

  function getFileName(row) {
    return row?.querySelector("strong.DNoYtb")?.textContent?.trim() ||
      row?.querySelector("[data-tooltip]")?.getAttribute("data-tooltip")?.trim() ||
      "";
  }

  function isVideoRow(row) {
    if (!row || row.getAttribute("role") !== "row" || row.closest("thead")) return false;
    const name = getFileName(row);
    if (name && VIDEO_EXTENSIONS.test(name)) return true;
    const iconTitle = row.querySelector("[data-file-icon] svg title");
    return Boolean(iconTitle && /^(vídeo|video)$/i.test(iconTitle.textContent.trim()));
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], result => resolve(Boolean(result[key])));
      } catch {
        resolve(false);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, resolve);
      } catch {
        resolve();
      }
    });
  }

  async function isWatched(fileId) {
    if (stateCache.has(fileId)) return stateCache.get(fileId);
    const value = await storageGet(STORAGE_PREFIX + fileId);
    stateCache.set(fileId, value);
    return value;
  }

  function updateVideoIcon(fileId, watched) {
    if (!fileId) return;

    // Drive commonly repeats the same file ID in the row and in its icon container.
    const matching = document.querySelectorAll(
      `[data-file-icon][data-id="${CSS.escape(fileId)}"]`
    );

    matching.forEach((iconContainer) => {
      const rect = iconContainer.querySelector("svg rect");
      if (!rect) return;

      // Preserve the original icon color so it can be restored when unchecking.
      if (!rect.hasAttribute("data-dvt-original-fill")) {
        rect.setAttribute("data-dvt-original-fill", rect.getAttribute("fill") || "#FC413D");
      }

      const originalFill = rect.getAttribute("data-dvt-original-fill") || "#FC413D";
      rect.setAttribute("fill", watched ? "#188038" : originalFill);
      iconContainer.classList.toggle("dvt-video-watched", watched);
    });
  }

  async function syncVisibleVideoIcons() {
    const rows = Array.from(document.querySelectorAll('tr[role="row"][data-id]'));
    for (const row of rows) {
      if (!isVideoRow(row)) continue;
      const fileId = getFileId(row);
      if (!fileId) continue;
      const watched = await isWatched(fileId);
      updateVideoIcon(fileId, watched);
    }
  }

  function findOpenMenus() {
    return Array.from(document.querySelectorAll('[role="menu"]'))
      .filter(menu => menu.getClientRects().length > 0);
  }

  function makeMenuItem(fileId, fileName, watched) {
    const item = document.createElement("div");
    item.className = MENU_ITEM_CLASS;
    item.setAttribute("role", "menuitem");
    item.setAttribute("tabindex", "-1");
    item.setAttribute("data-dvt-file-id", fileId);
    item.setAttribute("aria-label", watched ? "Marcar como não assistido" : "Marcar como assistido");

    const icon = document.createElement("span");
    icon.className = "dvt-menu-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = watched ? "✓" : "□";

    const label = document.createElement("span");
    label.className = "dvt-menu-label";
    label.textContent = watched ? "Marcar como não assistido" : "Marcar como assistido";

    item.append(icon, label);
    item.title = fileName ? `Vídeo: ${fileName}` : "Controle de vídeo";

    item.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const nextValue = !(await isWatched(fileId));
      stateCache.set(fileId, nextValue);
      await storageSet(STORAGE_PREFIX + fileId, nextValue);
      updateVideoIcon(fileId, nextValue);

      // Update the item immediately if the menu remains mounted.
      icon.textContent = nextValue ? "✓" : "□";
      label.textContent = nextValue ? "Marcar como não assistido" : "Marcar como assistido";
      item.setAttribute("aria-label", nextValue ? "Marcar como não assistido" : "Marcar como assistido");

      // Close Drive's menu using Escape, without clicking a Drive action.
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", bubbles: true
      }));
    });

    return item;
  }

  async function injectIntoMenu(menu) {
    if (!activeFile?.id || !activeFile.isVideo) return;
    if (!menu.isConnected || menu.querySelector("." + MENU_ITEM_CLASS)) return;

    const { id, name } = activeFile;
    const watched = await isWatched(id);
    if (!menu.isConnected || menu.querySelector("." + MENU_ITEM_CLASS)) return;

    const item = makeMenuItem(id, name, watched);

    // Add a divider and menu item at the bottom of the open menu.
    const divider = document.createElement("div");
    divider.className = "dvt-menu-divider";
    divider.setAttribute("role", "separator");

    menu.appendChild(divider);
    menu.appendChild(item);
  }

  function scanMenus() {
    scanQueued = false;
    const menus = findOpenMenus();
    menus.forEach(menu => injectIntoMenu(menu));
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scanMenus);
  }

  function rowFromTarget(target) {
    return target instanceof Element ? target.closest('tr[role="row"][data-id]') : null;
  }

  function rememberRow(row) {
    if (!row) return;
    const id = getFileId(row);
    if (!id) return;
    activeFile = {
      id,
      name: getFileName(row),
      isVideo: isVideoRow(row)
    };
  }

  // Track the file before Drive opens its contextual menu.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const row = rowFromTarget(target);
    if (!row) return;

    const actionButton = target.closest('button[aria-label*="Mais ações"], button[aria-label*="More actions"]');
    if (actionButton) {
      rememberRow(row);
      setTimeout(scheduleScan, 0);
    }
  }, true);

  document.addEventListener("contextmenu", (event) => {
    const row = rowFromTarget(event.target);
    if (row) {
      rememberRow(row);
      setTimeout(scheduleScan, 0);
    }
  }, true);

  function startObserver() {
    if (!document.body) {
      setTimeout(startObserver, 50);
      return;
    }

    observer = new MutationObserver(() => {
      scheduleScan();
      syncVisibleVideoIcons();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleScan();
    syncVisibleVideoIcons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }
})();