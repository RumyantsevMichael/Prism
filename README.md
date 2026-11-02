# Prism logo lab

This branch keeps the design tooling for the Prism mark, apart from `main` so that plugin installs never include it.

Open `prism-logo-lab.html` in a browser to tune the mark: corner angle θ, gap, optical lift, aperture animation, and per-size pixel grids.
The lab has its own copy of the geometry.
When it disagrees with `scripts/brand/prism-mark.mjs` on `main`, the script wins, because it generates the shipped icons.

## Shipped settings

The review app uses θ = 21°, gap 9, and optical lift 55%.

## Geometry

A line leaves each outer corner at angle θ to its edge.
Each piece has angles θ, 60° − θ, and 120°, and the hole is turned by θ.
θ and 60° − θ are mirror images, and θ = 30° closes the hole.
In an exact equilateral triangle at most one outer edge and one cut line can step evenly in pixels, because √3 is irrational.

## References

- `references/draft-concept.png` is the first concept image, with the right idea and broken geometry.
- `references/color-concept.png` is the spectrum coloring that the shipped color mark follows.
- `references/16px-grid.txt` is the candidate hand-tuned 16px layout for 1x screens, not shipped.
- The other images record the angle, lift, aperture, and background comparisons.
