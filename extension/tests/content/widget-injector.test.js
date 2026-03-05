jest.mock("motion", () => ({
  animate: jest.fn(),
  spring: jest.fn(() => ({ type: "spring" })),
}));

import { injectWidget } from "../../src/content/injectors/widget-injector.js";
import { MESSAGE_TYPES } from "../../src/shared/contracts/messages.js";

describe("widget auth-required behavior", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.open = jest.fn();

    global.chrome = {
      runtime: {
        lastError: null,
        onMessage: {
          addListener: jest.fn(),
        },
        sendMessage: jest.fn((message, callback) => {
          if (message?.type === MESSAGE_TYPES.CHECK_ASSIGNMENT_GUIDE_STATUS) {
            callback?.({
              ok: true,
              exists: false,
              authRequired: true,
              loginUrl: "http://localhost:3000/login",
            });
            return;
          }

          callback?.({ ok: true });
        }),
      },
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("switches CTA to login and opens login URL instead of starting a run", () => {
    injectWidget({
      title: "Project 1",
      courseName: "EECS 582",
      dueDate: null,
      pointsPossible: 100,
      rubric: null,
    });

    const actionBtn = document.querySelector(".headstart-sidebar__btn");
    expect(actionBtn).not.toBeNull();
    expect(actionBtn.textContent.trim()).toBe("Log in to Headstart");

    actionBtn.click();

    expect(window.open).toHaveBeenCalledWith(
      "http://localhost:3000/login",
      "_blank",
      "noopener,noreferrer",
    );

    const startCalls = global.chrome.runtime.sendMessage.mock.calls.filter(
      ([msg]) => msg?.type === MESSAGE_TYPES.START_HEADSTART_RUN,
    );
    expect(startCalls).toHaveLength(0);
  });

  test("re-checks auth status on tab focus and restores Generate Guide after login", () => {
    const guideStatusResponses = [
      {
        ok: true,
        exists: false,
        authRequired: true,
        loginUrl: "http://localhost:3000/login",
      },
      {
        ok: true,
        exists: false,
        authRequired: false,
      },
    ];

    global.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === MESSAGE_TYPES.CHECK_ASSIGNMENT_GUIDE_STATUS) {
        callback?.(guideStatusResponses.shift() || { ok: true, exists: false });
        return;
      }

      callback?.({ ok: true });
    });

    injectWidget({
      title: "Project 1",
      courseName: "EECS 582",
      dueDate: null,
      pointsPossible: 100,
      rubric: null,
    });

    const actionBtn = document.querySelector(".headstart-sidebar__btn");
    expect(actionBtn.textContent.trim()).toBe("Log in to Headstart");

    window.dispatchEvent(new Event("focus"));

    expect(actionBtn.textContent.trim()).toBe("Generate Guide");
  });

  test("re-check on focus still honors existing-guide status after login", () => {
    const guideStatusResponses = [
      {
        ok: true,
        exists: false,
        authRequired: true,
        loginUrl: "http://localhost:3000/login",
      },
      {
        ok: true,
        exists: true,
        authRequired: false,
      },
    ];

    global.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === MESSAGE_TYPES.CHECK_ASSIGNMENT_GUIDE_STATUS) {
        callback?.(guideStatusResponses.shift() || { ok: true, exists: true });
        return;
      }

      callback?.({ ok: true });
    });

    injectWidget({
      title: "Project 2",
      courseName: "EECS 582",
      dueDate: null,
      pointsPossible: 100,
      rubric: null,
    });

    const actionBtn = document.querySelector(".headstart-sidebar__btn");
    expect(actionBtn.textContent.trim()).toBe("Log in to Headstart");

    window.dispatchEvent(new Event("focus"));

    expect(actionBtn.textContent.trim()).toBe("Generate New Guide");
  });
});
