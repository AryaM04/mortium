# Deploy the server on a home machine

This guide shows how to run the full stack on a home machine. The stack
has a web server with automatic HTTPS (Caddy), the API, PostgreSQL, a TURN
server (coturn), and a nightly backup. One command starts all of it.
To run the stack behind a Cloudflare Tunnel, see step 13.

## 1. What you need

- A computer that runs all day. Use Linux. Docker Desktop (Windows and
  macOS) is for tests only, because the TURN server needs the Linux host
  network.
- 2 CPU cores, 2 GB of RAM and 20 GB of free disk space. The stack uses
  about 150 MB of RAM when no user is active.
- A second disk or a network share for the backup files (recommended).
- A domain name, or a free dynamic DNS name (see step 4).
- Access to the settings of your router.
- An SMTP account to send account email (verification and password reset).

## 2. Install Docker on Linux

1. Install Docker Engine and the Compose plugin. Follow the official guide
   for your distribution: `https://docs.docker.com/engine/install/`.
2. Add your user to the `docker` group: `sudo usermod -aG docker $USER`.
3. Log out and log in again.
4. Check the install: `docker compose version`.
5. Install Git: `sudo apt install git`.

## 3. Get the code and make the settings file

1. Get the code: `git clone <repository URL> mortium`.
2. Go into the folder: `cd mortium`.
3. Make the `.env` file with random secrets: `node scripts/generate-secrets.mjs`.
   If Node.js is not installed, use Docker instead:
   `docker run --rm -v "$PWD":/work -w /work node:24-alpine node scripts/generate-secrets.mjs`.
4. Open the `.env` file. Set these values:
   - `DOMAIN`: your domain name, for example `chat.example.com`.
   - `ACME_EMAIL`: your email address for the certificate.
   - `TURN_EXTERNAL_IP`: your public IP address and the LAN address of the
     server, in this form: `203.0.113.7/192.168.1.20`. The TURN server
     relays only on the LAN address.
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`.
   - `BACKUP_DIR`: a folder on the backup disk (see step 9).
   - `BACKUP_AGE_RECIPIENT` (optional): a public key to encrypt the backups (see step 9).
   - `CORS_ALLOWED_ORIGINS`: see step 8.
5. Keep the `.env` file secret. Do not commit it. Only your user must
   read it: `chmod 600 .env`. The script above makes the file with these
   rights.

The stack sets the other values itself. The end of `.env.example` lists them.

## 4. DNS

The domain must point to the public IP address of your home network.

- If your IP address does not change: make an `A` record for `DOMAIN` with
  your public IP address.
- If your IP address changes: use dynamic DNS.
  - Cloudflare: make an `A` record for `DOMAIN` with any value. Make an API
    token with the permission "Zone - DNS - Edit". Put it in
    `CLOUDFLARE_API_TOKEN`. Set `COMPOSE_PROFILES=ddns` in `.env`.
  - DuckDNS: make a name at `duckdns.org`. Put the name in
    `DUCKDNS_SUBDOMAIN` and the token in `DUCKDNS_TOKEN`. Set
    `COMPOSE_PROFILES=ddns-duckdns` in `.env`. Set `DOMAIN` to the full
    `<name>.duckdns.org` name.

The TURN server needs the public IP address in `TURN_EXTERNAL_IP`. If your
public IP address changes, change this value and run `docker compose up -d`
again.

## 5. Router and firewall

Check for CGNAT first. Open the status page of your router and read the
WAN IP address. Then compare it with the result of `https://ifconfig.me`.
If the two addresses are different, or the WAN address starts with `100.64`
to `100.127`, your provider uses CGNAT. Port forwarding does not work with
CGNAT. Ask your provider for a public IP address, or use a VPS instead.

Give the server a fixed LAN address (a DHCP reservation). Then make these
port forwards to the LAN address of the server:

