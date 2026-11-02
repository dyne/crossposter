---
name: Crossposter
description: Existing local operating interface, including focused owner approval
colors:
  accent: "#20b15a"
  accent-dark-theme: "#31b766"
  ink: "#171916"
  ink-dark-theme: "#edf1eb"
  background: "#f4f6f0"
  background-dark-theme: "#141716"
  panel: "#ffffff"
  panel-dark-theme: "#1a1e1b"
  muted: "#687066"
  muted-dark-theme: "#bcc4b9"
  line: "#d8dece"
  line-dark-theme: "#3d453d"
  danger: "#c74435"
  danger-dark-theme: "#ff8172"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Avenir Next, system-ui, sans-serif"
    fontWeight: 700
  body:
    fontFamily: "Hanken Grotesk, Avenir Next, Segoe UI, sans-serif"
    fontSize: "1rem"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
rounded:
  panel: "13px"
  control: "10px"
  compact-control: "7px"
spacing:
  tight: "8px"
  control: "12px"
  section: "24px"
components:
  approval-primary:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.compact-control}"
    padding: "10px 18px"
  approval-review:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.panel}"
---

# Design System: Crossposter

## Overview

**Creative North Star: "Crossposter local operating surface"**

This records the incumbent implementation, not a new visual direction. Use the
existing logo, fonts and theme variables. The approval surface serves one task:
reading a complete preparation and recording a clear decision.

**Key Characteristics:**

- Green primary actions and selected theme controls.
- Neutral reading surfaces with clear section boundaries.
- Familiar forms and visible keyboard focus.
- Existing light, dark and system theme behavior.

## Colors

Use the existing CSS custom properties rather than copying light-theme values
into a component. Accent identifies actions and selected controls; danger
identifies rejection and errors. Ink, muted text, lines and surfaces all have
existing dark-theme counterparts.

## Typography

Display headings use Bricolage Grotesque; body and controls use Hanken Grotesk.
JetBrains Mono is reserved for actual identifiers, digests and technical data.
Approval prose preserves newlines and wraps without truncation, with a readable
measure of up to 74ch. Text enlargement changes the reading height, not access
to content or decision controls.

## Layout

The incumbent workspace centers within the viewport. Owner approval narrows it
to 1040px and uses one continuous review surface. Summary facts use two columns
on wide screens and one below 700px. Section padding is 24px, reduced to 20px
on narrow screens. Decisions follow the complete content and identity details.

## Elevation & Depth

The incumbent masthead uses existing soft elevation. The approval reading
surface uses a border and tonal status region; it adds no decorative depth.

## Shapes

Reuse the current panel radius variable and established form-control geometry.
The approval surface uses compact control corners, with pill geometry retained
only in the existing theme selector.

## Components

Buttons expose loading, disabled, hover and keyboard focus states. The owner
review keeps its primary and reject actions distinct. Login fields use the
existing input surface and focus treatment. Status text and focused headings
describe the durable decision and distinguish it from publication outcomes.

The approval page's logo is the existing public Crossposter asset. Synthetic
media in test captures is a fixture and is not a new shipping illustration.

## Do's and Don'ts

- Do inherit theme variables and the existing ThemeToggle.
- Do preserve complete text, safe links, identifiers and media identity.
- Do use normal document scrolling for long reviews and enlarged text.
- Don't introduce a new visual world for a local feature.
- Don't turn identifiers into decorative labels or truncate the action preview.
- Don't add new eyebrow headings, decorative illustrations or motion unrelated
  to a user action. Existing unrelated surfaces remain outside this addition.
