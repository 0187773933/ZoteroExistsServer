var chromeHandle;

function install(data, reason) {}
function uninstall(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  // If you need your content/ scripts, keep your chrome registration
  // but it's not required for the HTTP endpoint itself.
  try {
    var aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    var manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
      ["content", "__addonRef__", rootURI + "content/"],
    ]);
  } catch (e) {
    // If you don't have content/ or registerChrome fails, endpoint can still work.
  }

  // Get Zotero global (privileged)
  const Zotero = Components.classes["@zotero.org/zotero;1"]
    .getService(Components.interfaces.nsISupports)
    .wrappedJSObject;

  Zotero.debug("Custom Exists Search: startup()");

  // Register endpoint
  registerExistsEndpoint(Zotero);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;

  const Zotero = Components.classes["@zotero.org/zotero;1"]
    .getService(Components.interfaces.nsISupports)
    .wrappedJSObject;

  // Optional: remove endpoint on shutdown
  try {
    delete Zotero.Server.Endpoints["/exists"];
  } catch (_) {}

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

async function onMainWindowLoad({ window }, reason) {}
async function onMainWindowUnload({ window }, reason) {}

/* ============================
 * Endpoint implementation
 * ============================ */

function registerExistsEndpoint(Zotero) {
  function ExistsEndpoint() {}

  ExistsEndpoint.prototype = {
    supportedMethods: ["POST"],

    init: async function (postData, sendResponse) {
      try {
        const payload = parsePostData(postData);
        const queries = Array.isArray(payload.queries) ? payload.queries : [];

        const results = [];
        for (const q of queries) {
          const matches = await searchOne(Zotero, q);
          results.push({
            id: q && q.id != null ? q.id : null,
            exists: matches.length > 0,
            matches
          });
        }

        sendResponse(200, "application/json", JSON.stringify({ results }));
      } catch (e) {
        Zotero.debug("Custom Exists Search: endpoint error");
        Zotero.debug(String(e));
        sendResponse(400, "application/json", JSON.stringify({ error: String(e) }));
      }
    }
  };

  Zotero.Server.Endpoints["/exists"] = ExistsEndpoint;

  Zotero.debug("Custom Exists Search: registered /exists");
}

function parsePostData(postData) {
  if (!postData) return {};

  let s = String(postData);

  // Remove UTF-8 BOM
  s = s.replace(/^\uFEFF/, "");

  // Try to decode percent-encoding (form posts, curl -d quirks)
  try { s = decodeURIComponent(s); } catch (_) {}

  // Extract JSON object substring (handles garbage prefix/suffix)
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("POST body does not contain JSON object");
  }

  return JSON.parse(s.slice(start, end + 1));
}

async function searchOne(Zotero, q) {
  if (!q || typeof q !== "object") return [];

  const s = new Zotero.Search();
  s.libraryID = Zotero.Libraries.userLibraryID;

  // Priority: DOI > ISBN > Title(+year)
  if (q.doi) {
    s.addCondition("DOI", "is", String(q.doi).trim());
  } else if (q.isbn) {
    s.addCondition("ISBN", "is", String(q.isbn).trim());
  } else if (q.title) {
    s.addCondition("title", "contains", String(q.title));
    if (q.year) s.addCondition("year", "is", String(q.year));
  } else {
    return [];
  }

  return await s.search();
}
