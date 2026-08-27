---
name: accessibility-quality
description: Accessibility quality gate for frontend work. Use when creating or reviewing interactive UI, forms, routing, dialogs, custom controls, visual states, keyboard behavior, or anything that changes semantic structure.
---

# Accessibility Quality

Accessibility is part of done for frontend work. Use semantic HTML first, then ARIA only to fill gaps that native elements cannot express.

## Non-Negotiables

- Interactive controls must be reachable and operable by keyboard.
- Focus order must follow the visual and task order.
- Visible focus must be clear against the surrounding UI.
- Form controls need programmatic labels.
- Validation and help text must be associated with the relevant fields.
- Images and icons need useful alternatives, or must be hidden from assistive tech when decorative.
- Color cannot be the only way to communicate state.
- Text and meaningful UI states need sufficient contrast.

## Prefer Native Semantics

- Use `button` for actions and links for navigation.
- Use headings to describe page structure, not just to style text.
- Use `label`, `fieldset`, `legend`, lists, tables, and landmarks when they match the content.
- Avoid custom controls unless the native element cannot meet the product need.

## Interactive UI Checklist

- Can a keyboard-only user complete the main flow?
- Does focus move intentionally after route changes, dialogs, submissions, and destructive actions?
- Do dialogs trap focus, restore focus on close, and expose an accessible name?
- Are disabled, pending, selected, expanded, and invalid states exposed programmatically when relevant?
- Are announcements needed for async results, validation summaries, or background updates?

## Testing Expectations

- Prefer behavior tests that exercise the public UI the way a user would.
- Include keyboard-path coverage for important custom interactions.
- Use automated checks as a baseline, not as proof that the UI is accessible.
- When manual verification matters, state what was checked and what remains unchecked.

## Relationship To UI Preferences

The cleanest UI is not accessible by accident. When `frontend-ui-preferences` applies, this skill applies too unless the change is purely visual and cannot affect semantics, focus, contrast, or interaction.
