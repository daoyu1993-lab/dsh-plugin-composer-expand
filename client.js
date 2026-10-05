/**
 * dsh-plugin-composer-expand — browser half.
 *
 * An expand button in the top-right corner of the composer card. One click turns
 * the composer into an immersive writing surface: the card grows to about 65% of
 * the conversation area, floats OVER the transcript (the transcript is not
 * reflowed and not scrolled), and plain Enter makes a newline instead of sending.
 * Collapse with the same button, with Esc, or by sending.
 *
 * WHAT THE SHIPPED CODE ACTUALLY LOOKS LIKE (from the installed
 * `@deepseek-ai/dsh-client-ui-conversation` product build)
 *
 *   The composer is a Lexical contenteditable, not a `<textarea>`:
 *
 *     div[data-conversation-content][data-content-phase=hero|active]
 *       div[data-conversation-scroll]                  the conversation scroll body
 *         div[data-slot="conversation.session"]        display:contents wrapper
 *           div.viewArea                               the transcript
 *         div[data-composer-seat]                      direct child, the composer's seat
 *           div.composerStack[.composerHero]
 *             div[data-slot="conversation.composer.bar"]   display:contents
 *               div.root
 *                 div[data-composer-card]              the input card (position:relative)
 *                   div.overlayAnchor                  position:absolute; inset:0 0 auto; height:0
 *                     div[data-slot="conversation.input.overlay"]   display:contents  -> our button
 *                   div...                             attachments
 *                   div[data-input-scroll]             max-height: var(--dsh-composer-text-max-height)
 *                     div.grow > div[data-composer-input]      the editable surface
 *                   div.row                            toolbar + the primary (send) button
 *                 div.dock                             the usage row (26px)
 *
 *   Enter-to-send is a Lexical command, not a DOM handler: the composer registers
 *   `KEY_ENTER_COMMAND` at priority 4 (`registerComposerKeymap`) and calls
 *   `handlers.submit(...)`. Two things follow, and both are used below:
 *
 *     - `event.shiftKey === true` returns `false` from that handler, so Lexical's
 *       own default `KEY_ENTER_COMMAND` (priority 0) runs and dispatches
 *       `INSERT_LINE_BREAK_COMMAND`. Shift+Enter *is* the official newline path
 *       (`fixed.newline`), and replaying it is how we get a newline without
 *       reaching into the editor.
 *     - Lexical attaches its listeners to the contenteditable root in the BUBBLE
 *       phase (`Fn(root, 'keydown', handler)`), so a capture-phase listener on
 *       `document` can reliably pre-empt it.
 *
 * WHY A CAPTURE-PHASE LISTENER PLUS A SYNTHETIC SHIFT+ENTER
 *   Lexical never inspects `event.isTrusted` (verified: zero occurrences in the
 *   product bundle), and its keydown handler reads `event.key` / `event.shiftKey`.
 *   Dispatching a synthetic shifted Enter on the editable surface therefore walks
 *   the exact official path — including the composer's own arbitration for popup
 *   menus — and inserts a line break. It needs no editor instance, no Lexical
 *   import and no DOM internals; the synthetic event carries `isTrusted === false`,
 *   which is what keeps this listener from re-entering itself.
 *
 * WHY A SLOT COMPONENT INSTEAD OF INJECTED DOM
 *   `conversation.input.overlay` is a shipped list slot rendered inside the card's
 *   own `.overlayAnchor`, i.e. exactly the top-right of the text surface. Taking
 *   that seat keeps the button inside the framework's lifecycle: it mounts and
 *   unmounts with the session, and it is remounted (never leaked across) when the
 *   session changes. The button is a real `<button>` with its own hit area.
 *
 * WHY THE STYLESHEET ADDRESSES DATA ATTRIBUTES ONLY
 *   Every DSH class name is a CSS-module hash (`yhfFVG_card`) that changes per
 *   build. The stable anchors are the shell's own data attributes — the same set
 *   the sibling `dsh-plugin-composer-align` relies on. Nothing here touches a
 *   hashed class, and every rule is scoped to `[data-composer-expanded]`, so with
 *   the attribute absent the composer is byte-for-byte the shipped one.
 *
 * Envelope: DSH browser bundles register themselves on the injected
 * `window.__ModuleLoader__` facade keyed by package id; the loader then calls
 * `apply(ctx)` and reads `inject` for service gating.
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-composer-expand',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');

		/** Plugin id, reused as the stylesheet owner marker. */
		const PLUGIN_ID = 'dsh-plugin-composer-expand';

		/* ── Build-stable anchors (never hashed class names) ─────────────────── */
		const CARD = '[data-composer-card]';
		const SEAT = '[data-composer-seat]';
		const SCROLL = '[data-conversation-scroll]';
		const CONTENT = '[data-conversation-content]';
		const INPUT = '[data-composer-input]';
		const INPUT_SCROLL = '[data-input-scroll]';
		const SESSION_SLOT = '[data-slot="conversation.session"]';

		/** Marker attribute the stylesheet hangs off; absent = shipped geometry. */
		const EXPANDED = 'data-composer-expanded';
		/** Our button's class (we own it, so it is not hashed). */
		const BUTTON_CLASS = 'dsh-composer-expand';
		/** Expando on the card: which session owns it (used by the DOM handlers). */
		const SESSION_KEY = '__dshComposerExpandSession';
		/** Expando on the card: the ResizeObserver keeping its height in sync. */
		const RESIZE_KEY = '__dshComposerExpandObserver';
		/** Custom property the stylesheet reads for the expanded card height. */
		const HEIGHT_VAR = '--dsh-composer-expanded-card-height';
		/** Custom property carrying the measured scrollbar gutter (see `syncHeight`). */
		const GUTTER_VAR = '--dsh-composer-expand-gutter';

		/** Expanded card height, as a fraction of the conversation area. */
		const HEIGHT_RATIO = 0.65;
		/** Never shrink below this, never reach the very top of the transcript. */
		const MIN_HEIGHT = 200;
		const TOP_CLEARANCE = 48;

		/**
		 * Grace window after `compositionend`, mirroring the shipped keymap: some
		 * IMEs deliver the committing Enter a tick after the composition ends.
		 * `data-composer-composing` does NOT cover this window, so it is tracked
		 * here.
		 */
		const COMPOSITION_GRACE_MS = 10;
		let lastCompositionEnd = 0;

		/**
		 * Anything that already owns Esc. While one of these is up, Esc belongs to
		 * the popup (`arbitrate("escape")` consumes it) and not to us.
		 */
		const POPUP_SELECTOR = [
			'[data-trigger-menu]',
			'[data-menu-backing]',
			'[role="menu"]',
			'[role="dialog"][aria-modal="true"]',
			'[data-approval-key]',
		].join(',');

		/**
		 * Seat order inside `conversation.input.overlay`. The shipped occupants are
		 * slash-menu (0), command-popup (1) and feedback-dialog (2); a positive
		 * order keeps this button behind all of them.
		 */
		const SEAT_ORDER = 10;

		/* ─────────────────────────────────────────────────────────────────────
		 * Per-session state, in memory only.
		 *
		 * The slot is declared `scope: "session"`, so React remounts the button
		 * whenever the session changes — component-local state cannot survive a
		 * switch. "Remember per session" therefore has to live outside React, in
		 * this Set, and the button subscribes to it. Nothing is persisted: the
		 * map dies with the page, which is what the plugin promises.
		 * ───────────────────────────────────────────────────────────────────── */
		/** @type {Set<string>} session ids currently expanded. */
		const expandedSessions = new Set();
		/** @type {Set<() => void>} one per mounted button. */
		const subscribers = new Set();

		/**
		 * Tell every mounted button to re-read its own snapshot.
		 * React bails out of the re-render when the snapshot is unchanged, so a
		 * fan-out to all buttons only ever repaints the one that flipped.
		 */
		function notify() {
			for (const listener of [...subscribers]) listener();
		}

		/**
		 * Subscribe to the expanded-session ledger.
		 * @param listener - React's store-change callback.
		 * @returns the unsubscribe function.
		 */
		function subscribe(listener) {
			subscribers.add(listener);
			return () => {
				subscribers.delete(listener);
			};
		}

		/**
		 * Read one session's expanded flag.
		 * @param sessionId - the owning session.
		 * @returns whether that session's composer is expanded.
		 */
		function isExpanded(sessionId) {
			return sessionId !== undefined && expandedSessions.has(sessionId);
		}

		/**
		 * Flip one session's expanded flag.
		 * @param sessionId - the owning session.
		 * @param on - the new value.
		 */
		function setExpanded(sessionId, on) {
			if (sessionId === undefined) return;
			if (expandedSessions.has(sessionId) === on) return;
			if (on) expandedSessions.add(sessionId);
			else expandedSessions.delete(sessionId);
			notify();
		}

		/**
		 * Collapse every expanded composer (Esc).
		 */
		function collapseAll() {
			if (expandedSessions.size === 0) return;
			expandedSessions.clear();
			notify();
		}

		/* ─────────────────────────────────────────────────────────────────────
		 * Geometry.
		 * ───────────────────────────────────────────────────────────────────── */

		/**
		 * Measure the conversation area and pin the expanded card's height.
		 *
		 * A percentage would need a definite parent height, and the seat is
		 * absolutely positioned with `height: auto` — so the number is measured
		 * here and handed to the stylesheet as a custom property. The fallback in
		 * the stylesheet (`65vh`) only applies for the sliver of time before the
		 * first measurement lands.
		 * @param card - the expanded composer card.
		 */
		function syncHeight(card) {
			const scroll = card.closest(SCROLL);
			const area = scroll === null ? 0 : scroll.clientHeight;
			if (area <= 0) return;
			const target = Math.round(area * HEIGHT_RATIO);
			const ceiling = area - TOP_CLEARANCE;
			const height = Math.max(MIN_HEIGHT, Math.min(target, ceiling));
			if (height !== card.__dshComposerExpandHeight) {
				card.__dshComposerExpandHeight = height;
				card.style.setProperty(HEIGHT_VAR, `${height}px`);
			}

			/* The seat's containing block becomes the conversation body, which is
			   wider than the scroll container the card used to be centred in — by
			   the scroll column's own right margin PLUS the reserved scrollbar
			   gutter. Measure both instead of trusting the theme's
			   `--dsh-scrollbar-width` (5px, and it says nothing about the margin),
			   then hand the total to the stylesheet so the card does not shift
			   sideways when it starts being centred by a wider box. */
			const body = card.closest(CONTENT);
			if (body !== null && scroll !== null) {
				const scrollbar = scroll.offsetWidth - scroll.clientWidth;
				const contentRight = scroll.getBoundingClientRect().right - scrollbar;
				const gutter = body.getBoundingClientRect().right - contentRight;
				if (gutter > 0) body.style.setProperty(GUTTER_VAR, `${gutter}px`);
			}
		}

		/**
		 * Re-measure every expanded card.
		 */
		function syncAllHeights() {
			for (const card of document.querySelectorAll(`${CARD}[${EXPANDED}]`)) {
				if (card[SESSION_KEY] !== undefined) syncHeight(card);
			}
		}

		/**
		 * Take one card back to the shipped geometry: drop the marker, the measured
		 * height and the measured scrollbar gutter.
		 * @param card - the composer card.
		 */
		function disarmCard(card) {
			card.removeAttribute(EXPANDED);
			card.style.removeProperty(HEIGHT_VAR);
			delete card.__dshComposerExpandHeight;
			const body = card.closest(CONTENT);
			if (body !== null) body.style.removeProperty(GUTTER_VAR);
		}

		/* ─────────────────────────────────────────────────────────────────────
		 * Keydown: Enter becomes a newline, Esc collapses.
		 * ───────────────────────────────────────────────────────────────────── */

		/**
		 * Find the composer card an event belongs to.
		 * @param node - `event.target` (or any node inside the composer).
		 * @returns the card, or null when the event is not inside a text surface.
		 */
		function cardOf(node) {
			if (!(node instanceof Element)) return null;
			const surface = node.closest(INPUT);
			return surface === null ? null : surface.closest(CARD);
		}

		/**
		 * Make a newline in the draft, through the official path.
		 *
		 * Two routes, best first:
		 *
		 *   1. Lexical's own command. `editor.setRootElement()` stamps the editor
		 *      onto the contenteditable (`root.__lexicalEditor = editor`), and the
		 *      editor's `_commands` map is keyed by the command objects themselves
		 *      — which are plain `{ type }` records. So
		 *      `INSERT_LINE_BREAK_COMMAND` can be dispatched directly, with no
		 *      dependency on how the browser would have synthesised the keystroke.
		 *   2. A synthetic shifted Enter, which Lexical's own keydown mapping turns
		 *      into exactly the same command. Kept as a fallback because (1)
		 *      reaches into internals: it is the route that survives an upstream
		 *      rename of the private field.
		 *
		 * `insertLineBreak` (not `insertParagraph`) is deliberate: it is what the
		 * shipped Shift+Enter does, i.e. a soft break inside the current block.
		 * @param surface - the composer's editable surface.
		 * @returns whether a newline was inserted.
		 */
		function insertNewline(surface) {
			/* Re-entrancy: the replayed keydown travels through `document` capture
			   again, and `onKeyDownCapture` sees it — but a shifted Enter returns
			   there at the `event.shiftKey` test before any interception happens, so
			   the replay cannot recurse. (This is also why the handlers do not need
			   an `isTrusted` gate, which would make them untestable.) */
			const editor = surface.__lexicalEditor;
			if (editor !== undefined && editor !== null && editor._commands instanceof Map) {
				for (const command of editor._commands.keys()) {
					if (command === null || typeof command !== 'object') continue;
					if (command.type !== 'INSERT_LINE_BREAK_COMMAND') continue;
					try {
						if (editor.dispatchCommand(command, false) === true) return true;
					} catch (error) {
						/* fall through to the keystroke replay */
					}
					break;
				}
			}

			const init = {
				key: 'Enter',
				code: 'Enter',
				keyCode: 13,
				which: 13,
				shiftKey: true,
				bubbles: false,
				cancelable: true,
				composed: true,
			};
			let event;
			try {
				event = new KeyboardEvent('keydown', init);
			} catch (error) {
				event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true });
			}
			/* `keyCode` is legacy and not guaranteed by the constructor; Lexical's
			   input state records `event.key` but other listeners still read the
			   legacy field, so make sure it is there either way. */
			if (event.keyCode !== 13) {
				try {
					Object.defineProperty(event, 'keyCode', { get: () => 13 });
					Object.defineProperty(event, 'which', { get: () => 13 });
				} catch (error) {
					/* non-configurable in this engine: Lexical only needs `key`. */
				}
			}
			surface.dispatchEvent(event);
			return true;
		}

		/**
		 * Grow one composer back down.
		 *
		 * The card is disarmed first so the panel is back to the shipped geometry
		 * on this frame — the DOM marker is what the stylesheet and the other DOM
		 * handlers read — and React's state follows so the button re-renders as
		 * "expand" again.
		 * @param card - the expanded composer card.
		 */
		function collapseCard(card) {
			const sessionId = card[SESSION_KEY];
			disarmCard(card);
			if (sessionId === undefined) {
				/* No owner recorded (should not happen): leave the immersive state
				   entirely rather than doing nothing. */
				collapseAll();
				return;
			}
			setExpanded(sessionId, false);
		}

		/**
		 * The expanded composer that is actually on screen.
		 *
		 * The conversation view renders only the active tab, so at most one
		 * composer is in the document at a time; the rect check is what keeps a
		 * hidden one out of the way.
		 * @returns the visible expanded card, or null.
		 */
		function visibleExpandedCard() {
			for (const card of document.querySelectorAll(`${CARD}[${EXPANDED}]`)) {
				if (!(card instanceof Element)) continue;
				if (card.getClientRects().length === 0) continue;
				return card;
			}
			return null;
		}

		/**
		 * Is the keyboard currently owned by some other text surface?
		 *
		 * A terminal, a search box or any other editable must keep its own Escape.
		 * The composer itself never counts.
		 * @param node - `document.activeElement`.
		 * @returns whether Escape belongs to somebody else.
		 */
		function ownsAnotherEditor(node) {
			if (node === null || node === document.body || node === document.documentElement) return false;
			if (node.closest(CARD) !== null) return false;
			const tag = node.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
			return node.isContentEditable === true;
		}

		/**
		 * Is the composer mid-composition (an IME candidate window is open)?
		 *
		 * The shipped keymap treats `event.isComposing`, the legacy `keyCode 229`
		 * and a 10ms grace window after `compositionend` as the same thing, because
		 * some IMEs deliver the committing Enter a tick after the composition ends.
		 * The composer does publish `data-composer-composing`, but only while it is
		 * actually composing — it does NOT cover that grace window, so it is
		 * mirrored here.
		 * @param event - the keydown.
		 * @param card - the composer card.
		 * @returns whether Enter belongs to the IME.
		 */
		function isComposingEvent(event, card) {
			if (event.isComposing || event.keyCode === 229) return true;
			const surface = card.querySelector(INPUT);
			if (surface !== null && surface.hasAttribute('data-composer-composing')) return true;
			return Date.now() - lastCompositionEnd < COMPOSITION_GRACE_MS;
		}

		/**
		 * Capture-phase keydown, installed on `document`.
		 *
		 * Capture is what makes this reliable: Lexical's own handler sits on the
		 * contenteditable in the bubble phase, so claiming the event here means the
		 * composer's Enter command never runs.
		 * @param event - the keydown.
		 */
		function onKeyDownCapture(event) {
			if (event.key !== 'Enter') return;

			const card = cardOf(event.target);
			if (card === null || !card.hasAttribute(EXPANDED)) return;

			/* IME: this Enter commits the candidate word. Never touch it. */
			if (isComposingEvent(event, card)) return;

			/* Shift+Enter is already the official newline; ⌘/Ctrl+Enter keeps its
			   official meaning (send / steer) and is one of the ways out of the
			   immersive state; Alt and AltGraph combos stay with the shipped
			   handler untouched. Only the bare Enter is redefined. */
			if (event.shiftKey) return;
			if (event.altKey || event.getModifierState?.('AltGraph') === true) return;
			if (event.metaKey || event.ctrlKey) {
				const primary = primaryButtonOf(card);
				if (primary !== null && primary.disabled === false) collapseCard(card);
				return;
			}

			/* Bare Enter: swap "send" for "newline". */
			event.preventDefault();
			event.stopImmediatePropagation();
			insertNewline(card.querySelector(INPUT) ?? event.target);
		}

		/**
		 * The composer's primary (send) button.
		 *
		 * The input bar renders the tools first and the primary button last inside
		 * the card, so it is the card's last `<button>`. Our own button lives in
		 * the card's top overlay anchor, i.e. before it in document order.
		 * @param card - the composer card.
		 * @returns the button, or null.
		 */
		function primaryButtonOf(card) {
			const buttons = card.querySelectorAll('button');
			for (let index = buttons.length - 1; index >= 0; index -= 1) {
				const button = buttons[index];
				if (!button.classList.contains(BUTTON_CLASS)) return button;
			}
			return null;
		}

		/**
		 * Capture-phase `compositionend`: start the grace window during which the
		 * next Enter still belongs to the IME.
		 */
		function onCompositionEnd() {
			lastCompositionEnd = Date.now();
		}

		/**
		 * Is a popup actually on screen?
		 *
		 * Several of these markers (`[role="menu"]`, the menu backing layer) stay in
		 * the DOM while closed, so matching the selector alone is not enough — the
		 * first version of this check silently disabled Esc for good. A closed
		 * popup is hidden, so it has no client rects.
		 * @returns whether a visible popup owns the keyboard.
		 */
		function hasVisiblePopup() {
			for (const node of document.querySelectorAll(POPUP_SELECTOR)) {
				if (!(node instanceof Element)) continue;
				if (node.closest('[aria-hidden="true"]') !== null) continue;
				const style = window.getComputedStyle(node);
				if (style.display === 'none' || style.visibility === 'hidden') continue;
				if (node.getClientRects().length === 0) continue;
				return true;
			}
			return false;
		}

		/**
		 * Bubble-phase keydown: Esc leaves the immersive state.
		 *
		 * Bubble phase is deliberate — it runs after Lexical's own Escape command,
		 * so `defaultPrevented` already tells us that a popup menu consumed the
		 * key. The composer itself must also be involved: with a modal open the
		 * focus is elsewhere and this is a no-op.
		 *
		 * This handler must NOT call `preventDefault()`: the shipped "press Esc
		 * twice to stop" gesture reads `gesture.defaultPrevented` at the window
		 * bubble phase, and marking the event handled here would silently disable
		 * it. Collapsing without consuming the key lets both behaviours coexist.
		 * @param event - the keydown.
		 */
		function onKeyDownBubble(event) {
			if (event.key !== 'Escape') return;
			if (event.defaultPrevented) return;
			/* The rendered marker is the truth for the DOM handlers; the module's
			   ledger is only what the React side renders from. */
			if (document.querySelector(`${CARD}[${EXPANDED}]`) === null) return;

			const target = event.target instanceof Element ? event.target : null;
			const active = document.activeElement instanceof Element ? document.activeElement : null;

			/* Prefer the composer the keyboard is actually in, but fall back to the
			   expanded composer that is on screen: once the pointer has been
			   anywhere else (the transcript, the sidebar) the focus is outside the
			   card, and Escape still has to leave the immersive state. */
			const focusedCard = [target, active]
				.map((node) => (node === null ? null : node.closest(CARD)))
				.find((candidate) => candidate !== null && candidate.hasAttribute(EXPANDED));
			const card = focusedCard ?? visibleExpandedCard();
			if (card === null || card === undefined) return;

			/* An IME candidate window owns Escape: that press cancels the candidate
			   and must not also tear the composer down. Same guard as Enter. */
			if (isComposingEvent(event, card)) return;

			/* A popup menu or a modal owns Escape (the shipped
			   `arbitrate("escape")`; the official modal set is
			   `[role="dialog"][aria-modal="true"], [role="menu"]`). */
			if (hasVisiblePopup()) return;

			/* Some other text surface owns the keyboard — a terminal, a search
			   box. Only exempted when the focus really is outside the composer. */
			if (focusedCard === undefined && ownsAnotherEditor(active)) return;

			collapseCard(card);
		}

		/* ─────────────────────────────────────────────────────────────────────
		 * Wheel: inside the expanded panel, scrolling must stay inside it.
		 * ───────────────────────────────────────────────────────────────────── */

		/**
		 * Capture-phase wheel.
		 *
		 * The shipped `installDraftWheel` listens on the draft's own scrollport and
		 * — by design — hands the wheel over to the conversation scrollport once
		 * the draft hits an edge (`host.scrollTop += e.deltaY`). In the collapsed
		 * composer that is a feature. In the expanded panel the transcript sits
		 * behind the card and is not what the user is looking at, so it reads as
		 * "scrolling the text also scrolls the conversation".
		 *
		 * Claiming the event on the way down stops it before it reaches that
		 * listener. Native scrolling is a *default action*, not a listener, so the
		 * panel keeps scrolling normally; only the hand-off disappears.
		 * @param event - the wheel event.
		 */
		function onWheelCapture(event) {
			const node = event.target;
			if (!(node instanceof Element)) return;
			const surface = node.closest(INPUT_SCROLL);
			if (surface === null) return;
			const card = surface.closest(CARD);
			if (card === null || !card.hasAttribute(EXPANDED)) return;
			event.stopPropagation();
		}

		/* ─────────────────────────────────────────────────────────────────────
		 * Click: sending collapses.
		 * ───────────────────────────────────────────────────────────────────── */

		/**
		 * Capture-phase click. A press on the composer's primary button is the one
		 * and only "send" gesture available in the immersive state, so it is also
		 * the moment to come back down. Disabled buttons never dispatch a click,
		 * which covers "cannot send right now" for free.
		 * @param event - the click.
		 */
		function onClickCapture(event) {
			const node = event.target;
			if (!(node instanceof Element)) return;
			const button = node.closest('button');
			if (button === null || button.classList.contains(BUTTON_CLASS)) return;
			const card = button.closest(CARD);
			if (card === null || !card.hasAttribute(EXPANDED)) return;
			if (primaryButtonOf(card) !== button) return;
			collapseCard(card);
		}

		/* ─────────────────────────────────────────────────────────────────────
		 * The stylesheet.
		 * ───────────────────────────────────────────────────────────────────── */

		/**
		 * Selector for "the conversation scroll body whose composer is expanded".
		 * `:has()` is not nestable, so this compound is built once and reused.
		 */
		const OPEN_SCROLL = `${SCROLL}:has(${CARD}[${EXPANDED}])`;
		/** Selector for the seat of an expanded composer. */
		const OPEN_SEAT = `${SEAT}:has(${CARD}[${EXPANDED}])`;

		const CSS = `
/* ── ① 展开按钮：与第一行文字垂直居中，上/右留白相等 ──────────────────────────
   槽位 \`conversation.input.overlay\` 渲染在卡片自己的 .overlayAnchor 里
   （position:absolute; inset:0 0 auto; height:0）—— 那个盒子横跨卡片上沿、
   高度为 0，所以绝对定位的按钮天然落在卡片右上角，两个轴都以卡片为基准。

   纵轴让按钮中心落在**第一行文字**（也就是 placeholder）的中心上。那一行相对
   卡片边框盒的中心是：
     卡片 padding-top 8
     + 写字区 padding-top 4
     + 行高 / 2          ← 行高 = calc(24px + var(--dsh-content-font-delta))
     = 24px + delta/2
   按钮高 26px，所以 top = 24 + delta/2 − 13 = 11px + delta/2。
   这个表达式跟着主题字号走：默认 14px 字号时 delta=0 → 11px；
   本 profile 的 15px 字号时 delta=1px → 11.5px。 */
${CARD} {
  --dsh-composer-expand-size: 26px;
  --dsh-composer-expand-inset: calc(11px + var(--dsh-content-font-delta, 0px) / 2);
}
.${BUTTON_CLASS} {
  position: absolute;
  top: var(--dsh-composer-expand-inset);
  right: var(--dsh-composer-expand-inset);
  z-index: 3;
  box-sizing: border-box;
  width: var(--dsh-composer-expand-size);
  height: var(--dsh-composer-expand-size);
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  /* 圆形底：hover 时落下的是一个正圆 */
  border-radius: 999px;
  corner-shape: round;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  transition: background-color .1s, color .1s;
}
.${BUTTON_CLASS}:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.${BUTTON_CLASS}:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 写字区右侧留出按钮的位置，正文不会跑到按钮底下。
   官方写字区是 padding:4px 8px 0 14px，这里只改右内边距：
   按钮右缘 + 6px 呼吸位。 */
${CARD} ${INPUT} {
  padding-right: calc(var(--dsh-composer-expand-inset) + var(--dsh-composer-expand-size) + 6px);
}

/* ── ② 覆盖态：座位脱离文档流，浮在消息区之上 ────────────────────────────────
   对话态里座位是 \`position:sticky;bottom:0\`，仍在文档流内 —— 卡片长高就会把
   消息区顶上去（那就是「重排」）。展开时把它改成绝对定位：

   \`[data-conversation-scroll]\`（滚动容器）**必须保持 static**。它是座位最近的
   定位祖先，一旦给它 position:relative，座位就会以它（一个滚动容器）为包含块：
   座位会跟着内容滚走，而且滚动容器被撑成 0 高之后消息会彻底不可滚（官方给
   composer-overlay 预留的那套规则正是这么写的，实测 scrollHeight==clientHeight、
   maxScroll==0、末条消息被裁到滚动口下方）。保持 static，包含块就落到
   \`[data-conversation-content]\`（.body，官方已声明 position:relative，且**不是**
   滚动容器）—— 座位既不随内容滚动，也不被裁剪。
   特异性 (0,4,0) 高于官方 \`.root[data-phase=active] .composerSeat\` 的 (0,3,0)。
   \`right\` 要减掉滚动条槽：包含块从滚动容器换成 .body 之后，座位会比原来宽出
   一条 \`scrollbar-gutter\`，居中的卡片会跟着右移半条槽。主题包在 body 上声明的
   \`--dsh-scrollbar-width\` 只是个近似（默认 5px，实测槽更宽），所以真正的宽度由
   JS 量出来写在 \`--dsh-composer-expand-gutter\` 上，下面那个值只是兜底。 */
${CONTENT} ${OPEN_SEAT} {
  position: absolute;
  left: 0;
  right: var(--dsh-composer-expand-gutter, var(--dsh-scrollbar-width, 5px));
  bottom: 0;
  z-index: 8;
}

/* ── ③ 把座位让出来的高度还给消息区 ─────────────────────────────────────────
   座位既然脱离了文档流，它原本占的那段滚动高度就没了；如果不管，滚动范围会
   突然缩短，滚动位置被夹取 —— 用户会看到消息「跳」一下。
   官方自己的 ResizeObserver 已经把座位高度写成了滚动容器上的
   \`--dsh-composer-height\`（chat 的「滚到底」也依赖它），这里直接拿它当消息区的
   下内边距：滚动范围与展开前严丝合缝，也能把最后一条消息滚到卡片上方来看。 */
${OPEN_SCROLL} > ${SESSION_SLOT} > * {
  padding-bottom: var(--dsh-composer-height, 128px);
}

/* ── ④ 新会话态（hero）也要落到底部 ─────────────────────────────────────────
   官方 hero 把「大标题 + 工作区行 + 输入卡片」整块垂直居中，栈上还有 32px 底距。
   展开时把这两条压掉，座位就落到与对话态同一个位置（hero 没有消息区，不需要
   ③ 那份补偿）。 */
${CONTENT}[data-content-phase="hero"]:has(${CARD}[${EXPANDED}]) > ${SCROLL} {
  justify-content: flex-start;
}
${CONTENT}[data-content-phase="hero"] ${OPEN_SEAT} {
  background: var(--dsw-alias-bg-base);
}
${CONTENT}[data-content-phase="hero"]:has(${CARD}[${EXPANDED}]) ${SEAT} :has(${CARD}):not(:has(> ${CARD})):not([data-slot]):not([data-chain-overlay-fallback]) {
  padding-bottom: 0;
}

/* ── ⑤ 卡片长高：写字区吃掉整张卡片，内部滚动 ────────────────────────────────
   高度由 JS 量出对话区高度后写成自定义属性（65%）；\`65vh\` 只是首次测量前的
   兜底。写字区官方上限定死 336px（--dsh-composer-text-max-height），这里不改那个
   变量（审批面板也用它）而只解除写字区自己的上限，并让它 flex:1。 */
${CARD}[${EXPANDED}] {
  height: var(${HEIGHT_VAR}, 65vh);
}
${CARD}[${EXPANDED}] ${INPUT_SCROLL} {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  /* 面板里滚到底就停住，不要把滚动接力给后面的对话列表。
     官方 JS（installDraftWheel）在草稿滚动区触边时会把滚轮转发给对话滚动容器，
     那一步由 onWheelCapture 拦掉；这条是浏览器原生滚动链的兜底。 */
  overscroll-behavior: contain;
}
`;

		/* ─────────────────────────────────────────────────────────────────────
		 * The button.
		 * ───────────────────────────────────────────────────────────────────── */

		/** Official icon set, when the primitives package is reachable. */
		let icons = null;
		try {
			const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
			const expand = primitives.IconChevronsUpDownOutlineRegular;
			const collapse = primitives.IconChevronDownOutlineRegular;
			if (typeof expand === 'function' && typeof collapse === 'function') icons = { expand, collapse };
		} catch (error) {
			/* Fall back to the inline artwork below; never let an icon take the
			   plugin down. */
		}

		/**
		 * Inline fallback artwork, drawn to match the shipped 16x16 outline icons
		 * (stroke `currentColor`, 1px, round caps) so the button does not change
		 * shape if the icon module is unreachable.
		 * @param props - `up`/`down` arms to draw.
		 * @returns the svg element.
		 */
		function fallbackIcon({ up, down }) {
			const arms = [];
			if (up) arms.push(React.createElement('path', { key: 'up', d: 'm5.1 6 2.9-2.9L10.9 6' }));
			if (down) arms.push(React.createElement('path', { key: 'down', d: 'm5.1 10 2.9 2.9 2.9-2.9' }));
			return React.createElement(
				'svg',
				{
					width: 16,
					height: 16,
					viewBox: '0 0 16 16',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
				},
				arms,
			);
		}

		/**
		 * The expand/collapse button, rendered into the composer's top overlay
		 * anchor.
		 *
		 * It owns two things beyond its own markup: the `data-composer-expanded`
		 * marker on the card (which is what the stylesheet and the DOM handlers
		 * read) and the card's measured height, kept fresh by a ResizeObserver on
		 * the conversation area.
		 * @param props - slot props; `composerExpandSessionId` comes from `inject`.
		 * @returns the button.
		 */
		function ComposerExpandButton(props) {
			/* Fast path: the session standard kit carries `sessionId`, and our own
			   `inject` mirrors it under a name we own. Fallback: read the id the
			   conversation body already publishes
			   (`[data-conversation-content][data-conversation-session]`), so the
			   plugin still works if neither prop arrives. */
			const ref = React.useRef(null);
			const cardRef = React.useRef(null);
			const [sessionId, setSessionId] = React.useState(
				props.composerExpandSessionId ?? props.sessionId,
			);

			React.useLayoutEffect(() => {
				const button = ref.current;
				const card = button === null ? null : button.closest(CARD);
				cardRef.current = card;
				if (sessionId !== undefined) return;
				const body = card === null ? null : card.closest(CONTENT);
				const id = body === null ? null : body.getAttribute('data-conversation-session');
				if (id !== null && id !== undefined && id !== '') setSessionId(id);
			}, [sessionId]);

			const expanded = React.useSyncExternalStore(
				subscribe,
				() => isExpanded(sessionId),
				() => false,
			);

			React.useEffect(() => {
				const card = cardRef.current;
				if (card === null) return undefined;
				if (!expanded) {
					disarmCard(card);
					return undefined;
				}

				card[SESSION_KEY] = sessionId;
				card.setAttribute(EXPANDED, '');
				syncHeight(card);

				const scroll = card.closest(SCROLL);
				const observer = new ResizeObserver(() => syncHeight(card));
				if (scroll !== null) observer.observe(scroll);
				card[RESIZE_KEY] = observer;

				return () => {
					observer.disconnect();
					delete card[RESIZE_KEY];
					delete card[SESSION_KEY];
					delete card.__dshComposerExpandHeight;
				};
			}, [expanded, sessionId]);

			/* Unmount: the composer can be torn down (or handed to another session)
			   while it is expanded, and the card element outlives the button. The
			   marker must not survive into a session that is not expanded. */
			React.useEffect(
				() => () => {
					const card = cardRef.current;
					if (card === null) return;
					disarmCard(card);
				},
				[],
			);

			/* Icon-only button, so the accessible name is the whole affordance. The
			   shell has no locale namespace for this plugin, so the two labels the
			   product actually ships are picked from the document language. */
			const label =
				(document.documentElement.lang ?? '').toLowerCase().startsWith('zh')
					? expanded
						? '收起输入框'
						: '展开输入框'
					: expanded
						? 'Collapse the input'
						: 'Expand the input';
			const icon =
				icons === null
					? expanded
						? fallbackIcon({ down: true })
						: fallbackIcon({ up: true, down: true })
					: React.createElement(expanded ? icons.collapse : icons.expand, { size: 16 });

			return React.createElement(
				'button',
				{
					ref,
					type: 'button',
					className: BUTTON_CLASS,
					'data-composer-expand-toggle': expanded ? 'collapse' : 'expand',
					'data-composer-expand-session': sessionId,
					'aria-label': label,
					'aria-expanded': expanded,
					/* Same trick the shipped toolbar buttons use: keep the caret in
					   the draft instead of moving focus to the button. */
					onMouseDown: (event) => event.preventDefault(),
					onClick: () => {
						const next = !isExpanded(sessionId);
						setExpanded(sessionId, next);
						if (!next) return;
						/* Land the caret where the writing happens. */
						const card = cardRef.current;
						const surface = card === null ? null : card.querySelector(INPUT);
						if (surface !== null) {
							window.requestAnimationFrame(() => surface.focus({ preventScroll: true }));
						}
					},
				},
				icon,
			);
		}

		/* ─────────────────────────────────────────────────────────────────────
		 * Install.
		 * ───────────────────────────────────────────────────────────────────── */

		/**
		 * Install the stylesheet, the keydown/click interception and the button
		 * seat. `ctx.effect` removes all of it again on unload and re-runs on hot
		 * reload, so iterations never stack duplicate tags or listeners.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(
				() => {
					const tag = document.createElement('style');
					tag.dataset.plugin = PLUGIN_ID;
					tag.textContent = CSS;
					document.head.appendChild(tag);

					document.addEventListener('keydown', onKeyDownCapture, true);
					document.addEventListener('compositionend', onCompositionEnd, true);
					document.addEventListener('keydown', onKeyDownBubble, false);
					document.addEventListener('click', onClickCapture, true);
					document.addEventListener('wheel', onWheelCapture, { capture: true, passive: true });
					window.addEventListener('resize', syncAllHeights);

					return () => {
						document.removeEventListener('keydown', onKeyDownCapture, true);
						document.removeEventListener('compositionend', onCompositionEnd, true);
						document.removeEventListener('keydown', onKeyDownBubble, false);
						document.removeEventListener('click', onClickCapture, true);
						document.removeEventListener('wheel', onWheelCapture, true);
						window.removeEventListener('resize', syncAllHeights);
						for (const card of document.querySelectorAll(`${CARD}[${EXPANDED}]`)) {
							disarmCard(card);
						}
						tag.remove();
					};
				},
				'composer-expand: stylesheet, key map and overlay seat',
			);

			ctx.slots.inject('conversation.input.overlay', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.overlay',
						id: 'composer-expand',
						/* The shipped occupants sit at 0/1/2; keep this one behind them. */
						order: SEAT_ORDER,
						/* The slot is session-scoped, and `inject` receives the scope's
						   key — i.e. the session id, which is what the per-session ledger
						   is keyed by. */
						inject: (sessionId) => ({ composerExpandSessionId: sessionId }),
					},
					ComposerExpandButton,
				),
			);
		}

		exports.apply = apply;
		/** `slots` for the button's seat. */
		exports.inject = ['slots'];
		return module.exports;
	},
});
