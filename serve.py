#!/usr/bin/env python3
import argparse
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
import unicodedata
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import Dict, List, Optional, Set, Tuple

# ============================================================
# Normalization
# ============================================================

_DOI_RE = re.compile(r"(10\.\d{4,9}/[^\s\"<>]+)", re.IGNORECASE)


def normalize_title(s: str) -> str:
	if not s:
		return ""

	# unicode normalization
	s = unicodedata.normalize("NFKD", s)

	# lowercase
	s = s.lower()

	# replace punctuation with space
	s = re.sub(r"[^a-z0-9]+", " ", s)

	# collapse whitespace
	s = " ".join(s.split())

	return s.strip()


def normalize_title_sql(s: str) -> str:
	if not s:
		return ""
	s = unicodedata.normalize("NFKD", s)
	s = s.lower()
	# Keep letters/numbers/underscore/spaces; punctuation -> spaces
	s = re.sub(r"[^\w\s]", " ", s)
	s = re.sub(r"\s+", " ", s).strip()
	return s

def normalize_doi(s: str) -> str:
	if not s:
		return ""
	s = s.strip()

	m = _DOI_RE.search(s)
	if m:
		s = m.group(1)

	s = s.strip().lower()
	s = re.sub(r"^doi:\s*", "", s)
	s = re.sub(r"^https?://(dx\.)?doi\.org/", "", s)
	s = s.rstrip(").,;:]}>\"'")
	return s

def chunked(seq: List[str], n: int) -> List[List[str]]:
	return [seq[i:i+n] for i in range(0, len(seq), n)]

# ============================================================
# Zotero DB discovery (path agnostic)
# ============================================================

def _candidates_common(home: Path) -> List[Path]:
	return [
		home / "Zotero" / "zotero.sqlite",
		home / "ZoteroBeta" / "zotero.sqlite",
		home / "Zotero Beta" / "zotero.sqlite",
		home / "Library" / "Application Support" / "Zotero" / "zotero.sqlite",
		home / "Library" / "Application Support" / "ZoteroBeta" / "zotero.sqlite",
		home / "Library" / "Application Support" / "Zotero Beta" / "zotero.sqlite",
	]

def _bounded_find_sqlite(home: Path) -> Optional[Path]:
	roots = [
		home / "Zotero",
		home / "Library" / "Application Support" / "Zotero",
		home / "Library" / "Application Support",
	]
	roots = [r for r in roots if r.exists()]

	best: Optional[Tuple[float, Path]] = None  # (mtime, path)

	for root in roots:
		for pat in ("zotero.sqlite", "**/zotero.sqlite"):
			try:
				for p in root.glob(pat):
					if p.name != "zotero.sqlite":
						continue
					try:
						st = p.stat()
					except OSError:
						continue
					if best is None or st.st_mtime > best[0]:
						best = (st.st_mtime, p)
			except Exception:
				continue

	return best[1] if best else None

def resolve_zotero_db_path(cli_db: Optional[str]) -> Path:
	# 1) CLI
	if cli_db:
		p = Path(cli_db).expanduser()
		if p.exists():
			return p
		raise SystemExit(f"--db path does not exist: {p}")

	# 2) ENV
	env = os.environ.get("ZOTERO_DB", "").strip()
	if env:
		p = Path(env).expanduser()
		if p.exists():
			return p
		raise SystemExit(f"ZOTERO_DB path does not exist: {p}")

	home = Path.home()

	# 3) Common locations
	for p in _candidates_common(home):
		if p.exists():
			return p

	# 4) Bounded search
	p = _bounded_find_sqlite(home)
	if p and p.exists():
		return p

	raise SystemExit(
		"Could not find zotero.sqlite automatically.\n"
		"Provide --db /path/to/zotero.sqlite or set ZOTERO_DB=/path/to/zotero.sqlite"
	)

# ============================================================
# Zotero schema helpers
# ============================================================

