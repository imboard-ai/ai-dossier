"""proxpi, requesting canonical simple-index URLs (#1010).

proxpi asks the upstream index for ``/simple/<name>`` without the trailing slash.
PyPI answers that with a redirect to ``/simple/<name>/``, and the egress policy
(ztfc-proxy-policy-v1) admits no redirects at all. Appending the slash before the
request leaves keeps the policy at zero redirects instead of widening it. Nothing
else about proxpi changes; it is started exactly as its image does, with this
module as the application.
"""
import re

from proxpi import _cache

_UNSLASHED = re.compile(r"https://pypi\.org/simple/[A-Za-z0-9._-]+")
_send = _cache.Session.send


def _send_canonical(self, request, **kwargs):
    if _UNSLASHED.fullmatch(request.url or ""):
        request.url += "/"
    return _send(self, request, **kwargs)


_cache.Session.send = _send_canonical

from proxpi.server import app  # noqa: E402,F401
