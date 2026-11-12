#!/usr/bin/env python3
"""Shrink a GLB by re-encoding its embedded textures as 1024px JPEGs (uses macOS `sips`).

usage: compress_glb.py input.glb output.glb [size]
"""
import json
import os
import struct
import subprocess
import sys
import tempfile


def read_glb(path):
    data = open(path, "rb").read()
    assert data[:4] == b"glTF", "not a GLB"
    json_len = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20 : 20 + json_len])
    bin_start = 20 + json_len
    bin_len = struct.unpack("<I", data[bin_start : bin_start + 4])[0]
    return doc, data[bin_start + 8 : bin_start + 8 + bin_len]


def reencode(png_bytes, size, tmp):
    src = os.path.join(tmp, "in.png")
    dst = os.path.join(tmp, "out.jpg")
    open(src, "wb").write(png_bytes)
    subprocess.run(
        ["sips", "-Z", str(size), "-s", "format", "jpeg", "-s", "formatOptions", "82", src, "--out", dst],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    return open(dst, "rb").read()


def main():
    src, dst = sys.argv[1], sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    doc, blob = read_glb(src)
    image_views = {img["bufferView"]: img for img in doc.get("images", []) if "bufferView" in img}

    out = bytearray()
    with tempfile.TemporaryDirectory() as tmp:
        for index, view in enumerate(doc["bufferViews"]):
            start = view.get("byteOffset", 0)
            chunk = blob[start : start + view["byteLength"]]
            if index in image_views:
                chunk = reencode(chunk, size, tmp)
                image_views[index]["mimeType"] = "image/jpeg"
            while len(out) % 4:
                out.append(0)
            view["byteOffset"] = len(out)
            view["byteLength"] = len(chunk)
            out += chunk
    while len(out) % 4:
        out.append(0)
    doc["buffers"] = [{"byteLength": len(out)}]

    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(dst, "wb") as f:
        f.write(b"glTF" + struct.pack("<II", 2, total))
        f.write(struct.pack("<I", len(js)) + b"JSON" + js)
        f.write(struct.pack("<I", len(out)) + b"BIN\x00" + bytes(out))
    print(f"{src}: {os.path.getsize(src) / 1e6:.1f} MB -> {dst}: {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
