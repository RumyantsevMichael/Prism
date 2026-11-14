---
name: verify-ui
description: Check a review app UI change in both themes before calling it done, with the layout check and the mockup comparisons. Use after changing any review app page, kit element, stylesheet, or design value, and before opening or updating its pull request.
---

# Verify a UI change

CI checks layout and mockup geometry in the light theme only, because the dark theme changes only colors and shadows.
A UI change can still look wrong in the dark theme, so whoever makes it looks at both themes before finishing.

1. Run the kit guard and open the component catalog for each element you touched, in both themes.
2. Run the layout check in both themes, and fix every finding:

   ```bash
   node scripts/review-demo/layout-check.mjs --themes light,dark
   ```

3. When the change touches a screen that a mockup shows, run its comparison, which covers both themes by default, and read every pair it writes:

   ```bash
   node scripts/review-demo/mockup-compare.mjs --out /tmp/mockup-compare
   node scripts/review-demo/places-compare.mjs --out /tmp/places-compare
   ```

4. In the pull request, name each difference that a comparison shows and the change keeps on purpose.

The commands and what they check are in [CONTRIBUTING.md](../../../CONTRIBUTING.md#review-app-design-values).