| Port | Protocol | Use |
| --- | --- | --- |
| 80 | TCP | Certificate request (Let's Encrypt) and redirect to HTTPS |
| 443 | TCP and UDP | The web app, the API and the gateway |
| 3478 | UDP and TCP | TURN |
| 5349 | TCP | TURN over TLS |
| 40000-40099 | UDP | TURN relay ports |

If you change `TURN_RELAY_MIN_PORT` or `TURN_RELAY_MAX_PORT` in `.env`,
forward the new range. Keep the range below 49152. Each user in a relayed
call needs about 10 ports.

If the host has a firewall, open the same ports. On Ubuntu with ufw, run
these commands:

```
sudo ufw allow 80,443,3478,5349/tcp
sudo ufw allow 443,3478/udp
sudo ufw allow 40000:40099/udp
```

## 6. First start

1. Start the stack: `docker compose up -d --build`.
   The first build takes several minutes.
2. Check that all services run: `docker compose ps`.
3. Wait one minute. Then open `https://<DOMAIN>` in a browser. Caddy gets
   the certificate on the first request.
4. Click "Register" and make the first account. The server sends a
   verification email. Open the link in the email.
5. Turn on TURN over TLS. The certificate file now exists. Set
   `TURN_TLS_ENABLED=true` in `.env`. Then run `docker compose up -d` and
   `docker compose restart coturn`. coturn finds the new certificate itself
   in one hour, but the restart makes it use the certificate now.

The first account has no special rights. Use it to make a server (guild)
and to invite your friends.

## 7. Updates

1. Go into the folder of the stack.
2. Get the new code: `git pull`.
3. Build and restart: `docker compose up -d --build`.
4. Remove old images: `docker image prune -f`.

The API runs the database migrations when it starts. Make a backup before
a large update (see step 9).

### Automatic updates (Linux)

`scripts/auto-deploy.sh` does steps 2 to 4 when a new commit is on the
main branch of GitHub and CI passed on it. Cron starts it every 2 minutes.
The script needs `git`, `curl` and `flock`. Ubuntu and Debian have them.

1. Set `DEPLOY_REPO` in `.env`, for example `DEPLOY_REPO=owner/mortium`.
2. Open the cron table: `crontab -e`.
3. Add this line, with the full path of the stack folder:

   ```
   */2 * * * * /home/<user>/mortium/scripts/auto-deploy.sh
   ```

The script writes one line for each deploy to `.deploy/deploy.log`, and
the build output of the last deploy to `.deploy/last-deploy.log`. It keeps
the last commit that built correctly in `.deploy/deployed`, and deploys
when the main branch has a different commit. The first run has no
`.deploy/deployed` file, so it builds the current commit one time.

When the deploy of a commit fails, the stack stays on the old containers:

- When CI fails, the script does not try that commit again.
- When the build fails, the next run tries the build again one time. After
  a second failure, the script does not try that commit again.
- When the merge cannot fast-forward, the script does not try that commit
  again.

In each of these cases, the script writes the commit to `.deploy/skip`. The
next commit on main starts a new deploy. To try the same commit again,
remove `.deploy/skip`.

CAUTION: The script only fast-forwards. Do not change tracked files in the
stack folder, or the deploy stops. Keep host values in `.env`.

Caddy renews the certificate about every 60 days. coturn needs no manual
step: each hour, `infra/coturn/start.sh` compares the certificate files.
When they changed, it sends the signal SIGUSR2 to coturn, and coturn reads
the new files. No service has access to the Docker socket.

## 8. Desktop apps

The desktop apps open the server from a different origin. Add the origins to
`CORS_ALLOWED_ORIGINS` in `.env`, separated by commas:

```
CORS_ALLOWED_ORIGINS=app://mortium,http://tauri.localhost,tauri://localhost
```

- `app://mortium`: the Linux app (Electron).
- `http://tauri.localhost`: the Windows app (Tauri).
- `tauri://localhost`: the macOS app (Tauri).

Run `docker compose up -d` to apply the change. In the desktop app, enter
`https://<DOMAIN>` as the server address.

## 9. Backups and restore

The `backup` service starts a backup each day at `BACKUP_HOUR` (UTC). It
runs as the user with the ID 100 (the user of the API). On Linux, this user
must be able to write to `BACKUP_DIR`. Do these steps one time:

```
mkdir -p /path/to/backups
sudo chown 100:101 /path/to/backups
```

If the folder is not writable, the backup log tells you the command.

Each backup makes two files in `BACKUP_DIR`:

- `db-<date>-<time>.dump`: the database (PostgreSQL custom format, compressed).
- `data-<date>-<time>.tar.gz`: the data files (avatars, icons and attachments).

The service keeps the files of the last `BACKUP_KEEP_DAYS` days (default 14).
To make a backup now: `docker compose run --rm backup once`.

Copy the files in `BACKUP_DIR` to a second place, for example a cloud
drive. A backup on the same disk does not help when the disk fails.

### Encrypt the backups (optional)

The messages and the attachments are encrypted end to end. But the backup
also has the email addresses, the password hashes and the user names in
plain form. Encrypt the backups before you copy them to a cloud drive:

1. On a different computer, install `age` (`https://age-encryption.org`).
2. Make a key pair: `age-keygen -o backup-key.txt`. The command shows the
   public key. It starts with `age1`.
3. Keep `backup-key.txt` safe, and not on the server. Without this file,
   you cannot restore the backups.
4. Put the public key in `.env`: `BACKUP_AGE_RECIPIENT=age1...`.
5. Run `docker compose up -d`.

The backup files then have the extension `.age`. To restore one, decrypt
it first. Then copy the result into `BACKUP_DIR`:

```
age --decrypt -i backup-key.txt -o db-20260930-030000.dump db-20260930-030000.dump.age
age --decrypt -i backup-key.txt -o data-20260930-030000.tar.gz data-20260930-030000.tar.gz.age
```

WARNING: A restore replaces the current database and data files.

To restore, use the file names from `BACKUP_DIR`:

- Linux and macOS: `sh infra/scripts/restore.sh db-20260930-030000.dump data-20260930-030000.tar.gz`
- Windows (PowerShell): `./infra/scripts/restore.ps1 db-20260930-030000.dump data-20260930-030000.tar.gz`

The script starts the database, stops the API, restores the files, and
starts the stack again. The data file is optional.

### Restore test

Do this test after you set up the stack, and again each few months. A
backup that you did not test can be useless.

1. Make a backup: `docker compose run --rm backup once`.
2. Count the users: `docker compose exec postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "select count(*) from users"'`.
3. Delete all the volumes: `docker compose down -v`.
4. Restore with the two newest files (see above).
5. Count the users again. The two numbers must be the same.
6. Open the web app and sign in.

Step 3 also deletes the certificate. Caddy gets a new one. Let's Encrypt
limits the number of new certificates, so do not repeat this test often on a
real domain. For a test with no limit, use a different `.env` with
`DOMAIN=localhost` and `TLS_MODE=internal`.

## 10. Hairpin NAT (access from the home network)

Some routers cannot send traffic from the LAN to their own public address
(hairpin NAT). Then `https://<DOMAIN>` does not open on the home network.
To fix it, make a local DNS override so that devices on the LAN resolve
`DOMAIN` to the LAN address of the server. Use the DNS settings of your
router, or a Pi-hole. Calls between two devices on the same LAN still work,
because the peers connect directly.

## 11. Security notes

See `docs/security-review.md` for the full review.

- The TURN server refuses peer addresses in private ranges. This means that
  nobody can use it to reach your home network. The one exception is the
  LAN address of the server itself: two peers that both use the relay need
  it. A call between two devices on the same LAN uses a direct connection.
- PostgreSQL and the API have no published port. Only Caddy is open to the
  internet for HTTP.
- The services run without root rights (the DuckDNS service is the one
  exception), with no Linux capabilities, and with a read-only file system
  where possible.
- Do not forward any other port.

### Harden the host

Do these steps on the Linux host.

1. Turn on automatic security updates. On Ubuntu and Debian:
   `sudo apt install unattended-upgrades`, then
   `sudo dpkg-reconfigure -plow unattended-upgrades`.
2. Use SSH keys only. In `/etc/ssh/sshd_config`, set
   `PasswordAuthentication no` and `PermitRootLogin no`. Then run
   `sudo systemctl restart ssh`. Do not forward the SSH port on the router.
3. Turn on the firewall. Allow SSH from the LAN only, and the ports of step 5:

   ```
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
   sudo ufw allow 80,443,3478,5349/tcp
   sudo ufw allow 443,3478/udp
   sudo ufw allow 40000:40099/udp
   sudo ufw enable
   ```

   Use the address range of your LAN in the SSH rule. Docker writes its own
   firewall rules for the published ports (80 and 443), and ufw does not
   control them. coturn uses the host network, so the ufw rules apply to it.
4. Optional: install fail2ban for SSH: `sudo apt install fail2ban`. The
   default settings protect SSH.
5. Limit the Docker logs. The stack limits the log of each service to
   3 files of 10 MB. To set the same limit for all containers, put this
   text in `/etc/docker/daemon.json`, then run `sudo systemctl restart docker`:

   ```
   { "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
   ```

### Change a secret

- `TURN_SECRET`: put a new random value in `.env` (`openssl rand -hex 32`).
  Then run `docker compose up -d`. The API and coturn restart with the new
  value. The TURN credentials of the clients are valid for a short time
  only, so a call in progress can lose the relay. The clients get new
  credentials when they join a call again.
- `JWT_SECRET`: change it the same way. All users must then sign in again.
- `POSTGRES_PASSWORD`: first change the password in the database:
  `docker compose exec postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB> -c "ALTER USER <POSTGRES_USER> PASSWORD '<new password>'"`.
  Then put the same value in `.env` and run `docker compose up -d`.

### Update from an older version of the stack

Older versions ran Caddy as root. Caddy now runs as the user with the ID
10001. If the stack already ran before, give the Caddy volumes to this user
one time. Then start the stack:

```
docker compose run --rm --no-deps --user 0 --cap-add CHOWN --cap-add FOWNER --entrypoint chown caddy -R 10001:10001 /data /config
docker compose up -d --build
```

### Update a database from before the key tables changed

The database migration `0008_m6_keys_and_to_device` adds required columns
to the key tables. On a database that has rows in these tables from before
this migration, the migration fails, and the API does not start. A new
database, or a database that already has this migration, needs no step.

1. Show the number of migrations that the database has:
   `docker compose exec postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "select count(*) from drizzle.__drizzle_migrations"'`.
2. If the number is 9 or more, stop here. This step is not necessary.
3. Delete the old key rows. Clients cannot use these rows, and the devices
   upload new keys when they start:
   `docker compose exec postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "delete from cross_signing_keys; delete from fallback_keys; delete from one_time_keys; delete from to_device_queue;"'`.
4. Start the stack: `docker compose up -d --build`.

## 12. Troubleshooting

Show the logs of a service: `docker compose logs --tail 100 <service>`.
The service names are `caddy`, `api`, `postgres`, `coturn` and `backup`.

**All services restart, and the log shows `exec ...: operation not permitted`.**
Docker from the Ubuntu snap package causes this. It cannot start a container with the `no-new-privileges` flag.
To make sure, run `docker run --rm --security-opt no-new-privileges:true alpine true`.
If this command fails too, set `NO_NEW_PRIVILEGES=false` in `.env`, then run `docker compose up -d`.
The containers still run without root, without capabilities and with read-only files.
For full protection, install Docker from the Docker apt repository instead of the snap package.
To see the user of a service, run `docker compose exec <service> id`.

- **No certificate.** Check that ports 80 and 443 reach the server from the
  internet, and that the DNS record points to your public IP address. Read
  `docker compose logs caddy`. Let's Encrypt limits failed attempts, so fix
  the problem before you try again.
- **The API does not start.** Read `docker compose logs api`. A wrong or
  missing value in `.env` gives a clear error message.
- **WebSocket check.** Open the web app, then the browser developer tools
  and the Network tab. Filter by "WS". The `/gateway` request must have the
  status 101. Or run this command:
  `curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://<DOMAIN>" https://<DOMAIN>/gateway`.
  The first line of the answer must be `HTTP/1.1 101`.
- **TURN check.** Sign in, then get TURN credentials from
  `GET /api/v1/voice/turn-credentials` (see `docs/concepts/nat-turn.md`).
  Put the URL, the user name and the password in a public tester, for
  example the "Trickle ICE" page at
  `https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/`.
  Use the URL `turn:<DOMAIN>:3478`. The result must have a candidate of the
  type `relay`. If it has none, check the port forwards for 3478 and the
  relay range, and check `TURN_EXTERNAL_IP`.
- **Calls do not connect between different networks.** Do the TURN check
  above. Check CGNAT (step 5).
- **The site does not open on the home network.** See step 10.
- **Disk space.** Run `docker system df`. Run `docker image prune -f`.

## 13. Deploy behind a Cloudflare Tunnel

Use this mode when a different web server already uses ports 80 and 443
on the host, or when you cannot forward these ports. A `cloudflared`
tunnel on the host sends the web traffic to Caddy. Cloudflare serves
HTTPS, so Caddy gets no certificate. The direct mode of steps 4 to 6 stays
the default.

A Cloudflare tunnel or proxy cannot carry TURN. TURN uses its own DNS-only
name, and the router forwards the TURN ports to the host. This mode has no
TURN over TLS, because the host has no public certificate.

The example below uses these values. Change them for your server:

| Item | Value |
| --- | --- |
| Web address | `mortium.example.com` (through the tunnel) |
| TURN name | `turn.example.com` (DNS only) |
| TURN port | 3479 (a different service uses 3478) |
| Relay ports | 40000-40099 |
| Local Caddy port | `127.0.0.1:8480` |

### Settings

Do steps 1 to 3 first. Then set these values in `.env`:

```
PROXY_MODE=cloudflare-tunnel
HTTP_BIND=127.0.0.1:8480
DOMAIN=mortium.example.com
TURN_PORT=3479
TURN_PUBLIC_HOST=turn.example.com
TURN_TLS_ENABLED=false
TURN_RELAY_MIN_PORT=40000
TURN_RELAY_MAX_PORT=40099
TURN_EXTERNAL_IP=<PUBLIC_IP>/<LAN_IP>
```

- Keep `HTTP_BIND` on `127.0.0.1`. Caddy trusts the client address in the
  `CF-Connecting-IP` header. Only a process on the host (cloudflared) can
  open a port on `127.0.0.1`, so a client on the internet cannot send a
  false address. The API rate limits then apply to each real user.
- Tunnel mode does not use `ACME_EMAIL` and `TLS_MODE`.
- Keep `MAX_ATTACHMENT_BYTES` below 100 MB. The Cloudflare free plan
  refuses a request body larger than 100 MB. The default (25 MiB) is
  correct.

### Start

Start the stack with the same command as in direct mode:
`docker compose up -d --build`. Caddy then listens only on
`127.0.0.1:8480`. The stack does not use ports 80, 443 and 3478 of the
host.

### Tunnel public hostname

Add one public hostname to the tunnel. It sends `mortium.example.com` to
`http://localhost:8480`.

- Tunnel managed in the Cloudflare dashboard: open Zero Trust, then
  Networks, then Tunnels. Select the tunnel and open "Public Hostname".
  Add a hostname: subdomain `mortium`, domain `example.com`, type
  `HTTP`, URL `localhost:8480`. Cloudflare makes the DNS record.
- Tunnel with a local `config.yml`: add this rule above the last rule (the
  rule without a hostname):

  ```
  ingress:
    - hostname: mortium.example.com
      service: http://localhost:8480
    # ... other rules ...
    - service: http_status:404
  ```

  Then make the DNS record and start cloudflared again:

  ```
  cloudflared tunnel route dns <TUNNEL_NAME> mortium.example.com
  sudo systemctl restart cloudflared
  ```

In the Cloudflare dashboard of the zone, keep "WebSockets" on (Network
settings). Turn off "Rocket Loader": it changes the scripts, and the
Content-Security-Policy then blocks them.

### DNS for TURN

Make an `A` record `turn` (`turn.example.com`) with the public IP address
of the home network. Set the proxy status to "DNS only" (grey cloud). If
your public IP address changes, use dynamic DNS for this name (see step 4)
and change `TURN_EXTERNAL_IP`.

### Router and firewall

Forward these ports to the LAN address of the server. Do not forward 80
and 443 for Mortium: the tunnel needs no open port.

| Port | Protocol | Use |
| --- | --- | --- |
| 3479 | UDP and TCP | TURN |
| 40000-40099 | UDP | TURN relay ports |

If the host uses ufw, run these commands:

```
sudo ufw allow 3479
sudo ufw allow 40000:40099/udp
```

### Check list

1. Health: `curl http://127.0.0.1:8480/api/v1/health` on the host, and
   `curl https://mortium.example.com/api/v1/health` from a different
   network. Both must give `{"status":"ok"}`.
2. Web app: open `https://mortium.example.com`. Register and sign in.
3. WebSocket: do the WebSocket check of step 12 with
   `DOMAIN=mortium.example.com`. The status must be 101. The gateway
   sends a heartbeat each 30 seconds, so the Cloudflare idle limit (100
   seconds) does not close the connection.
4. Client address: run `docker compose logs --tail 20 api`. The
   `remoteAddress` values must be public IP addresses of the users, not
   `172.x.x.x` addresses.
5. TURN: do the TURN check of step 12 with the URL
   `turn:turn.example.com:3479`. The result must have a candidate of the
   type `relay`.
