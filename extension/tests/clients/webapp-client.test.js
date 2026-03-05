import {
  createChatSession,
  getAssignmentGuideStatus,
  isWebappAuthError,
} from "../../src/clients/webapp-client.js";

describe("webapp-client auth error mapping", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  test("createChatSession marks 401 as auth-required", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Authentication required",
    });

    let caught = null;
    try {
      await createChatSession({ payload: {} }, "http://localhost:3000");
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(caught.name).toBe("WebappHttpError");
    expect(caught.status).toBe(401);
    expect(caught.isAuthError).toBe(true);
    expect(isWebappAuthError(caught)).toBe(true);
  });

  test("getAssignmentGuideStatus keeps non-auth failures as non-auth errors", async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Unexpected backend failure",
    });

    let caught = null;
    try {
      await getAssignmentGuideStatus(
        { courseId: "1", assignmentId: "2" },
        "http://localhost:3000",
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(caught.name).toBe("WebappHttpError");
    expect(caught.status).toBe(500);
    expect(caught.isAuthError).toBe(false);
    expect(isWebappAuthError(caught)).toBe(false);
  });
});
