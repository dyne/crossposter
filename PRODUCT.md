# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One local owner operating social accounts they already control. The daily
workflow starts in Codex / Gestalt through the local control API; the optional
dashboard remains available.

## Product Purpose

Crossposter prepares and operates publishing, schedules, one shared draft and
one media item through its existing backend and provider integrations. The
owner independently reviews the exact prepared action before authorizing a
later MCP commit.

## Operating Context

The backend runs locally on an explicitly configured loopback origin. Owner
approval uses a password configured locally outside MCP and entered directly
in the browser. Machine credentials grant no owner approval authority.

## Capabilities and Constraints

Prepared actions freeze content, targets, media identity and timing. Approval
records permission only; it neither publishes nor enqueues. Expired or changed
preparations require a new preparation. Account onboarding, remote MCP,
multi-user operation, analytics, bulk posting and native published-post deletion
are outside this release. Existing provider, storage and scheduler ownership
remain in the incumbent backend.

## Brand Commitments

Preserve the Crossposter name, logo, existing light/dark themes and component
language. The focused approval page extends the app without changing composer
or settings workflows.

## Evidence on Hand

Architecture and exact contracts are recorded in MCP_DESIGN_ANALYSIS.md and
ARCHITECTURE.md. Tests use synthetic fixtures and blocked provider/network IO.
Retained visual baselines cover composer, settings and scheduled pages.

## Product Principles

- Show the complete immutable action before asking for a decision.
- Keep owner authority independent from machine credentials.
- Distinguish preparation, approval, commit and actual publication outcomes.
- Preserve local ownership and report conflicts and uncertainty explicitly.

## Accessibility & Inclusion

Approval must work with the keyboard, visible focus, narrow screens, long
content and 200% text size in both existing themes.
