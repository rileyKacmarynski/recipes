---
name: frontend-ui-preferences
description: Repo-specific UI preferences. Use when designing or implementing screens, components, layouts, empty states, loading states, copy, visual polish, or reviewing whether frontend work matches the user's preference for simple, clean, non-generic interfaces.
---

# Frontend UI Preferences

Build simple, clean product UI that feels intentional rather than template-generated. Preserve existing design-system choices when present; otherwise use this skill to choose restrained defaults.

## Direction

- Prefer calm layouts, clear hierarchy, generous whitespace, and obvious interaction targets.
- Make the primary user action visually clear without making the page loud.
- Use fewer visual primitives well: type, spacing, alignment, border, surface, and one accent before reaching for decoration.
- Favor direct product copy over cleverness.
- Design mobile and desktop together; no desktop-only compositions that merely shrink.

## Avoid Generic Output

- Avoid interchangeable SaaS sections: big gradient hero, three-card feature grid, vague marketing copy, and ornamental icons unless the product calls for them.
- Avoid adding visual complexity to compensate for weak information architecture.
- Avoid using every available component. A smaller set of components with better hierarchy is usually stronger.
- Avoid placeholder microcopy that sounds like a demo app.

## Layout Defaults

- Start by identifying the user's main job on the screen.
- Put the main content in a readable column or grid with a clear max width.
- Use spacing to group related controls before adding boxes or dividers.
- Make empty, loading, and error states feel designed, not bolted on.
- Keep forms linear unless the domain strongly benefits from grouping.

## Interaction Defaults

- Prefer interactions that explain themselves through labels, affordance, and placement.
- Surface irreversible or destructive actions with confirmation and clear consequence copy.
- Keep optimistic UI honest: show pending state and recovery when failure is plausible.
- Make keyboard and pointer paths equally first-class.

## Review Checklist

- Is the user's primary job obvious within a few seconds?
- Does the page have a strong hierarchy without visual noise?
- Does every piece of copy earn its place?
- Are loading, empty, error, and success states handled with the same care as the happy path?
- Does the mobile layout feel designed rather than collapsed?
- Does the result match the existing app vocabulary and component style?

## When Unsure

If a UI choice is subjective and likely to affect product direction, produce two or three focused alternatives rather than guessing forever. Compare them on clarity, restraint, and fit with the app's existing feel.
