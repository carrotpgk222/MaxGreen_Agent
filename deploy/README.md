# Deployment

The nginx site, the systemd unit and the HTTP Basic auth file live **outside the repository** on
the host. This directory is a verbatim, version-controlled copy of the first two so that a fresh
clone can be provisioned without guesswork.

| File here | Live path on the host |
| --- | --- |
| `nginx-maxgreen.conf` | `/etc/nginx/sites-enabled/maxgreen` |
| `maxgreen-backend.service` | `/etc/systemd/system/maxgreen-backend.service` |
| *(not stored)* | `/etc/nginx/auth/maxgreen.htpasswd` — mode `640 root:www-data` |
| *(not stored)* | `/var/www/certbot` — ACME webroot |
| *(not stored)* | `/var/log/nginx/maxgreen.{access,error}.log` |

The credential file is deliberately **not** committed. Only its mode and ownership are recorded here.

> **Host-specific paths.** `maxgreen-backend.service` hardcodes `/home/ubuntu/MaxGreen_Agent` in both
> `WorkingDirectory` and `ExecStart`, because systemd does not expand variables in `ExecStart`. If the
> repo lives elsewhere on a new host, edit those two lines before enabling the unit. The nginx
> `root` directive points at `frontend/` for the same reason.

## Re-syncing from the host

If you change either file on the server, copy it back so the repo stays authoritative:

```bash
cp /etc/nginx/sites-enabled/maxgreen            deploy/nginx-maxgreen.conf
cp /etc/systemd/system/maxgreen-backend.service deploy/maxgreen-backend.service
```

## Provisioning a new host

`install.sh` performs the steps below. It is **not** run automatically — review it before use. Run as
root or with sudo.

```bash
sudo bash deploy/install.sh
```

What it does, in order:

1. Installs `nginx`, `python3-venv`, `python3-pip` and `certbot` if missing.
2. Creates the venv and installs `backend/requirements.txt`.
3. Creates `/etc/nginx/auth/` and an htpasswd entry (prompts for the user and password).
4. Installs the nginx site and the systemd unit from this directory.
5. Enables and starts `maxgreen-backend.service`.
6. `nginx -t` then reloads nginx.

TLS is issued separately, because it needs the DNS name to already resolve:

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d 54-179-55-232.sslip.io
sudo systemctl enable --now certbot.timer
```

## Verifying a deployment

```bash
systemctl status maxgreen-backend.service
curl -s http://127.0.0.1:8000/api/health          # loopback only; bypasses nginx and basic auth
curl -sk -u USER:PASS https://54-179-55-232.sslip.io/api/health
ss -ltnp | grep -E ':80|:443|:8000'               # 8000 must be 127.0.0.1, never 0.0.0.0
sudo nginx -t
journalctl -u maxgreen-backend.service -n 50
```

**Upstream error detail is logged, not returned.** Since the exception-leak fix, `/api` responses
carry a short safe message and the full traceback goes to the journal:

```bash
journalctl -u maxgreen-backend.service -f
```

## Changing the hostname

The hostname `54-179-55-232.sslip.io` is baked into three places that must be changed together, or
the site will not load:

1. `deploy/nginx-maxgreen.conf` — `server_name` in both the `:80` and `:443` blocks, plus the two
   `ssl_certificate` paths and the `return 301`.
2. The Let's Encrypt certificate, reissued for the new name.
3. Nothing else — the frontend uses relative paths and `core/api.js` detects the host at runtime.
