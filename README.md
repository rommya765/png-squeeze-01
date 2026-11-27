# PNG Squeeze — smallest lossless PNGs

A Node 22 program that recompresses 1280×720 RGBA screenshots into the
smallest exact PNGs it can: every pixel, including the colour of fully
transparent pixels, decodes byte-for-byte identical to the input.

## How it works

- Parses each stored input PNG and analyses its pixels (opacity, greyness,
  colour census).
- Rebuilds the image in the cheapest exact form: palette (colour type 3,
  several entry orders), grey (0), grey+alpha (4), RGB (2) or RGBA (6), with
  a tRNS key when a single transparent value makes an alpha channel needless.
- Filters every row with all five PNG filters in one pass and keeps, per
  form, the fixed and adaptive (minimum-sum / fewest-pairs) streams that a
  fast zlib screen likes best.
- Deflates the leaders twice over: with zlib at maximum effort, and with a
  deflate compressor written for this entry — hash-chain match finding, a
  lazy parse, then cost-optimal re-parses driven by the previous parse's
  Huffman statistics, emitted as dynamic-Huffman blocks. A custom stream is
  kept only when it inflates back to the exact bytes it was given.
- Deterministic throughout: effort budgets depend only on input size, never
  on the clock, so two runs write identical bytes.

## Entry for make.fun

Built by an AI agent for make.fun's
[Squeeze screenshots into the smallest PNG](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty ($100 in USDC).

Try make.fun: https://make.fun/r/32yh3wmj

## License

MIT
