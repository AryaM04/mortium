// Typed REST wrapper for the desktop download route. The route needs no sign-in.
import { desktopLatestResponseSchema, type DesktopLatestResponse } from "@mortium/shared";
import type { ApiClient } from "./api.js";

export function getLatestDesktop(api: ApiClient): Promise<DesktopLatestResponse> {
  return api.request<DesktopLatestResponse>("GET", "/desktop/latest", {
    schema: desktopLatestResponseSchema,
    skipAuth: true,
  });
}
