// ==UserScript==
// @name         Zotero Saved + Visited Highlighter (Multi-Site)
// @namespace    local.zotero.multi
// @version      0.2.1
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
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
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
				onerror: reject
			});
		});

	/* =========================
	 * STATE
	 * ========================= */
	const zoteroCache = new Map();
	const zoteroPending = new Set();
	const seenNodes = new WeakSet();

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

	const isStableTitle = t =>
		t && t.length > 10 && !t.endsWith("…");

	const isNewNode = node => {
		if (seenNodes.has(node)) return false;
		seenNodes.add(node);
		return true;
	};

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
	 * WOS VISITED
	 * ========================= */
	const getVisitedWOS = () => {
		try { return new Set(JSON.parse(localStorage.getItem(WOS_VISITED_KEY) || "[]")); }
		catch { return new Set(); }
	};

	const saveVisitedWOS = set =>
		localStorage.setItem(WOS_VISITED_KEY, JSON.stringify([...set]));

	const visitedWOS = getVisitedWOS();

	const extractWOSID = url =>
		(url || "").match(/WOS:\w+/)?.[0] || null;

	const markVisitedWOS = id => {
		if (!id || visitedWOS.has(id)) return;
		visitedWOS.add(id);
		saveVisitedWOS(visitedWOS);
	};

	const installWOSClickCapture = () => {
		if (!location.hostname.includes("webofscience")) return;

		document.addEventListener("click", e => {
			const a = e.target.closest?.('a[href*="/full-record/"]');
			const id = extractWOSID(a?.href);
			if (id) markVisitedWOS(id);
		}, true);
	};

	/* =========================
	 * COLLECTORS
	 * ========================= */
	const collect = (selector, mapFn) =>
		[...document.querySelectorAll(selector)].map(mapFn).filter(Boolean);

	const collectScholar = () =>
		collect("div.gs_r", (card, i) => {
			const h = card.querySelector("h3.gs_rt");
			if (!h || !isNewNode(h)) return;

			let title = h.innerText.trim().replace(/^\[[^\]]+\]\s*/, "");
			if (!title) return;

			const doi = extractDOI(card.innerText);

			return {
				id: `gs-${i}`,
				node: h,
				title,
				doi,
				key: cacheKey({ title, doi })
			};
		});

	const collectWOS = () =>
		collect('a[data-ta="summary-record-title-link"]', (a, i) => {
			if (!isNewNode(a)) return;

			const title = a.innerText.trim();
			if (!title) return;

			const doi = extractDOI(a.closest("app-summary-title")?.innerText);
			const wosid = extractWOSID(a.href);

			return {
				id: `wos-${i}`,
				node: a,
				title,
				doi,
				key: cacheKey({ title, doi }),
				wosid
			};
		});

	const collectPubMed = () =>
		collect("a.docsum-title", (a, i) => {
			if (!isNewNode(a)) return;

			const title = a.innerText.replace(/\s+/g, " ").trim();
			if (!isStableTitle(title)) return;

			return {
				id: `pm-${i}`,
				node: a,
				title,
				doi: null,
				key: cacheKey({ title })
			};
		});

	const collectArxiv = () =>
		collect("li.arxiv-result", (li, i) => {
			const node = li.querySelector("p.title");
			if (!node || !isNewNode(node)) return;

			const title = node.innerText.replace(/\s+/g, " ").trim();
			if (!isStableTitle(title)) return;

			const id = li.querySelector('a[href*="/abs/"]')?.href.match(/\/abs\/([^?#]+)/)?.[1];
			const doi = extractDOI(li.innerText);

			return {
				id: `arxiv-${id || i}`,
				node,
				title,
				doi,
				key: id ? `arxiv:${id}` : cacheKey({ title, doi })
			};
		});

	const collectScienceDirect = () =>
		collect('a[href*="/science/article/pii/"]', (a, i) => {
			if (!isNewNode(a)) return;

			const title = a.innerText.replace(/\s+/g, " ").trim();
			if (!isStableTitle(title)) return;

			const doi = extractDOI(a.closest("li, div")?.innerText);

			return {
				id: `sd-${i}`,
				node: a,
				title,
				doi,
				key: cacheKey({ title, doi })
			};
		});

	const collectSpringer = () =>
		collect("a.app-card-open__link", (a, i) => {
			if (!isNewNode(a)) return;

			const title = a.innerText.replace(/\s+/g, " ").trim();
			if (!isStableTitle(title)) return;

			const doi = extractDOI(a.closest("li, div, section")?.innerText);

			return {
				id: `springer-${i}`,
				node: a,
				title,
				doi,
				key: cacheKey({ title, doi })
			};
		});

	const collectIEEE = () =>
		collect("h3.text-md-md-lh a", (a, i) => {
			if (!isNewNode(a)) return;

			const title = a.innerText.replace(/\s+/g, " ").trim();
			if (!isStableTitle(title)) return;

			const container = a.closest("div, li");
			const doi = extractDOI(container?.innerText);

			return {
				id: `ieee-${i}`,
				node: a,
				title,
				doi,
				key: cacheKey({ title, doi })
			};
		});

	const collectItems = () => {
		const host = location.hostname;

		if (host.includes("scholar.google.com")) return collectScholar();
		if (host.includes("webofscience")) return collectWOS();
		if (host.includes("pubmed")) return collectPubMed();
		if (host.includes("arxiv")) return collectArxiv();
		if (host.includes("sciencedirect")) return collectScienceDirect();
		if (host.includes("springer")) return collectSpringer();
		if (host.includes("ieee")) return collectIEEE();
		return [];
	};

	/* =========================
	 * ZOTERO CHECK
	 * ========================= */
	const checkZotero = async items => {
		if (!items.length) return;

		// instant highlight
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
					doi: it.doi || undefined
				}))
			});
		} catch (e) {
			console.warn("Zotero API error", e);
			toQuery.forEach(it => zoteroPending.delete(it.key));
			return;
		}

		const map = new Map((data.results || []).map(r => [r.id, !!r.exists]));

		toQuery.forEach(it => {
			const exists = map.get(it.id);
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
	installWOSClickCapture();
	startScanLoop();
	watchURL();

	new MutationObserver(run).observe(document.body, {
		childList: true,
		subtree: true
	});

})();