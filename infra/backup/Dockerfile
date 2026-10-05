# The image of the backup service: the PostgreSQL client tools of the
# database image, and "age" for the optional encryption of the backup files.
# Build it from the repository root: docker build -f infra/backup/Dockerfile .
FROM postgres:16-alpine
# Docker fills a new, empty volume from the image. Thus a restore on a new
# host makes the data volume with the owner of the API user (100:101).
RUN apk add --no-cache age && mkdir -p /data && chown 100:101 /data
COPY infra/scripts/backup.sh /usr/local/bin/backup.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/backup.sh"]
CMD ["loop"]
