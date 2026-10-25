#!/usr/bin/env python3
"""Read Inkwell .inkw files with nothing but the Python standard library.

    python3 tools/inkw.py info FILE     a short summary
    python3 tools/inkw.py dump FILE     everything as JSON (strokes as [x, y, pressure] lists)

As a library:  from inkw import read;  doc = read("notes.inkw")

The format is in docs/inkw-spec.md. A file is a ZIP: JSON for the notes, one compact binary file per
page for strokes, pictures stored once under their SHA-256. This reader enforces the spec's limits,
so it is safe to point at files you did not make. Password-locked files need AES-GCM, which the
standard library does not have: they are reported, not opened.
"""
import hashlib
import json
import re
import sys
import zipfile

MIME = "application/vnd.inkwell.notebook+zip"
MAJOR = 1
LIMITS = {"entries": 100_000, "entry_bytes": 512 * 1024 * 1024, "total_bytes": 4 * 1024 * 1024 * 1024}
ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PAGE = re.compile(r"^pages/([A-Za-z0-9_-]{1,64})/page\.json$")
BLOB = re.compile(r"^blobs/([0-9a-f]{64})\.([a-z0-9]{1,8})$")
TOOLS = ["pen", "highlighter"]


class InkwError(Exception):
    """The file is not a valid .inkw file, or is one this reader cannot open."""


def _bad_name(name):
    return (
        name == ""
        or name.startswith("/")
        or "\\" in name
        or re.match(r"^[A-Za-z]:", name) is not None
        or "\0" in name
        or any(p in ("..", ".") for p in name.split("/"))
    )


class _Reader:
    def __init__(self, data):
        self.b, self.pos = data, 0

    def u8(self):
        if self.pos >= len(self.b):
            raise InkwError("Not an Inkwell file: strokes end early")
        v = self.b[self.pos]
        self.pos += 1
        return v

    def varint(self):
        v = 0
        for shift in range(0, 35, 7):
            x = self.u8()
            v += (x & 0x7F) << shift
            if not x & 0x80:
                if v > 0xFFFFFFFF:
                    raise InkwError("Not an Inkwell file: a number is too large")
                return v
        raise InkwError("Not an Inkwell file: a number is too long")

    def take(self, n):
        if n > len(self.b) - self.pos:
            raise InkwError("Not an Inkwell file: strokes end early")
        out = self.b[self.pos : self.pos + n]
        self.pos += n
        return out


def _unzigzag(n):
    return (n >> 1) ^ -(n & 1)


def decode_strokes(data):
    """strokes.bin bytes -> list of strokes (dicts); points are [x, y, pressure] lists."""
    r = _Reader(data)
    if r.take(4) != b"INKS":
        raise InkwError("Not an Inkwell file: bad stroke data")
    if r.u8() != 1:
        raise InkwError("This file needs a newer version of Inkwell")
    count = r.varint()
    if count > (len(data) - r.pos) / 14 + 1:
        raise InkwError("Not an Inkwell file: stroke count too large")
    strokes = []
    for _ in range(count):
        sid = bytes(r.take(r.varint())).decode("utf-8")
        tool = r.u8()
        if tool >= len(TOOLS):
            raise InkwError("This file uses a pen this reader lacks")
        flags = r.u8()
        rgb = [r.u8(), r.u8(), r.u8()]
        width = r.varint() / 16
        opacity = r.u8() / 255
        if r.u8() != 1:
            raise InkwError("This file has stroke data this reader cannot read")
        n = r.varint()
        if n > len(data) - r.pos:
            raise InkwError("Not an Inkwell file: point count too large")
        pts, x1, x2, y1, y2, p1 = [], 0, 0, 0, 0, 0
        for _ in range(n):
            x = _unzigzag(r.varint()) + 2 * x1 - x2
            y = _unzigzag(r.varint()) + 2 * y1 - y2
            p = _unzigzag(r.varint()) + p1
            pts.append([x / 64, y / 64, p / 255])
            x2, x1, y2, y1, p1 = x1, x, y1, y, p
        strokes.append(
            {
                "id": sid,
                "tool": TOOLS[tool],
                "color": "#%02x%02x%02x" % tuple(rgb),
                "width": width,
                "opacity": opacity,
                "pressure": bool(flags & 1),
                "points": pts,
            }
        )
    return strokes


