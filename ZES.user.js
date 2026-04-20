// ==UserScript==
// @name         Zotero Saved + Visited Highlighter (Multi-Site)
// @namespace    local.zotero.multi
// @version      0.4.0
// @description  Highlight Zotero-saved items + track visited WOS (SPA-safe)
// @match        https://scholar.google.com/*
// @match        https://scholar.google.com/scholar_labs/search/session/*
// @match        *://www-webofscience-com.ezproxy.libraries.wright.edu/wos/woscc/summary/*
// @match        https://pubmed.ncbi.nlm.nih.gov/*
// @match        https://arxiv.org/search/advanced?*
// @match        https://www.sciencedirect.com/search?*
// @match        https://www-sciencedirect-com.ezproxy.libraries.wright.edu/search?*
// @match        https://link.springer.com/search?*
// @match        https://link-springer-com.ezproxy.libraries.wright.edu/search?*
// @match        https://ieeexplore-ieee-org.ezproxy.libraries.wright.edu/search*
// @match        https://ieeexplore.ieee.org/search*
// @match        https://onlinelibrary-wiley-com.ezproxy.libraries.wright.edu/action/doSearch?*
// @match        https://onlinelibrary.wiley.com/action/doSearch?*
// @match        https://www-nature-com.ezproxy.libraries.wright.edu/search?*
// @match        https://www.nature.com/search?*
// @match        https://www.cell.com/action/doSearch?*
// @match        https://www-cell-com.ezproxy.libraries.wright.edu/action/doSearch?*
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(() => {
	"use strict";

	console.warn("ZOTERO HIGHLIGHTER LOADED", location.href);

	/* =========================
	 * CONFIG
	 * ========================= */
	const API = "http://127.0.0.1:9371/exists";
	const ZOTERO_COLOR = "#22c55e";

	const WOS_VISITED_KEY = "wosVisitedRecords_v1";
	const WOS_VISITED_OUTLINE = "2px solid #7c3aed";

	const SCAN_INTERVAL = 700;
	const SCAN_DURATION = 30000;

	const PROCESSED_ATTR = "data-zh-processed";

	/* =========================
	 * UTIL
	 * ========================= */
	const normalizeTitle = t =>
		(t || "")
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u2010-\u2015]/g, "-")
			.replace(/[.:;!?]+$/g, "")
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.replace(/\s+/g, " ")
			.trim();

	const cacheKey = ({ doi, title }) =>
		doi ? `doi:${doi.toLowerCase()}` : `title:${normalizeTitle(title)}`;

	const extractDOI = text =>
		(text || "").match(/10\.\d{4,9}\/[^\s"<>]+/i)?.[0] || null;

	const cleanText = el => {
		if (!el) return "";
		// innerText returns "" for not-yet-laid-out elements; textContent is the fallback
		const raw = el.innerText || el.textContent || "";
		return raw.replace(/\s+/g, " ").trim();
	};

	const isStableTitle = t =>
		t && t.length > 10 && !t.endsWith("…");

	/* =========================
	 * SITE CONFIG
	 *
	 * Each entry describes how to extract items on a given site.
	 *
	 * Required:
	 *   id          - short name; matched against hostname AND used as request prefix
	 *   itemSelector- CSS selector for the container that represents one result
	 *   titleNode   - (item) => the element to highlight and read title from
	 *
	 * Optional:
	 *   stripTitle  - (raw) => cleaned title string (default: cleanText + leading tag strip)
	 *   getDOI      - (item, titleNode) => doi string | null
	 *   getKey      - (item, titleNode, {title, doi}) => cache key (default: cacheKey)
	 *   requireStable - bool, enforce isStableTitle (default: true)
	 *   extra       - (item, titleNode) => object merged into the entry (e.g. {wosid})
	 * ========================= */

	// default DOI lookup: scan the closest reasonable container's text
	const defaultGetDOI = (item, _node) =>
		extractDOI(item.innerText);

	// default title: strip [PDF]/[HTML]/etc leading tag
	const defaultStripTitle = raw =>
		raw.replace(/^\[[^\]]+\]\s*/, "").trim();

	const SITES = [
		{
			id: "scholar.google.com",
			itemSelector: "div.gs_r",
			titleNode: item => item.querySelector("h3.gs_rt"),
			requireStable: false,
		},
		{
			id: "webofscience",
			itemSelector: 'a[data-ta="summary-record-title-link"]',
			titleNode: item => item,
			getDOI: (_item, node) => extractDOI(node.closest("app-summary-title")?.innerText),
			requireStable: false,
			extra: (_item, node) => {
				const wosid = (node.href || "").match(/WOS:\w+/)?.[0] || null;
				return { wosid };
			},
		},
		{
			id: "pubmed",
			itemSelector: "a.docsum-title",
			titleNode: item => item,
			getDOI: () => null,
		},
		{
			id: "arxiv",
			itemSelector: "li.arxiv-result",
			titleNode: item => item.querySelector("p.title"),
			getKey: (item, _node, { title, doi }) => {
				const arxivId = item.querySelector('a[href*="/abs/"]')
					?.href.match(/\/abs\/([^?#]+)/)?.[1];
				return arxivId ? `arxiv:${arxivId}` : cacheKey({ title, doi });
			},
		},
		{
			id: "sciencedirect",
			itemSelector: 'a[href*="/science/article/pii/"]',
			titleNode: item => item,
			getDOI: (_item, node) => extractDOI(node.closest("li, div")?.innerText),
		},
		{
			id: "springer",
			itemSelector: "a.app-card-open__link",
			titleNode: item => item,
			getDOI: (_item, node) => extractDOI(node.closest("li, div, section")?.innerText),
		},
		{
			id: "ieee",
			itemSelector: "h3.text-md-md-lh a",
			titleNode: item => item,
			getDOI: (_item, node) => extractDOI(node.closest("div, li")?.innerText),
		},
		{
			id: "wiley",
			itemSelector: "h2.meta__title a.publication_title",
			titleNode: item => item,
			getDOI: (_item, node) => {
				const container = node.closest("h2.meta__title");
				// wiley hides a clean DOI in a sibling input
				const hidden = container?.querySelector('input[type="hidden"]')?.value;
				if (hidden) return hidden;
				const href = node.getAttribute("href") || "";
				return extractDOI(`${href} ${container?.innerText || ""}`);
			},
		},
		{
			id: "nature.com",
			itemSelector: "h3.c-card__title a.c-card__link",
			titleNode: item => item,
			getDOI: (_item, node) => {
				const container = node.closest("div, li, article");
				const href = node.getAttribute("href") || "";
				return extractDOI(`${href} ${container?.innerText || ""}`);
			},
		},
        {
            id: "cell.com",
            itemSelector: "span.hlFld-Title h2.meta__title a",
            titleNode: item => item,
            getDOI: (_item, node) => {
                const container = node.closest("span.hlFld-Title, h2.meta__title, li, div, article");
                const href = node.getAttribute("href") || "";
                return extractDOI(`${href} ${container?.innerText || ""}`);
            },
        },
	];

	// ezproxy rewrites "www.nature.com" -> "www-nature-com.ezproxy...", so normalize
	// dashes to dots before matching site ids.
	const normalizedHost = location.hostname.replace(/-/g, ".");
	const activeSite = SITES.find(s => normalizedHost.includes(s.id)) || null;

	/* =========================
	 * HTTP
	 * ========================= */
	const httpRequest =
		(typeof GM !== "undefined" && GM.xmlHttpRequest) ||
		(typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest);

	if (!httpRequest) {
		console.error("No GM HTTP API available");
		return;
	}

	const postJSON = (url, data) =>
		new Promise((resolve, reject) => {
			httpRequest({
				method: "POST",
				url,
				headers: { "Content-Type": "application/json" },
				data: JSON.stringify(data),
				onload: r => {
					try { resolve(JSON.parse(r.responseText)); }
					catch (e) { reject(e); }
				},
				onerror: reject,
			});
		});

	/* =========================
	 * STATE
	 * ========================= */
	const zoteroCache = new Map();
	const zoteroPending = new Set();

	/* =========================
	 * HIGHLIGHT
	 * ========================= */
	const highlightZotero = node => {
		node.style.background = ZOTERO_COLOR;
		node.style.padding = "2px 4px";
		node.style.borderRadius = "4px";
		node.title = "Already in Zotero";
	};

	const highlightVisitedWOS = node => {
		node.style.outline = WOS_VISITED_OUTLINE;
		node.style.outlineOffset = "2px";
		node.style.opacity = "0.65";
		node.title = (node.title ? node.title + " | " : "") + "Previously opened";
	};

	/* =========================
	 * WOS VISITED TRACKING
	 * ========================= */
	const getVisitedWOS = () => {
		try { return new Set(JSON.parse(localStorage.getItem(WOS_VISITED_KEY) || "[]")); }
		catch { return new Set(); }
	};

	const saveVisitedWOS = set =>
		localStorage.setItem(WOS_VISITED_KEY, JSON.stringify([...set]));

	const visitedWOS = getVisitedWOS();

	const markVisitedWOS = id => {
		if (!id || visitedWOS.has(id)) return;
		visitedWOS.add(id);
		saveVisitedWOS(visitedWOS);
	};

	const installWOSClickCapture = () => {
		if (activeSite?.id !== "webofscience") return;

		document.addEventListener("click", e => {
			const a = e.target.closest?.('a[href*="/full-record/"]');
			const id = (a?.href || "").match(/WOS:\w+/)?.[0];
			if (id) markVisitedWOS(id);
		}, true);
	};

	/* =========================
	 * COLLECTION
	 *
	 * The key change vs v0.2.x: we no longer use a WeakSet of "seen" nodes that
	 * could get stamped during a transient render. Instead we mark a DOM attribute
	 * only AFTER we've successfully extracted a stable title. Unstable/early reads
	 * are retried on the next scan tick.
	 * ========================= */
	const collectItems = () => {
		if (!activeSite) return [];

		const {
			id: siteId,
			itemSelector,
			titleNode,
			stripTitle = defaultStripTitle,
			getDOI = defaultGetDOI,
			getKey,
			requireStable = true,
			extra,
		} = activeSite;

		const items = [...document.querySelectorAll(itemSelector)];
		const out = [];

		items.forEach((item, i) => {
			if (item.hasAttribute(PROCESSED_ATTR)) return;

			const node = titleNode(item);
			if (!node) return;

			const rawTitle = cleanText(node);
			const title = stripTitle(rawTitle);
			if (!title) return;
			if (requireStable && !isStableTitle(title)) return;

			const doi = getDOI(item, node) || null;
			const base = { title, doi };
			const key = getKey ? getKey(item, node, base) : cacheKey(base);
			const extras = extra ? extra(item, node) : {};

			// only stamp when we got a stable read
			item.setAttribute(PROCESSED_ATTR, "1");

			out.push({
				id: `${siteId}-${i}`,
				node,
				title,
				doi,
				key,
				...extras,
			});
		});

		return out;
	};

	/* =========================
	 * ZOTERO CHECK
	 * ========================= */
	const checkZotero = async items => {
		if (!items.length) return;

		// instant paint from local state
		items.forEach(it => {
			if (it.wosid && visitedWOS.has(it.wosid)) highlightVisitedWOS(it.node);
			if (zoteroCache.get(it.key)) highlightZotero(it.node);
		});

		const toQuery = items.filter(it => {
			if (zoteroCache.has(it.key)) return false;
			if (zoteroPending.has(it.key)) return false;
			zoteroPending.add(it.key);
			return true;
		});

		if (!toQuery.length) return;

		let data;
		try {
			data = await postJSON(API, {
				queries: toQuery.map(it => ({
					id: it.id,
					title: it.title,
					doi: it.doi || undefined,
				})),
			});
		} catch (e) {
			console.warn("Zotero API error", e);
			toQuery.forEach(it => zoteroPending.delete(it.key));
			return;
		}

		const resultMap = new Map((data.results || []).map(r => [r.id, !!r.exists]));

		toQuery.forEach(it => {
			const exists = resultMap.get(it.id);
			zoteroPending.delete(it.key);
			zoteroCache.set(it.key, exists);
			if (exists) highlightZotero(it.node);
		});
	};

	/* =========================
	 * SPA LOOP
	 * ========================= */
	let scanTimer = null;
	let currentURL = location.href;

	const run = () => checkZotero(collectItems());

	const startScanLoop = () => {
		if (scanTimer) clearInterval(scanTimer);

		const start = Date.now();

		scanTimer = setInterval(() => {
			if (Date.now() - start > SCAN_DURATION) {
				clearInterval(scanTimer);
				scanTimer = null;
				return;
			}
			run();
		}, SCAN_INTERVAL);
	};

	const watchURL = () => {
		setInterval(() => {
			if (location.href !== currentURL) {
				currentURL = location.href;
				startScanLoop();
			}
		}, 500);
	};

	/* =========================
	 * INIT
	 * ========================= */
	if (!activeSite) {
		console.warn("ZOTERO HIGHLIGHTER: no site config matched", location.hostname);
		return;
	}

	console.log("ZOTERO HIGHLIGHTER: site =", activeSite.id);

	installWOSClickCapture();
	startScanLoop();
	watchURL();

	new MutationObserver(run).observe(document.body, {
		childList: true,
		subtree: true,
	});

})();