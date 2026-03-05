/**
 * Artifact: extension/src/content/injectors/widget-injector.js
 * Purpose: Injects and manages the Headstart sidebar UI and webapp handoff actions inside Canvas pages.
 * Author: Ansuman Sharma
 * Created: 2026-02-27
 * Revised:
 * - 2026-03-01: Replaced in-extension chat flow with webapp chat handoff and status messaging. (Codex)
 * Preconditions:
 * - Executed on Canvas pages with DOM access and content-script runtime messaging available.
 * Inputs:
 * - Acceptable: Assignment payload objects for single-assignment or assignment-list rendering.
 * - Unacceptable: Null/undefined payloads or payloads missing required view fields (title/course/list data).
 * Postconditions:
 * - Sidebar/toggle UI is mounted once, user actions are wired, and status/error updates are shown.
 * Returns:
 * - `injectWidget` returns void after DOM and listener side effects are applied.
 * Errors/Exceptions:
 * - UI/rendering and animation errors are caught and logged; runtime errors are surfaced as status text.
 */

import { MESSAGE_TYPES } from "../../shared/contracts/messages.js";
import { createLogger } from "../../shared/logger.js";
import { animate, spring } from "motion";

const log = createLogger("Widget");

const SIDEBAR_ID = "headstart-sidebar";
const TOGGLE_ID = "headstart-toggle-btn";
const OUTPUT_ID = "headstart-output";
const WEBAPP_BASE_URL = "http://localhost:3000";
const DEFAULT_LOGIN_URL = `${WEBAPP_BASE_URL}/login`;
const STATUS_TONE_CLASSES = [
  "headstart-sidebar__output--info",
  "headstart-sidebar__output--success",
  "headstart-sidebar__output--error",
];
const LUCIDE_ICON_PATHS = {
  rocket: [
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path>',
    '<path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path>',
    '<path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"></path>',
    '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path>',
  ],
  close: [
    '<path d="M18 6 6 18"></path>',
    '<path d="m6 6 12 12"></path>',
  ],
};

function renderLucideIcon(paths, size = 18, className = "") {
  const safeSize = Number.isFinite(size) ? Math.max(12, Math.floor(size)) : 18;
  const safeClassName =
    typeof className === "string" && className.trim()
      ? ` class="${className.trim()}"`
      : "";

  return `<svg${safeClassName} xmlns="http://www.w3.org/2000/svg" width="${safeSize}" height="${safeSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.join("")}</svg>`;
}

export function injectWidget(assignmentData) {
  if (document.getElementById(SIDEBAR_ID)) {
    log.debug("Widget already injected - skipping.");
    return;
  }

  log.info(
    "Injecting widget | isList:",
    !!assignmentData.listAssignments,
    "| title:",
    assignmentData.title ?? "(list)",
  );
  injectToggle();
  injectSidebar(assignmentData);

  setTimeout(() => toggleSidebar(true), 500);
}

// ------------------------------------------------------------
// Toggle button
// ------------------------------------------------------------

function injectToggle() {
  const btn = document.createElement("button");
  btn.id = TOGGLE_ID;
  btn.className = "headstart-toggle";
  btn.innerHTML = renderLucideIcon(
    LUCIDE_ICON_PATHS.rocket,
    20,
    "headstart-toggle__icon",
  );
  btn.title = "Toggle Headstart AI";
  btn.setAttribute("aria-label", "Toggle Headstart AI sidebar");

  btn.onclick = () => {
    toggleSidebar(!sidebarOpen);
  };

  document.body.appendChild(btn);

  try {
    animate(
      btn,
      { opacity: [0, 1], transform: ["translateX(60px)", "translateX(0)"] },
      { easing: spring(0.3, 0.3) },
    );
  } catch (e) {
    log.warn("Toggle animate error:", e?.message || e);
  }
}

// ------------------------------------------------------------
// Sidebar
// ------------------------------------------------------------

