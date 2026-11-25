"""Plugin files must be revalidated by content, because package builds give every file the same date."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from owrx.controllers.assets import AssetsController


class Handler:
    def __init__(self, headers=None):
        self.headers = headers or {}
        self.status = None
        self.sent = {}
        self.body = b""
        self.wfile = SimpleNamespace(write=self.write)

    def send_response(self, code): self.status = code
    def send_header(self, key, value): self.sent[key] = value
    def end_headers(self): pass

    def write(self, data):
        self.body += data
        return len(data)


class CacheTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        (self.root / "plugins/receiver/demo").mkdir(parents=True)
        (self.root / "css").mkdir()
        self.plugin = self.root / "plugins/receiver/demo/demo.js"
        self.style = self.root / "css/site.css"
        self.plugin.write_text("console.log(1);")
        self.style.write_text("body{}")
        # Every file carries the same, old date, as after a package build.
        for path in (self.plugin, self.style):
            os.utime(path, (1700000000, 1700000000))

    def get(self, file, headers=None):
        root = self.root

        class Assets(AssetsController):
            def getFilePath(self, name): return str(root / name)

        handler = Handler(headers)
        Assets(handler, SimpleNamespace(headers={}, matches=None), {}).serve_file(file)
        return handler

    def test_plugin_is_served_with_a_content_tag_and_no_hour_long_cache(self):
        reply = self.get("plugins/receiver/demo/demo.js")
        self.assertEqual((reply.status, reply.body), (200, b"console.log(1);"))
        self.assertEqual(reply.sent["Cache-Control"], "max-age=0")
        self.assertRegex(reply.sent["ETag"], r'^"[0-9a-f]{40}"$')
        self.assertNotIn("Last-Modified", reply.sent)

    def test_unchanged_plugin_is_not_resent(self):
        tag = self.get("plugins/receiver/demo/demo.js").sent["ETag"]
        for offered in (tag, "W/" + tag, '"other", ' + tag):
            reply = self.get("plugins/receiver/demo/demo.js", {"If-None-Match": offered})
            self.assertEqual((reply.status, reply.body), (304, b""), offered)

    def test_updated_plugin_with_the_same_date_is_resent(self):
        tag = self.get("plugins/receiver/demo/demo.js").sent["ETag"]
        self.plugin.write_text("console.log(2);")
        os.utime(self.plugin, (1700000000, 1700000000))
        # What a browser holding the old copy sends, with and without a tag.
        for headers in ({"If-None-Match": tag}, {"If-Modified-Since": "Tue, 14 Nov 2023 22:13:20 GMT"},
                        {"If-None-Match": tag, "If-Modified-Since": "Tue, 14 Nov 2023 22:13:20 GMT"}):
            reply = self.get("plugins/receiver/demo/demo.js", headers)
            self.assertEqual((reply.status, reply.body), (200, b"console.log(2);"), headers)
            self.assertNotEqual(reply.sent["ETag"], tag)

    def test_other_assets_keep_the_stock_behaviour(self):
        reply = self.get("css/site.css")
        self.assertEqual((reply.status, reply.sent["Cache-Control"]), (200, "max-age=3600"))
        self.assertIn("Last-Modified", reply.sent)
        self.assertNotIn("ETag", reply.sent)
        reply = self.get("css/site.css", {"If-Modified-Since": "Tue, 14 Nov 2023 22:13:20 GMT"})
        self.assertEqual(reply.status, 304)

    def test_missing_plugin_is_a_404(self):
        self.assertEqual(self.get("plugins/receiver/none/none.js").status, 404)


if __name__ == "__main__":
    unittest.main()
