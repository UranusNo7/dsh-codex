# Third-Party Notices

Parts of this project include third-party work under its own licenses. The full
license text of each component is reproduced below, as required by that license.

## dsh-gpt-compat

- Upstream: https://github.com/YaoaY/dsh-gpt-compat
- Component version consulted: `0.2.4-desktop.2`
- Used in: `src/tool-compat.ts` (Codex-only redundant sandbox-escalation
  cleanup), adapted and renamed for this bundle. No upstream package is loaded
  at runtime, and no upstream code is bundled as a separate dependency.
- License: MIT (full text below)

### MIT License

Copyright (c) 2026 dsh-gpt-compat contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dsh-net-proxy runtime assets

This package also ships the runtime assets of the `dsh-net-proxy` DSH plugin
under `bin/net-proxy/`, so the plugin can start its bundled core without
downloading one at first use. The plugin's own source is MIT; its license is
reproduced in [`licenses/dsh-net-proxy/LICENSE.txt`](../licenses/dsh-net-proxy/LICENSE.txt).
The two redistributed components below keep their own licenses.

### mihomo core

- File: `bin/net-proxy/mihomo-windows-amd64-compatible.exe`
- Project: [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo),
  version `v1.19.15` (Windows amd64 "compatible" build)
- License: **GPL-3.0**. Redistributed unmodified as a separate executable,
  invoked as a subprocess and never linked into this package's code, so this
  package's own MIT-licensed source stays MIT. Corresponding source is
  available from the project link above.
- Bytes: 32,799,744
- SHA-256: `7f49fdbfc5c5a2a32807fadfeddbcefc61e439165495337a9b72ca090febaaf4`
- Note: the upstream release's `mihomo.zip.sha256`
  (`e9251191e459816c1aca55d495eabd50d525e83aff0cd445608d69da7e0f470c`)
  is the checksum of the release archive, not of this extracted executable.

### Geodata

- Files and bundled bytes:
  - `bin/net-proxy/geoip.metadb` — 8,414,245 bytes,
    SHA-256 `605026f19311038efd07e7a006e49a59f1dec3e2b7d4e07b4ca47967fbb73e81`
  - `bin/net-proxy/geosite.dat` — 4,290,986 bytes,
    SHA-256 `5800301b7bb0a04607c660b5d456aeca2c2262849fb77e6c7962174829a6b0f4`
- Project: [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)
- License: **GPL-3.0** (the project's own license; the underlying GeoIP data
  derives from MaxMind's GeoLite2, whose terms are in that repository)

### Bundled bytes are authoritative

The dsh-net-proxy source tree also contains sidecar files
(`geoip.metadb.sha256`, `geosite.dat.sha256`) whose recorded values
(`3e8fa3e2…`, `77416fb4…`) do **not** match the bytes copied into this bundle.
The SHA-256 values above are the actual hashes of the shipped bytes; do not use
the sidecar values to verify these files, and update this notice if the assets
are ever replaced.

### Deployment note

Do not enable the Windows x64 build and the standalone-installer build of the
desktop app at the same time; run only one distribution at a time so that two
bundled proxy cores do not compete for the same local state and port.
