// Typed REST wrappers for channel events (messages, edits, reactions,
// redactions and read state). Thin calls into the shared `ApiClient`,
// parsed with the shared zod schemas.
import {
  createEventRequestSchema,
  eventSchema,
  listEventsResponseSchema,
  updateReadStateRequestSchema,
  type CreateEventRequest,
  type EventJson,
  type ListEventsResponse,
} from "@mortium/shared";
import type { ApiClient } from "./api.js";

export function postEvent(api: ApiClient, channelId: string, input: CreateEventRequest): Promise<EventJson> {
  createEventRequestSchema.parse(input);
  return api.request<EventJson>("POST", `/channels/${channelId}/events`, { body: input, schema: eventSchema });
}

export interface ListEventsOptions {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
}

export function listEvents(api: ApiClient, channelId: string, options: ListEventsOptions = {}): Promise<ListEventsResponse> {
  const query = new URLSearchParams();
  if (options.before) query.set("before", options.before);
  if (options.after) query.set("after", options.after);
  if (options.around) query.set("around", options.around);
  if (options.limit) query.set("limit", String(options.limit));
  const search = query.toString();
  return api.request<ListEventsResponse>("GET", `/channels/${channelId}/events${search ? `?${search}` : ""}`, {
    schema: listEventsResponseSchema,
  });
}

export function redactEvent(api: ApiClient, channelId: string, eventId: string): Promise<void> {
  return api.request("DELETE", `/channels/${channelId}/events/${eventId}`);
}

export function updateReadState(api: ApiClient, channelId: string, eventId: string): Promise<void> {
  const body = updateReadStateRequestSchema.parse({ eventId });
  return api.request("PUT", `/channels/${channelId}/read`, { body });
}
