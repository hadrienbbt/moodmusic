# Deployment

The deployment procedure for the Raspberry Pi is written in step 8 of
[PLAN.md](PLAN.md). This page starts with the facts it builds on.

## Spotify app (2026-09-23)

- Client ID `a3b5315e6cdd4583acfc54f639aeb020`, the V1 app, in Development
  Mode. The client secret was rotated on 2026-09-23 because the old one had
  leaked in V1's git history.
- Redirect URIs: `http://127.0.0.1:5173/auth/callback`,
  `http://127.0.0.1:8004/auth/callback`,
  `https://moodmusic-v2.fedutia.fr/auth/callback`, plus V1's
  `https://moodmusic.fedutia.fr/callback` until V1 is retired (step 10).
- Allow-list: Hadrien only. The beta testers (at most four more) must be
  added before step 9.

## Raspberry Pi (2026-09-23)

- `fedutia.fr` has wildcard DNS: every `*.fedutia.fr` name, including
  `moodmusic-v2.fedutia.fr`, resolves to the Pi (80.14.198.73). The
  certificate in `/etc/letsencrypt/live/fedutia.fr/` covers `*.fedutia.fr`
  and `fedutia.fr`.
- Node services: each one is a systemd unit that runs a start script from
  `/home/pi/.bin/` as root, serving https behind Apache.

  | Port | Unit | Site |
  |---|---|---|
  | 8001 | `moodmusic.service` (V1): `ExecStart=/home/pi/.bin/moodmusic`, `After=network.target apache2.service mongod.service`, code in `/home/pi/webserver/mood-music` | moodmusic.fedutia.fr |
  | 8002 | secret-santa | secret-santa.fedutia.fr |
  | 8003 | frek | frek.fedutia.fr |
  | 8004 | free: `moodmusic-v2.service` | moodmusic-v2.fedutia.fr |

  The existing servers listen on every interface; V2 listens on 127.0.0.1
  only.
- Apache: every site is a `<VirtualHost>` in
  `/etc/apache2/sites-available/000-default.conf`, enabled through the usual
  `sites-enabled` symlink (which `grep -r` does not follow). The port 80
  virtual host redirects everything to https, so V2 needs no port 80 block.
- Each Node site has `ProxyPreserveHost On`,
  `ProxyPass / https://localhost:800x/` and `ProxyPassReverse`,
  `SSLEngine on`, and `SSLProxyEngine on` with no other `SSLProxy*`
  directive. It also has the `fedutia.fr` certificate,
  `Include /etc/letsencrypt/options-ssl-apache.conf`,
  `SSLProtocol all -SSLv3 -TLSv1 -TLSv1.1` and `Protocols h2 http/1.1`.
  Its headers are `Referrer-Policy`, HSTS, `X-Frame-Options`,
  `X-Content-Type-Options` and `Access-Control-Allow-Origin "*"`.
- **The last virtual host of the file is a catch-all**: `ServerName fedutia.fr`,
  `ServerAlias *.fedutia.fr`, `RedirectPermanent / https://hadrienbbt.fr/`.
  Apache serves the first virtual host whose name matches. So the V2 block
  must be added to `000-default.conf` above the catch-all, like the other
  sites. A separate file enabled with `a2ensite` loads after
  `000-default.conf`, so it would never be reached.
- For V2's block (plan appendix E), proxy to `https://127.0.0.1:8004/`,
  because V2 only listens on loopback. Keep HSTS and drop
  `Access-Control-Allow-Origin "*"`, since V2 is same-origin (plan §4.3).
  Leave `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and the
  CSP to Node, so they are not sent twice.
