// The network side of the crypto layer: the key server routes, the key
// backup routes, the to-device route, the channel members route and the
// TO_DEVICE_SEND and TO_DEVICE_ACK gateway ops. Tests use a fake in place
// of the HTTP one.
import {
  GatewayOpcode,
  channelMembersResponseSchema,
  claimKeysResponseSchema,
  createBackupVersionResponseSchema,
  getBackupSessionsResponseSchema,
  getBackupVersionResponseSchema,
  queryKeysResponseSchema,
  sendToDeviceResponseSchema,
  uploadKeysResponseSchema,
  type ChannelMembersResponse,
  type BackupVersion,
  type ClaimKeysResponse,
  type CreateBackupVersionRequest,
  type DeviceRef,
  type GetBackupSessionsQuery,
  type GetBackupSessionsResponse,
  type PutBackupSessionsRequest,
  type PutMasterKeyRequest,
  type QueryKeysResponse,
  type ResetMasterKeyRequest,
  type SendToDeviceResponse,
  type ToDeviceMessage,
  type UploadKeysRequest,
  type UploadKeysResponse,
  type UploadSignatureRequest,
} from "@mortium/shared";
import type { ApiClient } from "../api.js";

export interface CryptoTransport {
  uploadKeys(body: UploadKeysRequest): Promise<UploadKeysResponse>;
  putMasterKey(body: PutMasterKeyRequest): Promise<void>;
  /** Store the master signature of a different device of this user. */
  uploadSignature(body: UploadSignatureRequest): Promise<void>;
  resetMasterKey(body: ResetMasterKeyRequest): Promise<void>;
  createBackupVersion(body: CreateBackupVersionRequest): Promise<{ version: number }>;
  getBackupVersion(): Promise<BackupVersion | null>;
  deleteBackupVersion(version: number): Promise<void>;
  putBackupSessions(body: PutBackupSessionsRequest): Promise<{ stored: number }>;
  getBackupSessions(query: GetBackupSessionsQuery): Promise<GetBackupSessionsResponse>;
  putBackupSecrets(version: number, secrets: Record<string, string>): Promise<void>;
  queryKeys(userIds: string[]): Promise<QueryKeysResponse>;
  claimKeys(devices: DeviceRef[]): Promise<ClaimKeysResponse>;
  sendToDevice(messages: ToDeviceMessage[]): Promise<SendToDeviceResponse>;
  /** Send over the gateway op TO_DEVICE_SEND, with no reply. It is faster than the route. It does nothing while the gateway is down. */
  sendToDeviceLive(messages: ToDeviceMessage[]): void;
  /** The users who can view a channel, with the inputs to check their permissions. */
  channelMembers(channelId: string): Promise<ChannelMembersResponse>;
  /** Send TO_DEVICE_ACK over the gateway. It does nothing while the gateway is down. */
  ackToDevice(upToId: string, resync: boolean): void;
}

export function createHttpCryptoTransport(
  api: ApiClient,
  gatewaySend: (op: number, d?: unknown) => void,
): CryptoTransport {
  return {
    uploadKeys: (body) => api.request("POST", "/keys/upload", { body, schema: uploadKeysResponseSchema }),
    putMasterKey: (body) => api.request("PUT", "/keys/master", { body }),
    uploadSignature: (body) => api.request("POST", "/keys/signatures", { body }),
    resetMasterKey: (body) => api.request("POST", "/keys/master/reset", { body }),
    createBackupVersion: (body) =>
      api.request("POST", "/keys/backup/version", { body, schema: createBackupVersionResponseSchema }),
    getBackupVersion: async () =>
      (await api.request("GET", "/keys/backup/version", { schema: getBackupVersionResponseSchema })).backup,
    deleteBackupVersion: (version) => api.request("DELETE", `/keys/backup/version/${version}`),
    putBackupSessions: (body) => api.request("PUT", "/keys/backup/sessions", { body }),
    getBackupSessions: (query) => {
      const params = new URLSearchParams({ version: String(query.version) });
      for (const name of ["channelId", "after", "limit"] as const) {
        if (query[name] !== undefined) {
          params.set(name, String(query[name]));
        }
      }
      return api.request("GET", `/keys/backup/sessions?${params.toString()}`, { schema: getBackupSessionsResponseSchema });
    },
    putBackupSecrets: (version, secrets) => api.request("PUT", "/keys/backup/secrets", { body: { version, secrets } }),
    queryKeys: (userIds) => api.request("POST", "/keys/query", { body: { userIds }, schema: queryKeysResponseSchema }),
    claimKeys: (devices) => api.request("POST", "/keys/claim", { body: { devices }, schema: claimKeysResponseSchema }),
    sendToDevice: (messages) =>
      api.request("POST", "/to-device", { body: { messages }, schema: sendToDeviceResponseSchema }),
    sendToDeviceLive: (messages) => gatewaySend(GatewayOpcode.TO_DEVICE_SEND, { messages }),
    channelMembers: (channelId) =>
      api.request("GET", `/channels/${channelId}/members`, { schema: channelMembersResponseSchema }),
    ackToDevice: (upToId, resync) => gatewaySend(GatewayOpcode.TO_DEVICE_ACK, { upToId, ...(resync ? { resync } : {}) }),
  };
}
