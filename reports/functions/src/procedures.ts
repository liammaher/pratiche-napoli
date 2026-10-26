// The ids of the procedures on the site, from its procedures.json. Fetched on
// the first report and kept for an hour, so a new procedure can be reported on
// without a redeploy; if the site can't be reached, the last good list is used.

const MAX_AGE_MS = 60 * 60 * 1000;

export function procedureIndex(url: string, fetchJson = defaultFetchJson): () => Promise<Set<string>> {
  let cached: { ids: Set<string>; at: number } | undefined;
  let pending: Promise<Set<string>> | undefined;
  return () => {
    if (cached && Date.now() - cached.at < MAX_AGE_MS) return Promise.resolve(cached.ids);
    pending ??= (async () => {
      try {
        const index = (await fetchJson(url)) as { procedures?: { id?: unknown }[] };
        const ids = new Set((index.procedures ?? []).map((p) => p.id).filter((id) => typeof id === "string"));
        if (!ids.size) throw new Error(`${url} lists no procedures`);
        cached = { ids, at: Date.now() };
        return ids;
      } catch (err) {
        if (cached) return cached.ids;
        throw err;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
