# GBATEK (vendored reference copy)

`gbatek.htm` is **GBATEK**, the GBA/NDS technical reference written by
**Martin Korth**, fetched from <https://problemkaputt.de/gbatek.htm>
(2026-08-19, ~4.8 MB single file).

It is the canonical reference for GBA hardware: the memory region map and their
sizes/mirroring, I/O registers, DMA/timers/interrupts, BIOS calls, cartridge and
save hardware, and the ARM7TDMI/Thumb instruction encodings.

**This is third-party documentation, included here only as a local reference.**
It is not part of this project's work, is not modified, and Martin Korth's terms
are non-commercial. Keep the attribution, do not republish it, and keep
`vendor/` out of any Pages deploy (which is already the deploy step's job — see
the note at the bottom of `.gitignore`).

## When you actually need it

Rarely, and that is worth knowing up front. GBATEK answers *hardware* questions:
which region an address belongs to, how big it is, what an instruction encoding
means. It cannot tell you what a variable in this game means — that is a
property of the build, and lives in `research/hack-offsets.json`,
`research/engine-architecture.md`, and the pret decomps under `vendor/`.

Read it as HTML in a browser, or grep it: the file is one flat document with
`<b>` section headings, so `grep -n "EWRAM" gbatek.htm` works well enough for
lookups.
