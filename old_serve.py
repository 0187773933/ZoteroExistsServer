#!/usr/bin/env python3
import json
import sqlite3
import shutil
import re
import unicodedata
from pprint import pprint
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ZOTERO_DB = Path("/Users/morpheous/Zotero/zotero.sqlite")
HOST = "127.0.0.1"
PORT = 9371

def open_snapshot():
	tmpdir = Path(tempfile.mkdtemp(prefix="zotero_db_"))
	snap = tmpdir / "zotero.sqlite"
	shutil.copy2(ZOTERO_DB, snap)
	return sqlite3.connect(str(snap))

def normalize_title(s: str) -> str:
	if not s:
		return ""

	# unicode normalize
	s = unicodedata.normalize("NFKD", s)

	# lowercase
	s = s.lower()

	# remove punctuation
	s = re.sub(r"[^\w\s]", " ", s)

	# collapse whitespace
	s = re.sub(r"\s+", " ", s).strip()

	return s

class Handler(BaseHTTPRequestHandler):
	def do_POST(self):
		if self.path != "/exists":
			self.send_error(404)
			return

		try:
			length = int(self.headers.get("Content-Length", 0))
			body = json.loads(self.rfile.read(length))
			queries = body.get("queries", [])
			results = []

			db = open_snapshot()
			cur = db.cursor()

			for q in queries:
				exists = False

				# DOI exact match
				if q.get("doi"):
					cur.execute(
						"SELECT 1 FROM itemDataValues WHERE value = ? LIMIT 1",
						(q["doi"],),
					)
					exists = cur.fetchone() is not None

				# Title fallback (prefix heuristic)
				if not exists and q.get("title"):

					query_norm = normalize_title(q["title"])
					# print("QUERY:", query_norm)

					cur.execute("SELECT value FROM itemDataValues")
					for (db_title,) in cur.fetchall():

						db_norm = normalize_title(db_title)

						if db_norm == query_norm:
							exists = True
							break

				results.append({
					"id": q.get("id"),
					"exists": exists
				})

			db.close()

			resp = json.dumps({"results": results}).encode()
			self.send_response(200)
			self.send_header("Content-Type", "application/json")
			self.send_header("Content-Length", str(len(resp)))
			self.end_headers()
			self.wfile.write(resp)

			print(f"✔ served {len(results)} queries")

		except Exception as e:
			err = json.dumps({
				"results": [],
				"error": str(e)
			}).encode()

			self.send_response(500)
			self.send_header("Content-Type", "application/json")
			self.send_header("Content-Length", str(len(err)))
			self.end_headers()
			self.wfile.write(err)

			print("✖ server error:", e)

	def log_message(self, *_):
		return


if __name__ == "__main__":
	print(f"Zotero exists server running on http://{HOST}:{PORT}")
	HTTPServer((HOST, PORT), Handler).serve_forever()
