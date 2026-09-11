# Mail clients

LabMail speaks SMTP submission and IMAP, so a member can use Thunderbird,
Apple Mail, Outlook or a phone with the address and password they already have.
Both protocols sit in front of the same per-member view the web interface reads,
so a flag set in a client means the same thing in a browser, and a message sent
from either goes out the same way.

```
  mail client ──993/465, TLS──▶ nginx ──PROXY, plaintext──▶ LabMail ──▶ Gmail
```

## What LabMail listens on

Plaintext, and never on a public interface. TLS belongs to whatever publishes
993 and 465.

```
SMTP_PORT=10587
IMAP_PORT=10143
SMTP_HOST=0.0.0.0          # inside the container
IMAP_HOST=0.0.0.0
SMTP_PROXY_PROTOCOL=true
IMAP_PROXY_PROTOCOL=true
MAIL_BIND=127.0.0.1        # interface the host publishes them on
```

`MAIL_BIND` decides who can reach the plaintext ports and is the setting most
likely to be wrong:

| Where nginx runs | `MAIL_BIND` |
|---|---|
| This host | `127.0.0.1` |
| Another machine on the LAN | this host's LAN address, e.g. `10.20.0.21` |

Loopback is the default. It is also unreachable from another machine, so an
nginx elsewhere gets connection refused with nothing in either log to say why.

Never set it to an address the internet can reach. There is no TLS on these
ports.

## nginx

The `stream` module terminates TLS and forwards the connection untouched. It
is a plain TCP proxy: it does not speak IMAP or SMTP and does not need to.

`stream` sits at the top level of `nginx.conf`, beside `http` rather than
inside it. An `include` loaded from within `http` is ignored.

```nginx
stream {
    server {                          # IMAPS
        listen 993 ssl;
        listen [::]:993 ssl;

        ssl_certificate     /etc/letsencrypt/live/mail.example.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/mail.example.com/privkey.pem;
        ssl_protocols       TLSv1.2 TLSv1.3;

        proxy_pass            10.20.0.21:10143;
        proxy_protocol        on;
        proxy_timeout         1h;     # IMAP IDLE holds the connection open
        proxy_connect_timeout 5s;
    }

    server {                          # SMTPS, submission
        listen 465 ssl;
        listen [::]:465 ssl;

        ssl_certificate     /etc/letsencrypt/live/mail.example.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/mail.example.com/privkey.pem;
        ssl_protocols       TLSv1.2 TLSv1.3;

        proxy_pass            10.20.0.21:10587;
        proxy_protocol        on;
        proxy_timeout         5m;
        proxy_connect_timeout 5s;
    }
}
```

Requires nginx built `--with-stream --with-stream_ssl_module`; check with
`nginx -V`. On Debian and Ubuntu that means `nginx-full` or `nginx-extras`.

### Implicit TLS only, not STARTTLS

993 and 465 are encrypted from the first byte, which is what a TCP proxy can
terminate. STARTTLS begins in plaintext and switches inside the protocol, so a
proxy that does not speak the protocol cannot do it. Every current client
supports the implicit form, and it leaves no plaintext window at all.

nginx's `mail` module does handle STARTTLS, but it is an authenticating proxy
rather than a TLS terminator: it performs the login itself and asks an HTTP
endpoint where to send the connection. That endpoint would have to be built,
and it buys nothing once 993 and 465 are open.

### `proxy_protocol` is not optional

Without it every session appears to come from the proxy. The per-address
sign-in throttle collapses into one bucket that every member shares, and the
audit log records the proxy's address for every connection.

`SMTP_PROXY_PROTOCOL` and `IMAP_PROXY_PROTOCOL` declare that the header is
expected. Declared rather than sniffed: SMTP begins with the server speaking,
and a server waiting to find out whether a header is coming cannot greet.

A connection that arrives without one is closed, and says so once a minute:

```
[imap] connection from 10.20.0.21 closed: expected a PROXY protocol header.
       Set "proxy_protocol on" on the proxy, or unset IMAP_PROXY_PROTOCOL.
```

The client's own report is far less clear — TLS completes, the greeting never
arrives, and the client says only that it could not sign in.

## Checking it works

From anywhere that can reach the public ports:

```bash
python3 - <<'EOF'
import socket, ssl
for port in (993, 465):
    ctx = ssl.create_default_context()
    with ctx.wrap_socket(socket.create_connection(('mail.example.com', port), 6),
                         server_hostname='mail.example.com') as s:
        s.settimeout(6)
        print(port, s.recv(200).decode(errors='replace').strip())
EOF
```

Expected:

```
993 * OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SPECIAL-USE IDLE UIDPLUS MOVE] LabMail ready
465 220 LabMail submission
```

`openssl s_client` works too, but its buffering hides a greeting that did
arrive; a silent result there is not evidence of a problem.

| Symptom | Cause |
|---|---|
| Connection refused on 993 | nginx is not listening, or `stream` is nested inside `http` |
| TLS completes, no greeting | `proxy_protocol` missing, or `MAIL_BIND` unreachable from nginx |
| Greeting arrives, sign-in fails | credentials — see app passwords below |

`MAIL_TRACE=true` logs the exchange with credentials redacted. Leave it off in
normal operation.

## What members enter

Under **My settings → Mail clients**, each member creates a password per
device and finds the per-client instructions with the server values already
filled in. Those values come from system settings:

```
Mail client server   mail.example.com
IMAP port            993
SMTP port            465
```

Until the address is set, the instructions say so rather than guess.

## App passwords

A mail client keeps its password on disk and sends it on every connection, so
it does not get the sign-in password. Members create one per device; the first
one they create takes the sign-in password out of the mail path entirely.
Members who have created none keep using it, so nothing breaks before there is
somewhere to move to.

Losing a device costs one entry. The last-used column says which.

## What clients can do

Read, search, flag, move, delete, and send. Writes go through the same path the
web interface uses, so nothing behaves differently depending on where it was
done — including the rule that clears Gmail's shared `UNREAD` only once every
owner of a message has read it.

Sending is refused for an address with no send-as entry, exactly as the web
composer refuses it. The client reports `550 5.7.1`.

`IDLE` is supported, so new mail reaches a client on the sync tick that
attributes it rather than on the client's next poll.
