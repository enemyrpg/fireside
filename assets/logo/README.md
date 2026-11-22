# Logo

A flame above two crossed logs, drawn for this project. MIT licensed like the
rest of the repo. It is not based on any Jagex artwork.

| File                | Contents                                                              |
| ------------------- | --------------------------------------------------------------------- |
| `fireside.svg`      | Full logo: white strokes on a rounded square in the dark theme accent |
| `fireside-mark.svg` | Only the flame and logs, in `currentColor`                            |

Both are 24 × 24 units with a 2-unit round stroke (the lucide style) and are
readable at 16 px.

The drawing lives in `web/src/branding/logo.ts`. These files and
`web/public/favicon.svg` are generated from it, and a test fails if they drift.
The dashboard draws the logo inline in the current theme's `--accent`.

The plugin repo copies `fireside.svg` and renders its panel icon and
`icon.png` from it.