def get_field_ids(conn: sqlite3.Connection) -> Tuple[int, int]:
	"""
	Return (titleFieldID, doiFieldID) from Zotero fields table.
	"""
	cur = conn.cursor()

	cur.execute("SELECT fieldID FROM fields WHERE fieldName='title' LIMIT 1;")
	row = cur.fetchone()
	if not row:
		raise RuntimeError("Could not find fields.fieldName='title'")
	title_id = int(row[0])

	cur.execute("SELECT fieldID FROM fields WHERE fieldName='DOI' LIMIT 1;")
	row = cur.fetchone()
	if not row:
		cur.execute("SELECT fieldID FROM fields WHERE lower(fieldName)='doi' LIMIT 1;")
		row = cur.fetchone()
		if not row:
			raise RuntimeError("Could not find DOI field (fields.fieldName='DOI')")
	doi_id = int(row[0])

	return title_id, doi_id

# ============================================================
# Snapshot DB reader (lock-proof)
# ============================================================

@dataclass
class SnapshotState:
	conn: sqlite3.Connection
	title_id: int
	doi_id: int
	mtime_sig: Tuple[float, float, float]

class ZoteroSnapshot:
	"""
	Copies zotero.sqlite (+ wal + shm when present) into a private temp dir
	and queries the snapshot. This avoids all 'database is locked' issues.
	"""

	def __init__(self, real_db: Path, refresh_debounce_sec: float = 0.35):
		self.real_db = real_db
		self.refresh_debounce_sec = refresh_debounce_sec

		self.tmpdir = Path(tempfile.mkdtemp(prefix="zotero_snapshot_"))
		self.snap_db = self.tmpdir / "zotero.sqlite"
		self.snap_wal = self.tmpdir / "zotero.sqlite-wal"
		self.snap_shm = self.tmpdir / "zotero.sqlite-shm"

		self._state: Optional[SnapshotState] = None
		self._last_refresh_attempt = 0.0

	def _mtime_sig(self) -> Tuple[float, float, float]:
		wal = self.real_db.with_suffix(".sqlite-wal")
		shm = self.real_db.with_suffix(".sqlite-shm")

		db_m = self.real_db.stat().st_mtime if self.real_db.exists() else 0.0
		wal_m = wal.stat().st_mtime if wal.exists() else 0.0
		shm_m = shm.stat().st_mtime if shm.exists() else 0.0
		return (db_m, wal_m, shm_m)

	def _copy_snapshot_files(self) -> None:
		wal = self.real_db.with_suffix(".sqlite-wal")
		shm = self.real_db.with_suffix(".sqlite-shm")

		# Copy base DB
		shutil.copy2(self.real_db, self.snap_db)

		# Copy WAL/SHM if present; if not present, remove old snapshots so SQLite doesn't get confused
		if wal.exists():
			shutil.copy2(wal, self.snap_wal)
		else:
			try:
				self.snap_wal.unlink()
			except FileNotFoundError:
				pass

		if shm.exists():
			shutil.copy2(shm, self.snap_shm)
		else:
			try:
				self.snap_shm.unlink()
			except FileNotFoundError:
				pass

	def _open_snapshot_conn(self) -> SnapshotState:
		conn = sqlite3.connect(self.snap_db, check_same_thread=False)
		conn.execute("PRAGMA query_only=ON;")
		conn.execute("PRAGMA temp_store=MEMORY;")
		conn.create_function("norm", 1, normalize_title_sql)

		title_id, doi_id = get_field_ids(conn)
		return SnapshotState(conn=conn, title_id=title_id, doi_id=doi_id, mtime_sig=self._mtime_sig())

	def refresh_if_needed(self, force: bool = False) -> None:
		now = time.time()
		if not force and (now - self._last_refresh_attempt) < self.refresh_debounce_sec:
			return
		self._last_refresh_attempt = now

		sig = self._mtime_sig()
		if not force and self._state and self._state.mtime_sig == sig:
			return

		# Refresh snapshot
		if not self.real_db.exists():
			raise RuntimeError(f"Zotero DB not found: {self.real_db}")

		# Close old conn
		if self._state:
			try:
				self._state.conn.close()
			except Exception:
				pass
			self._state = None

		self._copy_snapshot_files()
		self._state = self._open_snapshot_conn()
		print("Snapshot refreshed")

	def get(self) -> Tuple[sqlite3.Connection, int, int]:
		# Ensure we have a snapshot (and it's reasonably up-to-date)
		if not self._state:
			self.refresh_if_needed(force=True)
		else:
			self.refresh_if_needed(force=False)

		assert self._state is not None
		return self._state.conn, self._state.title_id, self._state.doi_id

