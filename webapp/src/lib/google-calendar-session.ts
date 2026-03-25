import {
  getGoogleOAuthConfig,
  GoogleCalendarApiError,
  refreshGoogleAccessToken,
} from "@/lib/google-calendar";
import {
  getGoogleCalendarIntegration,
  type GoogleCalendarIntegrationStatus,
  upsertConnectedGoogleCalendarIntegration,
  upsertNeedsAttentionGoogleCalendarIntegration,
} from "@/lib/google-calendar-repository";

export type GoogleCalendarAccessState = {
  status: GoogleCalendarIntegrationStatus;
  connected: boolean;
  accessToken: string | null;
};

export async function ensureGoogleCalendarAccessToken(input: {
  userId: string;
  requestUrl: string;
}): Promise<GoogleCalendarAccessState> {
  const integration = await getGoogleCalendarIntegration(input.userId);
  if (!integration || integration.status !== "connected") {
    return {
      status: integration?.status ?? "disconnected",
      connected: false,
      accessToken: null,
    };
  }

  let accessToken = integration.accessToken;
  const needsRefresh = !accessToken || isExpired(integration.tokenExpiresAt);

  if (!needsRefresh) {
    return {
      status: "connected",
      connected: true,
      accessToken,
    };
  }

  const refreshToken = integration.refreshToken;
  if (!refreshToken) {
    await upsertNeedsAttentionGoogleCalendarIntegration({
      userId: input.userId,
      lastError: "Missing refresh token.",
    }).catch(() => undefined);

    return {
      status: "needs_attention",
      connected: false,
      accessToken: null,
    };
  }

  try {
    const config = getGoogleOAuthConfig(input.requestUrl);
    const refreshed = await refreshGoogleAccessToken({
      config,
      refreshToken,
    });

    const upserted = await upsertConnectedGoogleCalendarIntegration({
      userId: input.userId,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? refreshToken,
      scope: refreshed.scope ?? integration.scope,
      tokenExpiresAt: toExpiryIso(refreshed.expiresIn),
      googleEmail: integration.googleEmail,
    });

    accessToken = upserted.accessToken;

    return {
      status: "connected",
      connected: Boolean(accessToken),
      accessToken,
    };
  } catch (error) {
    if (
      error instanceof GoogleCalendarApiError &&
      (error.status === 400 || error.status === 401 || error.status === 403)
    ) {
      await upsertNeedsAttentionGoogleCalendarIntegration({
        userId: input.userId,
        lastError: "Google authorization rejected by provider.",
      }).catch(() => undefined);

      return {
        status: "needs_attention",
        connected: false,
        accessToken: null,
      };
    }

    throw error;
  }
}

function toExpiryIso(expiresInSeconds: number | null) {
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) {
    return null;
  }
  return new Date(Date.now() + Math.max(1, expiresInSeconds) * 1000).toISOString();
}

function isExpired(expiresAtIso: string | null) {
  if (!expiresAtIso) return true;
  const expiresAt = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - Date.now() <= 30_000;
}