def _json(data, what):
    try:
        v = json.loads(bytes(data).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise InkwError(f"Not an Inkwell file: {what} is damaged") from None
    if not isinstance(v, dict):
        raise InkwError(f"Not an Inkwell file: {what} is damaged")
    return v


def read(source):
    """Read a .inkw file (a path or the bytes) into a dict: manifest, notebooks, pages, blobs."""
    import io

    raw = open(source, "rb").read() if isinstance(source, str) else bytes(source)
    if raw[:8] == b"INKWLK1\0":
        raise InkwError("This file is locked with a password; this reader cannot open locked files")
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise InkwError("Not an Inkwell file") from None
    infos = zf.infolist()
    if len(infos) > LIMITS["entries"]:
        raise InkwError("This file has too many parts to open")
    names, total = set(), 0
    for i in infos:
        if i.filename.endswith("/"):
            continue
        if _bad_name(i.filename):
            raise InkwError(f"Not an Inkwell file: an unsafe name ({i.filename[:40]})")
        if i.filename in names:
            raise InkwError(f"Not an Inkwell file: a repeated name ({i.filename[:40]})")
        names.add(i.filename)
        total += i.file_size
        if i.file_size > LIMITS["entry_bytes"] or total > LIMITS["total_bytes"]:
            raise InkwError("This file is too large to open")

    def get(name):
        try:
            return zf.read(name)  # bounded by the declared size, which was checked above
        except (zipfile.BadZipFile, ValueError, OSError):
            raise InkwError("Not an Inkwell file: a part is damaged") from None

    if "mimetype" not in names or get("mimetype").decode("utf-8", "replace") != MIME:
        raise InkwError("Not an Inkwell file")
    if "inkw.json" not in names:
        raise InkwError("Not an Inkwell file")
    manifest = _json(get("inkw.json"), "the file header")
    version = manifest.get("version")
    if manifest.get("format") != "inkw" or not isinstance(version, dict) or not isinstance(version.get("major"), int):
        raise InkwError("Not an Inkwell file")
    if version["major"] > MAJOR:
        raise InkwError("This file needs a newer version of Inkwell")

    notebooks = []
    for nid in manifest.get("notebooks", []):
        if not isinstance(nid, str) or not ID.match(nid):
            raise InkwError("Not an Inkwell file: bad notebook id")
        if f"notebooks/{nid}.json" in names:
            notebooks.append(_json(get(f"notebooks/{nid}.json"), f"notebook {nid}"))
    pages, blobs = [], {}
    for name in sorted(names):
        m = PAGE.match(name)
        if m:
            pid = m.group(1)
            sb = f"pages/{pid}/strokes.bin"
            pages.append(
                {
                    "id": pid,
                    "json": _json(get(name), f"page {pid}"),
                    "strokes": decode_strokes(get(sb)) if sb in names else [],
                }
            )
            continue
        m = BLOB.match(name)
        if m:
            data = get(name)
            if hashlib.sha256(data).hexdigest() != m.group(1):
                raise InkwError("Not an Inkwell file: a picture is damaged")
            blobs[m.group(1)] = {"ext": m.group(2), "size": len(data)}
    return {"manifest": manifest, "notebooks": notebooks, "pages": pages, "blobs": blobs}


def _info(doc):
    m = doc["manifest"]
    strokes = sum(len(p["strokes"]) for p in doc["pages"])
    points = sum(len(s["points"]) for p in doc["pages"] for s in p["strokes"])
    print(f"Inkwell file, format {m['version']['major']}.{m['version'].get('minor', 0)}, made by {m.get('generator', '?')}")
    print(f"  notebooks: {len(doc['notebooks'])}, pages: {len(doc['pages'])}, strokes: {strokes} ({points} points), pictures: {len(doc['blobs'])}")
    for nb in doc["notebooks"]:
        print(f"  - {nb.get('name', '?')}: {sum(len(s.get('pages', [])) for s in nb.get('sections', []))} pages")


def main(argv):
    if len(argv) != 3 or argv[1] not in ("info", "dump"):
        print(__doc__)
        return 2
    try:
        doc = read(argv[2])
    except (InkwError, OSError) as e:
        print(f"inkw: {e}", file=sys.stderr)
        return 1
    if argv[1] == "info":
        _info(doc)
    else:
        json.dump(doc, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