# ============================================================
# Batched lookup engine (field-scoped)
# ============================================================

def lookup_exists_raw(conn: sqlite3.Connection, title_field_id: int, doi_field_id: int, queries: List[Dict]) -> List[Dict]:
	doi_keys: Dict[str, List[int]] = {}
	title_keys: Dict[str, List[int]] = {}

	norm_dois: List[str] = [""] * len(queries)
	norm_titles: List[str] = [""] * len(queries)
	for i, q in enumerate(queries):
		nd = normalize_doi(q.get("doi") or "")
		nt = normalize_title_sql(q.get("title") or "")
		norm_dois[i] = nd
		norm_titles[i] = nt

		if nd:
			doi_keys.setdefault(nd, []).append(i)
		elif nt:
			title_keys.setdefault(nt, []).append(i)

	found_dois: Set[str] = set()
	found_titles: Set[str] = set()

	cur = conn.cursor()

	# DOI lookup: only DOI field
	if doi_keys:
		all_dois = list(doi_keys.keys())
		for part in chunked(all_dois, 400):
			ph = ",".join(["?"] * len(part))
			sql = f"""
				SELECT lower(v.value) AS doi
				FROM itemData d
				JOIN itemDataValues v ON v.valueID = d.valueID
				WHERE d.fieldID = ?
				  AND lower(v.value) IN ({ph})
			"""
			cur.execute(sql, [doi_field_id, *part])
			for (doi_val,) in cur.fetchall():
				nd = normalize_doi(doi_val or "")
				if nd:
					found_dois.add(nd)

	# Title lookup: only Title field, normalized
	# if title_keys:
	#     all_titles = list(title_keys.keys())
	#     print( all_titles )
	#     for part in chunked(all_titles, 400):
	#         ph = ",".join(["?"] * len(part))
	#         sql = f"""
	#             SELECT norm(v.value) AS nt
	#             FROM itemData d
	#             JOIN itemDataValues v ON v.valueID = d.valueID
	#             WHERE d.fieldID = ?
	#               AND norm(v.value) IN ({ph})
	#         """
	#         cur.execute(sql, [title_field_id, *part])
	#         for (nt_val,) in cur.fetchall():
	#             if nt_val:
	#                 found_titles.add(nt_val.strip())
	if title_keys:

		# build normalized title set from Zotero
		cur.execute("""
			SELECT v.value
			FROM itemData d
			JOIN itemDataValues v ON v.valueID = d.valueID
			WHERE d.fieldID = ?
		""", (title_field_id,))

		db_titles = set()

		for (val,) in cur.fetchall():
			nt = normalize_title(val or "")
			if nt:
				db_titles.add(nt)

		# print( db_titles )

		# check incoming titles
		for t in title_keys.keys():
			nt = normalize_title(t)
			print(nt)

			if not nt:
				continue

			for dbt in db_titles:

				# exact
				if nt == dbt:
					found_titles.add(nt)
					break

				# incoming shorter
				if dbt.startswith(nt):
					found_titles.add(nt)
					break

				# db title shorter
				if nt.startswith(dbt):
					found_titles.add(nt)
					break

	results: List[Dict] = []
	for i, q in enumerate(queries):
		nd = norm_dois[i]
		nt = norm_titles[i]

		exists = False
		if nd:
			exists = nd in found_dois
		elif nt:
			exists = nt in found_titles

		results.append({
			"id": q.get("id"),
			"exists": bool(exists),
			"title": q.get("title"),
			"doi": q.get("doi"),
		})

	return results

