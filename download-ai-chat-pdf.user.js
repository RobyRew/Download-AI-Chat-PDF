// ==UserScript==
// @name         Download AI Chat PDF
// @namespace    https://github.com/RobyRew/Download-AI-Chat-PDF
// @version      1.1.0
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
 *      by its stable id (so virtualized rows are captured while on screen) and
 *      rewriting the layouts Chrome splits badly across pages,
 *   3. appends one clean copy of all messages to <body>, wrapped in shallow
 *      copies of the original ancestors so the site's own CSS still applies,
 *   4. hides the rest of the page, switches to the light theme (optional), sets
 *      the tab title to the chat title (= the PDF file name), opens the dialog,
 *   5. restores everything when the dialog closes.
 *
 * Print-critical overrides are inline `!important` styles: the sites ship their
 * own print CSS inside cascade layers, and a layered `!important` outranks any
 * unlayered stylesheet rule, but not an inline one.
 *
 * No network requests, no external libraries, no innerHTML (Gemini enforces
 * Trusted Types).
 */

(function () {
    'use strict';

    const VERSION = '1.1.0';
    const NS = 'aicp';
    const ID = { root: 'aicp-root', btn: 'aicp-btn', overlay: 'aicp-overlay', settings: 'aicp-settings', toast: 'aicp-toast' };

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
        theme: 'light',          // 'light' = printer-friendly light theme, 'page' = keep the page's current theme
        paper: 'auto',           // 'auto' (chosen in the print dialog) | 'A4' | 'letter'
        orientation: 'portrait', // 'portrait' | 'landscape'
        margins: 'normal',       // 'normal' | 'narrow' | 'none'
        scale: 100,              // text size in percent: 85 | 100 | 115
        header: true,            // title / site / date / link block at the top of the PDF
        images: true,            // keep images in the PDF
        hijackPrint: true,       // ⌘P / Ctrl+P runs the full-chat export instead of printing the visible part
        showButton: true,        // floating PDF button
    };
    const MARGINS = { normal: '12mm 12mm 14mm', narrow: '6mm', none: '0' };
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
            css: '',
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
    // Icon outlines adapted from Lucide (ISC License, https://lucide.dev): file-down and settings.
    const ICON_PDF = ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M12 11v6', 'M9 14l3 3 3-3'];
    const ICON_GEAR = [
        'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
        'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    ];

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const putStyle = (node, prop, value) => node.style.setProperty(prop, value, 'important');

    /** Runs `fn` once <html> exists (at document-start some managers run before it does). */
    function whenRoot(fn) {
        if (document.documentElement) { fn(); return; }
        const mo = new MutationObserver(() => {
            if (!document.documentElement) return;
            mo.disconnect();
            fn();
        });
        mo.observe(document, { childList: true });
    }

    /** A stylesheet that survives a strict style-src CSP and can be rewritten later. */
    function makeSheet(css) {
        let style = null;
        let sheet = null;
        if (typeof GM_addStyle === 'function') {
            try { style = GM_addStyle(css); } catch (_) { style = null; }
        }
        if (!style) {
            style = document.createElement('style');
            style.textContent = css;
        }
        const node = style;
        whenRoot(() => {
            if (!node.isConnected) (document.head || document.documentElement).append(node);
            // A strict style-src CSP leaves the <style> without rules; CSSOM sheets are not subject to it.
            if ((!node.sheet || !node.sheet.cssRules.length) && 'adoptedStyleSheets' in Document.prototype) {
                try {
                    sheet = new CSSStyleSheet();
                    sheet.replaceSync(node.textContent);
                    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
                } catch (_) { sheet = null; }
            }
        });
        return {
            set(text) {
                if (style) style.textContent = text;
                if (sheet) { try { sheet.replaceSync(text); } catch (_) { /* keep the old rules */ } }
            },
        };
    }

    /** Any CSS colour (rgb, oklch, color(), …) → [r, g, b, a] via a 1×1 canvas. */
    const rgbaCache = new Map();
    let paint = null;
    function rgba(color) {
        const key = String(color);
        if (rgbaCache.has(key)) return rgbaCache.get(key);
        let out = null;
        try {
            if (!paint) {
                const c = document.createElement('canvas');
                c.width = c.height = 1;
                paint = c.getContext('2d', { willReadFrequently: true });
            }
            paint.clearRect(0, 0, 1, 1);
            paint.fillStyle = '#000';
            paint.fillStyle = key;
            paint.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
            out = [r, g, b, a / 255];
        } catch (_) {
            // Canvas reads blocked (anti-fingerprinting) or unavailable: plain rgb()/rgba() only.
            const m = key.match(/rgba?\(([^)]+)\)/);
            const [r = 255, g = 255, b = 255, a = 1] = m ? m[1].split(/[\s,/]+/).filter(Boolean).map(Number) : [];
            out = [r, g, b, a];
        }
        rgbaCache.set(key, out);
        return out;
    }
    const luminance = (color) => {
        const [r, g, b] = rgba(color);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const pageIsDark = () => luminance(getComputedStyle(document.body).backgroundColor) < 0.45;

    /** Nearest painted background behind `node` (stops at `limit`). */
    function backdrop(node, limit) {
        for (let n = node; n && n !== limit; n = n.parentElement) {
            const bg = getComputedStyle(n).backgroundColor;
            if (rgba(bg)[3] > 0.5) return { node: n, color: bg };
        }
        return { node: null, color: '#fff' };
    }

    /**
     * Some sites colour code tokens for the dark theme only (Grok), so after switching to light
     * the code is light-on-light. Such blocks get a dark background back, keeping the token colours.
     * Returns the undo functions.
     */
    function fixCodeContrast(root) {
        const undo = [];
        for (const pre of root.querySelectorAll('pre')) {
            const inks = [pre, ...pre.querySelectorAll('span')].slice(0, 300)
                .filter((n) => (n.textContent || '').trim())
                .map((n) => luminance(getComputedStyle(n).color));
            if (!inks.length) continue;
            const ink = inks.reduce((a, b) => a + b, 0) / inks.length;
            const back = backdrop(pre, root);
            if (ink < 0.62 || luminance(back.color) < 0.62) continue;
            const box = back.node && back.node !== root && back.node.offsetHeight <= pre.offsetHeight + 120 ? back.node : pre;
            undo.push(setStyle(box, 'background', '#1f2328'));
            if (box === pre) { undo.push(setStyle(pre, 'padding', '12px 14px')); undo.push(setStyle(pre, 'border-radius', '8px')); }
        }
        return undo;
    }

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

    const XHTML = 'http://www.w3.org/1999/xhtml';
    const BLOCKISH = /^(block|flex|grid|table|list-item|flow-root)$/;
    const CHROME_LABEL = /^(copy|copy code|copied!?|edit|edit message|retry|regenerate|share|run|good response|bad response|read aloud|more actions?|show (more|less)|see more|read more|expand|collapse)$/i;

    /** In-flow children of a flex/grid container (display:contents wrappers are looked through). */
    function flowKids(node) {
        const out = [];
        for (const k of node.children) {
            const ks = getComputedStyle(k);
            if (ks.display === 'none' || ks.position === 'absolute' || ks.position === 'fixed') continue;
            if (ks.display === 'contents') out.push(...flowKids(k));
            else out.push(k);
        }
        return out;
    }

    /**
     * Chrome splits some layouts badly across printed pages: a tall column flexbox overlaps
     * the next item and cuts the last page, scroll boxes print as one clipped screen, masks
     * fade every page edge, inline wrappers around blocks misplace them after a page break.
     * Rewrites those spots on the copy from the live element's computed layout.
     */
    function normalize(orig, copy) {
        const origEls = [orig, ...orig.querySelectorAll('*')];
        const copyEls = [copy, ...copy.querySelectorAll('*')];
        if (origEls.length !== copyEls.length) return;
        const index = new Map(origEls.map((n, i) => [n, i]));
        for (let i = 0; i < origEls.length; i++) {
            const o = origEls[i];
            const c = copyEls[i];
            if (o.namespaceURI !== XHTML) continue;
            const s = getComputedStyle(o);
            if (s.display === 'none') continue;
            if (/(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`)) { putStyle(c, 'overflow', 'visible'); putStyle(c, 'max-height', 'none'); }
            if (s.position === 'sticky' || s.position === 'fixed') { putStyle(c, 'position', 'relative'); putStyle(c, 'top', 'auto'); putStyle(c, 'bottom', 'auto'); }
            if ((s.maskImage && s.maskImage !== 'none') || (s.webkitMaskImage && s.webkitMaskImage !== 'none')) {
                putStyle(c, 'mask', 'none');
                putStyle(c, '-webkit-mask', 'none');
            }
            if (s.display === 'inline') {
                // Only in-flow block children count: KaTeX keeps an absolutely positioned MathML copy inside its inline span.
                const blockChild = [...o.children].some((k) => {
                    const ks = getComputedStyle(k);
                    return BLOCKISH.test(ks.display) && ks.position !== 'absolute' && ks.position !== 'fixed' && ks.float === 'none';
                });
                if (blockChild) putStyle(c, 'display', 'block');
                continue;
            }
            const flexColumn = s.display.includes('flex') && s.flexDirection === 'column';
            const grid = s.display.includes('grid');
            if (!flexColumn && !grid) continue;
            const box = o.getBoundingClientRect();
            if (box.height < 150) continue;
            const kids = flowKids(o);
            const rects = kids.map((k) => k.getBoundingClientRect());
            // Only stacks are rewritten; a grid with items side by side keeps its layout.
            if (grid && rects.some((r, j) => j > 0 && r.top < rects[j - 1].bottom - 1)) continue;
            putStyle(c, 'display', 'block');
            const left = box.left + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth);
            const right = box.right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth);
            const inner = right - left;
            const gap = parseFloat(s.rowGap) || 0;
            kids.forEach((k, j) => {
                const ck = copyEls[index.get(k)];
                if (!ck) return;
                const ks = getComputedStyle(k);
                // Flex/grid items are blockified (an inline <span> bubble computes to block); pin that,
                // or the span turns inline again and its background breaks into line fragments.
                putStyle(ck, 'display', ks.display);
                if (j > 0 && gap) putStyle(ck, 'margin-top', `${gap + (parseFloat(ks.marginTop) || 0)}px`);
                const r = rects[j];
                if (inner <= 0 || r.width >= inner - 2) return;
                // A narrower item is a non-stretched flex item: it sized to its content (fit-content,
                // still capped by its own max-width) and keeps its side — right-aligned bubbles stay right.
                const gl = r.left - left;
                const gr = right - r.right;
                putStyle(ck, 'width', 'fit-content');
                if (Math.abs(gl - gr) < 2) { putStyle(ck, 'margin-left', 'auto'); putStyle(ck, 'margin-right', 'auto'); }
                else if (gr < gl) putStyle(ck, 'margin-left', 'auto');
            });
        }
    }

    /** Deep copy of one rendered message, cleaned for print. */
    function snapshot(node) {
        const clone = node.cloneNode(true);
        normalize(node, clone);

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
        // Icon-font glyphs are private-use characters (Claude's action bar), so they don't count as text.
        clone.querySelectorAll('button, [role="button"]').forEach((b) => {
            if (b.querySelector('img, picture, video')) return;
            const text = (b.textContent || '').replace(/[\p{Co}\p{Cf}]/gu, '').trim();
            const label = (b.getAttribute('aria-label') || '').trim();
            if (!text || CHROME_LABEL.test(text) || CHROME_LABEL.test(label)) b.remove();
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
     * Wrappers at or above the chat's scroller are app frame: their side padding and margins
     * hold the sidebar offset, so those are zeroed.
     */
    function captureShells(turns, scroller) {
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
            const css = {
                display: display === 'contents' ? 'contents' : 'block',
                position: 'static', transform: 'none', inset: 'auto',
                height: 'auto', 'min-height': '0', 'max-height': 'none', width: 'auto', 'min-width': '0',
                overflow: 'visible', contain: 'none', 'content-visibility': 'visible', flex: 'none',
                'margin-top': '0', 'margin-bottom': '0', 'box-shadow': 'none', border: '0', background: 'transparent',
                mask: 'none', '-webkit-mask': 'none',
            };
            if (scroller && (orig === scroller || orig.contains(scroller))) {
                Object.assign(css, { padding: '0', 'margin-left': '0', 'margin-right': '0', 'max-width': 'none' });
            }
            for (const [p, v] of Object.entries(css)) putStyle(shell, p, v);
            return shell;
        });
    }

    function newCapture() {
        return { path: location.pathname, items: new Map(), order: [], shells: null, shellsFrom: 0, scroller: null };
    }

    /**
     * Copy every message currently rendered into `cap`, preserving conversation order.
     * A batch with no already-known neighbour is appended, which is only correct while
     * moving downwards — so harvesting happens during the top-to-bottom sweep only.
     */
    function harvest(cap) {
        const turns = findTurns();
        if (!turns.length) return 0;
        if (!cap.scroller) cap.scroller = findScroller(turns[0]);
        if (turns.length > cap.shellsFrom && (turns.length > 1 || !cap.shells)) {
            cap.shells = captureShells(turns, cap.scroller);
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
        cap.scroller = sc;
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

    function pageCss() {
        const size = settings.paper === 'auto'
            ? (settings.orientation === 'landscape' ? 'landscape' : 'auto')
            : `${settings.paper} ${settings.orientation}`;
        return `@page { size: ${size}; margin: ${MARGINS[settings.margins] || MARGINS.normal}; }`;
    }

    function buildRoot(cap, title) {
        const root = el('div', { id: ID.root, 'data-site': site.id, 'data-theme': settings.theme });
        if (!settings.images) root.setAttribute('data-images', 'off');
        if (settings.scale && settings.scale !== 100) putStyle(root, 'zoom', String(settings.scale / 100));
        if (settings.header) {
            const now = new Date();
            root.append(el('header', { class: 'aicp-header' },
                el('div', { class: 'aicp-h-title', text: title }),
                el('div', { class: 'aicp-h-meta', text: `${site.name} · exported ${stamp(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}` }),
                el('div', { class: 'aicp-h-url', text: location.href.split('?')[0] }),
            ));
        }
        let outer = el('div', { class: 'aicp-shell' });
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

    /**
     * Puts the copy in place for printing; returns { root, unstage }. Synchronous on purpose
     * (beforeprint). The page itself is hidden with inline !important styles because the sites'
     * own print rules live in cascade layers, where !important beats any unlayered stylesheet.
     * While staged the copy is also what the screen shows behind the print dialog.
     */
    function stage(cap) {
        const title = chatTitle();
        const root = buildRoot(cap, title);
        document.body.append(root);
        const undo = [() => root.remove()];
        const hide = (n) => { if (n.nodeType === 1 && n !== root) undo.push(setStyle(n, 'display', 'none')); };
        [...document.body.children].forEach(hide);
        // Anything a site mounts for its own print view while the dialog is open stays hidden too.
        const mo = new MutationObserver((recs) => recs.forEach((r) => r.addedNodes.forEach(hide)));
        mo.observe(document.body, { childList: true });
        undo.push(() => mo.disconnect());
        undo.push(setStyle(root, 'display', 'block'));
        undo.push(swapClasses(docEl(), [], ['aicp-printing']));
        if (settings.theme === 'light') {
            undo.push(site.light());
            undo.push(...fixCodeContrast(root));
        }
        const pageBg = settings.theme === 'light' ? '#ffffff' : getComputedStyle(document.body).backgroundColor;
        const frameCss = {
            height: 'auto', 'min-height': '0', 'max-height': 'none', overflow: 'visible', position: 'static',
            transform: 'none', background: pageBg, 'print-color-adjust': 'exact', '-webkit-print-color-adjust': 'exact',
        };
        for (const n of [docEl(), document.body]) {
            for (const [p, v] of Object.entries(frameCss)) undo.push(setStyle(n, p, v));
        }
        for (const [p, v] of Object.entries({ display: 'block', margin: '0', padding: '0', width: 'auto' })) undo.push(setStyle(document.body, p, v));
        pageSheet.set(pageCss());
        undo.push(() => pageSheet.set('@page {}'));
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
        closeSettings();
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
            ui.close();
            const { root, unstage } = stage(cap);
            await imagesReady(root);
            await frame();
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
            if (staged) staged.unstage();
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

    // Registered at document-start, so it runs before the sites' own print handlers. While this
    // script prints, those handlers are stopped: ChatGPT, for one, mounts its own print document
    // whose layered "hide everything else" rule would blank the PDF.
    window.addEventListener('beforeprint', (e) => {
        if (ownPrint) { e.stopImmediatePropagation(); return; }
        if (staged || busy || !document.body || !findTurns().length) return;
        // Browser-menu print (File ▸ Print…) can't wait for loading: print what is rendered now,
        // merged with the last full capture of this chat if there is one.
        const cap = lastCapture && lastCapture.path === location.pathname ? lastCapture : newCapture();
        harvest(cap);
        const { unstage } = stage(cap);
        e.stopImmediatePropagation();
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
    // UI: split button (PDF | ⚙), options card, progress card, toast
    // ═══════════════════════════════════════════════════════════════

    const POS_KEY = `pos:${site.id}`;
    let btn = null;

    function placeButton() {
        const pos = storage.get(POS_KEY, null);
        const w = btn.offsetWidth || 96;
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
        const main = el('button', {
            type: 'button',
            class: 'aicp-main',
            title: `Save the full chat as PDF${settings.hijackPrint ? ' (⌘P / Ctrl+P)' : ''} — drag to move`,
            'aria-label': 'Save the full chat as PDF',
        }, svgIcon(ICON_PDF), el('span', { text: 'PDF' }));
        const gear = el('button', { type: 'button', class: 'aicp-gear', title: 'PDF options', 'aria-label': 'PDF options' }, svgIcon(ICON_GEAR));
        btn = el('div', { id: ID.btn, role: 'group', 'aria-label': 'Download AI Chat PDF' }, main, el('span', { class: 'aicp-sep', 'aria-hidden': 'true' }), gear);

        // Drag anywhere on the pill; a plain click runs the half that was clicked.
        let drag = null;
        let dragged = false;
        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const r = btn.getBoundingClientRect();
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, top: r.top, moved: false };
        });
        btn.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (!drag.moved) {
                if (Math.hypot(dx, dy) < 5) return;
                drag.moved = true;
                try { btn.setPointerCapture(drag.id); } catch (_) { /* synthetic pointer */ }
            }
            btn.style.right = `${Math.max(4, Math.min(window.innerWidth - btn.offsetWidth - 4, drag.right - dx))}px`;
            btn.style.top = `${Math.max(4, Math.min(window.innerHeight - btn.offsetHeight - 4, drag.top + dy))}px`;
        });
        const end = () => {
            if (!drag) return;
            if (drag.moved) {
                dragged = true;
                setTimeout(() => { dragged = false; }, 0);
                try { btn.releasePointerCapture(drag.id); } catch (_) { /* already released */ }
                storage.set(POS_KEY, { right: parseFloat(btn.style.right), top: parseFloat(btn.style.top) });
            }
            drag = null;
        };
        btn.addEventListener('pointerup', end);
        btn.addEventListener('pointercancel', end);
        main.addEventListener('click', (e) => { if (dragged) { e.preventDefault(); return; } exportChat(); });
        gear.addEventListener('click', (e) => { if (dragged) { e.preventDefault(); return; } openSettings(); });
        document.body.append(btn);
        placeButton();
    }

    function refreshButton() {
        if (!document.body || staged) return;
        if (!btn || !btn.isConnected) makeButton();
        const show = settings.showButton && findTurns().length > 0;
        btn.hidden = !show;
        if (show) btn.setAttribute('data-tone', pageIsDark() ? 'dark' : 'light');
    }

    /** Full-screen backdrop + card, closed by Esc or a click outside the card. */
    function modal(id, onClose) {
        const card = el('div', { class: 'aicp-card' });
        const overlay = el('div', { id, class: 'aicp-modal', 'data-tone': pageIsDark() ? 'dark' : 'light' }, card);
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        // Swallow wheel/touch so the reader can't fight the automatic scrolling underneath.
        overlay.addEventListener('wheel', (e) => { if (!card.contains(e.target)) e.preventDefault(); }, { passive: false });
        overlay.addEventListener('touchmove', (e) => { if (!card.contains(e.target)) e.preventDefault(); }, { passive: false });
        window.addEventListener('keydown', onKey, true);
        document.body.append(overlay);
        let closed = false;
        return {
            overlay,
            card,
            close() {
                if (closed) return;
                closed = true;
                window.removeEventListener('keydown', onKey, true);
                overlay.remove();
            },
        };
    }

    let settingsModal = null;
    function closeSettings() {
        if (settingsModal) settingsModal.close();
        settingsModal = null;
    }

    function openSettings() {
        if (settingsModal || busy) return;
        const m = modal(ID.settings, closeSettings);
        settingsModal = m;
        m.overlay.addEventListener('pointerdown', (e) => { if (e.target === m.overlay) closeSettings(); });

        const change = (key, value) => {
            settings[key] = value;
            saveSettings();
            registerMenu();
            if (btn && key === 'hijackPrint') btn.remove();
            refreshButton();
        };
        const segmented = (label, key, options) => {
            const group = el('div', { class: 'aicp-seg', role: 'radiogroup', 'aria-label': label });
            const paint = () => [...group.children].forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === String(settings[key]))));
            for (const [value, text] of options) {
                group.append(el('button', {
                    type: 'button', role: 'radio', 'data-value': String(value), text,
                    onclick: () => { change(key, value); paint(); },
                }));
            }
            paint();
            return el('div', { class: 'aicp-row' }, el('div', { class: 'aicp-label', text: label }), group);
        };
        const toggle = (label, key) => {
            const sw = el('button', { type: 'button', role: 'switch', class: 'aicp-switch', 'aria-label': label });
            const paint = () => sw.setAttribute('aria-checked', String(!!settings[key]));
            sw.addEventListener('click', () => { change(key, !settings[key]); paint(); });
            paint();
            return el('div', { class: 'aicp-toggle' }, el('span', { text: label }), sw);
        };

        m.card.append(
            el('div', { class: 'aicp-head' },
                el('div', { class: 'aicp-title', text: 'PDF options' }),
                el('button', { type: 'button', class: 'aicp-x', 'aria-label': 'Close', text: '✕', onclick: closeSettings }),
            ),
            segmented('Colours', 'theme', [['light', 'Light'], ['page', 'Same as page']]),
            segmented('Paper', 'paper', [['auto', 'Choose in dialog'], ['A4', 'A4'], ['letter', 'Letter']]),
            segmented('Orientation', 'orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']]),
            segmented('Margins', 'margins', [['normal', 'Normal'], ['narrow', 'Narrow'], ['none', 'None']]),
            segmented('Text size', 'scale', [[85, 'Small'], [100, 'Normal'], [115, 'Large']]),
            el('div', { class: 'aicp-toggles' },
                toggle('Title, date and link on top', 'header'),
                toggle('Images', 'images'),
                toggle('⌘P / Ctrl+P prints the full chat', 'hijackPrint'),
            ),
            el('div', { class: 'aicp-actions' },
                el('button', {
                    type: 'button', class: 'aicp-link', text: 'Reset button position',
                    onclick: () => { storage.set(POS_KEY, null); if (btn) placeButton(); },
                }),
                el('button', { type: 'button', class: 'aicp-primary', text: 'Save PDF', onclick: () => { closeSettings(); exportChat(); } }),
            ),
        );
        const first = m.card.querySelector('[aria-checked="true"]');
        if (first) first.focus();
    }

    function progress(onCancel) {
        let m = null;
        const title = el('div', { class: 'aicp-title', text: 'Loading the full chat…' });
        const sub = el('div', { class: 'aicp-sub', text: '' });
        const fill = el('div', { class: 'aicp-fill' });
        const bar = el('div', { class: 'aicp-bar', 'data-indeterminate': '1' }, fill);
        const doCancel = () => { onCancel(); m.close(); };
        const cancel = el('button', { type: 'button', class: 'aicp-cancel', text: 'Cancel', onclick: doCancel });
        m = modal(ID.overlay, doCancel);
        m.card.classList.add('aicp-progress');
        m.card.setAttribute('role', 'status');
        m.card.setAttribute('aria-live', 'polite');
        m.card.append(title, sub, bar, cancel);
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
            close: () => m.close(),
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
    const M = `#${ID.overlay}, #${ID.settings}`;

    makeSheet(`
#${ID.btn}, ${M} {
  --aicp-bg: rgba(255,255,255,.92); --aicp-solid: #fff; --aicp-fg: #1d1d1f; --aicp-line: rgba(0,0,0,.12);
  --aicp-fill: rgba(0,0,0,.06); --aicp-muted: #6e6e73; --aicp-accent: #1d1d1f; --aicp-on-accent: #fff;
}
#${ID.btn}[data-tone="dark"], ${M.split(', ').map((s) => `${s}[data-tone="dark"]`).join(', ')} {
  --aicp-bg: rgba(44,44,46,.9); --aicp-solid: #636366; --aicp-fg: #f5f5f7; --aicp-line: rgba(255,255,255,.14);
  --aicp-fill: rgba(255,255,255,.08); --aicp-muted: #a1a1a6; --aicp-accent: #f5f5f7; --aicp-on-accent: #1d1d1f;
}

#${ID.btn} {
  position: fixed; z-index: 2147483000; top: 72px; right: 28px;
  display: inline-flex; align-items: stretch; height: 34px; box-sizing: border-box; overflow: hidden;
  border-radius: 999px; border: 1px solid var(--aicp-line); background: var(--aicp-bg); color: var(--aicp-fg);
  font: 600 13px/1 ${FONT}; letter-spacing: .01em; user-select: none; touch-action: none;
  box-shadow: 0 1px 2px rgba(0,0,0,.10), 0 6px 18px rgba(0,0,0,.12);
  -webkit-backdrop-filter: blur(12px) saturate(1.4); backdrop-filter: blur(12px) saturate(1.4);
  opacity: .92; transition: opacity .15s ease, box-shadow .15s ease;
}
#${ID.btn}:hover { opacity: 1; box-shadow: 0 1px 2px rgba(0,0,0,.12), 0 10px 26px rgba(0,0,0,.18); }
#${ID.btn} button {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  cursor: pointer; color: inherit; font: inherit; transition: background .12s ease;
}
#${ID.btn} button:hover { background: var(--aicp-fill); }
#${ID.btn} button:active { background: var(--aicp-line); }
#${ID.btn} button:focus-visible { outline: 2px solid #4c8dff; outline-offset: -3px; border-radius: 999px; }
#${ID.btn} .aicp-main { padding: 0 11px 0 11px; }
#${ID.btn} .aicp-gear { padding: 0 10px 0 8px; }
#${ID.btn} .aicp-sep { width: 1px; margin: 8px 0; background: var(--aicp-line); flex: none; }
#${ID.btn} svg { width: 16px; height: 16px; flex: none; }
#${ID.btn} .aicp-gear svg { width: 15px; height: 15px; }
#${ID.btn}[hidden] { display: none !important; }
#${ID.btn}.aicp-busy { opacity: .55; pointer-events: none; }

${M} {
  position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center;
  background: rgba(0,0,0,.28); font: 14px/1.45 ${FONT}; color: var(--aicp-fg);
}
${M.split(', ').map((s) => `${s} .aicp-card`).join(', ')} {
  width: min(340px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
  padding: 20px 22px 16px; border-radius: 16px; display: grid; gap: 10px;
  background: var(--aicp-bg); color: var(--aicp-fg); border: 1px solid var(--aicp-line);
  box-shadow: 0 18px 50px rgba(0,0,0,.28);
  -webkit-backdrop-filter: blur(20px) saturate(1.5); backdrop-filter: blur(20px) saturate(1.5);
}
${M} button { font: inherit; color: inherit; }
${M} .aicp-title { font-weight: 650; font-size: 15px; }
#${ID.overlay} .aicp-card { text-align: center; }
#${ID.overlay} .aicp-sub { color: var(--aicp-muted); font-size: 13px; min-height: 1.2em; font-variant-numeric: tabular-nums; }
#${ID.overlay} .aicp-bar { position: relative; height: 4px; border-radius: 4px; overflow: hidden; background: var(--aicp-line); }
#${ID.overlay} .aicp-fill { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--aicp-accent); border-radius: 4px; transition: width .2s ease; }
#${ID.overlay} .aicp-bar[data-indeterminate] .aicp-fill { width: 35% !important; animation: aicp-slide 1.1s ease-in-out infinite; }
@keyframes aicp-slide { 0% { left: -35%; } 100% { left: 100%; } }
#${ID.overlay} .aicp-cancel {
  justify-self: center; margin-top: 4px; padding: 6px 14px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--aicp-line); background: transparent; font-weight: 500; font-size: 13px;
}
#${ID.overlay} .aicp-cancel:hover { background: var(--aicp-fill); }

#${ID.settings} .aicp-card { width: min(380px, calc(100vw - 32px)); gap: 14px; padding: 18px 18px 14px; text-align: left; }
#${ID.settings} .aicp-head { display: flex; align-items: center; justify-content: space-between; }
#${ID.settings} .aicp-x {
  all: unset; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 50%;
  cursor: pointer; color: var(--aicp-muted); font-size: 13px;
}
#${ID.settings} .aicp-x:hover { background: var(--aicp-fill); color: var(--aicp-fg); }
#${ID.settings} .aicp-row { display: grid; gap: 6px; }
#${ID.settings} .aicp-label { font-size: 12px; font-weight: 600; color: var(--aicp-muted); letter-spacing: .02em; }
#${ID.settings} .aicp-seg { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--aicp-fill); }
#${ID.settings} .aicp-seg button {
  all: unset; flex: 1; text-align: center; padding: 6px 6px; border-radius: 7px; cursor: pointer;
  font-size: 12.5px; color: var(--aicp-fg); white-space: nowrap; transition: background .12s ease;
}
#${ID.settings} .aicp-seg button:hover { background: var(--aicp-fill); }
#${ID.settings} .aicp-seg button[aria-checked="true"] { background: var(--aicp-solid); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.18); }
#${ID.settings} .aicp-toggles { display: grid; gap: 2px; padding-top: 2px; border-top: 1px solid var(--aicp-line); }
#${ID.settings} .aicp-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 0; font-size: 13.5px; }
#${ID.settings} .aicp-switch {
  all: unset; position: relative; flex: none; width: 38px; height: 22px; border-radius: 11px; cursor: pointer;
  background: var(--aicp-line); transition: background .15s ease;
}
#${ID.settings} .aicp-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .15s ease;
}
#${ID.settings} .aicp-switch[aria-checked="true"] { background: #34c759; }
#${ID.settings} .aicp-switch[aria-checked="true"]::after { transform: translateX(16px); }
#${ID.settings} button:focus-visible { outline: 2px solid #4c8dff; outline-offset: 2px; }
#${ID.settings} .aicp-actions { display: flex; align-items: center; gap: 8px; padding-top: 4px; }
#${ID.settings} .aicp-link { all: unset; margin-right: auto; cursor: pointer; font-size: 12.5px; color: var(--aicp-muted); }
#${ID.settings} .aicp-link:hover { color: var(--aicp-fg); text-decoration: underline; }
#${ID.settings} .aicp-primary {
  all: unset; cursor: pointer; padding: 8px 16px; border-radius: 999px; font-weight: 600; font-size: 13px;
  background: var(--aicp-accent); color: var(--aicp-on-accent);
}
#${ID.settings} .aicp-primary:hover { opacity: .88; }

#${ID.toast} {
  position: fixed; left: 50%; bottom: 110px; transform: translateX(-50%); z-index: 2147483002;
  max-width: min(520px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 12px;
  background: rgba(28,28,30,.94); color: #fff; font: 13px/1.4 ${FONT}; box-shadow: 0 8px 30px rgba(0,0,0,.25);
}
#${ID.toast}[hidden] { display: none !important; }

/* The copy only exists for printing (while staged it carries an inline display:block). */
#${ID.root} { display: none; }

@media print {
  html.aicp-printing body > *:not(#${ID.root}) { display: none !important; }
  #${ID.root}, #${ID.root} * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  #${ID.root} .aicp-turn, #${ID.root} .aicp-turn * { content-visibility: visible !important; contain: none !important; }
  #${ID.root} .aicp-turn {
    position: relative !important; inset: auto !important; transform: none !important;
    height: auto !important; min-height: 0 !important; max-height: none !important;
    opacity: 1 !important; visibility: visible !important;
  }
  #${ID.root} pre, #${ID.root} pre * { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
  #${ID.root} pre { overflow: visible !important; max-height: none !important; }
  #${ID.root} [class*="line-clamp"] { -webkit-line-clamp: unset !important; line-clamp: none !important; max-height: none !important; }
  /* "Show more" clamps are inline max-heights (ChatGPT uses max-height: 19lh on long prompts). */
  #${ID.root} .aicp-turn [style*="max-height"]:not(img):not(video):not(svg) { max-height: none !important; }
  #${ID.root} td, #${ID.root} th { overflow-wrap: anywhere; }
  #${ID.root} img { max-width: 100% !important; }
  #${ID.root}[data-images="off"] :is(img, picture, video) { display: none !important; }
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

    // @page (paper, orientation, margins) is written only while a print is staged.
    const pageSheet = makeSheet('@page {}');

    // ═══════════════════════════════════════════════════════════════
    // MENU COMMANDS
    // ═══════════════════════════════════════════════════════════════

    let menuIds = [];
    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        if (typeof GM_unregisterMenuCommand === 'function') menuIds.forEach((id) => { try { GM_unregisterMenuCommand(id); } catch (_) { /* gone */ } });
        menuIds = [];
        const add = (label, fn) => { try { menuIds.push(GM_registerMenuCommand(label, fn)); } catch (_) { /* unsupported */ } };
        add('🖨️ Save full chat as PDF', exportChat);
        add('⚙️ PDF options…', openSettings);
        add(`Floating button: ${settings.showButton ? 'Shown' : 'Hidden'} — switch`, () => {
            settings.showButton = !settings.showButton;
            saveSettings();
            registerMenu();
            refreshButton();
        });
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
