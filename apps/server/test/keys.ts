// Test helpers for the key server and to-device tests: real Ed25519 keys
// from node:crypto that sign the same canonical text as a client, and a
// helper that puts users in one guild.
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import {
  deviceKeysSignedText,
  masterKeySignedText,
  oneTimeKeySignedText,
  type DeviceKeys,
} from "@mortium/shared";
import { apiFor, type TestServer, type TestUser } from "./social.js";

/** Unpadded standard base64, the vodozemac form. */
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

export class TestSigner {
  readonly privateKey: KeyObject;
  readonly publicKey: string;

  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.publicKey = b64(Buffer.from(jwk.x!, "base64url"));
  }

  sign(text: string): string {
    return b64(sign(null, Buffer.from(text, "utf8"), this.privateKey));
  }
}

/** A random public key. The server does not check Curve25519 keys, only their form. */
export function randomCurveKey(): string {
  return b64(randomBytes(32));
}

/** The keys of one test device, with helpers that build signed upload bodies. */
export class TestDeviceKeys {
  readonly signer = new TestSigner();
  readonly curve25519 = randomCurveKey();
  private nextKeyId = 0;

  constructor(readonly user: TestUser) {}

  get deviceKeys(): DeviceKeys {
    const text = deviceKeysSignedText(this.user.userId, this.user.deviceId, this.curve25519, this.signer.publicKey);
    return { curve25519: this.curve25519, ed25519: this.signer.publicKey, signature: this.signer.sign(text) };
  }

  oneTimeKeys(count: number): Record<string, { key: string; signature: string }> {
    const keys: Record<string, { key: string; signature: string }> = {};
    for (let i = 0; i < count; i += 1) {
      this.nextKeyId += 1;
      const keyId = `AAAAAAAAA${this.nextKeyId.toString().padStart(3, "0")}`;
      const key = randomCurveKey();
      keys[keyId] = {
        key,
        signature: this.signer.sign(oneTimeKeySignedText("one_time_key", this.user.userId, this.user.deviceId, keyId, key)),
      };
    }
    return keys;
  }

  fallbackKey(keyId = "fallback1"): { keyId: string; key: string; signature: string } {
    const key = randomCurveKey();
    const text = oneTimeKeySignedText("fallback_key", this.user.userId, this.user.deviceId, keyId, key);
    return { keyId, key, signature: this.signer.sign(text) };
  }

  /** A body for PUT /keys/master that makes `master` the master key of the user. */
  masterBody(master: TestSigner): { publicKey: string; deviceSignature: string; masterSignature: string } {
    const deviceText = deviceKeysSignedText(this.user.userId, this.user.deviceId, this.curve25519, this.signer.publicKey);
    return {
      publicKey: master.publicKey,
      deviceSignature: this.signer.sign(masterKeySignedText(this.user.userId, master.publicKey)),
      masterSignature: master.sign(deviceText),
    };
  }

  /** Upload the identity keys, then return this object. */
  async upload(server: TestServer): Promise<this> {
    const result = await apiFor(server, this.user).post("/keys/upload", { deviceKeys: this.deviceKeys });
    if (result.status !== 200) {
      throw new Error(`The key upload failed: ${JSON.stringify(result.body)}`);
    }
    return this;
  }
}

/** Make a guild as `owner` and let each member join it with an invite. Returns the guild id. */
export async function shareGuild(server: TestServer, owner: TestUser, members: TestUser[]): Promise<string> {
  const guild = (await apiFor(server, owner).post("/guilds", { name: "Keys guild" })).body;
  const textChannel = guild.channels.find((channel: { type: string }) => channel.type === "text");
  const invite = (await apiFor(server, owner).post(`/channels/${textChannel.id}/invites`, {})).body;
  for (const member of members) {
    await apiFor(server, member).post(`/invites/${invite.code}`);
  }
  return guild.id as string;
}