# ============================================================
# HTTP server
# ============================================================

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
	daemon_threads = True

class Handler(BaseHTTPRequestHandler):
	snapshot: ZoteroSnapshot = None  # injected at startup

	def log_message(self, *_):
		return

	def _send_json(self, code: int, payload: Dict):
		raw = json.dumps(payload).encode("utf-8")
		self.send_response(code)
		self.send_header("Content-Type", "application/json; charset=utf-8")
		self.send_header("Content-Length", str(len(raw)))
		# permissive CORS (fine for GM.xmlHttpRequest, useful for fetch)
		self.send_header("Access-Control-Allow-Origin", "*")
		self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
		self.send_header("Access-Control-Allow-Headers", "Content-Type")
		self.end_headers()
		self.wfile.write(raw)

	def do_OPTIONS(self):
		self.send_response(204)
		self.send_header("Access-Control-Allow-Origin", "*")
		self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
		self.send_header("Access-Control-Allow-Headers", "Content-Type")
		self.end_headers()

	def do_POST(self):
		if self.path != "/exists":
			self._send_json(404, {"results": [], "error": "not found"})
			return

		try:
			length = int(self.headers.get("Content-Length", "0"))
			body = self.rfile.read(length) if length > 0 else b"{}"
			data = json.loads(body.decode("utf-8", errors="replace"))

			queries = data.get("queries", [])
			if not isinstance(queries, list):
				self._send_json(400, {"results": [], "error": "queries must be a list"})
				return

			cleaned: List[Dict] = []
			for q in queries:
				if not isinstance(q, dict):
					continue
				cleaned.append({
					"id": q.get("id"),
					"title": (q.get("title") or ""),
					"doi": (q.get("doi") or ""),
				})

			conn, title_id, doi_id = self.snapshot.get()
			results = lookup_exists_raw(conn, title_id, doi_id, cleaned)

			hits = 0
			for r in results:
				if r.get("exists"):
					hits += 1
					t = (r.get("title") or "")
					d = (r.get("doi") or "")
					t_short = t[:70] + ("..." if len(t) > 70 else "")
					d_short = d[:70] + ("..." if len(d) > 70 else "")
					print(f"✔ {r.get('id')} || {t_short} || {d_short}")

			print(f"✔ served {len(results)} queries ({hits} hits)")
			self._send_json(200, {"results": results})

		except Exception as e:
			print("✖ server error:", repr(e))
			self._send_json(500, {"results": [], "error": str(e)})

# ============================================================
# Main
# ============================================================

def main():
	ap = argparse.ArgumentParser(description="Zotero exists server (snapshot-based, lock-proof, path-agnostic)")
	ap.add_argument("--db", default=None, help="Path to zotero.sqlite (or set env ZOTERO_DB)")
	ap.add_argument("--host", default=os.environ.get("ZOTERO_HOST", "127.0.0.1"))
	ap.add_argument("--port", type=int, default=int(os.environ.get("ZOTERO_PORT", "9371")))
	ap.add_argument("--debounce", type=float, default=float(os.environ.get("ZOTERO_SNAPSHOT_DEBOUNCE", "0.35")),
					help="Snapshot refresh debounce seconds (default 0.35)")
	args = ap.parse_args()

	db_path = resolve_zotero_db_path(args.db)

	snapshot = ZoteroSnapshot(db_path, refresh_debounce_sec=args.debounce)
	# Force initial snapshot so we fail fast if schema is weird
	snapshot.refresh_if_needed(force=True)

	Handler.snapshot = snapshot

	server = ThreadingHTTPServer((args.host, args.port), Handler)
	print(f"Zotero exists server running on http://{args.host}:{args.port}")
	print(f"Using Zotero DB: {db_path}")
	print(f"Snapshot dir: {snapshot.tmpdir}")

	server.serve_forever()

if __name__ == "__main__":
	main()