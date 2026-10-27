#!/usr/bin/env python3
"""Serve the synthetic mock host and its UI on loopback, with representative CSP."""
import argparse
import functools
import http.server
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.split('?', 1)[0] == '/ui/file-browser.html':
            # Representative strict sandbox, not a claim about ChatGPT's exact CSP.
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'")
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    handler = functools.partial(Handler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    print(f'Synthetic test host: http://127.0.0.1:{server.server_port}/testing/mock-host.html', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
