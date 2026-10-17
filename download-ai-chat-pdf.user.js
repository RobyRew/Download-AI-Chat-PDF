// ==UserScript==
// @name         Download AI Chat PDF
// @namespace    https://github.com/RobyRew/Download-AI-Chat-PDF
// @version      1.0.0
// @description  Save or print the ENTIRE current chat as a PDF on ChatGPT, Gemini, Claude and Grok. Loads lazy and virtualized history first, keeps the on-page look, and makes ⌘P / Ctrl+P print the whole conversation.
// @author       RobyRew
// @license      Apache-2.0
// @homepageURL  https://github.com/RobyRew/Download-AI-Chat-PDF
// @supportURL   https://github.com/RobyRew/Download-AI-Chat-PDF/issues
// @updateURL    https://github.com/RobyRew/Download-AI-Chat-PDF/releases/latest/download/download-ai-chat-pdf.meta.js
// @downloadURL  https://github.com/RobyRew/Download-AI-Chat-PDF/releases/latest/download/download-ai-chat-pdf.user.js
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23111'/%3E%3Cpath d='M22 12h14l10 10v28a3 3 0 0 1-3 3H22a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3z' fill='none' stroke='%23fff' stroke-width='3.5' stroke-linejoin='round'/%3E%3Cpath d='M36 12v10h10M32.5 29v14m-6-6 6 6 6-6' fill='none' stroke='%23fff' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://gemini.google.com/*
// @match        https://claude.ai/*
// @match        https://grok.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * How it works
 * ────────────
 * ChatGPT, Claude and Grok virtualize long chats: only the messages near the
 * viewport exist in the DOM, the rest are empty fixed-height placeholders
 * (that is the blank gap a plain ⌘P prints). Gemini instead lazy-loads older
 * turns when you reach the top.
 *
 * So an export:
 *   1. scrolls the chat's own scroller to the top until no older turns arrive,
 *   2. sweeps down one screen at a time, cloning every rendered message keyed
 *      by its stable id (so virtualized rows are captured while on screen),
 *   3. appends one clean copy of all messages to <body>, wrapped in shallow
 *      copies of the original ancestors so the site's own CSS still applies,
 *   4. switches the page to its light theme (optional), sets the tab title to
 *      the chat title (= the PDF file name) and opens the print dialog,
 *   5. removes the copy and restores theme/title when the dialog closes.
 *
 * No network requests, no external libraries, no innerHTML (Gemini enforces
 * Trusted Types).
 */

