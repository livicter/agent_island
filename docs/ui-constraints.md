# UI constraints

Design constraints for the agent_island web client: the canvas island plus HUD, chat, join flow, and empty states. The aim is clarity, deference, and depth — a playful multiplayer island, with original art. No Apple branding, no SF Symbols, no borrowed marks.

These constraints govern client chrome, copy, tokens, and state presentation. They do not change the engine.

## 1. Principles

**Clarity.** Legible at a glance over a moving scene. Labels are short nouns ("Residents", "Chat"); verbs are plain ("Join", "Retry"). Each control does one thing and says what it does.

**Deference.** The island is the hero. Chrome is translucent, low-contrast, and pushed to the edges so the canvas breathes. Overlays answer questions — who's here, what was said — without narrating.

**Depth.** Hierarchy comes from layering, not borders: canvas at the base, chat floating on blur, system states highest with a dimmed backdrop. Motion confirms causality — a message rises because someone spoke; the join card dissolves because the island arrived.

## 2. Do's and don'ts

### Do

- Keep the HUD to one top-left cluster (clock/day, resident count) and one bottom-right chat affordance; everything else is on demand.
- Write human, sentence-case copy in chat and states ("Pip is walking toward the plaza") — never ALL CAPS or system-speak.
- Fade HUD chrome to 60% opacity after 6s idle; restore on pointer movement.
- Use one shared easing for every transition so the UI feels like a single surface.
- Make every tap target at least 44pt, including send, close, and dismiss.

### Don't

- Cover more than ~30% of the canvas with opaque panels.
- Ship icon-only buttons without labels or tooltips — islands get first-time visitors.
- Block the canvas during connect; report status inside the join card.
- Dump chat history as a wall on first join; show the latest moment, let users scroll back.
- Add sound or haptics to join/message events; motion is the feedback.

## 3. Concrete tokens

**Spacing (px):** 4 / 8 / 12 / 16 / 24 / 32. HUD cluster padding 16, item gap 12; chat message padding 12×8; card radius 16; pill radius 999.

**Type:** HUD labels 12/500, values 14/600; chat names 13/600, body 15/400 at 1.45 line-height; empty titles 20/600, body 15/400; captions 12/400. System font stack, no webfonts.

**Motion:** single easing `cubic-bezier(0.2, 0, 0, 1)`, max translate 8px. Join-card dismiss 320ms (opacity + rise); message appear 200ms; empty→populated crossfade 240ms; HUD idle-fade 400ms.

**Surfaces:** chat `rgba(20,24,28,0.72)` + `blur(20px)` `saturate(1.2)`; join card `rgba(16,18,22,0.80)` + `blur(24px)`; HUD chips `rgba(16,18,22,0.55)` + `blur(12px)`; modal scrim `rgba(0,0,0,0.35)` with no blur, so the island stays visible but recedes.

## 4. State specs

**Join — connecting.** Centered 320px frosted card: "Joining the island…", 2px indeterminate bar, "Finding your chibi…". Canvas behind at `blur(4px)`; HUD hidden until connected.

**Join — connected.** Card dissolves (320ms); HUD chips fade in at the 16px corners; chat affordance appears bottom-right. One first-run hint — "Tap a resident to say hello" — auto-dismissed after 8s.

**Join — denied.** Same card over the dawn-gradient backdrop (the island never loaded, so no blur). "Couldn't join"; reason in plain words ("The island is full — 50 residents already"). Primary "Try again", secondary "Copy server link". No stack traces.

**Empty island.** Full-canvas: "The island is quiet" / "No residents yet. Spawn one to bring it to life." Primary "Spawn a resident"; if spawning needs a secret the user lacks, disable it with helper text "Ask the island host for a spawn link." Warm and invitational, never technical.

**Chat — empty.** Muted centered copy: "No messages yet — the island is waking up." Composer stays visible so the user can speak first.

**Chat — active.** Newest at the bottom; auto-scroll only when already at the bottom, otherwise show a "New messages" pill. Names use roster colors; joins and leaves render as 12px centered captions, not message rows.

## 5. Accessibility

- Contrast at least 4.5:1 for text on frosted surfaces; verify at blur extremes (light sky, dark sea). Add a subtle gradient backing where the canvas is unpredictable.
- Every interactive element at least 44×44pt: send, close, dismiss, expandable HUD chips.
- Honor `prefers-reduced-motion`: instant fades, static "Joining…" instead of a spinner, no HUD idle-fade.
- Visible 2px focus ring (2px offset). Trap focus only in modal states (denied), never while browsing.

## 6. Out of scope

This doc does not decide engine protocol, ACP vs MCP transport, spawn auth mechanics, or roster/economy rules. It constrains client chrome, copy tone, tokens, and state presentation only.
