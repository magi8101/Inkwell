# Vendored onenote_parser 2.1.0 (modified)

Source: <https://github.com/msiemens/onenote.rs> (crates.io `onenote_parser` 2.1.0), licensed under the
Mozilla Public License 2.0 (<https://mozilla.org/MPL/2.0/>). The MPL applies to the files in
`onenote_parser/`, including the modified one below.

Modification (Inkwell, 2026-10-22): `src/onenote/ink.rs` exposes per-point pen pressure
(`InkStroke::pressure`, `InkStroke::ignore_pressure`) from the ISF NormalPressure channel, which
2.1.0 parses but drops. Intended to be offered upstream.
