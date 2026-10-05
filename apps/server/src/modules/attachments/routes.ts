// Encrypted attachment routes: upload, download, claim and delete. The body of an
// upload is raw ciphertext (application/octet-stream). It streams to disk.
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../app.js";
import { AppError } from "../../errors.js";
import { parseId } from "../../id.js";
import { checkRate } from "../keys/routes.js";
import { createEventRateLimiter } from "../messages/service.js";
import { claimAttachment, deleteAttachment, openAttachment, uploadAttachment } from "./service.js";

const UPLOADS_PER_MINUTE = 60;

export async function registerAttachmentRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const limiter = createEventRateLimiter(UPLOADS_PER_MINUTE, 60_000);
  const limits = { maxBytes: deps.config.maxAttachmentBytes, quotaBytes: deps.config.attachmentQuotaBytes };

  // Give the handler the request stream. Nothing reads the body before the handler does.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  app.post("/channels/:id/attachments", { preHandler: app.authenticate }, async (request, reply) => {
    const channelId = parseId((request.params as { id: string }).id);
    const { userId } = request.auth!;
    checkRate(limiter, userId);
    if (!request.headers["content-type"]?.startsWith("application/octet-stream")) {
      throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the file as application/octet-stream.");
    }
    const length = Number(request.headers["content-length"] ?? Number.NaN);
    const result = await uploadAttachment(
      deps.db,
      deps.config.dataDir,
      limits,
      channelId,
      userId,
      length,
      request.body as Readable,
    );
    return reply.status(201).send(result);
  });

  app.get("/attachments/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    const { size, stream } = await openAttachment(deps.db, deps.config.dataDir, id, request.auth!.userId);
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", size)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("X-Content-Type-Options", "nosniff")
      .send(stream);
  });

  app.post("/attachments/:id/claim", { preHandler: app.authenticate }, async (request, reply) => {
    await claimAttachment(deps.db, parseId((request.params as { id: string }).id), request.auth!.userId);
    return reply.status(204).send();
  });

  app.delete("/attachments/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    await deleteAttachment(deps.db, deps.config.dataDir, id, request.auth!.userId);
    return reply.status(204).send();
  });
}
