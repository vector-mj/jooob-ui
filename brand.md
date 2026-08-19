# jooob — visual identity

Always lowercase: **jooob**. Never "Jooob", never "JOOOB". No mascot.

## The mark

Three concentric orbits — one for each *o* in jooob — each carrying a small
body, around one solid centre. It is the product in one picture: thousands of
postings, companies and skills in motion around a single point of view, the
market. It echoes the galaxy on the landing hero. The wordmark is geometric
monoline lettering (outlined paths, no font dependency); the middle *o*
carries one accent bead, tying the type to the orbits.

## Files

| file | use |
|---|---|
| `logo.svg` | full lockup: hero, footer, docs |
| `logo-mark.svg` | cramped headers, avatars, square slots |
| `logo-animated.svg` | landing hero only; honors `prefers-reduced-motion` |
| `favicon.svg` | browser tab; explicit colours, no `currentColor` |

## Colour roles

- **Ink** (rings, centre, letters): `currentColor`. Inline the SVG so it
  inherits `--text` in both themes — via `<img>` it falls back to black.
- **Bodies** (the moving dots): fixed `#6ea8ff` (accent) and `#7c5cff`
  (accent-2). These are the only non-ink colours. Never recolour them with
  `--ok` / `--warn` / `--danger`, and never theme-swap them.

## Minimum sizes

- Lockup: 28px tall. Below that, use the mark alone.
- Mark: 20px. Below that, use `favicon.svg` (detail already stripped for 16px).

## Clear space

Keep a margin of one *o* (the letter's outer diameter, ≈ half the mark's
height) of empty space on all sides. Nothing enters it.

## Don't

- Don't rotate, skew, outline, shadow, or add gradients.
- Don't add or remove orbits or bodies — three of each, always.
- Don't set the wordmark in Vazirmatn or any font; use the outlined paths.
- Don't place ink-on-ink: over busy imagery, sit the lockup on a `--surface`
  chip with the clear-space padding.
- Don't animate anywhere except the landing hero, and never speed the loop up.
