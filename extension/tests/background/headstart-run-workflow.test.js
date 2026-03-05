jest.mock("../../src/clients/webapp-client.js", () => ({
  createChatSession: jest.fn(),
  getAssignmentGuideStatus: jest.fn(),
  isWebappAuthError: jest.fn(),
}));

jest.mock("../../src/storage/assignment-store.js", () => ({
  getAssignmentRecord: jest.fn(),
}));

import {
  createChatSession,
  getAssignmentGuideStatus,
  isWebappAuthError,
} from "../../src/clients/webapp-client.js";
import { getAssignmentRecord } from "../../src/storage/assignment-store.js";
import {
  handleCheckAssignmentGuideStatus,
  handleStartHeadstartRun,
} from "../../src/background/workflows/headstart-run-workflow.js";
import { MESSAGE_TYPES } from "../../src/shared/contracts/messages.js";

describe("headstart-run-workflow auth handling", () => {
  beforeEach(() => {
    global.chrome = {
      runtime: { lastError: null },
      tabs: {
        sendMessage: jest.fn((tabId, message, callback) => {
          if (typeof callback === "function") {
            callback();
          }
        }),
      },
    };
    jest.clearAllMocks();
  });

  test("handleCheckAssignmentGuideStatus returns authRequired on auth failures", async () => {
    getAssignmentGuideStatus.mockRejectedValue(new Error("unauthorized"));
    isWebappAuthError.mockReturnValue(true);

    const result = await handleCheckAssignmentGuideStatus({
      url: "https://canvas.example.edu/courses/10/assignments/20",
    });

    expect(getAssignmentGuideStatus).toHaveBeenCalledWith(
      {
        courseId: "10",
        assignmentId: "20",
        instanceDomain: "canvas.example.edu",
      },
      "http://localhost:3000",
    );
    expect(result).toEqual({
      exists: false,
      latestSessionId: null,
      latestSessionUpdatedAt: null,
      status: null,
      authRequired: true,
      loginUrl: "http://localhost:3000/login",
    });
  });

  test("handleStartHeadstartRun sends HEADSTART_AUTH_REQUIRED on auth failures", async () => {
    getAssignmentRecord.mockResolvedValue({
      key: "assignment::10::20",
      record: {
        courseId: "10",
        assignmentId: "20",
        title: "Problem Set 1",
        dueDate: null,
        descriptionText: "Solve all questions.",
        pdfAttachments: [],
      },
    });
    createChatSession.mockRejectedValue(new Error("401"));
    isWebappAuthError.mockReturnValue(true);

    await handleStartHeadstartRun({
      id: 321,
      url: "https://canvas.example.edu/courses/10/assignments/20",
    });

    expect(global.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    const [tabId, message] = global.chrome.tabs.sendMessage.mock.calls[0];
    expect(tabId).toBe(321);
    expect(message.type).toBe(MESSAGE_TYPES.HEADSTART_AUTH_REQUIRED);
    expect(message.loginUrl).toBe("http://localhost:3000/login");
  });

  test("handleStartHeadstartRun keeps HEADSTART_ERROR for non-auth failures", async () => {
    getAssignmentRecord.mockResolvedValue({
      key: "assignment::10::20",
      record: {
        courseId: "10",
        assignmentId: "20",
        title: "Problem Set 1",
        dueDate: null,
        descriptionText: "Solve all questions.",
        pdfAttachments: [],
      },
    });
    createChatSession.mockRejectedValue(new Error("backend down"));
    isWebappAuthError.mockReturnValue(false);

    await handleStartHeadstartRun({
      id: 321,
      url: "https://canvas.example.edu/courses/10/assignments/20",
    });

    expect(global.chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
    const [, message] = global.chrome.tabs.sendMessage.mock.calls[0];
    expect(message.type).toBe(MESSAGE_TYPES.HEADSTART_ERROR);
    expect(message.error).toContain("backend down");
  });
});
