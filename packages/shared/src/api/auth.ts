// Request and response schemas for the auth module.
// The server validates requests with these schemas. A client parses
// responses with the same schemas, so both sides agree on the shape.
import { z } from "zod";
import { idSchema } from "./common.js";
import { base64UrlSchema } from "./messages.js";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "The username must have at least 2 characters.")
  .max(32, "The username must have at most 32 characters.")
  .regex(
    /^[a-z0-9_.]+$/,
    "The username can have only lowercase letters, digits, the underscore and the dot.",
  );

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "The display name must have at least 1 character.")
  .max(32, "The display name must have at most 32 characters.");

export const passwordSchema = z
  .string()
  .min(8, "The password must have at least 8 characters.")
  .max(128, "The password must have at most 128 characters.");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("This is not a valid email address.");

export const oauthProviderSchema = z.enum(["github", "google"]);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/** A user, as the server sends it in a JSON body. */
export const userSchema = z.object({
  id: idSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  email: emailSchema.optional(),
  emailVerified: z.boolean().optional(),
  avatarKey: z.string().nullable(),
  statusText: z.string().nullable(),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;

/** The response of every route that starts or continues a session. */
export const authResultSchema = z.object({
  user: userSchema,
  deviceId: z.string(),
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
});
export type AuthResult = z.infer<typeof authResultSchema>;

// ---- password keys (docs/concepts/password-keys.md) ----

/** The Argon2id parameters of the password key, version 1. The client accepts no other values. */
export const PASSWORD_KDF_V1 = { memoryKib: 64 * 1024, iterations: 3, parallelism: 1 } as const;

/** The auth key: 32 bytes as base64url. The client derives it from the password. The server hashes it as a password. */
export const authKeySchema = base64UrlSchema.length(43, "The auth key must be 32 bytes as base64url.");

/** The salt of the password key: 16 bytes as base64url. */
export const kdfSaltSchema = base64UrlSchema.length(22, "The salt must be 16 bytes as base64url.");

/** The fields that set a new password: the auth key, its salt and the version of the derivation. */
const newPasswordFields = {
  authKey: authKeySchema,
  kdfSalt: kdfSaltSchema,
  kdfVersion: z.literal(1),
};

export const preloginRequestSchema = z.object({
  email: emailSchema,
});
export type PreloginRequest = z.infer<typeof preloginRequestSchema>;

/** "argon2id-v1": derive the auth key with these values. "legacy": send the password itself one time. */
export const preloginResponseSchema = z.discriminatedUnion("kdf", [
  z.object({
    kdf: z.literal("argon2id-v1"),
    salt: kdfSaltSchema,
    memoryKib: z.literal(PASSWORD_KDF_V1.memoryKib),
    iterations: z.literal(PASSWORD_KDF_V1.iterations),
    parallelism: z.literal(PASSWORD_KDF_V1.parallelism),
  }),
  z.object({ kdf: z.literal("legacy") }),
]);
export type PreloginResponse = z.infer<typeof preloginResponseSchema>;

/** The sign-up form. The client checks the password and sends only the auth key. */
export const registerFormSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
});
export type RegisterForm = z.infer<typeof registerFormSchema>;

export const registerRequestSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  ...newPasswordFields,
  displayName: displayNameSchema.optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginFormSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "The password is required."),
});
export type LoginForm = z.infer<typeof loginFormSchema>;

/** A sign-in sends the auth key. Only an account that has no password key yet ("legacy") sends the password. */
export const loginRequestSchema = z.union([
  z.object({ email: emailSchema, authKey: authKeySchema }),
  z.object({ email: emailSchema, password: z.string().min(1, "The password is required.").max(256) }),
]);
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Change a legacy account to the password key. The password proves the account one more time. */
export const upgradePasswordRequestSchema = z.object({
  password: z.string().min(1).max(256),
  ...newPasswordFields,
});
export type UpgradePasswordRequest = z.infer<typeof upgradePasswordRequestSchema>;

/** The recovery key, encrypted with the wrap key: 12 bytes IV, 32 bytes, 16 bytes tag, as base64url. */
export const keyWrapSchema = z.object({
  /** The key backup version that the recovery key opens. */
  version: z.number().int().positive(),
  data: base64UrlSchema.length(80, "The key wrap must be 60 bytes as base64url."),
});
export type KeyWrap = z.infer<typeof keyWrapSchema>;

/** Store a key wrap. `kdfSalt` names the password key that made it: the server refuses a wrap of an old password. */
export const putKeyWrapRequestSchema = keyWrapSchema.extend({ kdfSalt: kdfSaltSchema });
export type PutKeyWrapRequest = z.infer<typeof putKeyWrapRequestSchema>;

export const getKeyWrapResponseSchema = z.object({ keyWrap: keyWrapSchema.nullable() });
export type GetKeyWrapResponse = z.infer<typeof getKeyWrapResponseSchema>;

export const changePasswordRequestSchema = z.object({
  currentAuthKey: authKeySchema,
  ...newPasswordFields,
  /** The recovery key, encrypted with the new wrap key. Null removes the key wrap. */
  keyWrap: keyWrapSchema.nullable(),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1, "The refresh token is required."),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const refreshResultSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
});
export type RefreshResult = z.infer<typeof refreshResultSchema>;

export const verifyEmailRequestSchema = z.object({
  token: z.string().min(1, "The verification token is required."),
});
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const forgotPasswordRequestSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(1, "The reset token is required."),
  ...newPasswordFields,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const oauthProvidersResultSchema = z.object({
  providers: z.array(oauthProviderSchema),
});
export type OAuthProvidersResult = z.infer<typeof oauthProvidersResultSchema>;

export const oauthExchangeRequestSchema = z.object({
  code: z.string().min(1, "The exchange code is required."),
});
export type OAuthExchangeRequest = z.infer<typeof oauthExchangeRequestSchema>;