(function () {
    'use strict';

    const VERSION = '1.0.0';
    const NS = 'aicp';
    const ID = { root: 'aicp-root', btn: 'aicp-btn', overlay: 'aicp-overlay', toast: 'aicp-toast' };

    // ═══════════════════════════════════════════════════════════════
    // SETTINGS  (Tampermonkey storage when granted, localStorage otherwise)
    // ═══════════════════════════════════════════════════════════════

    const storage = {
        get(key, fallback) {
            try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback); } catch (_) { /* fall through */ }
            try {
                const raw = localStorage.getItem(`${NS}:${key}`);
                return raw === null ? fallback : JSON.parse(raw);
            } catch (_) { return fallback; }
        },
        set(key, value) {
            try { if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; } } catch (_) { /* fall through */ }
            try { localStorage.setItem(`${NS}:${key}`, JSON.stringify(value)); } catch (_) { /* private mode */ }
        },
    };

    const DEFAULTS = {
        theme: 'light',        // 'light' = printer-friendly light theme, 'page' = keep the page's current theme
        header: true,          // title / site / date / link block at the top of the PDF
        hijackPrint: true,     // ⌘P / Ctrl+P runs the full-chat export instead of printing the visible part
        showButton: true,      // floating PDF button
    };
    const settings = Object.assign({}, DEFAULTS, storage.get('settings', {}));
    const saveSettings = () => storage.set('settings', settings);

    // ═══════════════════════════════════════════════════════════════
    // SITE ADAPTERS
    // ═══════════════════════════════════════════════════════════════

    const docEl = () => document.documentElement;

    /** Each helper changes one thing and returns a function that undoes it. */
    function setAttr(el, name, value) {
        const prev = el.getAttribute(name);
        el.setAttribute(name, value);
        return () => (prev === null ? el.removeAttribute(name) : el.setAttribute(name, prev));
    }
    function swapClasses(el, remove, add) {
        const removed = remove.filter((c) => el.classList.contains(c));
        const added = add.filter((c) => !el.classList.contains(c));
        el.classList.remove(...remove);
        el.classList.add(...add);
        return () => { el.classList.remove(...added); el.classList.add(...removed); };
    }
    function setStyle(el, prop, value) {
        const prev = el.style.getPropertyValue(prop);
        const prio = el.style.getPropertyPriority(prop);
        el.style.setProperty(prop, value, 'important');
        return () => (prev ? el.style.setProperty(prop, prev, prio) : el.style.removeProperty(prop));
    }
    const combine = (...undos) => () => undos.reverse().forEach((u) => { try { u(); } catch (_) { /* best effort */ } });

    const SITES = [
        {
            id: 'chatgpt',
            name: 'ChatGPT',
            match: (h) => h === 'chatgpt.com' || h.endsWith('.chatgpt.com') || h === 'chat.openai.com',
            turns: ['[data-turn-key]', 'article[data-testid^="conversation-turn-"]', '[data-message-author-role]'],
            key: (el) => el.getAttribute('data-turn-key') || el.getAttribute('data-testid') || el.getAttribute('data-message-id'),
            scroller: ['.thread-scroll-container', '[data-scroll-root]'],
            strip: [],
            title: (t) => t.replace(/\s*[|–-]\s*ChatGPT\s*$/i, '').replace(/^ChatGPT$/i, ''),
            light: () => combine(setAttr(docEl(), 'data-theme', 'light'), setStyle(docEl(), 'color-scheme', 'light')),
            css: '#aicp-root .aicp-turn + .aicp-turn { margin-top: 12px; }',
        },
        {
            id: 'gemini',
            name: 'Gemini',
            match: (h) => h === 'gemini.google.com',
            turns: ['.conversation-container', 'div[id][class*="conversation-container"]'],
            key: (el) => el.id,
            scroller: ['infinite-scroller.chat-history', '#chat-history infinite-scroller', 'infinite-scroller'],
            // Gemini fetches older turns over the network when the top is reached.
            topQuiet: 2400,
            strip: [
                'message-actions', '.restart-chat-button-scroll-placeholder', 'model-response-disclaimers',
                '.luminous-expand-fade', 'freemium-rag-disclaimer', 'sensitive-memories-banner',
            ],
            fix(clone) {
                // Long prompts are clamped with a "collapsed" class; the full text is already in the DOM.
                clone.querySelectorAll('.collapsed, .luminous-collapsed').forEach((n) => n.classList.remove('collapsed', 'luminous-collapsed'));
            },
            title: (t) => t.replace(/\s*[|–-]\s*(Google\s+)?Gemini\s*$/i, '').replace(/^(Google\s+)?Gemini$/i, ''),
            light: () => combine(swapClasses(document.body, ['dark-theme'], ['light-theme']), setStyle(docEl(), 'color-scheme', 'light')),
            css: '#aicp-root user-query .query-text { max-height: none !important; -webkit-line-clamp: unset !important; }',
        },
        {
            id: 'claude',
            name: 'Claude',
            match: (h) => h === 'claude.ai' || h.endsWith('.claude.ai'),
            turns: ['[data-rs-index]', '[data-testid="transcript-row"]', '[data-test-render-count]'],
            key: (el) => el.getAttribute('data-index') || el.getAttribute('data-rs-index'),
            index: (el) => parseInt(el.getAttribute('data-index') || el.getAttribute('data-rs-index'), 10),
            // Each row's article carries aria-setsize = total messages in the thread.
            expected: () => {
                const a = document.querySelector('[data-rs-index] [aria-setsize], [data-testid="transcript-row"] [aria-setsize]');
                const n = a ? parseInt(a.getAttribute('aria-setsize'), 10) : 0;
                return Number.isFinite(n) ? n : 0;
            },
            scroller: ['[data-autoscroll-container]'],
            strip: [],
            title: (t) => t.replace(/\s*[|–-]\s*Claude\s*$/i, '').replace(/^Claude$/i, ''),
            // Claude scopes its theme with data-mode on <html> and on nested .cds-root wrappers.
            light: () => combine(
                ...[...document.querySelectorAll('[data-mode]')].map((n) => setAttr(n, 'data-mode', 'light')),
                setStyle(docEl(), 'color-scheme', 'light'),
            ),
            css: '',
        },
        {
            id: 'grok',
            name: 'Grok',
            match: (h) => h === 'grok.com' || h.endsWith('.grok.com'),
            turns: ['[data-plane-row]', '[id^="response-"]'],
            // Rows keyed "transcript:top-inset" / "transcript:bottom-spacing" are empty spacers.
            skip: (el) => /^transcript:/.test(el.getAttribute('data-plane-row') || ''),
            key: (el) => el.getAttribute('data-plane-row') || el.id,
            scroller: ['[data-testid="chat-transcript-scroller"]'],
            strip: [],
            title: (t) => t.replace(/\s*[|–-]\s*Grok\s*$/i, '').replace(/^Grok$/i, ''),
            light: () => combine(
                swapClasses(docEl(), ['dark', 'scheme-dark'], ['light', 'scheme-light']),
                setStyle(docEl(), 'color-scheme', 'light'),
            ),
            css: '',
        },
    ];

    const site = SITES.find((s) => s.match(location.hostname));
    if (!site) return;

    // ═══════════════════════════════════════════════════════════════
    // DOM HELPERS
    // ═══════════════════════════════════════════════════════════════

    function el(tag, props, ...kids) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v == null) continue;
            if (k === 'class') node.className = v;
            else if (k === 'text') node.textContent = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v);
        }
        for (const kid of kids.flat()) if (kid != null) node.append(kid);
        return node;
    }

    function svgIcon(paths) {
        const NSS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NSS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        for (const d of paths) {
            const p = document.createElementNS(NSS, 'path');
            p.setAttribute('d', d);
            svg.append(p);
        }
        return svg;
    }
    const ICON_PDF = ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M12 11v6', 'M9 14l3 3 3-3'];

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

    function addCss(css) {
        if (typeof GM_addStyle === 'function') {
            try { return GM_addStyle(css); } catch (_) { /* fall through */ }
        }
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).append(style);
        // A strict style-src CSP leaves the <style> without rules; CSSOM sheets are not subject to it.
        if ((!style.sheet || !style.sheet.cssRules.length) && 'adoptedStyleSheets' in Document.prototype) {
            try {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(css);
                document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            } catch (_) { /* nothing else to try */ }
        }
        return style;
    }

    function luminance(color) {
        const m = String(color).match(/rgba?\(([^)]+)\)/);
        if (!m) return 1;
        const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (a === 0) return 1;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    const pageIsDark = () => luminance(getComputedStyle(document.body).backgroundColor) < 0.45;

    // ═══════════════════════════════════════════════════════════════
    // FINDING THE CHAT
    // ═══════════════════════════════════════════════════════════════

    function findTurns() {
        for (const sel of site.turns) {
            const list = [...document.querySelectorAll(sel)].filter((n) => !n.closest(`#${ID.root}`) && !(site.skip && site.skip(n)));
            if (!list.length) continue;
            // Keep only outermost matches (a selector may also match nested nodes).
            return list.filter((n) => !list.some((o) => o !== n && o.contains(n)));
        }
        return [];
    }

    function isScrollable(node) {
        if (!node || node.nodeType !== 1) return false;
        const oy = getComputedStyle(node).overflowY;
        return /(auto|scroll|overlay)/.test(oy) && node.scrollHeight > node.clientHeight + 4;
    }

    function findScroller(turn) {
        for (const sel of site.scroller) {
            const cands = [...document.querySelectorAll(sel)].filter((n) => n.contains(turn));
            const hit = cands.find(isScrollable) || cands[0];
            if (hit) return hit;
        }
        for (let n = turn.parentElement; n && n !== document.body; n = n.parentElement) {
            if (isScrollable(n)) return n;
        }
        return document.scrollingElement || document.documentElement;
    }

    function keyOf(node) {
        const k = site.key(node);
        if (k) return `k:${k}`;
        // Fallback when a site drops its ids: content fingerprint.
        const t = (node.textContent || '').trim();
        let h = 0;
        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
        return `h:${t.length}:${h}`;
    }

    const weight = (node) => (node.textContent || '').length + 64 * node.querySelectorAll('img,svg,canvas,video,table,pre').length;

    // ═══════════════════════════════════════════════════════════════
    // SNAPSHOTS
    // ═══════════════════════════════════════════════════════════════

    const CHROME_LABEL = /^(copy|copy code|copied!?|edit|edit message|retry|regenerate|share|run|good response|bad response|read aloud|more actions?|show (more|less)|see more|read more|expand|collapse)$/i;

    /** Deep copy of one rendered message, cleaned for print. */
    function snapshot(node) {
        const clone = node.cloneNode(true);

        // <canvas> pixels are not cloned; carry them over as images.
        const srcCanvases = node.querySelectorAll('canvas');
        if (srcCanvases.length) {
            const dstCanvases = clone.querySelectorAll('canvas');
            srcCanvases.forEach((c, i) => {
                try {
                    const img = document.createElement('img');
                    img.src = c.toDataURL('image/png');
                    img.style.width = `${c.clientWidth || c.width}px`;
                    img.style.maxWidth = '100%';
                    dstCanvases[i].replaceWith(img);
                } catch (_) { /* tainted canvas: leave it blank */ }
            });
        }

        clone.querySelectorAll('img').forEach((img) => {
            img.loading = 'eager';
            img.removeAttribute('loading');
        });

        // Embedded frames would reload (often blank or cross-origin) inside a PDF.
        clone.querySelectorAll('iframe').forEach((f) => {
            const label = f.title || f.getAttribute('aria-label') || 'Embedded content';
            f.replaceWith(el('div', { class: 'aicp-embed', text: `[${label}]` }));
        });

        if (site.strip.length) clone.querySelectorAll(site.strip.join(',')).forEach((n) => n.remove());

        // Icon-only buttons and copy/edit chrome; buttons with text or images (attachments) stay.
        clone.querySelectorAll('button, [role="button"]').forEach((b) => {
            const text = (b.textContent || '').trim();
            if (b.querySelector('img, picture, video')) return;
            if (!text || CHROME_LABEL.test(text)) b.remove();
        });

        clone.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));

        // Ids move to data-aicp-id so page scripts never find the copy; SVG-internal ids stay
        // because gradients and <use> refer to them.
        const renameId = (n) => {
            if (!n.id || n.closest('svg')) return;
            n.setAttribute('data-aicp-id', n.id);
            n.removeAttribute('id');
        };
        renameId(clone);
        clone.querySelectorAll('[id]').forEach(renameId);

        if (site.fix) site.fix(clone);
        clone.classList.add('aicp-turn');
        return clone;
    }

    const SHELL_DROP_STYLES = [
        'height', 'min-height', 'max-height', 'width', 'min-width', 'transform', 'translate', 'top', 'right', 'bottom', 'left',
        'inset', 'position', 'overflow', 'overflow-x', 'overflow-y', 'padding-top', 'padding-bottom', 'margin-top',
        'margin-bottom', 'margin-left', 'margin-right', 'contain', 'content-visibility', 'will-change',
        'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
    ];

    /**
     * Shallow copies of the ancestors from the message list up to <body>, so selectors such as
     * `.markdown h2`, inherited CSS variables and container queries keep matching the copy.
     */
    function captureShells(turns) {
        let list = turns[0].parentElement;
        if (turns.length > 1) {
            const last = turns[turns.length - 1];
            while (list && !list.contains(last)) list = list.parentElement;
        }
        const chain = [];
        for (let n = list; n && n !== document.body && n !== document.documentElement; n = n.parentElement) chain.unshift(n);
        return chain.map((orig) => {
            const shell = orig.cloneNode(false);
            const display = getComputedStyle(orig).display;
            if (shell.id) { shell.setAttribute('data-aicp-id', shell.id); shell.removeAttribute('id'); }
            for (const p of SHELL_DROP_STYLES) shell.style.removeProperty(p);
            // Tailwind `print:*` variants on app chrome would hide the copy in print.
            [...shell.classList].filter((c) => c.startsWith('print:')).forEach((c) => shell.classList.remove(c));
            ['tabindex', 'aria-busy', 'role', 'aria-label'].forEach((a) => shell.removeAttribute(a));
            shell.classList.add('aicp-shell');
            shell.setAttribute('data-aicp-display', display === 'contents' ? 'contents' : 'block');
            return shell;
        });
    }

    function newCapture() {
        return { path: location.pathname, items: new Map(), order: [], shells: null, shellsFrom: 0 };
    }

    /**
     * Copy every message currently rendered into `cap`, preserving conversation order.
     * A batch with no already-known neighbour is appended, which is only correct while
     * moving downwards — so harvesting happens during the top-to-bottom sweep only.
     */
    function harvest(cap) {
        const turns = findTurns();
        if (!turns.length) return 0;
        if (turns.length > cap.shellsFrom && (turns.length > 1 || !cap.shells)) {
            cap.shells = captureShells(turns);
            cap.shellsFrom = turns.length;
        }
        const keys = turns.map(keyOf);
        let added = 0;
        turns.forEach((node, i) => {
            const key = keys[i];
            const w = weight(node);
            const known = cap.items.get(key);
            if (known) {
                // Re-copy if this render is fuller (placeholders and half-rendered markdown are lighter).
                if (w > known.weight) { known.node = snapshot(node); known.weight = w; }
                return;
            }
            cap.items.set(key, { node: snapshot(node), weight: w, index: site.index ? site.index(node) : NaN });
            added++;
            // Place after the nearest earlier neighbour we already know, else before the nearest later one.
            let at = -1;
            for (let j = i - 1; j >= 0; j--) {
                const p = cap.order.indexOf(keys[j]);
                if (p !== -1) { at = p + 1; break; }
            }
            if (at === -1) {
                for (let j = i + 1; j < keys.length; j++) {
                    const p = cap.order.indexOf(keys[j]);
                    if (p !== -1) { at = p; break; }
                }
            }
            if (at === -1) at = cap.order.length;
            cap.order.splice(at, 0, key);
        });
        return added;
    }

    // ═══════════════════════════════════════════════════════════════
    // LOADING THE WHOLE CHAT
    // ═══════════════════════════════════════════════════════════════

    class Cancelled extends Error {}

    /** Resolves after DOM changes inside `target` have been quiet for `quiet` ms (capped at `max`). */
    function settle(target, quiet = 140, max = 1600) {
        return new Promise((resolve) => {
            let idle = null;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                mo.disconnect();
                clearTimeout(idle);
                clearTimeout(cap);
                resolve();
            };
            const arm = () => { clearTimeout(idle); idle = setTimeout(finish, quiet); };
            const mo = new MutationObserver(arm);
            mo.observe(target, { childList: true, subtree: true, characterData: true });
            const cap = setTimeout(finish, max);
            requestAnimationFrame(() => requestAnimationFrame(arm));
        });
    }

    const signature = (sc) => {
        const t = findTurns();
        return `${sc.scrollHeight}|${t.length}|${t.length ? keyOf(t[0]) : ''}`;
    };

    async function waitForChange(sc, before, quiet, ctl) {
        const end = Date.now() + quiet;
        while (Date.now() < end) {
            ctl.check();
            await sleep(120);
            if (signature(sc) !== before) return true;
        }
        return false;
    }

    /** Background tabs stop rendering (no rAF, virtualizers idle), so wait until the tab is visible. */
    async function whileHidden(ctl, ui) {
        while (document.hidden) {
            ctl.check();
            ui.update('Paused', 'Bring this tab back to the front to continue', null);
            await sleep(300);
        }
    }

    async function loadToTop(sc, ctl, ui) {
        const quiet = site.topQuiet || 700;
        let calm = 0;
        for (let round = 0; round < 1000 && calm < 2; round++) {
            ctl.check();
            await whileHidden(ctl, ui);
            const before = signature(sc);
            if (sc.scrollTop > 0) {
                sc.scrollTop = 0;
            } else {
                // Already at the top: nudge so the site sees a fresh scroll event.
                sc.scrollTop = 40;
                await frame();
                sc.scrollTop = 0;
            }
            const changed = await waitForChange(sc, before, quiet, ctl);
            calm = changed ? 0 : calm + 1;
            ui.update('Loading earlier messages…', `${findTurns().length} on screen`, null);
        }
    }

    async function sweepDown(sc, cap, ctl, ui) {
        sc.scrollTop = 0;
        await settle(sc);
        harvest(cap);
        let stuck = 0;
        for (let guard = 0; guard < 20000; guard++) {
            ctl.check();
            await whileHidden(ctl, ui);
            const prev = sc.scrollTop;
            sc.scrollTop = prev + Math.max(160, Math.floor(sc.clientHeight * 0.85));
            await settle(sc);
            harvest(cap);
            const progress = sc.scrollHeight > 0 ? (sc.scrollTop + sc.clientHeight) / sc.scrollHeight : 1;
            ui.update('Capturing messages…', `${cap.order.length} captured`, Math.min(1, progress));
            const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2;
            if (atBottom || sc.scrollTop <= prev) {
                // Give a last chance for late rows / growing scrollHeight before stopping.
                await settle(sc, 350, 2500);
                harvest(cap);
                if (++stuck >= 2) break;
            } else {
                stuck = 0;
            }
        }
    }

    async function captureFullChat(ctl, ui) {
        const first = findTurns()[0];
        if (!first) throw new Error('No conversation found on this page.');
        const sc = findScroller(first);
        const cap = newCapture();
        const startTop = sc.scrollTop;
        const wasAtBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 48;
        const undoSmooth = combine(setStyle(sc, 'scroll-behavior', 'auto'), setStyle(docEl(), 'scroll-behavior', 'auto'));
        try {
            await loadToTop(sc, ctl, ui);
            await sweepDown(sc, cap, ctl, ui);
            const expected = site.expected ? site.expected() : 0;
            for (let pass = 0; expected && cap.order.length < expected && pass < 2; pass++) {
                ui.update('Re-checking for skipped messages…', `${cap.order.length} / ${expected}`, null);
                await sweepDown(sc, cap, ctl, ui);
            }
            cap.expected = expected;
            // Sites that expose a numeric message index get a strict sort on it.
            const items = cap.order.map((k) => cap.items.get(k));
            if (items.length && items.every((it) => Number.isFinite(it.index))) {
                cap.order.sort((a, b) => cap.items.get(a).index - cap.items.get(b).index);
            }
        } finally {
            sc.scrollTop = wasAtBottom ? sc.scrollHeight : startTop;
            undoSmooth();
        }
        return cap;
    }

    // ═══════════════════════════════════════════════════════════════
    // PRINT DOCUMENT
    // ═══════════════════════════════════════════════════════════════

    function chatTitle() {
        const fromTitle = site.title(document.title || '').trim();
        if (fromTitle) return fromTitle;
        const first = findTurns()[0];
        const text = first ? (first.textContent || '').replace(/\s+/g, ' ').trim() : '';
        return text ? text.slice(0, 80) : `${site.name} chat`;
    }

    const pad = (n) => String(n).padStart(2, '0');
    function stamp(d = new Date()) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function fileName(title) {
        const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        return `${safe} - ${site.name} - ${stamp()}`;
    }

    function buildRoot(cap, title) {
        const root = el('div', { id: ID.root, 'data-site': site.id, 'data-theme': settings.theme });
        if (settings.header) {
            const now = new Date();
            root.append(el('header', { class: 'aicp-header' },
                el('div', { class: 'aicp-h-title', text: title }),
                el('div', { class: 'aicp-h-meta', text: `${site.name} · exported ${stamp(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}` }),
                el('div', { class: 'aicp-h-url', text: location.href.split('?')[0] }),
            ));
        }
        let outer = el('div', { class: 'aicp-shell', 'data-aicp-display': 'block' });
        let inner = outer;
        if (cap.shells && cap.shells.length) {
            const copies = cap.shells.map((s) => s.cloneNode(false));
            copies.reduce((parent, child) => { parent.append(child); return child; });
            outer = copies[0];
            inner = copies[copies.length - 1];
        }
        for (const key of cap.order) inner.append(cap.items.get(key).node.cloneNode(true));
        root.append(outer);
        return root;
    }

    async function imagesReady(root, timeout = 8000) {
        const imgs = [...root.querySelectorAll('img')].filter((i) => !i.complete);
        if (!imgs.length) return;
        await Promise.race([
            Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
            sleep(timeout),
        ]);
    }

    /** Puts the copy in place for printing; returns the undo function. Synchronous on purpose (beforeprint). */
    function stage(cap) {
        const title = chatTitle();
        const root = buildRoot(cap, title);
        document.body.append(root);
        const undo = [() => root.remove()];
        undo.push(swapClasses(docEl(), [], ['aicp-printing']));
        if (settings.theme === 'light') undo.push(site.light());
        const pageBg = settings.theme === 'light' ? '#ffffff' : getComputedStyle(document.body).backgroundColor;
        undo.push(setStyle(docEl(), '--aicp-page-bg', pageBg));
        const prevTitle = document.title;
        const pdfTitle = fileName(title);
        document.title = pdfTitle;
        undo.push(() => { if (document.title === pdfTitle) document.title = prevTitle; });
        let undone = false;
        const unstage = () => {
            if (undone) return;
            undone = true;
            combine(...undo)();
            staged = null;
        };
        staged = { root, unstage };
        return staged;
    }

    let staged = null;
    let ownPrint = false;
    let lastCapture = null;
    let busy = false;

    async function exportChat() {
        if (busy) return;
        if (!findTurns().length) { toast('Open a conversation first.'); return; }
        busy = true;
        setButtonBusy(true);
        const ctl = { cancelled: false, check() { if (this.cancelled) throw new Cancelled('cancelled'); } };
        const ui = progress(() => { ctl.cancelled = true; });
        try {
            const cap = await captureFullChat(ctl, ui);
            lastCapture = cap;
            if (cap.expected && cap.order.length < cap.expected) {
                toast(`Captured ${cap.order.length} of ${cap.expected} messages — some could not be loaded.`, 7000);
            }
            ui.update('Preparing PDF…', `${cap.order.length} messages`, 1);
            if (staged) staged.unstage();
            const { root, unstage } = stage(cap);
            await imagesReady(root);
            await frame();
            ui.close();
            await frame();
            ownPrint = true;
            window.addEventListener('afterprint', unstage, { once: true });
            try {
                window.print();
            } finally {
                ownPrint = false;
            }
            // Chromium's print() returns only after the dialog closes; afterprint covers the rest.
            if (navigator.userAgentData && navigator.userAgentData.brands && navigator.userAgentData.brands.some((b) => /Chromium/i.test(b.brand))) {
                setTimeout(unstage, 500);
            }
        } catch (err) {
            if (!(err instanceof Cancelled)) {
                console.error('[Download AI Chat PDF]', err);
                toast(`Export failed: ${err && err.message ? err.message : err}`, 7000);
            }
        } finally {
            ui.close();
            busy = false;
            setButtonBusy(false);
        }
    }

    // Browser-menu print (File ▸ Print…) can't wait for loading: print what is rendered now,
    // merged with the last full capture of this chat if there is one.
    window.addEventListener('beforeprint', () => {
        if (ownPrint || staged || busy || !document.body) return;
        if (!findTurns().length) return;
        const cap = lastCapture && lastCapture.path === location.pathname ? lastCapture : newCapture();
        harvest(cap);
        const { unstage } = stage(cap);
        window.addEventListener('afterprint', unstage, { once: true });
    });

    // ⌘P / Ctrl+P → full export (registered at document-start so it runs before the page's handlers).
    window.addEventListener('keydown', (e) => {
        if (!settings.hijackPrint) return;
        if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
        if ((e.key || '').toLowerCase() !== 'p' && e.code !== 'KeyP') return;
        if (!document.body || !findTurns().length) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) exportChat();
    }, true);

    // ═══════════════════════════════════════════════════════════════
    // UI: floating button, progress card, toast
    // ═══════════════════════════════════════════════════════════════

    const POS_KEY = `pos:${site.id}`;
    let btn = null;

    function placeButton() {
        const pos = storage.get(POS_KEY, null);
        const w = btn.offsetWidth || 72;
        const h = btn.offsetHeight || 34;
        const right = pos ? pos.right : 28;
        const top = pos ? pos.top : 72;
        btn.style.right = `${Math.max(4, Math.min(window.innerWidth - w - 4, right))}px`;
        btn.style.top = `${Math.max(4, Math.min(window.innerHeight - h - 4, top))}px`;
    }

    function setButtonBusy(on) {
        if (btn) btn.classList.toggle('aicp-busy', on);
    }

    function makeButton() {
        btn = el('button', {
            id: ID.btn,
            type: 'button',
            title: `Save the full chat as PDF${settings.hijackPrint ? ' (⌘P / Ctrl+P)' : ''} — drag to move`,
            'aria-label': 'Save the full chat as PDF',
        }, svgIcon(ICON_PDF), el('span', { text: 'PDF' }));

        let drag = null;
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const r = btn.getBoundingClientRect();
            drag = { x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, top: r.top, moved: false };
            try { btn.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
        });
        btn.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 5) return;
            drag.moved = true;
            btn.style.right = `${Math.max(4, Math.min(window.innerWidth - btn.offsetWidth - 4, drag.right - dx))}px`;
            btn.style.top = `${Math.max(4, Math.min(window.innerHeight - btn.offsetHeight - 4, drag.top + dy))}px`;
        });
        const end = (e) => {
            if (!drag) return;
            const moved = drag.moved;
            drag = null;
            try { btn.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
            if (moved) storage.set(POS_KEY, { right: parseFloat(btn.style.right), top: parseFloat(btn.style.top) });
            else if (e.type === 'pointerup') exportChat();
        };
        btn.addEventListener('pointerup', end);
        btn.addEventListener('pointercancel', end);
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); exportChat(); }
        });
        document.body.append(btn);
        placeButton();
    }

    function refreshButton() {
        if (!document.body) return;
        if (!btn || !btn.isConnected) makeButton();
        const show = settings.showButton && findTurns().length > 0;
        btn.hidden = !show;
        if (show) btn.setAttribute('data-tone', pageIsDark() ? 'dark' : 'light');
    }

    function progress(onCancel) {
        const title = el('div', { class: 'aicp-title', text: 'Loading the full chat…' });
        const sub = el('div', { class: 'aicp-sub', text: '' });
        const fill = el('div', { class: 'aicp-fill' });
        const bar = el('div', { class: 'aicp-bar', 'data-indeterminate': '1' }, fill);
        const cancel = el('button', { type: 'button', class: 'aicp-cancel', text: 'Cancel' });
        const card = el('div', { class: 'aicp-card', role: 'status', 'aria-live': 'polite' }, title, sub, bar, cancel);
        const overlay = el('div', { id: ID.overlay, 'data-tone': pageIsDark() ? 'dark' : 'light' }, card);
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); doCancel(); } };
        const doCancel = () => { onCancel(); close(); };
        // Swallow wheel/touch so the reader can't fight the automatic scrolling.
        overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
        overlay.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
        cancel.addEventListener('click', doCancel);
        window.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        let closed = false;
        function close() {
            if (closed) return;
            closed = true;
            window.removeEventListener('keydown', onKey, true);
            overlay.remove();
        }
        return {
            update(t, s, ratio) {
                title.textContent = t;
                sub.textContent = s || '';
                if (ratio == null) {
                    bar.setAttribute('data-indeterminate', '1');
                } else {
                    bar.removeAttribute('data-indeterminate');
                    fill.style.width = `${Math.round(ratio * 100)}%`;
                }
            },
            close,
        };
    }

    let toastTimer = null;
    function toast(message, ms = 4000) {
        if (!document.body) return;
        let t = document.getElementById(ID.toast);
        if (!t) {
            t = el('div', { id: ID.toast, role: 'status' });
            document.body.append(t);
        }
        t.textContent = message;
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.hidden = true; }, ms);
    }

    // ═══════════════════════════════════════════════════════════════
    // STYLES
    // ═══════════════════════════════════════════════════════════════

    const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

    addCss(`
#${ID.btn} {
  position: fixed; z-index: 2147483000; top: 72px; right: 28px;
  display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px 0 10px;
  border-radius: 999px; border: 1px solid var(--aicp-line); background: var(--aicp-bg); color: var(--aicp-fg);
  font: 600 13px/1 ${FONT}; letter-spacing: .01em; cursor: pointer; user-select: none; touch-action: none;
  box-shadow: 0 1px 2px rgba(0,0,0,.10), 0 6px 18px rgba(0,0,0,.12);
  -webkit-backdrop-filter: blur(12px) saturate(1.4); backdrop-filter: blur(12px) saturate(1.4);
  opacity: .9; transition: opacity .15s ease, transform .15s ease, box-shadow .15s ease;
}
#${ID.btn}, #${ID.overlay} { --aicp-bg: rgba(255,255,255,.92); --aicp-fg: #1d1d1f; --aicp-line: rgba(0,0,0,.12); --aicp-muted: #6e6e73; --aicp-accent: #1d1d1f; }
#${ID.btn}[data-tone="dark"], #${ID.overlay}[data-tone="dark"] { --aicp-bg: rgba(44,44,46,.9); --aicp-fg: #f5f5f7; --aicp-line: rgba(255,255,255,.14); --aicp-muted: #a1a1a6; --aicp-accent: #f5f5f7; }
#${ID.btn}:hover { opacity: 1; box-shadow: 0 1px 2px rgba(0,0,0,.12), 0 10px 26px rgba(0,0,0,.18); }
#${ID.btn}:active { transform: scale(.96); }
#${ID.btn}:focus-visible { outline: 2px solid #4c8dff; outline-offset: 2px; }
#${ID.btn} svg { width: 16px; height: 16px; flex: none; }
#${ID.btn}[hidden] { display: none !important; }
#${ID.btn}.aicp-busy { opacity: .55; pointer-events: none; }

#${ID.overlay} {
  position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center;
  background: rgba(0,0,0,.28); font: 14px/1.45 ${FONT};
}
#${ID.overlay} .aicp-card {
  width: min(340px, calc(100vw - 32px)); box-sizing: border-box; padding: 20px 22px 16px; border-radius: 16px;
  background: var(--aicp-bg); color: var(--aicp-fg); border: 1px solid var(--aicp-line);
  box-shadow: 0 18px 50px rgba(0,0,0,.28); display: grid; gap: 10px; text-align: center;
  -webkit-backdrop-filter: blur(20px) saturate(1.5); backdrop-filter: blur(20px) saturate(1.5);
}
#${ID.overlay} .aicp-title { font-weight: 650; font-size: 15px; }
#${ID.overlay} .aicp-sub { color: var(--aicp-muted); font-size: 13px; min-height: 1.2em; font-variant-numeric: tabular-nums; }
#${ID.overlay} .aicp-bar { position: relative; height: 4px; border-radius: 4px; overflow: hidden; background: var(--aicp-line); }
#${ID.overlay} .aicp-fill { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--aicp-accent); border-radius: 4px; transition: width .2s ease; }
#${ID.overlay} .aicp-bar[data-indeterminate] .aicp-fill { width: 35% !important; animation: aicp-slide 1.1s ease-in-out infinite; }
@keyframes aicp-slide { 0% { left: -35%; } 100% { left: 100%; } }
#${ID.overlay} .aicp-cancel {
  justify-self: center; margin-top: 4px; padding: 6px 14px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--aicp-line); background: transparent; color: var(--aicp-fg); font: 500 13px/1 ${FONT};
}
#${ID.overlay} .aicp-cancel:hover { background: var(--aicp-line); }

#${ID.toast} {
  position: fixed; left: 50%; bottom: 110px; transform: translateX(-50%); z-index: 2147483002;
  max-width: min(520px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 12px;
  background: rgba(28,28,30,.94); color: #fff; font: 13px/1.4 ${FONT}; box-shadow: 0 8px 30px rgba(0,0,0,.25);
}
#${ID.toast}[hidden] { display: none !important; }

/* The copy only exists for printing. */
@media screen { #${ID.root} { display: none !important; } }

@media print {
  @page { margin: 12mm 12mm 14mm; }

  html.aicp-printing, html.aicp-printing body {
    height: auto !important; min-height: 0 !important; max-height: none !important; width: auto !important;
    overflow: visible !important; position: static !important; display: block !important; transform: none !important;
    margin: 0 !important; padding: 0 !important;
    background: var(--aicp-page-bg, #fff) !important;
    -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important;
  }
  html.aicp-printing body > *:not(#${ID.root}) { display: none !important; }
  html.aicp-printing #${ID.root} { display: block !important; position: static !important; margin: 0 !important; padding: 0 !important; }

  #${ID.root}, #${ID.root} * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; content-visibility: visible !important; }

  #${ID.root} .aicp-shell {
    position: static !important; transform: none !important; inset: auto !important;
    height: auto !important; min-height: 0 !important; max-height: none !important;
    overflow: visible !important; contain: none !important; flex: none !important;
    margin-top: 0 !important; margin-bottom: 0 !important; box-shadow: none !important;
    border: 0 !important; background: transparent !important;
  }
  /* Flex layout is dropped, so flex-sized widths (Grok's \`w-0 flex-grow\`) fall back to auto. */
  #${ID.root} .aicp-shell[data-aicp-display="block"] { display: block !important; width: auto !important; min-width: 0 !important; }
  #${ID.root} .aicp-shell[data-aicp-display="contents"] { display: contents !important; }

  #${ID.root} .aicp-turn {
    position: relative !important; inset: auto !important; transform: none !important;
    height: auto !important; min-height: 0 !important; max-height: none !important;
    contain: none !important; opacity: 1 !important; visibility: visible !important;
  }

  #${ID.root} pre, #${ID.root} pre * { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
  #${ID.root} pre, #${ID.root} [class*="overflow-x-auto"], #${ID.root} [class*="overflow-auto"], #${ID.root} [class*="overflow-scroll"] {
    overflow: visible !important; max-height: none !important;
  }
  #${ID.root} [class*="sticky"] { position: relative !important; top: auto !important; }
  #${ID.root} [class*="line-clamp"] { -webkit-line-clamp: unset !important; line-clamp: none !important; max-height: none !important; }
  /* "Show more" clamps are inline max-heights (ChatGPT uses max-height: 19lh on long prompts). */
  #${ID.root} .aicp-turn [style*="max-height"]:not(img):not(video):not(svg) { max-height: none !important; }
  #${ID.root} td, #${ID.root} th { overflow-wrap: anywhere; }
  #${ID.root} img { max-width: 100% !important; }
  #${ID.root} img, #${ID.root} svg, #${ID.root} video, #${ID.root} figure, #${ID.root} tr, #${ID.root} .katex-display { break-inside: avoid; }
  #${ID.root} h1, #${ID.root} h2, #${ID.root} h3, #${ID.root} h4 { break-after: avoid; }

  #${ID.root} .aicp-header {
    font: 12px/1.45 ${FONT}; color: inherit; padding: 0 0 10px; margin: 0 0 18px;
    border-bottom: 1px solid rgba(128,128,128,.35); break-after: avoid;
  }
  #${ID.root} .aicp-h-title { font-size: 18px; font-weight: 650; margin-bottom: 2px; }
  #${ID.root} .aicp-h-meta, #${ID.root} .aicp-h-url { opacity: .7; overflow-wrap: anywhere; }
  #${ID.root} .aicp-embed { padding: 8px 10px; border: 1px dashed rgba(128,128,128,.5); border-radius: 8px; opacity: .8; font: 12px/1.4 ${FONT}; }
  ${site.css || ''}
}
`);

    // ═══════════════════════════════════════════════════════════════
    // MENU COMMANDS
    // ═══════════════════════════════════════════════════════════════

    let menuIds = [];
    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        if (typeof GM_unregisterMenuCommand === 'function') menuIds.forEach((id) => { try { GM_unregisterMenuCommand(id); } catch (_) { /* gone */ } });
        menuIds = [];
        const add = (label, fn) => { try { menuIds.push(GM_registerMenuCommand(label, fn)); } catch (_) { /* unsupported */ } };
        const toggle = (key, a, b) => () => {
            settings[key] = settings[key] === a ? b : a;
            saveSettings();
            registerMenu();
            refreshButton();
        };
        add('🖨️ Save full chat as PDF', exportChat);
        add(`Theme in PDF: ${settings.theme === 'light' ? 'Light (printer-friendly)' : 'Same as page'} — switch`, toggle('theme', 'light', 'page'));
        add(`Header block: ${settings.header ? 'On' : 'Off'} — switch`, toggle('header', true, false));
        add(`⌘P / Ctrl+P prints full chat: ${settings.hijackPrint ? 'On' : 'Off'} — switch`, toggle('hijackPrint', true, false));
        add(`Floating button: ${settings.showButton ? 'Shown' : 'Hidden'} — switch`, toggle('showButton', true, false));
        add('Reset button position', () => { storage.set(POS_KEY, null); if (btn) placeButton(); });
    }

    // ═══════════════════════════════════════════════════════════════
    // BOOT
    // ═══════════════════════════════════════════════════════════════

    function boot() {
        registerMenu();
        refreshButton();
        // SPA navigation and re-renders: cheap periodic check instead of a document-wide observer.
        setInterval(refreshButton, 1200);
        window.addEventListener('resize', () => { if (btn) placeButton(); });
        console.info(`[Download AI Chat PDF] v${VERSION} ready on ${site.name}`);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