function injectSidebar(data) {
  const sidebar = document.createElement("div");
  sidebar.id = SIDEBAR_ID;
  sidebar.className = "headstart-sidebar";

  const isList = !!data.listAssignments;
  const userTimezone = data.userTimezone || null;

  let contentHtml = "";
  if (isList) {
    contentHtml = `
      <div class="headstart-sidebar__course-label">${escapeHtml(
        data.courseName || "Course Overview",
      )}</div>
      <ul class="headstart-sidebar__list">
        ${data.listAssignments
          .map(
            (a) => `
          <li class="headstart-sidebar__item">
            <div class="headstart-sidebar__item-title">${escapeHtml(a.title)}</div>
            <div class="headstart-sidebar__item-meta">
              ${
                a.dueDate
                  ? `<span class="headstart-sidebar__pill">Due ${escapeHtml(formatDateInTimezone(a.dueDate, userTimezone) || a.dueDate)}</span>`
                  : `<span class="headstart-sidebar__pill">No due date</span>`
              }
            </div>
          </li>
        `,
          )
          .join("")}
      </ul>
    `;
  } else {
    const formattedDueDate = data.dueDate
      ? formatDateInTimezone(data.dueDate, userTimezone) || data.dueDate
      : null;
    contentHtml = `
      <div class="headstart-sidebar__course-label">${escapeHtml(
        data.courseName || "Current Course",
      )}</div>
      <div class="headstart-sidebar__item headstart-sidebar__item--single">
        <div class="headstart-sidebar__item-title">${escapeHtml(data.title)}</div>
        <div class="headstart-sidebar__item-meta">
          ${
            formattedDueDate
              ? `<span class="headstart-sidebar__pill">Due ${escapeHtml(formattedDueDate)}</span>`
              : `<span class="headstart-sidebar__pill">No due date</span>`
          }
          ${
            data.pointsPossible
              ? `<span class="headstart-sidebar__pill">${escapeHtml(data.pointsPossible)} points</span>`
              : ""
          }
        </div>
      </div>
      ${
        data.rubric
          ? `<div class="headstart-sidebar__rubric-note">Rubric: ${data.rubric.criteria.length} criteria</div>`
          : ""
      }
    `;
  }

  sidebar.innerHTML = `
    <div class="headstart-sidebar__header">
      <div class="headstart-sidebar__logo-area">
        <span class="headstart-sidebar__logo-icon">${renderLucideIcon(LUCIDE_ICON_PATHS.rocket, 16)}</span>
        <span class="headstart-sidebar__title-wrap">
          <span class="headstart-sidebar__title">Headstart AI</span>
          <span class="headstart-sidebar__subtitle">Canvas companion</span>
        </span>
      </div>
      <button class="headstart-sidebar__close" aria-label="Close Headstart sidebar">
        ${renderLucideIcon(LUCIDE_ICON_PATHS.close, 16)}
      </button>
    </div>

    <div class="headstart-sidebar__body">
      <div class="headstart-sidebar__body-content">
        ${contentHtml}
      </div>
      <div id="${OUTPUT_ID}" class="headstart-sidebar__output"></div>
    </div>

    <div class="headstart-sidebar__action-area">
      <button class="headstart-sidebar__btn">
        ${isList ? "Open Dashboard" : "Generate Guide"}
      </button>
    </div>
  `;

  sidebar.querySelector(".headstart-sidebar__close").onclick = () =>
    toggleSidebar(false);

  const outputEl = sidebar.querySelector(`#${OUTPUT_ID}`);
  const setStatus = (text, tone = "info") => {
    if (!outputEl) return;
    outputEl.classList.add("headstart-sidebar__output--visible");
    outputEl.classList.remove(...STATUS_TONE_CLASSES);
    if (tone === "error") {
      outputEl.classList.add("headstart-sidebar__output--error");
    } else if (tone === "success") {
      outputEl.classList.add("headstart-sidebar__output--success");
    } else {
      outputEl.classList.add("headstart-sidebar__output--info");
    }
    outputEl.textContent = stringifySafe(text);
  };

  const actionBtn = sidebar.querySelector(".headstart-sidebar__btn");
  let dashboardUrl = null;
  let authRequired = false;
  let loginUrl = DEFAULT_LOGIN_URL;
  let guideStatusCheckInFlight = false;
  let singleAssignmentActionLabel = "Generate Guide";
  const resetSingleAssignmentActionLabel = () => {
    if (authRequired) {
      actionBtn.textContent = "Log in to Headstart";
      return;
    }
    if (!dashboardUrl) {
      actionBtn.textContent = singleAssignmentActionLabel;
    }
  };
  const applyAuthRequiredState = (message, nextLoginUrl) => {
    authRequired = true;
    dashboardUrl = null;
    if (typeof nextLoginUrl === "string" && nextLoginUrl.trim()) {
      loginUrl = nextLoginUrl.trim();
    } else {
      loginUrl = DEFAULT_LOGIN_URL;
    }
    actionBtn.disabled = false;
    actionBtn.textContent = "Log in to Headstart";
    setStatus(
      message || "Sign in to Headstart before checking guide status or generating one.",
      "error",
    );
  };
  const clearAuthRequiredState = () => {
    authRequired = false;
    loginUrl = DEFAULT_LOGIN_URL;
  };
  const checkGuideStatus = ({ showAuthStatus = true } = {}) => {
    if (isList || guideStatusCheckInFlight) return;
    if (actionBtn.disabled && !authRequired) return;

    guideStatusCheckInFlight = true;
    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.CHECK_ASSIGNMENT_GUIDE_STATUS },
      (resp) => {
        guideStatusCheckInFlight = false;

        if (chrome.runtime.lastError) {
          log.warn(
            "CHECK_ASSIGNMENT_GUIDE_STATUS failed:",
            chrome.runtime.lastError.message,
          );
          return;
        }

        if (resp?.authRequired) {
          const message = showAuthStatus
            ? "Sign in to Headstart to check existing guides and generate one."
            : null;
          applyAuthRequiredState(message, resp?.loginUrl);
          return;
        }

        if (!resp?.ok) {
          return;
        }

        clearAuthRequiredState();
        singleAssignmentActionLabel = resp?.exists
          ? "Generate New Guide"
          : "Generate Guide";
        resetSingleAssignmentActionLabel();

        if (resp?.exists) {
          setStatus(
            "A guide already exists for this assignment. You can still generate a new guide.",
            "info",
          );
        }
      },
    );
  };
  const refreshGuideStatusOnReturn = () => {
    if (isList) return;
    checkGuideStatus({ showAuthStatus: false });
  };
  actionBtn.onclick = () => {
    try {
      animate(
        actionBtn,
        { transform: ["scale(1)", "scale(0.95)", "scale(1)"] },
        { duration: 0.2 },
      );
    } catch (e) {
      log.warn("Button animate error:", e?.message || e);
    }

    if (isList) {
      window.open(`${WEBAPP_BASE_URL}/dashboard`, "_blank", "noopener,noreferrer");
      setStatus("Opened dashboard in a new tab.", "success");
      return;
    }

    if (authRequired) {
      window.open(loginUrl, "_blank", "noopener,noreferrer");
      setStatus("Authentication required. Opened login in a new tab.", "info");
      return;
    }

    if (dashboardUrl) {
      window.open(dashboardUrl, "_blank", "noopener,noreferrer");
      setStatus("Opened dashboard guide view in a new tab.", "success");
      return;
    }

    actionBtn.disabled = true;
    actionBtn.textContent = "Generating...";
    setStatus("Guide generation started. This can take up to a minute.", "info");

    chrome.runtime.sendMessage({ type: MESSAGE_TYPES.START_HEADSTART_RUN }, (resp) => {
      log.debug("START_HEADSTART_RUN ack:", resp);
      if (!resp?.ok) {
        actionBtn.disabled = false;
        resetSingleAssignmentActionLabel();
        setStatus(
          `Unable to start guide generation: ${resp?.error || "unknown error"}`,
          "error",
        );
      }
    });
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === MESSAGE_TYPES.HEADSTART_AUTH_REQUIRED) {
      log.warn("HEADSTART_AUTH_REQUIRED received");
      applyAuthRequiredState(
        stringifySafe(msg.message),
        msg.loginUrl,
      );
      return;
    }

    if (msg.type === MESSAGE_TYPES.HEADSTART_ERROR) {
      log.error("HEADSTART_ERROR received:", msg.error);
      actionBtn.disabled = false;
      resetSingleAssignmentActionLabel();
      setStatus(
        `Unable to start guide generation: ${stringifySafe(msg.error || "Unknown error")}`,
        "error",
      );
      return;
    }

    if (msg.type === MESSAGE_TYPES.HEADSTART_RESULT) {
      log.info("HEADSTART_RESULT received");
      log.debug("Result payload:", msg.result);
      actionBtn.disabled = false;
      clearAuthRequiredState();

      const redirectUrl = msg.result?.redirectUrl || msg.redirectUrl;
      if (redirectUrl) {
        dashboardUrl = redirectUrl;
        actionBtn.textContent = "View Guide in Dashboard";
        setStatus(
          "Guide generation is running in the background. Click \"View Guide in Dashboard\" to follow progress.",
          "success",
        );
      } else {
        resetSingleAssignmentActionLabel();
        setStatus("Guide request started, but dashboard link was missing.", "error");
      }
    }
  });

  if (!isList) {
    checkGuideStatus({ showAuthStatus: true });
    window.addEventListener("focus", refreshGuideStatusOnReturn);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshGuideStatusOnReturn();
      }
    });
  }

  document.body.appendChild(sidebar);
}

// ------------------------------------------------------------
// Sidebar open/close
// ------------------------------------------------------------

let sidebarOpen = false;

function toggleSidebar(open) {
  const sidebar = document.getElementById(SIDEBAR_ID);
  if (!sidebar) return;

  const shouldOpen = !!open;
  if (shouldOpen === sidebarOpen) return;
  sidebarOpen = shouldOpen;

  try {
    if (shouldOpen) {
      animate(
        sidebar,
        { transform: ["translateX(100%)", "translateX(0)"] },
        { easing: spring(0.35, 0.15) },
      );
    } else {
      animate(
        sidebar,
        { transform: ["translateX(0)", "translateX(100%)"] },
        { duration: 0.25, easing: "ease-in" },
      );
    }
  } catch (e) {
    log.warn("Sidebar animate error:", e?.message || e);
    sidebar.style.transform = shouldOpen ? "translateX(0)" : "translateX(100%)";
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function stringifySafe(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function formatDateInTimezone(dateStr, timezone) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const opts = {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    };
    if (timezone) opts.timeZone = timezone;
    return new Intl.DateTimeFormat("en-US", opts).format(d);
  } catch {
    return dateStr;
  }
}
