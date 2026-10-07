import { useEffect } from "react";

/** Runs `open` once when the URL has `?new=1` (used by "New campaign" shortcuts), then drops the flag. */
export function useOpenFromQuery(open: () => void, allowed = true) {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") !== "1") return;
    params.delete("new");
    const qs = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    if (allowed) open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
